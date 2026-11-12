import { randomUUID } from "node:crypto"

import pg from "pg"

import { stackState } from "./db.ts"

/**
 * QA test authoring, step [5e], EPIC-0010 (pasted job descriptions). Exact strings from
 * epics/active/EPIC-0010-pasted-job-description/copy-deck.r1.md byte for byte (not the web
 * app's copy objects), so a wrong string in the product fails the journey. Fixtures run on
 * the E2E database as the bootstrap superuser (RLS does not bind it).
 *
 * Declared doubles (qa.md tier 3): the E2E stack has no AI provider (ANTHROPIC_API_KEY is
 * empty and every non-loopback host but the ATS fixtures is blocked), so `markEvaluated`
 * stands in for the evaluation's result and `seedGeneratedDocuments` for document
 * generation. Everything the browser does goes through the real web app, api and Postgres.
 */
export const PD = {
  toggle: "Add the job description", // C-PD-1
  descriptionLabel: /^Job description/, // C-PD-4 (+ C-PD-3 "Optional" in the label text)
  titleLabel: "Job title", // C-PD-9
  companyLabel: "Company", // C-PD-10
  send: "Check this job", // C-PD-12
  counterEmpty: "0 / 30,000", // C-PD-6
  descriptionLong: "Over the 30,000-character limit. Shorten it to check this job.", // C-PD-22
  created: "Saved from your description. Eve is checking it.", // C-PD-30
  employerPage: "Eve read the job from the employer's page and used that. Your description wasn't saved.", // C-PD-31
  waitingCost: /^Saved\. Eve checks it when paid automation resumes on .+, or sooner if the ceiling is raised\.$/, // C-PD-36
  waitingInvitee: "Saved. It's checked once the person who runs your Eve turns on checks for you.", // C-PD-37
  view: "View it", // C-HP-CHECK-VIEW
  pastedBadge: "Pasted", // C-PD-40
  pastedNote: "You pasted this text. Eve didn't read the employer's page.", // C-PD-41
  warningTitle: "Eve wouldn't apply to this job by itself.", // C-PD-42
  applicationBadge: "Pasted, manual only", // C-PD-51
  manualOnlyTitle: "Eve never sends this one. You apply yourself.", // C-PD-60
  manualOnlyBodyNoLink: "Download the resume and cover letter, then apply wherever you found the job. It isn't queued or counted in the daily cap.", // C-PD-62
  prepare: /^Prepare documents/, // existing PrepareDocumentsButton
  manualOnlyError: "This Application is manual only. Eve never sends it, so it can't be queued or used as a sample. Nothing changed.", // manual_application_only
} as const

/** Companies the EPIC-0010 journeys type carry this prefix, so the reset touches only their rows. */
export const PD_PREFIX = "PD-E2E"

async function withClient<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

/** A plain-text description of at least 1,240 characters carrying `marker`. */
export function description(marker: string): string {
  let text =
    `Senior Frontend Engineer\n\nAbout the role\nBuild React features with TypeScript for the merchant dashboard. Design GraphQL queries. Reference ${marker}.\n\n` +
    "Location: Remote, open to candidates in Nigeria. Salary USD 60,000 to 80,000 per year.\n"
  while (text.length < 1240) text += "We value clear writing, steady delivery and kind code review. "
  return text.trim()
}

/** Removes the postings, Applications and documents the EPIC-0010 journeys own (company prefix or marker). */
export async function resetPastedDescription(): Promise<void> {
  await withClient(async (client) => {
    const apps = `select id from application where company like '${PD_PREFIX}%' or job_posting_id in (select id from job_posting where posting_text like '%QA-E2E-PD%')`
    for (const table of ["notification_outbox", "submission_event", "application_form_read", "tailored_document", "outcome"]) await client.query(`delete from ${table} where application_id in (${apps})`)
    await client.query(`delete from application where id in (${apps})`)
    const postings = `select id from job_posting where company like '${PD_PREFIX}%' or posting_text like '%QA-E2E-PD%'`
    for (const table of ["ai_call", "match_evidence", "eligibility_result", "candidate_posting"]) await client.query(`delete from ${table} where job_posting_id in (${postings})`)
    await client.query(`delete from job_posting where id in (${postings})`)
  })
}

/** Stands in for a finished evaluation (no AI provider in the E2E stack): the decision, Eligibility and the posting's keywords. */
export async function markEvaluated(
  email: string,
  postingId: string,
  decision: Readonly<{ status: "ranked" | "skipped" | "excluded"; skipReason?: string | null; violated?: readonly string[] }>,
  keywords: Readonly<{ technologies: readonly string[]; atsSkills: readonly string[] }> = { technologies: ["React", "TypeScript", "Kubernetes"], atsSkills: ["GraphQL"] }
): Promise<void> {
  await withClient(async (client) => {
    const candidateId = (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]!.id
    const violated = decision.violated ?? []
    const skipReason = decision.skipReason ?? (decision.status === "excluded" ? "violated_rule" : null)
    await client.query(
      `update candidate_posting set status = $3, skip_reason = $4, skip_detail = $5, evaluation_failure = null, evaluated_at = now() where candidate_id = $1 and job_posting_id = $2`,
      [candidateId, postingId, decision.status, skipReason, decision.status === "excluded" ? (violated[0] ?? null) : null]
    )
    const toStored = (names: readonly string[]) => JSON.stringify(names.map((name) => ({ name, quote: name })))
    await client.query("update job_posting set technologies = $2::jsonb, ats_skills = $3::jsonb, role_family = 'senior_frontend' where id = $1", [postingId, toStored(keywords.technologies), toStored(keywords.atsSkills)])
    const rules = [
      ...violated.map((rule) => ({ rule, result: "violated", quote: `E2E quote for ${rule}` })),
      ...(violated.includes("location") ? [] : [{ rule: "location", result: "met", quote: "Remote, open to candidates in Nigeria" }]),
    ]
    await client.query("delete from eligibility_result where candidate_id = $1 and job_posting_id = $2", [candidateId, postingId])
    await client.query(
      `insert into eligibility_result (candidate_id, job_posting_id, arrangement, relocation_country, employment_type, rules, eligible, normalized_monthly_max_usd, fx_rate_date, evaluated_at)
        values ($1, $2, 'remote', null, 'direct', $3::jsonb, $4, null, null, now())`,
      [candidateId, postingId, JSON.stringify(rules), violated.length === 0]
    )
  })
}

export type Ats = Readonly<{ score: number; total: number; matched: readonly string[]; missing: readonly string[]; gaps: readonly string[] }>

/** Stands in for document generation (no AI provider): both documents, the resume carrying `ats`, state documents ready. */
export async function seedGeneratedDocuments(applicationId: string, ats: Ats): Promise<void> {
  await withClient(async (client) => {
    const candidateId = (await client.query<{ candidate_id: string }>("select candidate_id from application where id = $1", [applicationId])).rows[0]!.candidate_id
    await client.query("delete from tailored_document where application_id = $1", [applicationId])
    const content = {
      resume: { kind: "resume", summary: [], experience: [], skills: [], education: [], ats },
      cover_letter: { kind: "cover_letter", greeting: "Dear team,", opening: null, paragraphs: [], closingLine: null, closing: "Regards," },
    } as const
    for (const kind of ["resume", "cover_letter"] as const) {
      await client.query(
        `insert into tailored_document (candidate_id, id, application_id, kind, career_profile_version, content, pdf_storage_name, docx_storage_name, pdf_sha256, docx_sha256, created_at)
          values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7, 'x', 'x', now())`,
        [candidateId, randomUUID(), applicationId, kind, JSON.stringify(content[kind]), `${randomUUID()}.pdf`, `${randomUUID()}.docx`]
      )
    }
    await client.query("update application set state = 'documents_ready', career_profile_version = 1 where id = $1", [applicationId])
  })
}

/** Rows whose text, title or company contains `marker` ("stored nowhere"). */
export async function postingsContaining(marker: string): Promise<number> {
  return withClient(async (client) => Number((await client.query<{ n: string }>("select count(*) as n from job_posting where posting_text like $1 or title like $1 or company like $1", [`%${marker}%`])).rows[0]?.n ?? 0))
}

export type PastedRow = Readonly<{ id: string; origin: string; posting_text: string; title: string; company: string; apply_mode: string; application_url: string | null }>

/** The Candidate's holds, newest first. */
export async function holdsOf(email: string): Promise<PastedRow[]> {
  return withClient(async (client) =>
    (
      await client.query<PastedRow>(
        `select p.id, cp.origin, p.posting_text, p.title, p.company, p.apply_mode, p.application_url
           from candidate_posting cp join job_posting p on p.id = cp.job_posting_id join candidate c on c.id = cp.candidate_id
          where c.email = $1 order by cp.discovered_at desc`,
        [email]
      )
    ).rows
  )
}

export async function applicationRow(id: string): Promise<{ state: string; submission_state: string | null; override_created_at: Date | null }> {
  return withClient(async (client) => (await client.query("select state, submission_state, override_created_at from application where id = $1", [id])).rows[0])
}
