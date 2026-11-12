import { randomUUID } from "node:crypto"

import pg from "pg"

import { stackState } from "./db.ts"

/**
 * QA test authoring (apply anyway, bounds and consent; api-contract.md v1.24.0).
 * Fixtures on the E2E database as the bootstrap superuser (RLS does not bind it).
 * Postings are visible (dated today, senior_frontend, mid_plus) unless hidden.
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

/** Valid empty tailored document content per kind (the api parses it on read). */
const EMPTY_TAILORED_CONTENT: Record<string, unknown> = {
  resume: { kind: "resume", summary: [], experience: [], skills: [], education: [] },
  cover_letter: { kind: "cover_letter", greeting: "Dear team,", opening: null, paragraphs: [], closingLine: null, closing: "Regards," },
}

export type Decision = Readonly<{ status: "ranked" | "skipped" | "excluded"; skipReason: string | null; skipDetail: string | null; violatedRules: readonly string[] }>

export const WEAK_SKIP: Decision = { status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [] }
export const INDUSTRY_ONLY: Decision = { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"] }
export const LOCATION_EXCLUDED: Decision = { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violatedRules: ["location"] }
export const RANKED: Decision = { status: "ranked", skipReason: null, skipDetail: null, violatedRules: [] }

export type SeededPosting = Readonly<{ id: string; title: string; company: string; requisition: string }>

/** Deletes Applications and postings the apply-anyway journeys own (by the "AA-E2E" company prefix). */
export async function resetApplyAnyway(): Promise<void> {
  await withClient(async (client) => {
    const ids = "select id from application where company like 'AA-E2E %'"
    for (const table of ["notification_outbox", "submission_event", "application_form_read", "tailored_document", "outcome"]) {
      await client.query(`delete from ${table} where application_id in (${ids})`)
    }
    await client.query("delete from application where company like 'AA-E2E %'")
    const postings = "select id from job_posting where company like 'AA-E2E %'"
    for (const table of ["match_evidence", "eligibility_result", "candidate_posting"]) await client.query(`delete from ${table} where job_posting_id in (${postings})`)
    await client.query("delete from job_posting where company like 'AA-E2E %'")
  })
}

/** A visible automatic Greenhouse posting held by the Candidate `email` with `decision`; `company` gets the "AA-E2E " prefix. */
export async function seedDecidedPosting(email: string, decision: Decision, opts: Readonly<{ company: string; title?: string }>): Promise<SeededPosting> {
  const id = randomUUID()
  const company = `AA-E2E ${opts.company}`
  const title = opts.title ?? "Senior Frontend Engineer"
  const requisition = `AA-${id.slice(0, 6)}`
  const url = `https://boards.greenhouse.io/aae2e/jobs/${requisition}`
  const now = new Date()
  await withClient(async (client) => {
    const candidateId = (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]!.id
    await client.query(
      `insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, posting_text,
          role_family, discovered_at, posted_at, posted_date_kind, seniority_marker)
        values ($1, $2, $3, $2, 'greenhouse', 'automatic', 'employer_board', $4, lower($4), $5, 'Remote, open to candidates in Nigeria. Build React features.',
          'senior_frontend', $6, $6, 'published', 'mid_plus')`,
      [id, url, requisition, title, company, now]
    )
    await client.query(
      `insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
        values ($1, $2, 'employer_board', $3, $4, $5, null, $6, $6)`,
      [candidateId, id, decision.status, decision.skipReason, decision.skipDetail, now]
    )
    const rules = [
      ...decision.violatedRules.map((rule) => ({ rule, result: "violated", quote: `E2E quote for ${rule}` })),
      ...(decision.violatedRules.includes("location") ? [] : [{ rule: "location", result: "met", quote: "Remote" }]),
    ]
    await client.query(
      `insert into eligibility_result (candidate_id, job_posting_id, arrangement, relocation_country, employment_type, rules, eligible, normalized_monthly_max_usd, fx_rate_date, evaluated_at)
        values ($1, $2, 'remote', null, 'direct', $3::jsonb, $4, null, null, $5)`,
      [candidateId, id, JSON.stringify(rules), decision.violatedRules.length === 0, now]
    )
  })
  return { id, title, company, requisition }
}

/** Puts an Application in the queue the way generation and POST …/queue leave it (documents ready, queued, automatic). */
export async function makeQueued(applicationId: string): Promise<void> {
  await withClient(async (client) => {
    const row = (await client.query<{ candidate_id: string }>("select candidate_id from application where id = $1", [applicationId])).rows[0]!
    for (const kind of ["resume", "cover_letter"]) {
      await client.query(
        `insert into tailored_document (candidate_id, id, application_id, kind, career_profile_version, content, pdf_storage_name, docx_storage_name, pdf_sha256, docx_sha256, created_at)
          values ($1, $2, $3, $4, 1, $7::jsonb, $5, $6, 'x', 'x', now())`,
        [row.candidate_id, randomUUID(), applicationId, kind, `${randomUUID()}.pdf`, `${randomUUID()}.docx`, JSON.stringify(EMPTY_TAILORED_CONTENT[kind])]
      )
    }
    await client.query("update application set state = 'documents_ready', career_profile_version = 1, submission_state = 'queued', submission_kind = 'automatic' where id = $1", [applicationId])
  })
}

/** A queued automatic Application for the Candidate on a fresh ranked posting, inserted directly. */
export async function seedQueuedApplication(email: string, opts: Readonly<{ company: string; title?: string }>): Promise<{ applicationId: string; posting: SeededPosting }> {
  const posting = await seedDecidedPosting(email, RANKED, opts)
  const applicationId = randomUUID()
  await withClient(async (client) => {
    const candidateId = (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]!.id
    await client.query(
      `insert into application (candidate_id, id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, 'prepared', null, now(), now())`,
      [candidateId, applicationId, posting.id, `https://boards.greenhouse.io/aae2e/jobs/${posting.requisition}`, posting.requisition, posting.company, posting.title]
    )
  })
  await makeQueued(applicationId)
  return { applicationId, posting }
}

export type ApplicationRow = Readonly<{
  id: string
  state: string
  submission_state: string | null
  override_created_at: Date | null
  override_status: string | null
  override_skip_reason: string | null
  override_violated_rules: string[] | null
}>

export async function applicationsForPosting(postingId: string): Promise<ApplicationRow[]> {
  return withClient(async (client) =>
    (
      await client.query<ApplicationRow>(
        "select id, state, submission_state, override_created_at, override_status, override_skip_reason, override_violated_rules from application where job_posting_id = $1",
        [postingId]
      )
    ).rows
  )
}

export async function applicationRow(id: string): Promise<ApplicationRow & { queue_removed: number; documents: number }> {
  return withClient(async (client) => {
    const row = (
      await client.query<ApplicationRow & { queue_removed: number; documents: number }>(
        `select id, state, submission_state, override_created_at, override_status, override_skip_reason, override_violated_rules,
           (select count(*)::int from submission_event e where e.application_id = a.id and e.kind = 'queue_removed') as queue_removed,
           (select count(*)::int from tailored_document d where d.application_id = a.id) as documents
         from application a where id = $1`,
        [id]
      )
    ).rows[0]
    if (!row) throw new Error(`no application ${id}`)
    return row
  })
}
