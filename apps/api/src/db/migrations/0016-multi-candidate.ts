import { type Kysely, sql } from "kysely"
import type { Migration } from "kysely/migration"

/**
 * EPIC-0002 A1 (architecture r2, "Migration of the owner"). One Kysely
 * migration, one transaction: any refusal or failure leaves the database where
 * it was. Numbering follows D19 (r5-addendum): no number is reserved; the
 * branch that merges later renumbers its migrations in its merge change.
 *
 * 1. `candidate` (identity), one Operator at most.
 * 2. Preflight (R2-6, AC 1), before any write: refuse a `00:00` hours cutoff
 *    and a work-authorization text the slice 5 classifier does not read as
 *    "Nigeria only".
 * 3. The owner becomes the Operator. Their Google `sub` comes from the
 *    migration step (`CANDIDATE_GOOGLE_SUB` once), never from a request.
 * 4. Every Candidate-data table gets `candidate_id` (owner for every existing
 *    row), a foreign key, a leading index, and the per-Candidate keys of the
 *    architecture's column map. `wat_day` columns become local-day columns
 *    with the same values. No other column value changes.
 * 5. `migration_marker('multi_candidate')`.
 *
 * Until RLS lands, `candidate_id` defaults to the owner, so single-Candidate
 * code keeps writing the owner's rows unchanged.
 */
export type MultiCandidateContext = Readonly<{ operatorGoogleSub: string | undefined }>

/**
 * Candidate-data tables (architecture r2 table classification, plus `outcome`, C25 resolved in r3).
 * `job_criteria` (EPIC-0004, 0012) is the Candidate's minimum core Match and
 * lists: Candidate data (EPIC-0004 architecture "the Candidate's criteria are
 * Candidate data"; EPIC-0002 r2 "job_preferences" is Candidate data), until
 * slice B folds it into Job Preferences.
 *
 * Three EPIC-0005 Stack posts tables (0013) are Candidate data too: a
 * Candidate's registered Alert feeds (their private Google Alerts URLs), the
 * posts read from them and matched against their Job criteria, and their read
 * runs. r5 K6: `alert_feed_verification` is NOT Candidate data. It stays the
 * shared singleton, written only by the Operator (the Operator's server reads
 * every feed, so the Operator carries the permitted-use judgement), and every
 * Candidate path reads it.
 *
 * EPIC-0001 slice 9 (0015-retention, merged first) adds `retention_run`: one
 * row per run of automatic expiry, counts only. Expiry deletes a Candidate's
 * Application details, so it runs per Candidate, and each run row (and the
 * launch grace its earliest row starts) belongs to that Candidate. The new
 * `application.details_deleted_by` column rides with `application`.
 */
export const CANDIDATE_TABLES: readonly string[] = [
  "resume_upload",
  "career_profile_version",
  "approved_answer",
  "gross_salary_answer",
  "preferred_net_pay",
  "candidate_contact",
  "candidate_setting",
  "eligibility_result",
  "match_evidence",
  "application",
  "application_form_read",
  "tailored_document",
  "submission_day",
  "existing_application",
  "activation_state",
  "submission_event",
  "notification_outbox",
  "outcome",
  "job_criteria",
  "alert_feed",
  "stack_post",
  "stack_post_run",
  "retention_run",
]

/** Tables whose one row is created by an earlier migration as a default, not by the Candidate. */
const SEEDED_SINGLETONS: ReadonlySet<string> = new Set(["candidate_setting", "candidate_contact", "activation_state", "job_criteria"])

/**
 * Candidate tables the worker fills on its own on an empty installation:
 * `retention.daily` records a `skipped_launch_grace` run every day from the
 * first start. Their rows hold no career data, so they do not make a database
 * "have data" that needs CANDIDATE_GOOGLE_SUB to bind it.
 */
const SYSTEM_ROWS_ONLY: ReadonlySet<string> = new Set(["retention_run"])

/** The texts `onlyNigeria` (answer-assignment.ts, slice 5) accepts, after its normalisation. Pinned here on purpose. */
const NIGERIA_ONLY_TEXTS: ReadonlySet<string> = new Set(["", "none outside nigeria", "nigeria", "nigeria only", "only nigeria"])

/** One unsupported setting the preflight found. */
export type PreflightProblem = Readonly<{ setting: string; detail: string }>

/** Names every unsupported setting in one refusal (migration-and-operator-bootstrap.feature:960). */
export class MigrationPreflightError extends Error {
  readonly settings: readonly string[]
  constructor(readonly problems: readonly PreflightProblem[]) {
    super(`Multi-candidate migration refused: ${problems.map(({ setting, detail }) => `${setting} ${detail}`).join("; ")}`)
    this.name = "MigrationPreflightError"
    this.settings = problems.map(({ setting }) => setting)
  }
}

/** The slice 5 classifier's normalisation of the work-authorization setting (`onlyNigeria`). */
export function normaliseWorkAuthorization(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "")
}

export function multiCandidateMigration(context: MultiCandidateContext): Migration {
  return { up: (db) => up(db, context) }
}

async function up(db: Kysely<unknown>, context: MultiCandidateContext): Promise<void> {
  await preflight(db)
  await createCandidateTable(db)
  const ownerId = await insertOwner(db, context)
  const owner = sql.lit(ownerId)

  for (const table of CANDIDATE_TABLES) await addCandidateColumn(db, table, owner, { nullable: false })
  await addCandidateColumn(db, "ai_call", owner, { nullable: true })
  await rekey(db)
  await renameLocalDays(db)
  await bindSessions(db, ownerId, context.operatorGoogleSub)

  await sql`create table migration_marker (name text primary key, applied_at timestamptz not null default now())`.execute(db)
  await sql`insert into migration_marker (name) values ('multi_candidate')`.execute(db)
}

/** R2-6, AC 1: reads only; checks every setting, then refuses once, naming each unsupported one, before the first write. */
async function preflight(db: Kysely<unknown>): Promise<void> {
  const problems: PreflightProblem[] = []
  const hours = await sql<{ hours_cutoff: string }>`select hours_cutoff from evaluation_setting`.execute(db)
  if (hours.rows.some((row) => row.hours_cutoff === "00:00")) {
    problems.push({ setting: "evaluation_setting.hours_cutoff", detail: `is "00:00", which has no latest work hour; set it to 01:00 to 23:00 first` })
  }
  const work = await sql<{ work_authorization: string }>`select work_authorization from candidate_setting`.execute(db)
  if (work.rows.some((row) => !NIGERIA_ONLY_TEXTS.has(normaliseWorkAuthorization(row.work_authorization)))) {
    problems.push({
      setting: "candidate_setting.work_authorization",
      detail: "is not read as Nigeria only by the work-question classifier; set it to \"none outside Nigeria\" first",
    })
  }
  if (problems.length > 0) throw new MigrationPreflightError(problems)
}

async function createCandidateTable(db: Kysely<unknown>): Promise<void> {
  await sql`create table candidate (
    id uuid primary key default gen_random_uuid(),
    email text,
    google_sub text unique,
    role text not null check (role in ('operator', 'candidate')),
    state text not null default 'active' check (state in ('active', 'revoked', 'deleting')),
    onboarded_at timestamptz,
    created_at timestamptz not null default now(),
    revoked_at timestamptz
  )`.execute(db)
  await sql`create unique index candidate_one_operator on candidate ((true)) where role = 'operator'`.execute(db)
  await sql`create unique index candidate_email_idx on candidate (lower(email)) where email is not null`.execute(db)
}

/**
 * The owner as Operator, onboarded (they never see the wizard), email null until
 * their first sign-in. Without a bound `sub` the migration refuses when the
 * Candidate already has data: the rows would belong to nobody who can sign in.
 */
async function insertOwner(db: Kysely<unknown>, context: MultiCandidateContext): Promise<string> {
  const sub = context.operatorGoogleSub?.trim() || null
  if (sub === null && (await hasCandidateData(db))) {
    throw new MigrationPreflightError([{ setting: "CANDIDATE_GOOGLE_SUB", detail: "is required once to bind the existing data to its owner" }])
  }
  const { rows } = await sql<{ id: string }>`
    insert into candidate (email, google_sub, role, onboarded_at) values (null, ${sub}, 'operator', now()) returning id`.execute(db)
  return (rows[0] as { id: string }).id
}

/**
 * `job_posting` counts too (F-CR-06): it is shared, not a Candidate table, but
 * 0019 gives every stored posting to the Operator as their `candidate_posting`,
 * and PRD AC 1 lists the owner's postings as their data.
 */
const OWNER_DATA_TABLES: readonly string[] = [...CANDIDATE_TABLES, "job_posting"]

async function hasCandidateData(db: Kysely<unknown>): Promise<boolean> {
  for (const table of OWNER_DATA_TABLES) {
    if (SEEDED_SINGLETONS.has(table) || SYSTEM_ROWS_ONLY.has(table)) continue
    // EPIC-0003's access-request outbox rows are installation data, not the owner's (0017, C36).
    const rowsOf = table === "notification_outbox" ? sql`select 1 from notification_outbox where kind not in ('access_request', 'access_request_cap')` : sql`select 1 from ${sql.table(table)}`
    const { rows } = await sql<{ any: boolean }>`select exists (${rowsOf}) as any`.execute(db)
    if (rows[0]?.any) return true
  }
  return false
}

/** Nullable first, backfill, then not null, FK, leading index, and a default of the owner until RLS sets the scope. */
async function addCandidateColumn(db: Kysely<unknown>, table: string, owner: ReturnType<typeof sql.lit>, options: { nullable: boolean }): Promise<void> {
  const t = sql.table(table)
  await sql`alter table ${t} add column candidate_id uuid`.execute(db)
  await sql`update ${t} set candidate_id = ${owner}`.execute(db)
  if (!options.nullable) await sql`alter table ${t} alter column candidate_id set not null`.execute(db)
  await sql`alter table ${t} alter column candidate_id set default ${owner}::uuid`.execute(db)
  await sql`alter table ${t} add constraint ${sql.id(`${table}_candidate_fk`)} foreign key (candidate_id) references candidate (id) on delete cascade`.execute(db)
  await sql`create index ${sql.id(`${table}_candidate_idx`)} on ${t} (candidate_id)`.execute(db)
}

/** The architecture's key changes, exactly ("Migration of the owner", column map). */
async function rekey(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  // Singletons become one row per Candidate.
  for (const table of ["activation_state", "preferred_net_pay", "candidate_contact", "candidate_setting", "job_criteria"]) {
    await run(sql`alter table ${sql.table(table)} drop constraint ${sql.id(`${table}_pkey`)}`)
    await run(sql`alter table ${sql.table(table)} drop column singleton`)
    await run(sql`alter table ${sql.table(table)} add primary key (candidate_id)`)
  }

  await run(sql`alter table gross_salary_answer drop constraint gross_salary_answer_pkey, add primary key (candidate_id, kind)`)
  await run(sql`alter table approved_answer drop constraint approved_answer_answer_key_key`)
  await run(sql`create unique index approved_answer_candidate_key_idx on approved_answer (candidate_id, answer_key)`)

  await run(sql`alter table career_profile_version drop constraint career_profile_version_pkey, add primary key (candidate_id, version)`)
  await run(sql`drop index career_profile_one_draft_idx`)
  await run(sql`drop index career_profile_one_approved_idx`)
  await run(sql`create unique index career_profile_one_draft_idx on career_profile_version (candidate_id) where status = 'draft'`)
  await run(sql`create unique index career_profile_one_approved_idx on career_profile_version (candidate_id) where status = 'approved'`)

  await run(sql`drop index resume_upload_one_drafting_idx`)
  await run(sql`create unique index resume_upload_one_drafting_idx on resume_upload (candidate_id) where status = 'drafting'`)

  for (const table of ["eligibility_result", "match_evidence"]) {
    await run(sql`alter table ${sql.table(table)} drop constraint ${sql.id(`${table}_pkey`)}, add primary key (candidate_id, job_posting_id)`)
  }

  await run(sql`drop index application_requisition_key_idx`)
  await run(sql`create unique index application_requisition_key_idx on application (candidate_id, application_url, requisition_id)`)
  await run(sql`drop index application_submission_state_idx`)
  await run(sql`create index application_submission_state_idx on application (candidate_id, submission_state)`)
  await run(sql`drop index application_company_idx`)
  await run(sql`create index application_company_idx on application (candidate_id, lower(company))`)
  await run(sql`drop index application_sample_state_idx`)
  await run(sql`create index application_sample_state_idx on application (candidate_id, sample_state) where sample_state is not null`)

  await run(sql`drop index existing_application_key_idx`)
  await run(sql`create unique index existing_application_key_idx on existing_application (candidate_id, application_url, coalesce(requisition_id, ''))`)

  await run(sql`alter table submission_day drop constraint submission_day_pkey`)
  await run(sql`alter table submission_day rename column wat_day to day`)
  await run(sql`alter table submission_day add primary key (candidate_id, day)`)

  // EPIC-0005: feed URLs and post URLs are unique per Candidate; list and retention indexes lead with the Candidate.
  await run(sql`alter table alert_feed drop constraint alert_feed_url_key`)
  await run(sql`create unique index alert_feed_candidate_url_idx on alert_feed (candidate_id, url)`)
  await run(sql`drop index alert_feed_created_idx`)
  await run(sql`create index alert_feed_created_idx on alert_feed (candidate_id, created_at, id)`)
  await run(sql`alter table stack_post drop constraint stack_post_canonical_url_key`)
  await run(sql`create unique index stack_post_candidate_url_idx on stack_post (candidate_id, canonical_url)`)
  await run(sql`drop index stack_post_list_idx`)
  await run(sql`create index stack_post_list_idx on stack_post (candidate_id, (coalesce(published_at, first_seen_at)) desc, first_seen_at desc, id desc)`)
  await run(sql`drop index stack_post_first_seen_idx`)
  await run(sql`create index stack_post_first_seen_idx on stack_post (candidate_id, first_seen_at)`)
  // r5 K8: a post names a feed of its own Candidate only. A foreign key check ignores RLS, so the
  // one-column key let one Candidate's post name another's feed. Removing a feed nulls only the source.
  await run(sql`create unique index alert_feed_candidate_id_idx on alert_feed (candidate_id, id)`)
  await run(sql`alter table stack_post drop constraint stack_post_source_feed_id_fkey`)
  await run(sql`alter table stack_post add constraint stack_post_source_feed_fk foreign key (candidate_id, source_feed_id)
    references alert_feed (candidate_id, id) on delete set null (source_feed_id)`)
  await run(sql`drop index stack_post_source_feed_idx`)
  await run(sql`create index stack_post_source_feed_idx on stack_post (candidate_id, source_feed_id)`)
  await run(sql`drop index stack_post_run_started_idx`)
  await run(sql`create index stack_post_run_started_idx on stack_post_run (candidate_id, started_at)`)

  // r3 `outcome` (C25): an Application's Outcomes are listed per Candidate.
  await run(sql`drop index outcome_application_idx`)
  await run(sql`create index outcome_application_idx on outcome (candidate_id, application_id, created_at)`)

  await run(sql`drop index notification_outbox_due`)
  await run(sql`drop index notification_outbox_last_failed`)
  await run(sql`create index notification_outbox_due on notification_outbox (candidate_id, created_at) where status in ('pending', 'sending')`)
  await run(sql`create index notification_outbox_last_failed on notification_outbox (candidate_id, last_failed_at desc) where status = 'failed'`)

  // EPIC-0001 slice 9 (0015-retention): the job's selection, the retention counts and the run history are read per Candidate.
  await run(sql`drop index application_live_created_idx`)
  await run(sql`create index application_live_created_idx on application (candidate_id, created_at) where details_deleted_at is null`)
  await run(sql`drop index retention_run_wat_date_idx`)
  await run(sql`create index retention_run_wat_date_idx on retention_run (candidate_id, wat_date desc, started_at desc)`)
}

/** `wat_day` names become local-day names; values are unchanged (for the owner, a local day is the WAT day). */
async function renameLocalDays(db: Kysely<unknown>): Promise<void> {
  await sql`drop index notification_outbox_summary_once`.execute(db)
  await sql`alter table notification_outbox rename column wat_day to local_day`.execute(db)
  await sql`create unique index notification_outbox_summary_once on notification_outbox (candidate_id, local_day) where kind = 'daily_summary'`.execute(db)
  await sql`alter table application rename column submitted_wat_day to submitted_local_day`.execute(db)
  await sql`alter table application rename column queued_for_wat_day to queued_for_local_day`.execute(db)
  await sql`alter table application add column submitted_local_day_zone text`.execute(db)
  await sql`update application set submitted_local_day_zone = 'Africa/Lagos' where submitted_local_day is not null`.execute(db)
}

/** Sessions belong to a Candidate. Under ADR 0007 only the bound `sub` has sessions; any other row is removed. */
async function bindSessions(db: Kysely<unknown>, ownerId: string, sub: string | undefined): Promise<void> {
  await sql`delete from dashboard_session where google_sub is distinct from ${sub?.trim() || null}`.execute(db)
  await sql`alter table dashboard_session add column candidate_id uuid`.execute(db)
  await sql`update dashboard_session set candidate_id = ${ownerId}`.execute(db)
  await sql`alter table dashboard_session alter column candidate_id set not null`.execute(db)
  await sql`alter table dashboard_session add constraint dashboard_session_candidate_fk foreign key (candidate_id) references candidate (id) on delete cascade`.execute(db)
  await sql`create index dashboard_session_candidate_idx on dashboard_session (candidate_id)`.execute(db)
}
