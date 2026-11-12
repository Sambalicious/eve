import { randomUUID } from "node:crypto"

import pg from "pg"

import { stackState } from "./db.ts"

/**
 * QA test authoring, EPIC-0011. Fixtures on the E2E database as the bootstrap
 * superuser (RLS does not bind it). Every seeded row is named with the "E11 "
 * company prefix so `resetEpic11` removes exactly what these journeys made.
 */
async function withClient<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

export const NEW_INVITEE = { email: "new.invitee@example.com", sub: "100000000000000000031" } as const
const candidateId = async (client: pg.Client, email: string) => (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]!.id

/** An invited non-Operator with no Career Profile and not onboarded (the "new.invitee" fixture). */
export async function ensureNewInvitee(): Promise<void> {
  await withClient((client) =>
    client.query("insert into candidate (email, google_sub, role) values ($1, $2, 'candidate') on conflict (google_sub) do nothing", [NEW_INVITEE.email, NEW_INVITEE.sub])
  )
}

/** Sets the Advanced flag directly (the same row PUT /v1/me/advanced writes). `note` sets simpler_note_due. */
export async function setAdvanced(email: string, enabled: boolean, note = false): Promise<void> {
  await withClient(async (client) => {
    const id = await candidateId(client, email)
    await client.query(
      `insert into candidate_view_setting (candidate_id, advanced_enabled, simpler_note_due, improve_list_dismissed_at, updated_at) values ($1, $2, $3, null, now())
       on conflict (candidate_id) do update set advanced_enabled = excluded.advanced_enabled, simpler_note_due = excluded.simpler_note_due, improve_list_dismissed_at = null, updated_at = now()`,
      [id, enabled, note]
    )
  })
}

export async function readAdvanced(email: string): Promise<{ advanced: boolean; note: boolean } | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ advanced: boolean; note: boolean }>(
      "select advanced_enabled as advanced, simpler_note_due as note from candidate_view_setting where candidate_id = (select id from candidate where email = $1)",
      [email]
    )
    return rows[0] ?? null
  })
}

export async function deleteAdvanced(email: string): Promise<void> {
  await withClient((client) => client.query("delete from candidate_view_setting where candidate_id = (select id from candidate where email = $1)", [email]))
}

/** Sets automatic_enabled directly (a non-Operator cannot turn it on through the route). Creates the row if missing. */
export async function setAutomatic(email: string, enabled: boolean, gatePassed = true): Promise<void> {
  await withClient(async (client) => {
    const id = await candidateId(client, email)
    await client.query(
      `insert into activation_state (candidate_id, gate_passed_at, automatic_enabled, existing_applications_completed_at) values ($1, $2, $3, $2)
       on conflict (candidate_id) do update set automatic_enabled = excluded.automatic_enabled, gate_passed_at = excluded.gate_passed_at`,
      [id, gatePassed ? new Date("2026-10-01T00:00:00Z") : null, enabled]
    )
  })
}

export async function readAutomatic(email: string): Promise<boolean> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ automatic_enabled: boolean }>("select automatic_enabled from activation_state where candidate_id = (select id from candidate where email = $1)", [email])
    return rows[0]?.automatic_enabled ?? false
  })
}

export async function setGlobalPause(paused: boolean): Promise<void> {
  await withClient((client) => client.query("update control_state set global_paused = $1", [paused]))
}

export type SeededApplication = Readonly<{ id: string; company: string; title: string }>
export type ApplicationSeed = Readonly<{
  company: string
  title?: string
  state?: string
  submissionState?: string | null
  submissionKind?: "automatic" | "sample" | null
  sampleState?: "awaiting_review" | "approved" | "rejected" | null
  blockedReason?: string | null
  detailsDeleted?: boolean
  /** Outcomes oldest first. */
  outcomes?: readonly string[]
}>

/** An Application (and its posting) for `email`; company gets the "E11 " prefix. */
export async function seedApplication(email: string, seed: ApplicationSeed): Promise<SeededApplication> {
  const company = `E11 ${seed.company}`
  const title = seed.title ?? "Senior Frontend Engineer"
  return withClient(async (client) => {
    const owner = await candidateId(client, email)
    const postingId = randomUUID()
    const id = randomUUID()
    const requisition = `E11-${id.slice(0, 6)}`
    const url = `https://boards.greenhouse.io/e11/jobs/${requisition}`
    await client.query(
      `insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, discovered_at, role_family, seniority_marker, posted_at, posted_date_kind)
       values ($1, $2, $3, $2, 'greenhouse', 'automatic', 'employer_board', $4, lower($4), $5, now(), 'senior_frontend', 'mid_plus', now(), 'published')`,
      [postingId, url, requisition, title, company]
    )
    await client.query(
      `insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at, evaluated_at) values ($1, $2, 'employer_board', 'ranked', now(), now())`,
      [owner, postingId]
    )
    await client.query(
      `insert into application (id, candidate_id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at,
                               submission_state, submission_kind, sample_state, blocked_reason, details_deleted_at, manual_completed_at, submit_clicked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, now(), now(), $9, $10, $11, $12, $13, $14, $15)`,
      // QA gate: a submission that reached the employer's form (submitting, confirmed, uncertain) always has its submit click
      // time; the Unsure sends card renders it (C-UNC-1), so a seed without it is not a state production can reach.
      [id, owner, postingId, url, requisition, company, title, seed.state ?? "documents_ready", seed.submissionState ?? null, seed.submissionKind ?? (seed.submissionState && seed.submissionState !== "manual" ? "automatic" : null), seed.sampleState ?? null, seed.blockedReason ?? null, seed.detailsDeleted ? new Date() : null, seed.submissionState === "manual" ? new Date() : null, ["submitting", "confirmed", "uncertain"].includes(seed.submissionState ?? "") ? new Date() : null]
    )
    let tick = 0
    for (const type of seed.outcomes ?? []) {
      const at = new Date(Date.now() - (10 - tick++) * 60_000)
      await client.query("insert into outcome (candidate_id, id, application_id, type, created_at, updated_at) values ($1, $2, $3, $4, $5, $5)", [owner, randomUUID(), id, type, at])
    }
    return { id, company, title }
  })
}

export async function outcomeTypes(applicationId: string): Promise<string[]> {
  return withClient(async (client) => (await client.query<{ type: string }>("select type from outcome where application_id = $1 order by created_at, id", [applicationId])).rows.map((r) => r.type))
}

export async function applicationSubmission(applicationId: string): Promise<{ submission_state: string | null; manual_completed_at: Date | null; submitted_local_day: string | null }> {
  return withClient(async (client) => (await client.query("select submission_state, manual_completed_at, submitted_local_day::text from application where id = $1", [applicationId])).rows[0])
}

/** Removes every Application, posting and Outcome the E11 journeys seeded. */
export async function resetEpic11(): Promise<void> {
  await withClient(async (client) => {
    const ids = "select id from application where company like 'E11 %'"
    for (const table of ["notification_outbox", "submission_event", "application_form_read", "tailored_document", "outcome"]) {
      await client.query(`delete from ${table} where application_id in (${ids})`)
    }
    await client.query("delete from application where company like 'E11 %'")
    const postings = "select id from job_posting where company like 'E11 %'"
    for (const table of ["match_evidence", "eligibility_result", "candidate_posting"]) await client.query(`delete from ${table} where job_posting_id in (${postings})`)
    await client.query("delete from job_posting where company like 'E11 %'")
  })
}

/** Product-state counters used by the baseline measurement and the "no data changed" journeys. */
export async function countRows(table: string): Promise<number> {
  return withClient(async (client) => Number((await client.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n))
}

/**
 * Gives `email` an approved Career Profile version (a profile in use), so Home does not redirect to /welcome (AC-2.7).
 * Sections are empty: these journeys never read profile content.
 */
export async function ensureProfileInUse(email: string): Promise<void> {
  await withClient(async (client) => {
    const id = await candidateId(client, email)
    await client.query(
      `insert into career_profile_version (candidate_id, version, status, source, resume_upload_id, sections, created_at, approved_at)
       select $1, 1, 'approved', 'edit', null, '[]', now(), now() where not exists (select 1 from career_profile_version where candidate_id = $1 and status = 'approved')`,
      [id]
    )
  })
}

/** Removes every Career Profile version of `email` (the "no profile" state: first sign-in lands on /welcome). */
export async function removeProfile(email: string): Promise<void> {
  await withClient(async (client) => {
    const id = await candidateId(client, email)
    await client.query("delete from career_profile_version where candidate_id = $1", [id])
  })
}

/**
 * QA gate (step 6a): the installation-wide AI provider approval (table `ai_provider_approval`, one row per provider).
 * FD Background: "a Career Profile in use and an approved AI provider"; without it Home shows the Upload link
 * instead of the paste box (FD:154). The stack starts with no approval (ONB:24 relies on that), so callers
 * approve in the test and clear it again in `finally`.
 */
export async function approveAiProvider(): Promise<void> {
  await withClient((client) =>
    client.query(
      `insert into ai_provider_approval (provider, approved_at, terms_checked_on, training_line, retention_line, whats_sent_line)
       values ('anthropic', now(), current_date, 'E11 training', 'E11 retention', 'E11 sent') on conflict (provider) do nothing`
    )
  )
}

export async function clearAiApproval(): Promise<void> {
  await withClient((client) => client.query("delete from ai_provider_approval where training_line = 'E11 training'"))
}

/** Gives `email` a contact name and a saved-once Job criteria version (two of the five "Improve your results" Done states). */
export async function markContactAndCriteriaDone(email: string): Promise<void> {
  await withClient(async (client) => {
    const id = await candidateId(client, email)
    await client.query(
      "insert into candidate_contact (candidate_id, full_name, lines) values ($1, 'Bisi Adeyemi', $2::jsonb) on conflict (candidate_id) do update set full_name = excluded.full_name, lines = excluded.lines",
      [id, JSON.stringify(["Lagos, Nigeria", "bisi@example.test"])]
    )
    await client.query("update job_criteria set version = greatest(version, 2) where candidate_id = $1", [id])
  })
}

/**
 * Replaces the rule results of a seeded posting for `email`, e.g. one `unverified` rule (ST:65). `rules` use the stored shape
 * `{ rule, result, quote }`.
 */
export async function setRuleResults(email: string, postingId: string, rules: readonly { rule: string; result: string; quote: string }[]): Promise<void> {
  await withClient(async (client) => {
    const id = await candidateId(client, email)
    await client.query("update eligibility_result set rules = $3::jsonb, eligible = $4 where candidate_id = $1 and job_posting_id = $2", [id, postingId, JSON.stringify(rules), !rules.some((r) => r.result === "violated")])
  })
}
