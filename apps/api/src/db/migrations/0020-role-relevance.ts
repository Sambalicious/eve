import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0006 (architecture.r1 "Schema: migration 0020-role-relevance"; PRD
 * AC-8.1 to AC-8.4). Runs after 0016 to 0019 in the migrator's one
 * transaction, as the owner role.
 *
 * Schema:
 * - `job_posting` (shared facts, no RLS): `posted_at`, `posted_date_kind` (both
 *   null or both set) and `seniority_marker`.
 * - `candidate_posting.status` gains `not_checked`. 0019 created the status
 *   check inline, so its name is looked up; exactly one must match.
 * - `job_criteria` (per Candidate): `target_role_families` and
 *   `seniority_floor`, with the AC-1.6 and AC-2.1 defaults. ADD COLUMN ...
 *   DEFAULT gives every Candidate's existing row the defaults (DDL, no RLS).
 *
 * Data, no network and no AI call:
 * 1. Logs the counts per family before.
 * 2. As the Operator (the only Candidate with evaluations before EPIC-0002
 *    slice D), reclassifies every titled row with `prefilter_skip is null` with
 *    the frozen 13-family classifier; `technical_lead` may become
 *    `people_management` by the frozen duty rule over the Operator's core
 *    items. Rows with `prefilter_skip` get `role_family = null`.
 * 3. Writes `seniority_marker` on every titled row (untitled stay null).
 * 4. Changes nothing else: no status, skip reason, Match evidence or
 *    technologies, and no row deleted (AC-8.3).
 * 5. For each Candidate in id order, counts hidden rows per first reason under
 *    their (defaulted) criteria and logs one JSON line with both family counts.
 * 6. Records the schema marker last, so the api and worker refuse to boot
 *    without this migration.
 *
 * No index is added. `down` is for development only and loses data: it maps
 * `platform_engineering` to `devops_platform` and the other three new families
 * to `other`, and moves `not_checked` rows to `checking`. In production, roll
 * back by restoring a backup.
 *
 * Frozen: this file imports nothing from the app (0020-frozen.spec.ts checks
 * that its copies agree with the live classifier, marker and fold).
 */
export const ROLE_RELEVANCE_MARKER = "0020-role-relevance"

const ALL_FAMILIES = [
  "senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering",
  "backend", "mobile", "platform_engineering", "devops_platform", "people_management",
  "data_ml", "solutions_customer", "other",
]
const DEFAULT_TARGETS = [
  "senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering",
  "backend", "mobile", "platform_engineering", "people_management",
]
const STATUSES_0019 = ["checking", "waiting_to_be_checked", "ranked", "excluded", "skipped", "evaluation_failed"]
const STATUSES_0020 = ["checking", "waiting_to_be_checked", "not_checked", "ranked", "excluded", "skipped", "evaluation_failed"]

const textArray = (values: readonly string[]) => sql.raw(`array[${values.map((value) => `'${value}'`).join(",")}]::text[]`)
const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(","))

export async function up(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  await run(sql`alter table job_posting
    add column posted_at timestamptz,
    add column posted_date_kind text check (posted_date_kind in ('published', 'updated')),
    add column seniority_marker text check (seniority_marker in ('entry', 'mid_plus', 'none')),
    add constraint job_posting_posted_pair check ((posted_at is null) = (posted_date_kind is null))`)

  const statusCheck = await candidatePostingStatusCheck(db)
  await run(sql`alter table candidate_posting drop constraint ${sql.id(statusCheck)},
    add constraint candidate_posting_status_check check (status in (${inList(STATUSES_0020)}))`)

  await run(sql`alter table job_criteria
    add column target_role_families text[] not null default ${textArray(DEFAULT_TARGETS)}
      check (cardinality(target_role_families) between 1 and 13 and target_role_families <@ ${textArray(ALL_FAMILIES)}),
    add column seniority_floor text not null default 'hide_entry_level' check (seniority_floor in ('all_levels', 'hide_entry_level'))`)

  const familiesBefore = await familyCounts(db)
  await reclassify(db)
  await writeSeniorityMarkers(db)
  const familiesAfter = await familyCounts(db)
  const hidden = await hiddenCountsPerCandidate(db)
  process.stdout.write(`${JSON.stringify({ migration: ROLE_RELEVANCE_MARKER, familiesBefore, familiesAfter, hidden })}\n`)

  await recordSchemaMarker(db, ROLE_RELEVANCE_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)
  await run(sql`delete from migration_marker where name = ${ROLE_RELEVANCE_MARKER}`)
  await withEachCandidate(db, async (candidateId) => {
    await run(sql`update candidate_posting set status = 'checking' where candidate_id = ${candidateId}::uuid and status = 'not_checked'`)
  })
  await run(sql`update job_posting set role_family = case role_family when 'platform_engineering' then 'devops_platform' else 'other' end
    where role_family in ('platform_engineering', 'software_engineering', 'data_ml', 'solutions_customer')`)
  await run(sql`alter table candidate_posting drop constraint candidate_posting_status_check,
    add constraint candidate_posting_status_check check (status in (${inList(STATUSES_0019)}))`)
  await run(sql`alter table job_criteria drop column target_role_families, drop column seniority_floor`)
  await run(sql`alter table job_posting drop constraint job_posting_posted_pair,
    drop column posted_at, drop column posted_date_kind, drop column seniority_marker`)
}

/** The one check constraint on candidate_posting that names `status`; refuses unless exactly one matches. */
async function candidatePostingStatusCheck(db: Kysely<unknown>): Promise<string> {
  const { rows } = await sql<{ name: string }>`
    select conname::text as name from pg_constraint
    where contype = 'c' and conrelid = 'candidate_posting'::regclass and pg_get_constraintdef(oid) like '%status%'`.execute(db)
  if (rows.length !== 1) throw new Error(`0020: expected one status check on candidate_posting, found ${rows.length}`)
  return rows[0]!.name
}

async function familyCounts(db: Kysely<unknown>): Promise<Record<string, number>> {
  const { rows } = await sql<{ family: string | null; n: number }>`
    select role_family as family, count(*)::int as n from job_posting group by role_family order by role_family nulls first`.execute(db)
  return Object.fromEntries(rows.map((row) => [row.family ?? "null", row.n]))
}

type TitledRow = { id: string; title: string; prefilter_skip: string | null; core: string[] | null }

/** Steps 2 and 3 of the data change; one batch update per column. */
async function reclassify(db: Kysely<unknown>): Promise<void> {
  const operator = await sql<{ id: string }>`select id from candidate where role = 'operator'`.execute(db)
  const operatorId = operator.rows[0]?.id
  // match_evidence has forced RLS: only the Operator's own core items are readable, and only with the setting.
  if (operatorId !== undefined) await sql`select set_config('eve.candidate_id', ${operatorId}, true)`.execute(db)
  const { rows } = await sql<TitledRow>`
    select p.id, p.title, p.prefilter_skip,
      (select array_agg(e.item ->> 'text' order by e.n)
         from match_evidence m
         cross join lateral jsonb_array_elements(case when jsonb_typeof(m.items) = 'array' then m.items else '[]'::jsonb end) with ordinality as e(item, n)
         where m.job_posting_id = p.id and m.candidate_id = nullif(current_setting('eve.candidate_id', true), '')::uuid
           and jsonb_typeof(e.item) = 'object' and e.item ->> 'group' = 'core' and jsonb_typeof(e.item -> 'text') = 'string') as core
    from job_posting p
    where p.title is not null and btrim(p.title) <> ''
    order by p.id`.execute(db)
  if (operatorId !== undefined) await sql`select set_config('eve.candidate_id', '', true)`.execute(db)

  const ids = rows.map((row) => row.id)
  const families = rows.map((row) => (row.prefilter_skip === null ? frozenMigratedFamily(row.title, row.core ?? []) : null))
  if (ids.length > 0) {
    await sql`update job_posting p set role_family = c.family
      from unnest(${ids}::uuid[], ${families}::text[]) as c(id, family) where p.id = c.id`.execute(db)
  }
  await sql`update job_posting set role_family = null where prefilter_skip is not null and role_family is not null`.execute(db)
}

async function writeSeniorityMarkers(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ id: string; title: string }>`select id, title from job_posting where title is not null and btrim(title) <> '' order by id`.execute(db)
  if (rows.length === 0) return
  await sql`update job_posting p set seniority_marker = c.marker
    from unnest(${rows.map((row) => row.id)}::uuid[], ${rows.map((row) => frozenSeniority(row.title))}::text[]) as c(id, marker)
    where p.id = c.id`.execute(db)
}

/** Each Candidate's hidden rows per first reason (AC-3.4 order), under their criteria and today's WAT date. */
async function hiddenCountsPerCandidate(db: Kysely<unknown>) {
  const result: { candidateId: string; hidden: { offTarget: number; belowSeniorityFloor: number; undated: number; olderThan60Days: number } }[] = []
  await withEachCandidate(db, async (candidateId) => {
    const { rows } = await sql<{ off_target: number; below_floor: number; undated: number; older: number }>`
      with ctx as (
        select target_role_families as targets, seniority_floor = 'hide_entry_level' as hide_entry,
          ((date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') - interval '60 days') as cutoff
        from job_criteria where candidate_id = ${candidateId}::uuid
      ), reasons as (
        select case
          when p.title_folded is not null and (p.prefilter_skip is not null or p.role_family is null or not (p.role_family = any(ctx.targets))) then 'off_target'
          when p.title_folded is not null and ctx.hide_entry and p.seniority_marker = 'entry' then 'below_floor'
          when p.posted_at is null then 'undated'
          when p.posted_at < ctx.cutoff then 'older'
        end as reason
        from candidate_posting cp join job_posting p on p.id = cp.job_posting_id cross join ctx
        where cp.candidate_id = ${candidateId}::uuid
      )
      select count(*) filter (where reason = 'off_target')::int as off_target, count(*) filter (where reason = 'below_floor')::int as below_floor,
        count(*) filter (where reason = 'undated')::int as undated, count(*) filter (where reason = 'older')::int as older
      from reasons`.execute(db)
    const row = rows[0]
    result.push({ candidateId, hidden: { offTarget: row?.off_target ?? 0, belowSeniorityFloor: row?.below_floor ?? 0, undated: row?.undated ?? 0, olderThan60Days: row?.older ?? 0 } })
  })
  return result
}

/** Runs `work` once per Candidate, in id order, with `eve.candidate_id` set (RLS is forced on their tables). */
async function withEachCandidate(db: Kysely<unknown>, work: (candidateId: string) => Promise<void>): Promise<void> {
  const { rows } = await sql<{ id: string }>`select id from candidate order by id`.execute(db)
  for (const { id } of rows) {
    await sql`select set_config('eve.candidate_id', ${id}, true)`.execute(db)
    await work(id)
  }
  await sql`select set_config('eve.candidate_id', '', true)`.execute(db)
}

// ── Frozen copies of the EPIC-0006 live functions (apps/api/src/discovery/rules/ranking.ts, seniority.ts,
// packages/contracts keyword-fold.ts). Do not edit: a later classifier change ships its own migration. ──────

export function frozenFold(text: string): string {
  return text
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (abbreviation) => abbreviation.replace(/\./g, ""))
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

const frozenWords = (list: readonly string[]) => new RegExp(`\\b(${list.join("|")})\\b`)
const F_SOLUTIONS = frozenWords([
  "solutions? architect(ure)?", "sales architect", "pre-?sales architect", "customer architect",
  "technical account manag(er|ement)", "tam", "solutions? engineer(ing)?", "customer engineer(ing)?",
])
const F_DATA_ML = frozenWords([
  "data engineer(ing)?", "data scien(ce|tist)", "data analyst", "analytics engineer", "machine learning", "ml", "mlops",
  "ai engineer", "ai/ml", "ai ml", "deep learning", "applied scientist", "business intelligence", "bi engineer",
])
const F_MANAGEMENT_TITLE = /\b(engineering manager|manager,? engineering|head of engineering|director|vp|vice president|people manager)\b/
const F_MANAGEMENT_DUTIES = /\b(hiring|performance reviews?|line management|people management|direct reports|career development of)\b/
const F_HANDS_ON = /\b(code|coding|hands-on|hands on|build|implement|write|ship|react|typescript|frontend|front-end)\b/
const F_LEAD = /\b(tech(nical)? lead|lead engineer|lead developer|team lead|engineering lead|lead (frontend|front-end|software))\b/
const F_FRONTEND = /\b(frontend|front-end|front end|ui engineer|web engineer|react)\b/
const F_FULLSTACK = /\b(full[- ]?stack)\b/
const F_PRODUCT = /\b(product engineer(ing)?)\b/
const F_MOBILE = /\b(ios|android|mobile|flutter|swiftui|react native|xamarin|kotlin multiplatform)\b/
const F_BACKEND = /\b(backend|back-end|back end|server-side|server side)\b/
const F_PLATFORM = frozenWords(["platform engineer(ing)?", "platform reliability"])
const F_DEVOPS = frozenWords(["devops", "dev ops", "site reliability", "sre", "reliability engineer", "infrastructure", "infra engineer", "cloud engineer", "cloud infrastructure"])
const F_NOT_SOFTWARE = frozenWords(["qa", "quality assurance", "sdet", "in test", "test engineer", "test automation", "developer relations", "developer advocate", "devrel"])
const F_SOFTWARE = frozenWords([
  "software", "developer", "programmer", "sde", "staff engineer", "principal engineer", "member of technical staff", "mts",
  "developpeur", "developpeuse", "programmeur", "programmeuse",
  "ingenieur(?:\\(e\\)|\u00b7e|-e|e)? (?:logiciel|developpement)",
  "desarrollador", "desarrolladora", "programador", "programadora", "ingenier[oa] de software",
  "desenvolvedor", "desenvolvedora", "engenheir[oa] de software",
  "entwickler", "entwicklerin", "softwareentwickler", "softwareentwicklerin", "webentwickler", "webentwicklerin",
  "anwendungsentwickler", "anwendungsentwicklerin", "programmierer", "programmiererin", "softwareingenieur", "softwareingenieurin",
])

/** Frozen copy of the live title-and-duties classifier. */
export function frozenFamilyWithDuties(title: string, core: readonly string[]): string {
  const folded = frozenFold(title)
  if (F_SOLUTIONS.test(folded)) return "solutions_customer"
  if (F_DATA_ML.test(folded)) return "data_ml"
  const duties = frozenFold(core.join(". "))
  const managing = F_MANAGEMENT_TITLE.test(folded) || (F_MANAGEMENT_DUTIES.test(duties) && !F_HANDS_ON.test(duties))
  if (managing && !F_LEAD.test(folded)) return "people_management"
  if (F_LEAD.test(folded)) return F_MANAGEMENT_DUTIES.test(duties) && !F_HANDS_ON.test(duties) ? "people_management" : "technical_lead"
  if (F_FULLSTACK.test(folded)) return "fullstack"
  if (F_PRODUCT.test(folded)) return "product_engineering"
  if (F_FRONTEND.test(folded)) return "senior_frontend"
  if (F_MOBILE.test(folded)) return "mobile"
  if (F_BACKEND.test(folded)) return "backend"
  if (F_PLATFORM.test(folded)) return "platform_engineering"
  if (F_DEVOPS.test(folded)) return "devops_platform"
  if (F_NOT_SOFTWARE.test(folded)) return "other"
  if (F_SOFTWARE.test(folded)) return "software_engineering"
  return "other"
}

/**
 * The 0020 family: the title-only result, except that `technical_lead` becomes
 * `people_management` when the Operator's stored core items satisfy the duty
 * rule (AC-1.8, AC-8.2). Duties change no other family.
 */
export function frozenMigratedFamily(title: string, core: readonly string[]): string {
  const family = frozenFamilyWithDuties(title, [])
  if (family !== "technical_lead" || core.length === 0) return family
  return frozenFamilyWithDuties(title, core) === "people_management" ? "people_management" : family
}

const F_MID_PLUS = /\b(mid|mid-level|intermediate|senior|sr|staff|principal|lead)\b/
const F_ENTRY =
  /\b(intern|internship|junior|jr|graduate|grad|new grad|entry level|entry-level|apprentice|apprenticeship|trainee|stagiaire|alternance|becario|becaria|pasante|praktikant|praktikantin|werkstudent|werkstudentin)\b/

/** Frozen `seniorityMarker` for a non-blank title. */
export function frozenSeniority(title: string): string {
  const folded = frozenFold(title)
  if (F_MID_PLUS.test(folded)) return "mid_plus"
  return F_ENTRY.test(folded) ? "entry" : "none"
}
