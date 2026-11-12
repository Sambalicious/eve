import { type Kysely, sql } from "kysely"

import type { Database } from "../../src/db/schema.js"
import { preFilter } from "../../src/discovery/pre-filters.js"
import { classifyTitle } from "../../src/discovery/rules/ranking.js"
import { OWNER_EVALUATION, ownerVerdicts } from "../../src/discovery/rules/__golden__/owner-regression.js"
import { RULE_NAMES, foldForKeywords } from "../../src/discovery/rules/rule-result.js"

/**
 * EPIC-0002 A0 item 4 (architecture r4 "Slice A0: golden capture", item 7):
 * the seed of the Job Postings page snapshot. It stores every
 * `owner-postings.ts` fixture with the verdict `owner-regression.ts` decides
 * for it (status, skip reason and detail, Eligibility rules, Match counts,
 * role family), so the page reads exactly what the evaluator would have
 * written, with no AI call. Five extra rows cover the states a fixture never
 * reaches (waiting, checking, evaluation failed, a pre-filter skip and an
 * unsupported application system), so `waitingToBeCheckedCount` and the
 * Skipped and All tabs see them.
 *
 * Raw SQL on purpose: the same seed runs on the single-Candidate schema of
 * `main` (state on `job_posting`) and on the A1 schema (state on
 * `candidate_posting`, `candidate_id` on the evaluation rows), so the
 * snapshot can be captured on one and proved equal on the other.
 *
 * Regenerate the snapshot with
 * `UPDATE_GOLDEN=1 pnpm --filter @eve/api exec vitest run --project integration test/__golden__/job-postings-page`.
 */

/** Fixture key → the stored posting ID (a fixed UUID, so the page order ties on ID are stable). */
export function goldenUuid(key: string): string {
  const digits = key.replace(/\D/g, "").padStart(12, "0")
  return `00000000-0000-4000-8000-${digits}`
}

type ExtraRow = Readonly<{
  key: string
  title: string
  status: "waiting_to_be_checked" | "checking" | "evaluation_failed" | "skipped"
  skipReason: string | null
  skipDetail: string | null
  failure: string | null
  day: number
}>

const EXTRA_ROWS: readonly ExtraRow[] = [
  { key: "golden-91", title: "Senior React Engineer", status: "waiting_to_be_checked", skipReason: null, skipDetail: null, failure: null, day: 20 },
  { key: "golden-92", title: "Backend Engineer, Payments", status: "checking", skipReason: null, skipDetail: null, failure: null, day: 21 },
  { key: "golden-93", title: "Frontend Engineer", status: "evaluation_failed", skipReason: null, skipDetail: null, failure: "provider_error", day: 22 },
  { key: "golden-94", title: "Sales Engineer", status: "skipped", skipReason: "not_software_role", skipDetail: null, failure: null, day: 23 },
  { key: "golden-95", title: "Mobile Engineer (Workday)", status: "skipped", skipReason: "unsupported_application_system", skipDetail: "Workday", failure: null, day: 24 },
]

const EVALUATED_AT = new Date(OWNER_EVALUATION.evaluatedOn)

/**
 * Stores the fixtures for the single Candidate. `holder` is the Candidate's ID
 * on a schema with `candidate_posting`, or null on the pre-A1 schema. Runs as
 * the bootstrap superuser (the test `db`).
 */
export async function seedOwnerPostings(db: Kysely<Database>, holder: string | null): Promise<void> {
  const criteriaVersion = await sql<{ version: number }>`select version from job_criteria limit 1`.execute(db)
  const version = criteriaVersion.rows[0]?.version ?? 0
  for (const { posting, verdict } of ownerVerdicts()) {
    const id = goldenUuid(posting.id)
    // As the pipeline does: a pre-filter skip is stored skipped at first store and never evaluated.
    const skippedByTitle = !preFilter({ title: posting.title }).pass
    await insertPosting(db, holder, {
      id,
      key: posting.id,
      title: posting.title,
      postingText: posting.postingText,
      structured: posting.structured,
      origin: posting.fromEmployerBoard ? "employer_board" : "remote_board",
      roleFamily: skippedByTitle ? null : verdict.roleFamily,
      discoveredAt: new Date(posting.discoveredAt),
      status: skippedByTitle ? "skipped" : verdict.status,
      skipReason: skippedByTitle ? "not_software_role" : verdict.skipReason,
      skipDetail: skippedByTitle ? null : verdict.skipDetail,
      failure: null,
      evaluatedAt: skippedByTitle ? null : EVALUATED_AT,
    })
    if (skippedByTitle) continue
    const rules = verdict.eligibility.rules
    const owner = holder === null ? sql`` : sql`candidate_id, `
    const ownerValue = holder === null ? sql`` : sql`${holder}::uuid, `
    await sql`insert into eligibility_result (${owner}job_posting_id, arrangement, relocation_country, employment_type, rules, eligible, normalized_monthly_max_usd, fx_rate_date, evaluated_at)
      values (${ownerValue}${id}::uuid, ${verdict.eligibility.arrangement}, ${verdict.eligibility.relocationCountry}, ${verdict.eligibility.employmentType},
        ${JSON.stringify(RULE_NAMES.map((rule) => ({ rule, result: rules[rule].result, quote: rules[rule].quote })))}::jsonb, ${verdict.decision.eligible},
        ${rules.pay.normalizedMonthlyMaxUsd}, ${rules.pay.fxRateDate}, ${EVALUATED_AT})`.execute(db)
    await sql`insert into match_evidence (${owner}job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
      values (${ownerValue}${id}::uuid, 1, ${verdict.matchVerdict.verdict}, ${verdict.matchVerdict.weakReason}, ${verdict.match.coveredCount}, ${verdict.match.totalCount},
        ${OWNER_EVALUATION.matchThreshold.toFixed(3)}, '[]'::jsonb, ${EVALUATED_AT}, ${version})`.execute(db)
  }
  for (const row of EXTRA_ROWS) {
    await insertPosting(db, holder, {
      id: goldenUuid(row.key),
      key: row.key,
      title: row.title,
      postingText: "Remote, open to Nigeria.",
      structured: {},
      origin: "employer_board",
      roleFamily: null,
      discoveredAt: new Date(Date.UTC(2026, 9, row.day, 9, 30, 0)),
      status: row.status,
      skipReason: row.skipReason,
      skipDetail: row.skipDetail,
      failure: row.failure,
      evaluatedAt: row.status === "waiting_to_be_checked" || row.status === "checking" ? null : EVALUATED_AT,
    })
  }
}

type PostingInput = Readonly<{
  id: string
  key: string
  title: string
  postingText: string
  structured: unknown
  origin: "employer_board" | "remote_board"
  roleFamily: string | null
  discoveredAt: Date
  status: string
  skipReason: string | null
  skipDetail: string | null
  failure: string | null
  evaluatedAt: Date | null
}>

async function insertPosting(db: Kysely<Database>, holder: string | null, row: PostingInput): Promise<void> {
  const number = row.key.replace(/\D/g, "")
  const url = `https://boards.greenhouse.io/golden/jobs/${number}`
  const facts = sql`${row.id}::uuid, ${url}, ${number}, ${url}, 'Greenhouse', 'automatic', ${row.origin}, ${row.title}, ${foldForKeywords(row.title)}, 'Acme', ${row.postingText},
    ${JSON.stringify(row.structured)}::jsonb, ${row.roleFamily}, ${row.discoveredAt}`
  const factColumns = sql`id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, posting_text, structured, role_family, discovered_at`
  if (holder === null) {
    await sql`insert into job_posting (${factColumns}, status, skip_reason, skip_detail, evaluation_failure, evaluated_at)
      values (${facts}, ${row.status}, ${row.skipReason}, ${row.skipDetail}, ${row.failure}, ${row.evaluatedAt})`.execute(db)
    return
  }
  const prefilter = row.skipReason === "not_software_role" ? "not_software_role" : null
  // EPIC-0006 (0020): a posting is dated with its discovery time when the schema has posted_at, so the A0 rows
  // stay visible by date; not_software_role skips are off-target and hidden, as the epic intends.
  const dated = await sql<{ present: boolean }>`select exists (select 1 from information_schema.columns where table_name = 'job_posting' and column_name = 'posted_at') as present`.execute(db)
  if (dated.rows[0]?.present) {
    // AC-1.8: from 0020 a stored titled posting past the pre-filter has its store-time family, even before evaluation.
    const family = row.roleFamily ?? (prefilter === null ? classifyTitle(row.title) : null)
    await sql`insert into job_posting (${factColumns}, prefilter_skip, posted_at, posted_date_kind) values (${facts}, ${prefilter}, ${row.discoveredAt}, 'published')`.execute(db)
    if (family !== row.roleFamily) await sql`update job_posting set role_family = ${family} where id = ${row.id}::uuid`.execute(db)
  } else {
    await sql`insert into job_posting (${factColumns}, prefilter_skip) values (${facts}, ${prefilter})`.execute(db)
  }
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
    values (${holder}::uuid, ${row.id}::uuid, ${row.origin}, ${row.status}, ${row.skipReason}, ${row.skipDetail}, ${row.failure}, ${row.discoveredAt}, ${row.evaluatedAt})`.execute(db)
}

/** The single Candidate on the A1 schema, or null before it (no `candidate_posting`). */
export async function postingHolder(db: Kysely<Database>): Promise<string | null> {
  const split = await sql<{ present: boolean }>`select to_regclass('public.candidate_posting') is not null as present`.execute(db)
  if (!split.rows[0]?.present) return null
  const operator = await sql<{ id: string }>`select id from candidate where role = 'operator'`.execute(db)
  if (!operator.rows[0]) throw new Error("no Operator Candidate")
  return operator.rows[0].id
}
