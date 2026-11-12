import { roleFamilySchema } from "@eve/contracts"
import { type Insertable, type Kysely, sql } from "kysely"

import type { CandidatePostingTable, Database, JobPostingStatus, JobPostingTable } from "../../src/db/schema.js"
import { classifyTitle } from "../../src/discovery/rules/ranking.js"
import { foldForKeywords } from "../../src/discovery/rules/rule-result.js"
import { seniorityMarker } from "../../src/discovery/rules/seniority.js"
import { type VisibilityContext, buildVisibilityContext, hiddenReason } from "../../src/discovery/visibility.js"

export type CandidatePostingState = Readonly<{
  status: JobPostingStatus
  origin?: CandidatePostingTable["origin"]
  skipReason?: string | null
  skipDetail?: string | null
  evaluationFailure?: string | null
  discoveredAt?: Date
  evaluatedAt?: Date | null
}>

/**
 * EPIC-0002 A1 item 6: a Candidate's state for a shared `job_posting`
 * (`candidate_posting`). Fixtures insert the posting's facts, then call this
 * for every Candidate that holds it. Origin and discovery time default to the
 * posting's own, so a single-Candidate fixture reads as it did before the split.
 * Runs as the bootstrap superuser (the test `db`), which RLS does not bind.
 */
export async function insertCandidatePosting(db: Kysely<Database>, candidateId: string, jobPostingId: string, state: CandidatePostingState): Promise<void> {
  const posting = await db.selectFrom("job_posting").select(["origin", "discovered_at"]).where("id", "=", jobPostingId).executeTakeFirstOrThrow()
  await db
    .insertInto("candidate_posting")
    .values({
      candidate_id: candidateId,
      job_posting_id: jobPostingId,
      origin: state.origin ?? posting.origin,
      status: state.status,
      skip_reason: state.skipReason ?? null,
      skip_detail: state.skipDetail ?? null,
      evaluation_failure: state.evaluationFailure ?? null,
      discovered_at: state.discoveredAt ?? posting.discovered_at,
      evaluated_at: state.evaluatedAt === undefined ? (state.status === "checking" || state.status === "waiting_to_be_checked" ? null : posting.discovered_at) : state.evaluatedAt,
    })
    .execute()
}

/** Sets a Candidate's state for a posting (the test-side replacement for `update job_posting set status = …`). */
export async function setCandidatePosting(db: Kysely<Database>, candidateId: string, jobPostingId: string, patch: Partial<Record<"status" | "skip_reason" | "skip_detail" | "evaluation_failure", string | null>> & { evaluated_at?: Date | null }): Promise<void> {
  await db
    .updateTable("candidate_posting")
    .set(patch as never)
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", jobPostingId)
    .execute()
}

/** The per-Candidate columns a pre-split fixture wrote on `job_posting`. */
type LegacyState = Readonly<{
  status: JobPostingStatus
  skip_reason?: string | null
  skip_detail?: string | null
  evaluation_failure?: string | null
  evaluated_at?: Date | null
}>

/**
 * Inserts a posting written in the pre-split shape: the shared facts go to
 * `job_posting`, the status, skip and evaluation columns to `candidateId`'s
 * `candidate_posting` row (origin and discovery time copied). Lets the slice 3
 * to 8 fixtures keep their one-object rows (codemod in the item 6 commit).
 */
export async function insertPostingFor(
  db: Kysely<Database>,
  candidateId: string,
  row: Insertable<JobPostingTable> & LegacyState,
  options: Readonly<{ keepFamily?: boolean }> = {}
): Promise<void> {
  const { status, skip_reason, skip_detail, evaluation_failure, evaluated_at, ...facts } = row
  // A pre-split fixture that writes a not_software_role skip as status (no prefilter_skip) keeps no family.
  const preFiltered = skip_reason === "not_software_role" && !("role_family" in facts && facts.role_family !== null)
  const keepFamily = preFiltered || options.keepFamily === true
  await db.insertInto("job_posting").values(visibleByDefault(preFiltered ? { ...facts, role_family: null, prefilter_skip: facts.prefilter_skip ?? null } : facts, keepFamily)).execute()
  await db
    .insertInto("candidate_posting")
    .values({
      candidate_id: candidateId,
      job_posting_id: facts.id,
      origin: facts.origin,
      status,
      skip_reason: skip_reason ?? null,
      skip_detail: skip_detail ?? null,
      evaluation_failure: evaluation_failure ?? null,
      discovered_at: facts.discovered_at,
      evaluated_at: evaluated_at ?? null,
    })
    .execute()
}

/**
 * A Candidate's postings as one row source named `job_posting`, with their own
 * state columns: lets a test read `status`, `skip_reason` and the shared facts
 * together, as before the split. The old `job_posting` state columns still
 * exist (unwritten) in the database, so a plain join would be ambiguous.
 */
export function postingsOf(db: Kysely<Database>, candidateId: string) {
  return db.selectFrom((eb) =>
    eb
      .selectFrom("job_posting as p")
      .innerJoin("candidate_posting as cp", "cp.job_posting_id", "p.id")
      .where("cp.candidate_id", "=", candidateId)
      .select([
        "p.id",
        "p.application_url",
        "p.requisition_id",
        "p.title",
        "p.company",
        "p.role_family",
        "p.technologies",
        "p.prefilter_skip",
        "p.title_folded",
        "p.seniority_marker",
        "p.posted_at",
        "cp.origin",
        "cp.status",
        "cp.skip_reason",
        "cp.skip_detail",
        "cp.evaluation_failure",
        "cp.discovered_at",
        "cp.evaluated_at",
      ])
      .as("job_posting")
  )
}

/** `update candidate_posting` for one Candidate's rows of the postings matching `where` (a shared-fact column). */
export async function setStateWhere(
  db: Kysely<Database>,
  candidateId: string,
  where: Readonly<{ column: "id" | "title" | "company"; value: string }>,
  patch: Partial<Record<"status" | "skip_reason" | "skip_detail" | "evaluation_failure", string | null>> & { evaluated_at?: Date | null }
): Promise<void> {
  await db
    .updateTable("candidate_posting")
    .set(patch as never)
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "in", db.selectFrom("job_posting").select("id").where(where.column, "=", where.value))
    .execute()
}

/**
 * For bulk fixtures written with raw SQL in the pre-split shape: gives
 * `candidateId` a `candidate_posting` row, copied from the old `job_posting`
 * state columns, for every posting they do not hold yet. Those columns are
 * still in the database (unwritten by the app) until a later migration drops them.
 */
export async function holdAllPostings(db: Kysely<Database>, candidateId: string): Promise<void> {
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
    select ${candidateId}::uuid, p.id, p.origin, p.status, p.skip_reason, p.skip_detail, p.evaluation_failure, p.discovered_at, p.evaluated_at
    from job_posting p where not exists (select 1 from candidate_posting cp where cp.candidate_id = ${candidateId}::uuid and cp.job_posting_id = p.id)`.execute(db)
}

/**
 * EPIC-0006: postings that tests before this epic insert are visible unless the
 * test says otherwise, as the store path makes them in production. A posting
 * with no posted date gets its `discovered_at` (a fresh posting, dated); a
 * titled posting without `title_folded` gets the fold, and its seniority marker
 * from the title. A titled posting past the pre-filter with a null family (the
 * pre-epic "not evaluated yet" shape, which AC-1.8 no longer stores) gets
 * `classifyTitle(title)`; a named family is kept. Pass `posted_at: null` to
 * test an undated posting; insert with `db` directly for a titled family-null row.
 */
export function visibleByDefault(facts: Insertable<JobPostingTable>, keepFamily = false): Insertable<JobPostingTable> {
  const title = facts.title ?? null
  const titled = title !== null && title.trim() !== ""
  const postedAt = "posted_at" in facts ? (facts.posted_at ?? null) : (facts.discovered_at as Date)
  const family = keepFamily ? (facts.role_family ?? null) : (facts.role_family ?? (titled && (facts.prefilter_skip ?? null) === null ? classifyTitle(title) : null))
  return {
    ...facts,
    role_family: family,
    title_folded: "title_folded" in facts ? facts.title_folded : titled ? foldForKeywords(title) : null,
    seniority_marker: "seniority_marker" in facts ? facts.seniority_marker : seniorityMarker(title),
    posted_at: postedAt,
    posted_date_kind: "posted_date_kind" in facts ? facts.posted_date_kind : postedAt === null ? null : "published",
  }
}

/**
 * EPIC-0006: slice 8 ranking, paging and reader-order specs are about order,
 * not visibility, and seed every family (and null). They target all 13
 * families with `all_levels`, so only the date rule could hide a row, and the
 * fixture helper dates every row.
 */
export async function targetEveryFamily(db: Kysely<Database>, candidateId: string): Promise<void> {
  await db
    .updateTable("job_criteria")
    .set({ target_role_families: [...roleFamilySchema.options], seniority_floor: "all_levels" })
    .where("candidate_id", "=", candidateId)
    .execute()
}

/**
 * EPIC-0006: the TS visibility rule as a query filter over `postingsOf`, for
 * the slice 8 reference orders (every row a list returns is visible). Under
 * `targetEveryFamily` only a titled family-null or pre-filtered row, or an
 * undated or old one, is hidden.
 */
export function visibleFilter(ctx: VisibilityContext) {
  return (row: Readonly<{ title_folded: string | null; prefilter_skip: string | null; role_family: string | null; seniority_marker: string | null; posted_at: Date | null; origin?: string }>) =>
    hiddenReason({ titled: row.title_folded !== null, prefilterSkip: row.prefilter_skip, roleFamily: row.role_family, seniorityMarker: row.seniority_marker, postedAt: row.posted_at, pastedDescription: row.origin === "pasted_description" }, ctx) === null
}

export function everyFamilyContext(now: Date): VisibilityContext {
  return buildVisibilityContext({ targetRoleFamilies: [...roleFamilySchema.options], seniorityFloor: "all_levels" }, now)
}

/**
 * EPIC-0002 B1 unit 6: the Eligibility result evaluation stores for a ranked
 * posting, which answer assignment reads for the role's location (sponsorship
 * answer, PRD r4 E5). Submission fixtures that skip evaluation add it here: a
 * relocation to the United States reproduces slice 5's fixed sponsorship "Yes"
 * for the Operator (architecture r4: "a role located outside Nigeria").
 */
export async function insertEligibilityFor(db: Kysely<Database>, candidateId: string, postingId: string, destination = "United States"): Promise<void> {
  await db
    .insertInto("eligibility_result")
    .values({
      candidate_id: candidateId, job_posting_id: postingId, arrangement: "relocation", relocation_country: destination, employment_type: null,
      rules: JSON.stringify([{ rule: "location", result: "met", quote: `Relocation to ${destination}` }]), eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date(),
    })
    .onConflict((oc) => oc.columns(["candidate_id", "job_posting_id"]).doNothing())
    .execute()
}
