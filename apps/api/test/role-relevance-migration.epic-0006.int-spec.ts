import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { type Migration, Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { SCHEMA_MARKERS } from "../src/db/migrations/schema-markers.js"

/**
 * EPIC-0006 QA test authoring (step [5e]): migration 0020-role-relevance on
 * test databases only (AC-8.6: no live database is touched). Source:
 * migration-and-performance.feature (AC-8.1 to AC-8.5), architecture.r1.md
 * "Migration 0020" (columns, data steps, one JSON log line, schema marker).
 * Expected to fail until 0020 is registered in migrationsFor().
 *
 * Each test creates its own database at 0019, seeds it, then applies 0020.
 */
const MIGRATION = "0020-role-relevance"
const OWNER_SUB = "google-sub-ada-0006"
const ALL = (): Record<string, Migration> => migrationsFor({ operatorGoogleSub: OWNER_SUB })
const upTo = (lastIncluded: string) => Object.fromEntries(Object.entries(ALL()).filter(([name]) => name <= lastIncluded))
const DEFAULT_TARGETS = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering", "backend", "mobile", "platform_engineering", "people_management"]
const T0 = "2026-10-20T08:00:00Z"

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

async function databaseAt(lastIncluded: string): Promise<Db> {
  const name = `ja_e6_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  const db = createDatabase(url.toString()) as unknown as Db
  opened.push({ name, db })
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => upTo(lastIncluded) } }).migrateToLatest()
  if (error) throw error
  return db
}

/** Applies every pending migration through 0020, capturing the 0020 JSON log line. */
async function migrate0020(db: Db, migrations: Record<string, Migration> = upTo(MIGRATION)) {
  expect(Object.keys(migrations), "0020-role-relevance must be registered in migrationsFor()").toContain(MIGRATION)
  const lines: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    if (text.includes(`"migration":"${MIGRATION}"`)) {
      lines.push(text)
      return true
    }
    return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest)
  })
  try {
    const result = await new Migrator({ db, provider: { getMigrations: async () => migrations } }).migrateToLatest()
    return { ...result, log: lines[0] ? (JSON.parse(lines[0]) as Record<string, unknown>) : null }
  } finally {
    vi.restoreAllMocks()
  }
}

async function applied(db: Db): Promise<string[]> {
  return (await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db)).rows.map((r) => r.name)
}

async function operatorId(db: Db): Promise<string> {
  return (await sql<{ id: string }>`select id from candidate where role = 'operator'`.execute(db)).rows[0]!.id
}

async function addCandidate(db: Db, email: string): Promise<string> {
  const id = (await sql<{ id: string }>`insert into candidate (email, google_sub, role, onboarded_at) values (${email}, ${`sub-${email}`}, 'candidate', now()) returning id`.execute(db)).rows[0]!.id
  await sql`insert into job_criteria (candidate_id, min_core_match_percent) values (${id}, 70)`.execute(db)
  return id
}

type Seed = Readonly<{
  title: string | null
  family?: string | null
  status?: string
  skipReason?: string | null
  failure?: string | null
  prefilter?: boolean
  origin?: "employer_board" | "pasted_link"
  core?: string[]
  holders?: { id: string; core?: string[]; status?: string }[]
}>

/** One shared posting at 0019 shape, held by the Operator unless `holders` is given. */
async function seedPosting(db: Db, s: Seed): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${id}`
  const family = s.family === undefined ? "other" : s.family
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at, prefilter_skip, technologies)
    values (${id}, ${url}, ${id.slice(0, 12)}, ${url}, 'greenhouse', 'automatic', ${s.origin ?? "employer_board"}, ${s.title}, ${s.title?.toLowerCase() ?? null}, 'Acme', '{}', ${family}, ${T0},
      ${s.prefilter ? "not_software_role" : null}, ${s.status === "ranked" ? JSON.stringify([{ name: "React", quote: "React" }]) : null})`.execute(db)
  const holders = s.holders ?? [{ id: await operatorId(db), core: s.core }]
  for (const holder of holders) {
    const status = holder.status ?? s.status ?? "ranked"
    await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
      values (${holder.id}, ${id}, ${s.origin ?? "employer_board"}, ${status}, ${s.skipReason ?? null}, null, ${s.failure ?? null}, ${T0}, ${status === "checking" ? null : T0})`.execute(db)
    if (holder.core) {
      const items = holder.core.map((text) => ({ group: "core", text, factId: null }))
      await sql`insert into match_evidence (candidate_id, job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
        values (${holder.id}, ${id}, 1, 'strong', null, 1, 1, '0.700', ${JSON.stringify(items)}, ${T0}, 1)`.execute(db)
    }
  }
  return id
}

async function familyOf(db: Db, id: string) {
  return (await sql<{ role_family: string | null; seniority_marker: string | null; posted_at: Date | null; posted_date_kind: string | null }>`
    select role_family, seniority_marker, posted_at, posted_date_kind from job_posting where id = ${id}`.execute(db)).rows[0]!
}

async function criteriaRows(db: Db) {
  return (await sql<{ candidate_id: string; target_role_families: string[]; seniority_floor: string; min_core_match_percent: number; version: number }>`
    select candidate_id, target_role_families, seniority_floor, min_core_match_percent, version from job_criteria order by candidate_id`.execute(db)).rows
}

async function snapshot(db: Db, table: string, order: string) {
  return (await sql`select * from ${sql.table(table)} order by ${sql.raw(order)}`.execute(db)).rows
}

/** The AC-8.5 live distribution shape (6 rows). */
async function seedLiveShape(db: Db, holders?: { id: string }[]) {
  const rows: Record<string, string> = {}
  const shape: [string, Seed][] = [
    ["Hotline Paralegal", { title: "Hotline Paralegal", family: null, status: "skipped", skipReason: "not_software_role", prefilter: true }],
    ["Marketing Operations Specialist", { title: "Marketing Operations Specialist", family: null, status: "skipped", skipReason: "not_software_role", prefilter: true }],
    ["Senior Frontend Engineer", { title: "Senior Frontend Engineer", family: "senior_frontend", status: "skipped", skipReason: "unsupported_application_system" }],
    ["Solutions Architect", { title: "Solutions Architect", family: "other", status: "evaluation_failed", failure: "not_configured" }],
    ["TAM Architect", { title: "TAM Architect", family: "other", status: "evaluation_failed", failure: "not_configured" }],
    ["Senior Software Engineer", { title: "Senior Software Engineer", family: "other", status: "evaluation_failed", failure: "not_configured" }],
  ]
  for (const [label, s] of shape) rows[label] = await seedPosting(db, { ...s, holders })
  return rows
}

describe("AC-8.1 @AC-8.1 schema, defaults and ordering (migration-and-performance:31-104)", () => {
  it("migration:32 adds posted date and basis as null for every existing row; the row count stays", async () => {
    const db = await databaseAt("0019-candidate-posting")
    for (const status of ["checking", "waiting_to_be_checked", "ranked", "excluded", "skipped", "evaluation_failed"]) {
      for (let i = 0; i < 50; i++) await seedPosting(db, { title: `Senior Frontend Engineer ${i}`, family: "senior_frontend", status, skipReason: status === "skipped" ? "weak_core_match" : status === "excluded" ? "violated_rule" : null, failure: status === "evaluation_failed" ? "provider_error" : null })
    }
    const { error } = await migrate0020(db)
    expect(error).toBeUndefined()
    const { rows } = await sql<{ n: string; dated: string; based: string }>`select count(*) as n, count(posted_at) as dated, count(posted_date_kind) as based from job_posting`.execute(db)
    expect(rows[0]).toEqual({ n: "300", dated: "0", based: "0" })
  })

  it("migration:39 @AC-7.10 adds not_checked to the status check and moves no existing row to it", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const kofi = await addCandidate(db, "kofi@example.test")
    const op = await operatorId(db)
    for (const status of ["checking", "waiting_to_be_checked", "ranked", "excluded", "skipped", "evaluation_failed"]) {
      await seedPosting(db, { title: "Senior Frontend Engineer", status, holders: [{ id: op }, { id: kofi }] })
    }
    const before = await snapshot(db, "candidate_posting", "candidate_id, job_posting_id")
    expect((await migrate0020(db)).error).toBeUndefined()
    expect(await snapshot(db, "candidate_posting", "candidate_id, job_posting_id")).toEqual(before)
    const anyPosting = (before[0] as { job_posting_id: string }).job_posting_id
    await sql`update candidate_posting set status = 'not_checked' where job_posting_id = ${anyPosting} and candidate_id = ${op}`.execute(db)
    await expect(sql`update candidate_posting set status = 'hidden' where job_posting_id = ${anyPosting}`.execute(db)).rejects.toThrow(/check/)
  })

  it("migration:48 / :56 every Candidate's Job criteria row gets the nine defaults and hide_entry_level; other values and row count stay", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const op = await operatorId(db)
    await sql`update job_criteria set min_core_match_percent = 75, frameworks = '{React}', technologies = '{TypeScript}' where candidate_id = ${op}`.execute(db)
    const kofi = await addCandidate(db, "kofi@example.test")
    await sql`update job_criteria set min_core_match_percent = 60 where candidate_id = ${kofi}`.execute(db)
    await addCandidate(db, "wanjiru@example.test")
    expect((await migrate0020(db)).error).toBeUndefined()
    const rows = await criteriaRows(db)
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row).toMatchObject({ target_role_families: DEFAULT_TARGETS, seniority_floor: "hide_entry_level" })
    expect(rows.find((r) => r.candidate_id === op)).toMatchObject({ min_core_match_percent: 75 })
    expect(rows.find((r) => r.candidate_id === kofi)).toMatchObject({ min_core_match_percent: 60 })
    const { rows: lists } = await sql<{ frameworks: string[]; technologies: string[] }>`select frameworks, technologies from job_criteria where candidate_id = ${op}`.execute(db)
    expect(lists[0]).toEqual({ frameworks: ["React"], technologies: ["TypeScript"] })
  })

  it("the job_criteria checks refuse an empty, unknown or over-13 family set and an unknown floor", async () => {
    const db = await databaseAt("0019-candidate-posting")
    expect((await migrate0020(db)).error).toBeUndefined()
    const op = await operatorId(db)
    for (const bad of [sql`'{}'::text[]`, sql`'{robotics}'::text[]`, sql`array_fill('backend'::text, array[14])`]) {
      await expect(sql`update job_criteria set target_role_families = ${bad} where candidate_id = ${op}`.execute(db)).rejects.toThrow(/check/)
    }
    await expect(sql`update job_criteria set seniority_floor = 'senior_only' where candidate_id = ${op}`.execute(db)).rejects.toThrow(/check/)
  })

  it("the job_posting checks: posted date and basis are null together; basis and marker take only known values", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const id = await seedPosting(db, { title: "Senior Frontend Engineer", family: "senior_frontend" })
    expect((await migrate0020(db)).error).toBeUndefined()
    await expect(sql`update job_posting set posted_at = now() where id = ${id}`.execute(db)).rejects.toThrow(/check/)
    await expect(sql`update job_posting set posted_date_kind = 'published' where id = ${id}`.execute(db)).rejects.toThrow(/check/)
    await expect(sql`update job_posting set posted_at = now(), posted_date_kind = 'created' where id = ${id}`.execute(db)).rejects.toThrow(/check/)
    await expect(sql`update job_posting set seniority_marker = 'junior' where id = ${id}`.execute(db)).rejects.toThrow(/check/)
    await sql`update job_posting set posted_at = now(), posted_date_kind = 'updated', seniority_marker = 'entry' where id = ${id}`.execute(db)
  })

  it("migration:64 refuses to run before 0016 to 0019: applying only 0020 on a 0015 database fails and leaves it at 0015", async () => {
    expect(ALL(), "0020-role-relevance must be registered in migrationsFor()").toHaveProperty(MIGRATION)
    const db = await databaseAt("0015-retention")
    const only = { ...upTo("0015-retention"), [MIGRATION]: ALL()[MIGRATION]! }
    const { error } = await migrate0020(db, only)
    expect(error).toBeDefined()
    expect((await applied(db)).at(-1)).toBe("0015-retention")
  })

  it("migration:71 the migrate step applies 0016 to 0019 before 0020 and records the 0020 schema marker", async () => {
    const db = await databaseAt("0015-retention")
    const { error, results } = await migrate0020(db)
    expect(error).toBeUndefined()
    expect(results?.map((r) => r.migrationName)).toEqual(["0016-multi-candidate", "0017-row-level-security", "0018-owner-preferences", "0019-candidate-posting", MIGRATION])
    const markers = (await sql<{ name: string }>`select name from migration_marker`.execute(db)).rows.map((r) => r.name)
    expect(markers).toContain(MIGRATION)
    expect(SCHEMA_MARKERS).toContain(MIGRATION)
  })

  it("migration:79 deletes no row and clears no column other than role family", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const ids = await seedLiveShape(db)
    await seedPosting(db, { title: "Senior Data Engineer", family: "other", status: "ranked", core: ["Build pipelines"] })
    const tables = [
      ["job_posting", "id"],
      ["candidate_posting", "candidate_id, job_posting_id"],
      ["match_evidence", "candidate_id, job_posting_id"],
      ["application", "id"],
      ["job_criteria", "candidate_id"],
    ] as const
    const before = Object.fromEntries(await Promise.all(tables.map(async ([t, o]) => [t, await snapshot(db, t, o)] as const)))
    expect((await migrate0020(db)).error).toBeUndefined()
    for (const [table, order] of tables) {
      const after = (await snapshot(db, table, order)) as Record<string, unknown>[]
      const was = before[table] as Record<string, unknown>[]
      expect(after).toHaveLength(was.length)
      for (const [i, row] of was.entries()) {
        for (const [column, value] of Object.entries(row)) {
          if (table === "job_posting" && column === "role_family") continue
          if (value !== null) expect(after[i]![column], `${table}.${column}`).toEqual(value)
        }
      }
    }
    expect(Object.keys(ids)).toHaveLength(6)
  })
})

describe("AC-8.2 @AC-8.2 reclassification and seniority marker (migration:91-180)", () => {
  it("migration:92 recomputes every titled posting's family with the new classifier", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const table: [string, string, string, string[] | undefined, string][] = [
      ["Solutions Architect", "evaluation_failed", "other", undefined, "solutions_customer"],
      ["TAM Architect", "evaluation_failed", "other", undefined, "solutions_customer"],
      ["Senior Data Engineer", "ranked", "other", ["Build pipelines"], "data_ml"],
      ["Senior Platform Engineer", "ranked", "devops_platform", ["Run the platform"], "platform_engineering"],
      ["Site Reliability Engineer", "skipped", "devops_platform", ["Own on-call"], "devops_platform"],
      ["Senior Software Engineer", "ranked", "other", ["Build services"], "software_engineering"],
      ["Data Engineering Lead", "ranked", "technical_lead", ["Write Python and ship pipelines hands-on"], "data_ml"],
      ["Senior Frontend Engineer", "ranked", "senior_frontend", ["Build React UIs"], "senior_frontend"],
    ]
    const ids: string[] = []
    for (const [title, status, family, core] of table) {
      ids.push(await seedPosting(db, { title, status, family, core, skipReason: status === "skipped" ? "weak_core_match" : null, failure: status === "evaluation_failed" ? "not_configured" : null }))
    }
    expect((await migrate0020(db)).error).toBeUndefined()
    for (const [i, row] of table.entries()) expect((await familyOf(db, ids[i]!)).role_family, row[0]).toBe(row[4])
  })

  it("migration:115 the core-responsibility rule turns an evaluated Engineering Lead into people_management only", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const evaluated = await seedPosting(db, { title: "Engineering Lead", family: "technical_lead", core: ["Hiring, performance reviews and line management of 12 engineers"] })
    const unevaluated = await seedPosting(db, { title: "Engineering Lead", family: "technical_lead", status: "checking" })
    expect((await migrate0020(db)).error).toBeUndefined()
    expect((await familyOf(db, evaluated)).role_family).toBe("people_management")
    expect((await familyOf(db, unevaluated)).role_family).toBe("technical_lead")
  })

  it("migration:123 only the Operator's core responsibilities feed the rule", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const op = await operatorId(db)
    const kofi = await addCandidate(db, "kofi@example.test")
    const id = await seedPosting(db, {
      title: "Engineering Lead",
      family: "technical_lead",
      holders: [{ id: op, status: "checking" }, { id: kofi, core: ["Hiring, performance reviews and line management of 12 engineers"] }],
    })
    expect((await migrate0020(db)).error).toBeUndefined()
    expect((await familyOf(db, id)).role_family).toBe("technical_lead")
  })

  it("migration:131 every titled posting gets a seniority marker; with the default floor only the Junior title is entry", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const titles = ["Junior Frontend Developer", "Senior Frontend Engineer", "Software Engineer", "Senior/Junior Developer"]
    const ids = await Promise.all(titles.map((title) => seedPosting(db, { title, family: "senior_frontend" })))
    expect((await migrate0020(db)).error).toBeUndefined()
    const markers = await Promise.all(ids.map(async (id) => (await familyOf(db, id)).seniority_marker))
    for (const marker of markers) expect(["entry", "mid_plus", "none"]).toContain(marker)
    expect(markers.map((m) => m === "entry")).toEqual([true, false, false, false])
  })

  it("migration:138 six not_software_role skips keep a null family and stay skipped", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await seedPosting(db, { title: `Hotline Paralegal ${i}`, family: null, status: "skipped", skipReason: "not_software_role", prefilter: true }))
    expect((await migrate0020(db)).error).toBeUndefined()
    for (const id of ids) {
      expect((await familyOf(db, id)).role_family).toBeNull()
      const { rows } = await sql<{ status: string; skip_reason: string }>`select status, skip_reason from candidate_posting where job_posting_id = ${id}`.execute(db)
      expect(rows[0]).toEqual({ status: "skipped", skip_reason: "not_software_role" })
    }
  })

  it("migration:145 an untitled posting keeps family other and gets no seniority marker", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const id = await seedPosting(db, { title: null, family: "other", status: "checking", origin: "pasted_link" })
    expect((await migrate0020(db)).error).toBeUndefined()
    expect(await familyOf(db, id)).toMatchObject({ role_family: "other", seniority_marker: null })
  })

  it("migration:152 logs family counts before and after and each Candidate's hidden counts per reason", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const op = await operatorId(db)
    const kofi = await addCandidate(db, "kofi@example.test")
    await seedLiveShape(db, [{ id: op }])
    for (let i = 0; i < 10; i++) await seedPosting(db, { title: `Senior Frontend Engineer ${i}`, family: "senior_frontend", holders: [{ id: op }, { id: kofi }] })
    const { error, log } = await migrate0020(db)
    expect(error).toBeUndefined()
    expect(log).toMatchObject({ migration: MIGRATION })
    expect(log).toHaveProperty("familiesBefore")
    expect(log).toHaveProperty("familiesAfter")
    const before = log!.familiesBefore as Record<string, number>
    const after = log!.familiesAfter as Record<string, number>
    expect(before.other).toBe(3)
    expect(after.solutions_customer).toBe(2)
    expect(after.software_engineering).toBe(1)
    const candidates = log!.hidden as { candidateId: string; hidden: Record<string, number> }[]
    const kofiLog = candidates.find((c) => c.candidateId === kofi)!
    expect(kofiLog.hidden).toEqual({ offTarget: 0, belowSeniorityFloor: 0, undated: 10, olderThan60Days: 0 })
    const opLog = candidates.find((c) => c.candidateId === op)!
    expect(Object.values(opLog.hidden).reduce((a, b) => a + b, 0)).toBe(16)
  })

  it("migration:163 makes no AI call and no network request with 500 postings", async () => {
    const db = await databaseAt("0019-candidate-posting")
    for (let i = 0; i < 500; i++) await seedPosting(db, { title: i % 2 ? `Senior Data Engineer ${i}` : `Engineering Lead ${i}`, family: "other" })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is off"))
    try {
      expect((await migrate0020(db)).error).toBeUndefined()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("AC-8.3 @AC-8.3 statuses, evidence and criteria version are unchanged (migration:172-186)", () => {
  it("migration:173 no status, skip reason, skip detail, failure, Match evidence or technologies changes", async () => {
    const db = await databaseAt("0019-candidate-posting")
    await seedLiveShape(db)
    await seedPosting(db, { title: "Senior Frontend Engineer", family: "senior_frontend", status: "ranked", core: ["Build React"] })
    await seedPosting(db, { title: "Frontend Engineer", family: "senior_frontend", status: "excluded", skipReason: "violated_rule", core: ["Build React"] })
    await seedPosting(db, { title: "Fullstack Engineer", family: "fullstack", status: "skipped", skipReason: "weak_core_match", core: ["Build APIs"] })
    const cp = await snapshot(db, "candidate_posting", "candidate_id, job_posting_id")
    const me = await snapshot(db, "match_evidence", "candidate_id, job_posting_id")
    const tech = (await sql`select id, technologies from job_posting order by id`.execute(db)).rows
    expect((await migrate0020(db)).error).toBeUndefined()
    expect(await snapshot(db, "candidate_posting", "candidate_id, job_posting_id")).toEqual(cp)
    expect(await snapshot(db, "match_evidence", "candidate_id, job_posting_id")).toEqual(me)
    expect((await sql`select id, technologies from job_posting order by id`.execute(db)).rows).toEqual(tech)
  })

  it("migration:181 the criteria version stays 4", async () => {
    const db = await databaseAt("0019-candidate-posting")
    await sql`update job_criteria set version = 4`.execute(db)
    expect((await migrate0020(db)).error).toBeUndefined()
    expect((await criteriaRows(db))[0]!.version).toBe(4)
  })
})

describe("AC-8.4 @AC-8.4 @AC-8.5 @AC-3.4 live distribution after the migration (migration:189-252)", () => {
  async function hiddenCountsFor(db: Db, candidateId: string, today: string) {
    // Read-side reasons per AC-3.4, computed from stored facts the same way the contract defines them.
    const { rows } = await sql<{ reason: string; n: string }>`
      with c as (select target_role_families t, seniority_floor f from job_criteria where candidate_id = ${candidateId})
      select case
        when p.prefilter_skip is not null or (p.title is not null and btrim(p.title) <> '' and not (coalesce(p.role_family = any((select t from c)::text[]), false))) then 'offTarget'
        when (select f from c) = 'hide_entry_level' and p.seniority_marker = 'entry' then 'belowSeniorityFloor'
        when p.posted_at is null then 'undated'
        when (${today}::date - (p.posted_at at time zone 'Africa/Lagos')::date) > 60 then 'olderThan60Days'
        else 'visible' end as reason, count(*) as n
      from candidate_posting cp join job_posting p on p.id = cp.job_posting_id where cp.candidate_id = ${candidateId} group by 1`.execute(db)
    return Object.fromEntries(rows.map((r) => [r.reason, Number(r.n)]))
  }

  it("migration:189 / :198 2,222 Operator postings in the live distribution: all hidden, 1,135+ off-target by first reason, rest undated", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const op = await operatorId(db)
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at, prefilter_skip)
      select gen_random_uuid(), 'https://x.test/' || g, g::text, 'https://x.test/' || g, 'greenhouse', 'automatic', 'employer_board',
        case when g <= 1135 then 'Hotline Paralegal ' || g when g <= 1293 then 'Senior Frontend Engineer ' || g when g % 2 = 0 then 'Solutions Architect ' || g else 'Senior Software Engineer ' || g end,
        lower(case when g <= 1135 then 'Hotline Paralegal ' || g when g <= 1293 then 'Senior Frontend Engineer ' || g when g % 2 = 0 then 'Solutions Architect ' || g else 'Senior Software Engineer ' || g end), 'Co', '{}', case when g <= 1135 then null when g <= 1293 then 'senior_frontend' else 'other' end, ${T0},
        case when g <= 1135 then 'not_software_role' else null end
      from generate_series(1, 2222) g`.execute(db)
    await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, evaluation_failure, discovered_at)
      select ${op}::uuid, p.id, 'employer_board',
        case when p.prefilter_skip is not null or p.role_family = 'senior_frontend' then 'skipped' else 'evaluation_failed' end,
        case when p.prefilter_skip is not null then 'not_software_role' when p.role_family = 'senior_frontend' then 'unsupported_application_system' else null end,
        case when p.prefilter_skip is null and p.role_family <> 'senior_frontend' then 'not_configured' else null end, p.discovered_at
      from job_posting p`.execute(db)
    const { error, log } = await migrate0020(db)
    expect(error).toBeUndefined()
    const counts = await hiddenCountsFor(db, op, "2026-10-24")
    expect(counts.visible ?? 0).toBe(0)
    expect(counts.offTarget).toBeGreaterThanOrEqual(1135)
    expect((counts.offTarget ?? 0) + (counts.undated ?? 0)).toBe(2222)
    const opLog = (log!.hidden as { candidateId: string; hidden: Record<string, number> }[]).find((c) => c.candidateId === op)!
    expect(Object.values(opLog.hidden).reduce((a, b) => a + b, 0)).toBe(2222)
    expect(opLog.hidden).toMatchObject({ offTarget: counts.offTarget, undated: counts.undated, belowSeniorityFloor: 0, olderThan60Days: 0 })
  })

  it("migration:207 / :226 the AC-8.5 shape re-filters as the PRD requires, per Candidate", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const op = await operatorId(db)
    const kofi = await addCandidate(db, "kofi@example.test")
    const ids = await seedLiveShape(db, [{ id: op }, { id: kofi }])
    const statusBefore = await snapshot(db, "candidate_posting", "candidate_id, job_posting_id")
    expect((await migrate0020(db)).error).toBeUndefined()
    await sql`update job_posting set posted_at = ${"2026-10-20T11:00:00Z"}, posted_date_kind = 'published'`.execute(db)
    expect((await familyOf(db, ids["Solutions Architect"]!)).role_family).toBe("solutions_customer")
    expect((await familyOf(db, ids["TAM Architect"]!)).role_family).toBe("solutions_customer")
    expect((await familyOf(db, ids["Senior Software Engineer"]!)).role_family).toBe("software_engineering")
    expect(await snapshot(db, "candidate_posting", "candidate_id, job_posting_id")).toEqual(statusBefore)
    expect(await hiddenCountsFor(db, op, "2026-10-24")).toEqual({ offTarget: 4, visible: 2 })
    await sql`update job_criteria set target_role_families = ${["senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering", "backend", "mobile", "platform_engineering", "devops_platform", "people_management", "data_ml", "solutions_customer", "other"]}::text[], seniority_floor = 'all_levels' where candidate_id = ${kofi}`.execute(db)
    expect(await hiddenCountsFor(db, kofi, "2026-10-24")).toEqual({ offTarget: 2, visible: 4 })
  })
})

describe("AC-8.1 @AC-8.1 idempotency, empty install and rollback on failure (migration:254-284)", () => {
  it("migration:255 a second migrate step does not re-run 0020; a saved data_ml target stays", async () => {
    const db = await databaseAt("0019-candidate-posting")
    expect((await migrate0020(db)).error).toBeUndefined()
    await sql`update job_criteria set target_role_families = array_append(target_role_families, 'data_ml')`.execute(db)
    const again = await migrate0020(db)
    expect(again.error).toBeUndefined()
    expect(again.results).toEqual([])
    expect((await criteriaRows(db))[0]!.target_role_families).toContain("data_ml")
  })

  it("migration:262 an installation with no postings migrates and stores the defaults", async () => {
    const db = await databaseAt("0019-candidate-posting")
    expect((await migrate0020(db)).error).toBeUndefined()
    expect((await criteriaRows(db))[0]).toMatchObject({ target_role_families: DEFAULT_TARGETS, seniority_floor: "hide_entry_level" })
  })

  it("migration:269 a failure while writing role families rolls back the whole migration", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const ids: string[] = []
    for (let i = 0; i < 300; i++) ids.push(await seedPosting(db, { title: i % 3 ? `Senior Data Engineer ${i}` : `Solutions Architect ${i}`, family: "other" }))
    // Make the role-family write fail: a trigger that raises on any update to role_family.
    await sql`create function e6_fail() returns trigger language plpgsql as $$ begin raise exception 'e6 forced failure'; end $$`.execute(db)
    await sql`create trigger e6_fail before update of role_family on job_posting for each row execute function e6_fail()`.execute(db)
    const { error } = await migrate0020(db)
    expect(String(error)).toMatch(/e6 forced failure/)
    expect(await applied(db)).not.toContain(MIGRATION)
    const columns = (await sql<{ column_name: string }>`select column_name from information_schema.columns where table_name in ('job_posting', 'job_criteria')`.execute(db)).rows.map((r) => r.column_name)
    for (const col of ["posted_at", "posted_date_kind", "seniority_marker", "target_role_families", "seniority_floor"]) expect(columns).not.toContain(col)
    const { rows } = await sql<{ n: string }>`select count(*) as n from job_posting where role_family <> 'other'`.execute(db)
    expect(rows[0]!.n).toBe("0")
  })
})

describe("CHK-30 @AC-8.1 the status-check lookup refuses unless exactly one constraint matches (threat-model CHK-30, SEC-603)", () => {
  async function checks(db: Db) {
    return (await sql<{ table: string; name: string; def: string }>`
      select conrelid::regclass::text as table, conname::text as name, pg_get_constraintdef(oid) as def
      from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace order by 1, 2`.execute(db)).rows
  }

  it("zero status checks on candidate_posting: 0020 refuses, rolls back and is not recorded", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const name = (await sql<{ name: string }>`select conname::text as name from pg_constraint where conrelid = 'candidate_posting'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%'`.execute(db)).rows
    expect(name).toHaveLength(1)
    await sql`alter table candidate_posting drop constraint ${sql.id(name[0]!.name)}`.execute(db)
    const { error } = await migrate0020(db)
    expect(String(error)).toMatch(/expected one status check on candidate_posting, found 0/)
    expect(await applied(db)).not.toContain(MIGRATION)
    const columns = (await sql<{ column_name: string }>`select column_name from information_schema.columns where table_name = 'job_posting'`.execute(db)).rows.map((r) => r.column_name)
    expect(columns).not.toContain("posted_at")
  })

  it("two status checks on candidate_posting: 0020 refuses and both checks are left as they were", async () => {
    const db = await databaseAt("0019-candidate-posting")
    await sql`alter table candidate_posting add constraint e6_second_status_check check (status <> 'bogus')`.execute(db)
    const before = await checks(db)
    const { error } = await migrate0020(db)
    expect(String(error)).toMatch(/expected one status check on candidate_posting, found 2/)
    expect(await applied(db)).not.toContain(MIGRATION)
    expect(await checks(db)).toEqual(before)
  })

  it("exactly one match: of the existing check constraints, only candidate_posting_status_check changes, and it now allows not_checked", async () => {
    const db = await databaseAt("0019-candidate-posting")
    const before = await checks(db)
    expect((await migrate0020(db)).error).toBeUndefined()
    const after = await checks(db)
    const key = (c: { table: string; name: string }) => `${c.table}.${c.name}`
    const afterByKey = new Map(after.map((c) => [key(c), c.def]))
    const changed = before.filter((c) => afterByKey.get(key(c)) !== c.def).map(key)
    expect(changed).toEqual(["candidate_posting.candidate_posting_status_check"])
    expect(afterByKey.get("candidate_posting.candidate_posting_status_check")).toContain("not_checked")
    // New checks belong only to the 0020 columns on job_posting and job_criteria.
    const added = after.filter((c) => !before.some((b) => key(b) === key(c))).map((c) => c.table)
    expect([...new Set(added)].sort()).toEqual(["job_criteria", "job_posting"])
  })
})
