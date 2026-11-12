import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrationsFor } from "../src/db/migrations/index.js"

/**
 * EPIC-0006 migration 0020-role-relevance (migration-and-performance.feature;
 * PRD AC-8.1 to AC-8.5; architecture.r1 "Schema"). A database at 0019, seeded
 * with the live distribution shape for the Operator and a second Candidate,
 * then 0020 applied on its own. No network and no AI: the migration is SQL plus
 * frozen copies.
 */
const OWNER_SUB = "google-sub-ada-0020"
/** Through 0020: this file tests 0020 and its `down`. Later migrations (EPIC-0007's 0021) are out of scope. */
const ALL = Object.fromEntries(Object.entries(migrationsFor({ operatorGoogleSub: OWNER_SUB })).filter(([name]) => name < "0021"))
const THROUGH_0019 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name < "0020"))
/** Run a2e: EPIC-0007's 0021 and EPIC-0002 A2's 0022 and 0023 now follow 0020, so "latest" and one step down stop at 0020 here. */
const THROUGH_0020 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name <= "0020-role-relevance"))

type Db = Kysely<unknown>
const opened: { name: string; db: Db }[] = []
let cluster: Db

beforeAll(() => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
})

afterAll(async () => {
  for (const { name, db } of opened) {
    await db.destroy()
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  }
  await cluster.destroy()
})

async function databaseAt0019(): Promise<Db> {
  const name = `ja_rr_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  const db = createDatabase(url.toString()) as unknown as Db
  opened.push({ name, db })
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => THROUGH_0019 } }).migrateToLatest()
  if (error) throw error
  return db
}

const migrate0020 = (db: Db) => new Migrator({ db, provider: { getMigrations: async () => THROUGH_0020 } }).migrateToLatest()

type Seeded = { operatorId: string; kofiId: string; ids: Record<string, string> }

/**
 * The live distribution shape (AC-8.5): `not_software_role` skips,
 * `unsupported_application_system` skips, `evaluation_failed` `not_configured`
 * rows (including "Solutions Architect" and "TAM Architect"), plus one ranked
 * Engineering Lead with management core items, and Kofi holding a subset.
 */
async function seed(db: Db): Promise<Seeded> {
  // 0016 created the Operator from OWNER_SUB, with the 0012 job_criteria row (70%).
  const operatorId = (await sql<{ id: string }>`select id from candidate where role = 'operator'`.execute(db)).rows[0]!.id
  const kofiId = (await sql<{ id: string }>`insert into candidate (email, google_sub, role) values ('kofi@example.test', 'sub-kofi', 'candidate') returning id`.execute(db)).rows[0]!.id
  await sql`insert into job_criteria (candidate_id, min_core_match_percent) values (${operatorId}::uuid, 70), (${kofiId}::uuid, 80)
    on conflict (candidate_id) do update set min_core_match_percent = excluded.min_core_match_percent`.execute(db)
  const rows: Array<{ key: string; title: string | null; family: string | null; prefilter: string | null; status: string; skip: string | null; failure: string | null }> = [
    { key: "paralegal", title: "Hotline Paralegal", family: null, prefilter: "not_software_role", status: "skipped", skip: "not_software_role", failure: null },
    { key: "marketing", title: "Marketing Operations Specialist", family: null, prefilter: "not_software_role", status: "skipped", skip: "not_software_role", failure: null },
    { key: "workday", title: "Senior Frontend Engineer", family: null, prefilter: null, status: "skipped", skip: "unsupported_application_system", failure: null },
    { key: "solutions", title: "Solutions Architect", family: null, prefilter: null, status: "evaluation_failed", skip: null, failure: "not_configured" },
    { key: "tam", title: "TAM Architect", family: null, prefilter: null, status: "evaluation_failed", skip: null, failure: "not_configured" },
    { key: "platform", title: "Senior Platform Engineer", family: "devops_platform", prefilter: null, status: "evaluation_failed", skip: null, failure: "not_configured" },
    { key: "software", title: "Software Engineer", family: "other", prefilter: null, status: "evaluation_failed", skip: null, failure: "not_configured" },
    { key: "junior", title: "Junior Frontend Developer", family: "senior_frontend", prefilter: null, status: "evaluation_failed", skip: null, failure: "not_configured" },
    { key: "lead", title: "Engineering Lead", family: "technical_lead", prefilter: null, status: "ranked", skip: null, failure: null },
    { key: "untitled", title: null, family: null, prefilter: null, status: "checking", skip: null, failure: null },
  ]
  const ids: Record<string, string> = {}
  for (const [index, row] of rows.entries()) {
    const id = randomUUID()
    ids[row.key] = id
    const url = `https://boards.greenhouse.io/acme/jobs/${index}`
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, role_family, discovered_at, prefilter_skip, structured, technologies)
      values (${id}::uuid, ${url}, ${String(index)}, ${url}, 'Greenhouse', 'automatic', 'employer_board', ${row.title}, ${row.title === null ? null : row.title.toLowerCase()}, 'Acme', ${row.family},
        '2026-10-01T08:00:00Z', ${row.prefilter}, '{}', ${row.key === "lead" ? '[{"name":"React","quote":"React"}]' : null})`.execute(db)
    await sql`select set_config('eve.candidate_id', ${operatorId}, false)`.execute(db)
    await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, evaluation_failure, discovered_at)
      values (${operatorId}::uuid, ${id}::uuid, 'employer_board', ${row.status}, ${row.skip}, ${row.failure}, '2026-10-01T08:00:00Z')`.execute(db)
    if (["paralegal", "solutions", "junior", "software"].includes(row.key)) {
      await sql`select set_config('eve.candidate_id', ${kofiId}, false)`.execute(db)
      await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, evaluation_failure, discovered_at)
        values (${kofiId}::uuid, ${id}::uuid, 'employer_board', ${row.status}, ${row.skip}, ${row.failure}, '2026-10-01T08:00:00Z')`.execute(db)
    }
  }
  await sql`select set_config('eve.candidate_id', ${operatorId}, false)`.execute(db)
  await sql`insert into match_evidence (candidate_id, job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
    values (${operatorId}::uuid, ${ids.lead}::uuid, 1, 'strong', null, 1, 1, 0.7, ${JSON.stringify([{ group: "core", text: "Hiring and performance reviews for direct reports", factId: "F1" }])}::jsonb, '2026-10-02T08:00:00Z', 1)`.execute(db)
  await sql`select set_config('eve.candidate_id', '', false)`.execute(db)
  return { operatorId, kofiId, ids }
}

async function postingFacts(db: Db) {
  const { rows } = await sql<{ id: string; role_family: string | null; seniority_marker: string | null; posted_at: Date | null; posted_date_kind: string | null }>`
    select id::text, role_family, seniority_marker, posted_at, posted_date_kind from job_posting order by id`.execute(db)
  return new Map(rows.map((row) => [row.id, row]))
}

async function candidateState(db: Db) {
  const { rows } = await sql<Record<string, string | null>>`
    select candidate_id::text, job_posting_id::text, status, skip_reason, evaluation_failure from candidate_posting order by 1, 2`.execute(db)
  return rows
}

describe("migration 0020-role-relevance", () => {
  it("adds the columns and constraints, defaults every Candidate's criteria, and records the marker (AC-8.1)", async () => {
    const db = await databaseAt0019()
    const { operatorId, kofiId } = await seed(db)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    expect((await migrate0020(db)).error).toBeUndefined()
    stdout.mockRestore()
    const criteria = await sql<{ candidate_id: string; target_role_families: string[]; seniority_floor: string; min_core_match_percent: number }>`
      select candidate_id::text, target_role_families, seniority_floor, min_core_match_percent from job_criteria order by candidate_id`.execute(db)
    const defaults = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering", "backend", "mobile", "platform_engineering", "people_management"]
    expect(criteria.rows.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id))).toEqual(
      [
        { candidate_id: operatorId, target_role_families: defaults, seniority_floor: "hide_entry_level", min_core_match_percent: 70 },
        { candidate_id: kofiId, target_role_families: defaults, seniority_floor: "hide_entry_level", min_core_match_percent: 80 },
      ].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id))
    )
    const markers = await sql<{ name: string }>`select name from migration_marker order by name`.execute(db)
    expect(markers.rows.map((row) => row.name)).toContain("0020-role-relevance")
    const checks = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'candidate_posting_status_check'`.execute(db)
    expect(checks.rows[0]?.def).toContain("not_checked")
    await expect(sql`update job_posting set posted_at = now() where title = 'Software Engineer'`.execute(db)).rejects.toThrow(/job_posting_posted_pair/)
    await expect(sql`update job_criteria set target_role_families = '{}'::text[]`.execute(db)).rejects.toThrow(/check/)
    await expect(sql`update job_criteria set target_role_families = '{robotics}'::text[]`.execute(db)).rejects.toThrow(/check/)
    await expect(sql`update job_criteria set seniority_floor = 'senior'`.execute(db)).rejects.toThrow(/check/)
  })

  it("reclassifies families with the frozen classifier, Operator core items only for lead/management, null for pre-filter skips (AC-8.2)", async () => {
    const db = await databaseAt0019()
    const { ids } = await seed(db)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    expect((await migrate0020(db)).error).toBeUndefined()
    vi.restoreAllMocks()
    const facts = await postingFacts(db)
    const family = (key: string) => facts.get(ids[key]!)?.role_family ?? null
    expect({
      paralegal: family("paralegal"), marketing: family("marketing"), workday: family("workday"), solutions: family("solutions"), tam: family("tam"),
      platform: family("platform"), software: family("software"), junior: family("junior"), lead: family("lead"), untitled: family("untitled"),
    }).toEqual({
      paralegal: null, marketing: null, workday: "senior_frontend", solutions: "solutions_customer", tam: "solutions_customer",
      platform: "platform_engineering", software: "software_engineering", junior: "senior_frontend", lead: "people_management", untitled: null,
    })
    const marker = (key: string) => facts.get(ids[key]!)?.seniority_marker ?? null
    expect([marker("junior"), marker("platform"), marker("software"), marker("untitled")]).toEqual(["entry", "mid_plus", "none", null])
    for (const row of facts.values()) expect([row.posted_at, row.posted_date_kind]).toEqual([null, null])
  })

  it("changes no status, skip reason, failure kind, Match evidence or technologies and deletes no row (AC-8.3)", async () => {
    const db = await databaseAt0019()
    await seed(db)
    const before = await candidateState(db)
    const evidence = await sql`select candidate_id, job_posting_id, verdict, items::text, threshold::text, criteria_version from match_evidence order by 1, 2`.execute(db)
    const technologies = await sql`select id, technologies::text, title from job_posting order by id`.execute(db)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    expect((await migrate0020(db)).error).toBeUndefined()
    vi.restoreAllMocks()
    expect(await candidateState(db)).toEqual(before)
    expect((await sql`select candidate_id, job_posting_id, verdict, items::text, threshold::text, criteria_version from match_evidence order by 1, 2`.execute(db)).rows).toEqual(evidence.rows)
    expect((await sql`select id, technologies::text, title from job_posting order by id`.execute(db)).rows).toEqual(technologies.rows)
  })

  it("logs family counts before and after and each Candidate's hidden counts by first reason (AC-8.2, AC-8.4, AC-8.5)", async () => {
    const db = await databaseAt0019()
    const { operatorId, kofiId } = await seed(db)
    const lines: string[] = []
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    expect((await migrate0020(db)).error).toBeUndefined()
    vi.restoreAllMocks()
    const line = lines.map((text) => text.trim()).find((text) => text.includes('"0020-role-relevance"'))
    const log = JSON.parse(line ?? "{}") as { familiesBefore: Record<string, number>; familiesAfter: Record<string, number>; hidden: { candidateId: string; hidden: Record<string, number> }[] }
    expect(log.familiesBefore).toEqual({ null: 6, devops_platform: 1, other: 1, senior_frontend: 1, technical_lead: 1 })
    expect(log.familiesAfter).toEqual({ null: 3, people_management: 1, platform_engineering: 1, senior_frontend: 2, software_engineering: 1, solutions_customer: 2 })
    const byCandidate = Object.fromEntries(log.hidden.map((entry) => [entry.candidateId, entry.hidden]))
    // Operator: paralegal, marketing, solutions, tam off-target; junior below the floor; the rest undated (every row is undated, AC-8.4).
    expect(byCandidate[operatorId]).toEqual({ offTarget: 4, belowSeniorityFloor: 1, undated: 5, olderThan60Days: 0 })
    // Kofi holds paralegal, solutions (off-target), junior (below floor) and software (undated).
    expect(byCandidate[kofiId]).toEqual({ offTarget: 2, belowSeniorityFloor: 1, undated: 1, olderThan60Days: 0 })
    expect(log.hidden.map((entry) => entry.candidateId)).toEqual([operatorId, kofiId].sort())
  })

  it("applies cleanly to an empty database and rolls back as one unit on failure", async () => {
    const empty = await databaseAt0019()
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    expect((await migrate0020(empty)).error).toBeUndefined()
    vi.restoreAllMocks()

    const db = await databaseAt0019()
    await seed(db)
    const before = await candidateState(db)
    // A name clash on the posted-pair constraint makes 0020 fail on its first statement's companion.
    await sql`alter table job_posting add constraint job_posting_posted_pair check (true)`.execute(db)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const { error } = await migrate0020(db)
    vi.restoreAllMocks()
    expect(String((error as Error | undefined)?.message ?? "")).toMatch(/job_posting_posted_pair/)
    const state = await sql<{ n: number; markers: number }>`
      select (select count(*)::int from information_schema.columns where table_name in ('job_posting', 'job_criteria') and column_name in ('posted_at', 'seniority_marker', 'target_role_families', 'seniority_floor')) as n,
        (select count(*)::int from migration_marker where name = '0020-role-relevance') as markers`.execute(db)
    expect(state.rows[0]).toEqual({ n: 0, markers: 0 })
    expect(await candidateState(db)).toEqual(before)
  })

  it("down (development only) restores the 0019 schema and maps new families back", async () => {
    const db = await databaseAt0019()
    const { ids } = await seed(db)
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    expect((await migrate0020(db)).error).toBeUndefined()
    vi.restoreAllMocks()
    await sql`select set_config('eve.candidate_id', (select id::text from candidate where role = 'operator'), false)`.execute(db)
    await sql`update candidate_posting set status = 'not_checked' where job_posting_id = ${ids.software}::uuid`.execute(db)
    await sql`select set_config('eve.candidate_id', '', false)`.execute(db)
    const { error } = await new Migrator({ db, provider: { getMigrations: async () => THROUGH_0020 } }).migrateDown()
    expect(error).toBeUndefined()
    const facts = await sql<{ role_family: string | null; title: string | null }>`select role_family, title from job_posting where title in ('Senior Platform Engineer', 'Software Engineer', 'Solutions Architect') order by title`.execute(db)
    expect(facts.rows).toEqual([
      { role_family: "devops_platform", title: "Senior Platform Engineer" },
      { role_family: "other", title: "Software Engineer" },
      { role_family: "other", title: "Solutions Architect" },
    ])
    const status = await sql<{ status: string }>`select status from candidate_posting where job_posting_id = ${ids.software}::uuid order by candidate_id`.execute(db)
    expect(status.rows.every((row) => row.status !== "not_checked")).toBe(true)
    const columns = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where column_name in ('posted_at', 'target_role_families')`.execute(db)
    expect(columns.rows[0]?.n).toBe(0)
  })
})
