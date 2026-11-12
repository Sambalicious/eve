import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { type JobPostingsResponse, jobPostingsResponseSchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"

import { SESSION_COOKIE } from "../../src/auth/cookies.js"
import type { Database } from "../../src/db/schema.js"
import { foldForKeywords } from "../../src/discovery/rules/rule-result.js"
import { Browser } from "./browser.js"
import type { FakeGoogle } from "./fake-google.js"
import { SignedInCandidate } from "./signed-in.js"

/**
 * EPIC-0006 QA fixtures (test authoring, step [5e]). Written from
 * api-contract.r1.md v1.18.0 and gherkin r4, not from the implementation.
 *
 * Shared posting facts go to `job_posting`, including the three columns
 * migration 0020-role-relevance adds (`posted_at`, `posted_date_kind`,
 * `seniority_marker`). Per-Candidate state goes to `candidate_posting`, whose
 * status check gains `not_checked`. Job criteria gain `target_role_families`
 * and `seniority_floor`. Raw SQL keeps these helpers compiling before
 * `schema.ts` knows the new columns.
 */

/** The nine defaults, catalog order (AC-1.6). */
export const DEFAULT_TARGETS = [
  "senior_frontend",
  "technical_lead",
  "fullstack",
  "product_engineering",
  "software_engineering",
  "backend",
  "mobile",
  "platform_engineering",
  "people_management",
] as const

/** All thirteen keys, catalog order (AC-1.2). */
export const ALL_FAMILIES = [
  "senior_frontend",
  "technical_lead",
  "fullstack",
  "product_engineering",
  "software_engineering",
  "backend",
  "mobile",
  "platform_engineering",
  "devops_platform",
  "people_management",
  "data_ml",
  "solutions_customer",
  "other",
] as const

export type Family = (typeof ALL_FAMILIES)[number]
export type Status = "checking" | "waiting_to_be_checked" | "not_checked" | "ranked" | "excluded" | "skipped" | "evaluation_failed"

/** Today in the Gherkin: 2026-10-24 WAT, 09:00 local. */
export const TODAY = "2026-10-24T09:00:00+01:00"

/** 00:00 WAT on `date` (Africa/Lagos is UTC+1, no DST), or `time` on that WAT date. */
export function wat(date: string, time = "00:00"): Date {
  return new Date(`${date}T${time}:00+01:00`)
}

/** A dated posting within 60 days: 2026-10-20 WAT, age 4 at TODAY. */
export const DATED = wat("2026-10-20", "12:00")

export type PostingFixture = Readonly<{
  id?: string
  title?: string | null
  company?: string
  family?: Family | null
  prefilterSkip?: "not_software_role" | null
  /** null = undated. Default DATED. */
  postedAt?: Date | null
  kind?: "published" | "updated"
  /** Stored seniority marker. Default: null when untitled, else "mid_plus" (titles here carry "Senior" unless a test says otherwise). */
  marker?: "entry" | "mid_plus" | "none" | null
  applyMode?: "automatic" | "manual"
  origin?: "employer_board" | "remote_board" | "pasted_link"
  discoveredAt?: Date
  requisitionId?: string
  postingText?: string
}>

/** Inserts one shared posting. Returns its id. */
export async function insertPosting(db: Kysely<Database>, f: PostingFixture = {}): Promise<string> {
  const id = f.id ?? randomUUID()
  const title = f.title === undefined ? "Senior Frontend Engineer" : f.title
  const titled = title !== null && title.trim() !== ""
  const url = `https://boards.greenhouse.io/qa6/jobs/${id}`
  const postedAt = f.postedAt === undefined ? DATED : f.postedAt
  const marker = f.marker === undefined ? (titled ? "mid_plus" : null) : f.marker
  const family = f.family === undefined ? (titled ? "senior_frontend" : "other") : f.family
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin,
      employer_board_id, remote_board_key, attribution_name, attribution_url, title, title_folded, company, posting_text,
      role_family, prefilter_skip, discovered_at, posted_at, posted_date_kind, seniority_marker)
    values (${id}, ${url}, ${f.requisitionId ?? id.slice(0, 13)}, ${url}, 'greenhouse', ${f.applyMode ?? "automatic"}, ${f.origin ?? "employer_board"},
      null, null, null, null, ${title}, ${titled ? foldForKeywords(title) : null}, ${f.company ?? "QA6"}, ${f.postingText ?? "Remote, open to candidates in Nigeria. Build React features."},
      ${family}, ${f.prefilterSkip ?? null}, ${f.discoveredAt ?? new Date("2026-10-20T08:00:00Z")},
      ${postedAt}, ${postedAt === null ? null : (f.kind ?? "published")}, ${marker})`.execute(db)
  return id
}

export type HoldState = Readonly<{
  status: Status
  skipReason?: string | null
  skipDetail?: string | null
  evaluationFailure?: string | null
  /** Strong Match evidence for ranked rows (rank order uses coverage). Default: inserted for ranked, 8 of 10. */
  covered?: number | null
  /**
   * EPIC-0006 r4 (migration 0032): the row's last move into `checking`. Default: the column default, the
   * database's wall clock, which is after every TestClock date in these files, so a `checking` row is never stuck
   * unless a test says so. Pass the test clock's `now` for an explicitly recent row.
   */
  checkingSince?: Date
}>

/** Gives `candidateId` their own row for a shared posting. */
export async function hold(db: Kysely<Database>, candidateId: string, postingId: string, state: HoldState): Promise<void> {
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
    select ${candidateId}::uuid, p.id, p.origin, ${state.status}, ${state.skipReason ?? null}, ${state.skipDetail ?? null}, ${state.evaluationFailure ?? null}, p.discovered_at,
      ${["checking", "waiting_to_be_checked", "not_checked"].includes(state.status) ? null : new Date("2026-10-20T09:00:00Z")}
    from job_posting p where p.id = ${postingId}`.execute(db)
  if (state.checkingSince !== undefined) await setCheckingSince(db, candidateId, postingId, state.checkingSince)
  const covered = state.covered === undefined ? (state.status === "ranked" ? 8 : null) : state.covered
  if (covered !== null) {
    await db
      .insertInto("match_evidence")
      .values({ candidate_id: candidateId, job_posting_id: postingId, career_profile_version: 1, verdict: covered * 10 >= 70 ? "strong" : "weak", weak_reason: covered * 10 >= 70 ? null : "coverage_below_threshold", covered_count: covered, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: new Date("2026-10-20T09:00:00Z"), criteria_version: 1 })
      .execute()
  }
}

/** EPIC-0006 r4 (AC-7.12): when `candidateId`'s row for the posting last moved into `checking`. */
export async function setCheckingSince(db: Kysely<Database>, candidateId: string, postingId: string, at: Date): Promise<void> {
  await sql`update candidate_posting set checking_since = ${at} where candidate_id = ${candidateId}::uuid and job_posting_id = ${postingId}::uuid`.execute(db)
}

export async function checkingSinceOf(db: Kysely<Database>, candidateId: string, postingId: string): Promise<Date> {
  const { rows } = await sql<{ at: Date }>`select checking_since as at from candidate_posting where candidate_id = ${candidateId}::uuid and job_posting_id = ${postingId}::uuid`.execute(db)
  return rows[0]!.at
}

/** A posting held by one Candidate. Returns its id. */
export async function seed(db: Kysely<Database>, candidateId: string, posting: PostingFixture, state: HoldState): Promise<string> {
  const id = await insertPosting(db, posting)
  await hold(db, candidateId, id, state)
  return id
}

export async function setCriteria(
  db: Kysely<Database>,
  candidateId: string,
  c: Readonly<{ targets?: readonly string[]; floor?: "all_levels" | "hide_entry_level"; min?: number; version?: number }>
): Promise<void> {
  if (c.targets) await sql`update job_criteria set target_role_families = ${[...c.targets]}::text[] where candidate_id = ${candidateId}`.execute(db)
  if (c.floor) await sql`update job_criteria set seniority_floor = ${c.floor} where candidate_id = ${candidateId}`.execute(db)
  if (c.min !== undefined) await sql`update job_criteria set min_core_match_percent = ${c.min} where candidate_id = ${candidateId}`.execute(db)
  if (c.version !== undefined) await sql`update job_criteria set version = ${c.version} where candidate_id = ${candidateId}`.execute(db)
}

export async function readCriteria(db: Kysely<Database>, candidateId: string) {
  const { rows } = await sql<{ targets: string[]; floor: string; min: number; version: number }>`
    select target_role_families as targets, seniority_floor as floor, min_core_match_percent as min, version
    from job_criteria where candidate_id = ${candidateId}`.execute(db)
  return rows[0]!
}

/** Back to the EPIC-0006 defaults for every Candidate, criteria version 1. */
export async function resetCriteria(db: Kysely<Database>): Promise<void> {
  await sql`update job_criteria set target_role_families = default, seniority_floor = default,
    min_core_match_percent = 70, frameworks = '{}', technologies = '{}', version = 1`.execute(db)
}

/** Deletes every posting, Application, AI call, spend row and queued evaluation; leaves Candidates and criteria. */
export async function clearPostings(db: Kysely<Database>): Promise<void> {
  await sql`delete from pgboss.job where name = 'evaluate.posting'`.execute(db)
  await db.deleteFrom("application").execute()
  await db.deleteFrom("match_evidence").execute()
  await db.deleteFrom("eligibility_result").execute()
  await db.deleteFrom("candidate_posting").execute()
  await db.deleteFrom("ai_call").execute()
  await db.deleteFrom("job_posting").execute()
}

export type QueuedEvaluation = { postingId: string; candidateId: string | null }

/** Every `evaluate.posting` job in pg-boss (any state), with its payload. */
export async function queuedEvaluations(db: Kysely<Database>): Promise<QueuedEvaluation[]> {
  const { rows } = await sql<{ data: { postingId: string; candidateId?: string } }>`select data from pgboss.job where name = 'evaluate.posting' order by created_on`.execute(db)
  return rows.map((row) => ({ postingId: row.data.postingId, candidateId: row.data.candidateId ?? null }))
}

export async function statusOf(db: Kysely<Database>, candidateId: string, postingId: string) {
  const row = await db
    .selectFrom("candidate_posting")
    .select(["status", "evaluation_failure", "skip_reason"])
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", postingId)
    .executeTakeFirstOrThrow()
  return row as { status: string; evaluation_failure: string | null; skip_reason: string | null }
}

/** Shared facts of a posting, including the 0020 columns. */
export async function factsOf(db: Kysely<Database>, postingId: string) {
  const { rows } = await sql<{ role_family: string | null; posted_at: Date | null; posted_date_kind: string | null; seniority_marker: string | null; title: string | null }>`
    select role_family, posted_at, posted_date_kind, seniority_marker, title from job_posting where id = ${postingId}`.execute(db)
  return rows[0]!
}

/** Every column of a posting's shared row and its Candidate rows, for "nothing changed" checks. */
export async function snapshotPosting(db: Kysely<Database>, postingId: string) {
  const shared = await sql`select * from job_posting where id = ${postingId}`.execute(db)
  const rows = await sql`select * from candidate_posting where job_posting_id = ${postingId} order by candidate_id`.execute(db)
  const evidence = await sql`select * from match_evidence where job_posting_id = ${postingId} order by candidate_id`.execute(db)
  return JSON.stringify([shared.rows, rows.rows, evidence.rows])
}

/** A second Candidate (not the Operator), signed in over HTTP, with a defaulted Job criteria row. */
export async function signInSecondCandidate(
  app: INestApplication,
  google: FakeGoogle,
  db: Kysely<Database>,
  options: Readonly<{ sub?: string; email?: string }> = {}
): Promise<{ candidate: SignedInCandidate; id: string }> {
  const sub = options.sub ?? "200000000000000000606"
  const email = options.email ?? "kofi.e6@example.test"
  const existing = await db.selectFrom("candidate").select("id").where("email", "=", email).executeTakeFirst()
  const id =
    existing?.id ??
    (await db.insertInto("candidate").values({ email, google_sub: sub, role: "candidate", onboarded_at: new Date() } as never).returning("id").executeTakeFirstOrThrow()).id
  await db.insertInto("job_criteria").values({ candidate_id: id, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub, email, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  return { candidate: new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, email), id }
}

/** `GET /v1/job-postings?{query}`, parsed with the v1.18.0 contract schema. */
export async function list(who: SignedInCandidate, query = "tab=all&limit=100"): Promise<JobPostingsResponse> {
  const response = await who.get(`/v1/job-postings?${query}`).expect(200)
  return jobPostingsResponseSchema.parse(response.body)
}

export const ids = (page: JobPostingsResponse) => page.postings.map((p) => p.id)

export function zeroCounts() {
  return { offTarget: 0, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, total: 0 }
}

export function counts(c: Partial<{ offTarget: number; belowSeniorityFloor: number; undated: number; olderThan60Days: number }>) {
  const full = { offTarget: 0, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, ...c }
  return { ...full, total: full.offTarget + full.belowSeniorityFloor + full.undated + full.olderThan60Days }
}

/** The exact v1.18.0 (r1) `posting_hidden` message, copy-deck row api.error.posting_hidden. */
export const POSTING_HIDDEN_MESSAGE = "This Job Posting is hidden from your board. Eve won't start a new Application or sample from it. Reload the page to see why."
