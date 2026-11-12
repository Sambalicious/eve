import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"

import type { Database, JobPostingStatus, StoredRule } from "../../src/db/schema.js"
import { insertPostingFor } from "./candidate-posting.js"

/**
 * QA test authoring (apply anyway, bounds and consent; api-contract.md v1.24.0,
 * gherkin/apply-anyway.feature). Fixtures and the exact copy the QA specs assert.
 * QA-authored and independent of the implementation: strings come from
 * copy-deck-apply-anyway.md byte for byte, not from the api or @eve/contracts.
 *
 * The v1.24.0 `override_*` columns are written and read with raw SQL so this
 * file type-checks before the backend adds them to `schema.ts`.
 */

/** copy-deck-apply-anyway.md (api.error.* rows and the reused messages), byte for byte. */
export const AA_COPY = {
  overrideDecisionChanged: "This posting's decision changed after you opened the dialog, so your override wasn't recorded. Review its new reason, then try again.", // C-AA-9
  overrideNotAllowed: "This posting's reason can't be overridden. Nothing changed.", // C-AA-10
  overrideApplicationState: "The Application for this requisition is past the point where you can record an override. Nothing changed. Open it from Applications.", // C-AA-11
  overrideAcknowledgementMissing: "Confirm the override in its dialog first. Nothing changed. Reload the page and try again.", // C-AA-12
  sampleNotAllowed: "An Application with an override, or for a Job Posting that isn't ranked, can't be an Activation Gate sample. Nothing changed.", // C-AA-37
  postingHidden: "This Job Posting is hidden from your board. Eve won't start a new Application or sample from it. Reload the page to see why.", // api.error.posting_hidden
  notEligible: "This Job Posting is still being checked or couldn't be checked, so it can't become an Application yet.", // application_not_eligible
  emailOverrideFact: (reason: string) => `Override: you chose to apply despite ${reason}`, // C-AA-32
  summaryMarker: " [Override]", // C-AA-34 (leading space is part of the marker)
  summaryOverrideDropped: "the posting changed after you chose to prepare it anyway", // C-AA-35
  postingClosed: "posting closed", // C-SKIP-7 short form
} as const

/** A posting's decision for the session Candidate (contract "Terms": OverrideDecision). */
export type Decision = Readonly<{ status: JobPostingStatus; skipReason: string | null; skipDetail: string | null; violatedRules: readonly string[] }>

export const skipped = (skipReason: string, skipDetail: string | null = null): Decision => ({ status: "skipped", skipReason, skipDetail, violatedRules: [] })
/** Excluded for `violated_rule`; `skip_detail` holds only the first violated rule. */
export const excluded = (...violatedRules: string[]): Decision => ({ status: "excluded", skipReason: "violated_rule", skipDetail: violatedRules[0] ?? null, violatedRules })
export const statusOnly = (status: JobPostingStatus): Decision => ({ status, skipReason: null, skipDetail: null, violatedRules: [] })

export const WEAK = skipped("weak_core_match")
export const KOTLIN = skipped("uncovered_mandatory_prerequisite", "Professional Kotlin Android experience")
export const CLEARANCE = skipped("uncovered_mandatory_prerequisite", "Active security clearance")
export const NO_CORE = skipped("no_core_responsibilities")
export const INDUSTRY = excluded("industry")
export const RANKED = statusOnly("ranked")

/** The create request's acknowledgement (createApplicationAcknowledgementSchema). */
export const ack = (decision: Decision) => ({ confirmed: true as const, decision: { status: decision.status, skipReason: decision.skipReason, skipDetail: decision.skipDetail, violatedRules: [...decision.violatedRules] } })

/** Every Eligibility rule `met` except the violated ones, unless `rules` is given. */
function rulesFor(decision: Decision, extra: readonly StoredRule[] = []): StoredRule[] {
  const named = new Set(extra.map((r) => r.rule))
  const violated = decision.violatedRules.filter((rule) => !named.has(rule)).map((rule): StoredRule => ({ rule, result: "violated", quote: `QA quote for ${rule}` }))
  const base = named.has("location") || decision.violatedRules.includes("location") ? [] : [{ rule: "location", result: "met", quote: "Remote" }]
  return [...violated, ...extra, ...base]
}

export type PostingSpec = Readonly<{
  decision: Decision
  company?: string
  title?: string
  requisition?: string
  family?: string | null
  /** Older than 60 days, so EPIC-0006 hides it (older_than_60_days). */
  hidden?: boolean
  /** Extra stored Eligibility rules (e.g. unverified ones), added to the violated set. */
  rules?: readonly StoredRule[]
  /** No Eligibility result at all. */
  noEligibility?: boolean
  evaluationFailure?: string | null
  prefilterNotSoftware?: boolean
  applyHost?: string
}>

export type Posting = Readonly<{ id: string; url: string; requisition: string; company: string; title: string }>

/** A Greenhouse automatic posting held by `candidateId` with the given decision. Visible unless `hidden`. */
export async function insertDecidedPosting(db: Kysely<Database>, candidateId: string, at: Date, spec: PostingSpec): Promise<Posting> {
  const id = randomUUID()
  const company = spec.company ?? "Acme Payments"
  const title = spec.title ?? "Senior Frontend Engineer"
  const requisition = spec.requisition ? `${spec.requisition}-${id.slice(0, 4)}` : `R-${id.slice(0, 8)}`
  const host = spec.applyHost ?? "boards.greenhouse.io"
  const url = `https://${host}/${company.toLowerCase().replace(/\W+/g, "")}/jobs/${requisition}`
  await insertPostingFor(db, candidateId, {
    id,
    application_url: url,
    requisition_id: requisition,
    apply_url: url,
    application_system: "greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title,
    company,
    posting_text: "Remote, open to candidates in Nigeria.",
    status: spec.decision.status,
    skip_reason: spec.decision.skipReason,
    skip_detail: spec.decision.skipDetail,
    evaluation_failure: spec.evaluationFailure ?? (spec.decision.status === "evaluation_failed" ? "provider_error" : null),
    role_family: spec.prefilterNotSoftware ? null : spec.family === undefined ? "senior_frontend" : spec.family,
    prefilter_skip: spec.prefilterNotSoftware ? "not_software_role" : null,
    discovered_at: at,
    evaluated_at: ["checking", "waiting_to_be_checked", "not_checked"].includes(spec.decision.status) ? null : at,
    posted_at: spec.hidden ? new Date("2026-07-01T09:00:00Z") : at,
  })
  if (!spec.noEligibility) await writeEligibility(db, candidateId, id, at, rulesFor(spec.decision, spec.rules))
  return { id, url, requisition, company, title }
}

/**
 * EPIC-0002 B1 unit 6 (merge with main 0422b14): answer assignment reads the role's location from this
 * row, so a relocation to the United States keeps slice 5's sponsorship "Yes" for the Operator, as
 * `insertEligibilityFor` does. Apply anyway reads only the rule results.
 */
async function writeEligibility(db: Kysely<Database>, candidateId: string, postingId: string, at: Date, rules: readonly StoredRule[]): Promise<void> {
  await db.deleteFrom("eligibility_result").where("candidate_id", "=", candidateId).where("job_posting_id", "=", postingId).execute()
  await db
    .insertInto("eligibility_result")
    .values({ candidate_id: candidateId, job_posting_id: postingId, arrangement: "relocation", relocation_country: "United States", employment_type: "direct", rules: JSON.stringify(rules), eligible: !rules.some((r) => r.result === "violated"), normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: at })
    .execute()
}

/** Re-decides a posting for `candidateId` (status, reason, detail and the stored Eligibility rules), as a save or re-evaluation leaves it. */
export async function redecide(db: Kysely<Database>, candidateId: string, postingId: string, at: Date, decision: Decision, options: Readonly<{ evaluationFailure?: string | null; rules?: readonly StoredRule[] }> = {}): Promise<void> {
  await db
    .updateTable("candidate_posting")
    .set({
      status: decision.status,
      skip_reason: decision.skipReason,
      skip_detail: decision.skipDetail,
      evaluation_failure: options.evaluationFailure ?? (decision.status === "evaluation_failed" ? "provider_error" : null),
    })
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", postingId)
    .execute()
  await writeEligibility(db, candidateId, postingId, at, rulesFor(decision, options.rules))
}

/** EPIC-0006: posted before the 60-day cutoff, so hidden for every Candidate. */
export async function hidePosting(db: Kysely<Database>, postingId: string): Promise<void> {
  await db.updateTable("job_posting").set({ posted_at: new Date("2026-07-01T09:00:00Z") }).where("id", "=", postingId).execute()
}

/** Valid empty tailored document content per kind (the api parses it on read). */
export const EMPTY_TAILORED_CONTENT = {
  resume: { kind: "resume", summary: [], experience: [], skills: [], education: [] },
  cover_letter: { kind: "cover_letter", greeting: "Dear team,", opening: null, paragraphs: [], closingLine: null, closing: "Regards," },
} as const

export type ApplicationSeed = Readonly<{
  submissionState?: string | null
  submissionKind?: "automatic" | "sample" | null
  state?: "prepared" | "documents_ready"
  queuedForLocalDay?: string | null
  attemptNumber?: number
  documents?: boolean
  /** Number of stored form controls (application_form_read). */
  formControls?: number
  extra?: Record<string, unknown>
  createdAt?: Date
}>

/** An Application on `posting`, inserted directly (documents ready unless told otherwise). */
export async function insertApplication(db: Kysely<Database>, candidateId: string, posting: Posting, at: Date, seed: ApplicationSeed = {}): Promise<string> {
  const id = randomUUID()
  const created = seed.createdAt ?? at
  const submission = seed.submissionState ?? null
  await db
    .insertInto("application")
    .values({
      candidate_id: candidateId,
      id,
      job_posting_id: posting.id,
      application_url: posting.url,
      requisition_id: posting.requisition,
      company: posting.company,
      role_title: posting.title,
      state: seed.state ?? "documents_ready",
      career_profile_version: 1,
      blocked_document: null,
      blocked_claim: null,
      failure: null,
      created_at: created,
      updated_at: created,
      submission_state: submission as never,
      submission_kind: (seed.submissionKind === undefined ? (submission ? "automatic" : null) : seed.submissionKind) as never,
      queued_for_local_day: seed.queuedForLocalDay ?? null,
      attempt_number: seed.attemptNumber ?? 0,
      ...(seed.extra ?? {}),
    } as never)
    .execute()
  if (seed.documents !== false) {
    for (const kind of ["resume", "cover_letter"] as const) {
      await db
        .insertInto("tailored_document")
        .values({ candidate_id: candidateId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: JSON.stringify(EMPTY_TAILORED_CONTENT[kind]), pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: created })
        .execute()
    }
  }
  if (seed.formControls) {
    const controls = Array.from({ length: seed.formControls }, (_, i) => ({ ref: `q${i}`, label: `Question ${i}`, kind: "text" as const, required: true }))
    await db.insertInto("application_form_read").values({ candidate_id: candidateId, application_id: id, host: "boards.greenhouse.io", controls: JSON.stringify(controls), read_at: created }).execute()
  }
  return id
}

/** Records a v1.24.0 override (stored decision) on an Application. */
export async function setOverride(db: Kysely<Database>, applicationId: string, at: Date, decision: Decision): Promise<void> {
  await sql`update application set override_created_at = ${at}, override_status = ${decision.status}, override_skip_reason = ${decision.skipReason},
      override_skip_detail = ${decision.skipDetail}, override_violated_rules = ${[...decision.violatedRules]}::text[], candidate_override_at = null
    where id = ${applicationId}`.execute(db)
}

/** A legacy override after migration 0026 (time moved to override_created_at, no stored decision). */
export async function setLegacyOverride(db: Kysely<Database>, applicationId: string, at: Date): Promise<void> {
  await sql`update application set override_created_at = ${at}, override_status = null, override_skip_reason = null, override_skip_detail = null,
      override_violated_rules = null, candidate_override_at = null where id = ${applicationId}`.execute(db)
}

/** A legacy override written by a v1.23.x image during a rolling deploy (only candidate_override_at). */
export async function setOldImageOverride(db: Kysely<Database>, applicationId: string, at: Date): Promise<void> {
  await sql`update application set candidate_override_at = ${at} where id = ${applicationId}`.execute(db)
}

export type OverrideColumns = Readonly<{
  override_created_at: Date | null
  override_status: string | null
  override_skip_reason: string | null
  override_skip_detail: string | null
  override_violated_rules: string[] | null
  candidate_override_at: Date | null
}>

export async function overrideColumns(db: Kysely<Database>, applicationId: string): Promise<OverrideColumns> {
  const { rows } = await sql<OverrideColumns>`select override_created_at, override_status, override_skip_reason, override_skip_detail, override_violated_rules, candidate_override_at
    from application where id = ${applicationId}`.execute(db)
  const row = rows[0]
  if (!row) throw new Error(`no application ${applicationId}`)
  return row
}

/** Every column of the Application row, for "unchanged" comparisons (includes the v1.24.0 columns). */
export async function applicationSnapshot(db: Kysely<Database>, applicationId: string): Promise<string> {
  const { rows } = await sql`select * from application where id = ${applicationId}`.execute(db)
  return JSON.stringify(rows)
}

export async function submissionEvents(db: Kysely<Database>, applicationId: string): Promise<{ kind: string; detail: string | null }[]> {
  return db.selectFrom("submission_event").select(["kind", "detail"]).where("application_id", "=", applicationId).orderBy("created_at").execute()
}

export async function applicationsFor(db: Kysely<Database>, postingId: string) {
  return db.selectFrom("application").select(["id"]).where("job_posting_id", "=", postingId).execute()
}

export async function tailoredCount(db: Kysely<Database>, applicationId: string): Promise<number> {
  const row = await db.selectFrom("tailored_document").select(sql<number>`count(*)::int`.as("n")).where("application_id", "=", applicationId).executeTakeFirstOrThrow()
  return row.n
}

export async function formControlCount(db: Kysely<Database>, applicationId: string): Promise<number> {
  const row = await db.selectFrom("application_form_read").select("controls").where("application_id", "=", applicationId).executeTakeFirst()
  return row ? row.controls.length : 0
}
