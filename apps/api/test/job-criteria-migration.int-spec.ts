import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrations } from "../src/db/migrations/index.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"

/**
 * migration-and-compatibility.feature against fresh databases migrated to
 * 0011, seeded, then migrated to 0012. The 0004 column is numeric(4,3) with
 * check (0, 1], so the out-of-range Gherkin values are written after widening
 * the column and dropping the check (architecture "Storage").
 */
const before0012 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0012"))
/**
 * The image that shipped 0012 as its latest migration. Later migrations
 * (EPIC-0005's 0013-stack-posts, EPIC-0003's 0014-access-request, the EPIC-0002
 * tenancy migrations 0016 to 0019) are tested in their own files.
 */
const through0012 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < "0013"))
const opened: { name: string; db: Kysely<unknown> }[] = []
/** QA-05: records every non-loopback request made while 0012 runs. */
const network = setupServer()
const outbound = new OutboundRecorder(network)
beforeAll(() => network.listen())
afterAll(() => network.close())

async function freshDatabase(): Promise<Kysely<unknown>> {
  const admin = createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
  const name = `ja_jc_mig_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  try {
    await sql`create database ${sql.id(name)}`.execute(admin)
  } finally {
    await admin.destroy()
  }
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  const db = createDatabase(url.toString()) as unknown as Kysely<unknown>
  opened.push({ name, db })
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => before0012 } }).migrateToLatest()
  if (error) throw error
  return db
}

afterEach(async () => {
  const admin = createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
  for (const { name, db } of opened.splice(0)) {
    await db.destroy()
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin)
  }
  await admin.destroy()
  vi.restoreAllMocks()
})

/** Runs 0012, returning its result and the JSON migration log line. */
async function migrate(db: Kysely<unknown>): Promise<{ error: unknown; log: Record<string, unknown> | null }> {
  const lines: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    if (text.includes('"migration":"0012-job-criteria"')) {
      lines.push(text)
      return true
    }
    return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest)
  })
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => through0012 } }).migrateToLatest()
  vi.restoreAllMocks()
  return { error, log: lines[0] ? (JSON.parse(lines[0]) as Record<string, unknown>) : null }
}

async function setThreshold(db: Kysely<unknown>, value: string | null) {
  if (value === null) {
    await sql`delete from evaluation_setting`.execute(db)
    return
  }
  await sql`alter table evaluation_setting drop constraint if exists evaluation_setting_match_threshold_check`.execute(db)
  await sql`alter table evaluation_setting alter column match_threshold type numeric`.execute(db)
  await sql`update evaluation_setting set match_threshold = ${value}::numeric`.execute(db)
}

type Seed = { status: string; skipReason?: string | null; covered?: number; total?: number; evidence?: boolean; text?: string }

async function seed(db: Kysely<unknown>, options: Seed): Promise<string> {
  const id = randomUUID()
  const url = `https://x.test/${id}`
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, posting_text, structured, status, skip_reason, discovered_at)
    values (${id}, ${url}, ${id.slice(0, 8)}, ${url}, 'greenhouse', 'automatic', 'employer_board', 'Role', 'Co', ${options.text ?? "Remote."}, '{}', ${options.status}, ${options.skipReason ?? null}, now())`.execute(db)
  if (options.evidence !== false) {
    const covered = options.covered ?? 7
    const total = options.total ?? 10
    const strong = options.status === "ranked"
    const weak = strong ? null : options.skipReason === "uncovered_mandatory_prerequisite" ? "unmet_mandatory" : "coverage_below_threshold"
    await sql`insert into match_evidence (job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at)
      values (${id}, 1, ${strong ? "strong" : "weak"}, ${weak}, ${covered}, ${total}, 0.700, '[]', now())`.execute(db)
  }
  return id
}

async function statusOf(db: Kysely<unknown>, id: string) {
  const { rows } = await sql<{ status: string; skip_reason: string | null }>`select status, skip_reason from job_posting where id = ${id}`.execute(db)
  return rows[0]
}

async function criteria(db: Kysely<unknown>) {
  const { rows } = await sql<{ min_core_match_percent: number; frameworks: string[]; technologies: string[]; version: number }>`select * from job_criteria`.execute(db)
  return rows
}

describe("migration 0012-job-criteria (migration-and-compatibility.feature)", () => {
  it("@ac-7.1 copies 0.700 as 70 with empty lists and logs zero changes", async () => {
    const db = await freshDatabase()
    await Promise.all(Array.from({ length: 200 }, (_, i) => seed(db, i % 2 ? { status: "ranked", covered: 8 } : { status: "skipped", skipReason: "weak_core_match", covered: 5 })))
    const { error, log } = await migrate(db)
    expect(error).toBeUndefined()
    expect(await criteria(db)).toEqual([expect.objectContaining({ min_core_match_percent: 70, frameworks: [], technologies: [], version: 1 })])
    expect(log).toEqual({ migration: "0012-job-criteria", storedThreshold: "0.700", minCoreMatchPercent: 70, changedPostings: 0 })
  })

  it("@ac-7.1 every status and skip reason in a production-shaped snapshot is identical after migration", async () => {
    const db = await freshDatabase()
    const snapshot: Seed[] = [
      { status: "ranked", covered: 7 }, { status: "ranked", covered: 10 }, { status: "skipped", skipReason: "weak_core_match", covered: 6 },
      { status: "skipped", skipReason: "weak_core_match", covered: 2, total: 3 }, { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", covered: 9 },
      { status: "skipped", skipReason: "no_core_responsibilities", covered: 0, total: 0 }, { status: "excluded", skipReason: "violated_rule", covered: 3 },
      { status: "evaluation_failed", evidence: false }, { status: "checking", evidence: false }, { status: "waiting_to_be_checked", evidence: false },
      { status: "skipped", skipReason: "not_software_role", evidence: false }, { status: "skipped", skipReason: "unsupported_application_system", evidence: false },
    ]
    const ids = await Promise.all(snapshot.map((row) => seed(db, row)))
    const before = await Promise.all(ids.map((id) => statusOf(db, id)))
    expect((await migrate(db)).error).toBeUndefined()
    expect(await Promise.all(ids.map((id) => statusOf(db, id)))).toEqual(before)
  })

  it("@ac-7.1 @ac-4.5 existing postings have no technology data; evidence gets version 1 and threshold 0.700", async () => {
    const db = await freshDatabase()
    const id = await seed(db, { status: "ranked" })
    await migrate(db)
    const { rows } = await sql<{ technologies: unknown; criteria_version: number; threshold: string; criteria_technologies: string[] }>`
      select p.technologies, m.criteria_version, m.threshold::text as threshold, m.criteria_technologies from job_posting p join match_evidence m on m.job_posting_id = p.id where p.id = ${id}`.execute(db)
    expect(rows[0]).toEqual({ technologies: null, criteria_version: 1, threshold: "0.700", criteria_technologies: [] })
    expect(await statusOf(db, id)).toEqual({ status: "ranked", skip_reason: null })
  })

  it.each([
    ["0.700", 70], ["0.600", 60], ["1.000", 100], ["0.010", 1],
    ["0.655", 66], ["0.7049", 70], ["0.705", 71], ["0.6949", 69], ["0.695", 70], ["0.004", 1], ["0.005", 1], ["0.000", 1], ["0.9951", 100], ["1.250", 100], ["-0.100", 1],
  ])("@ac-7.1 @ac-7.4 a stored %s migrates to %i and the log records both", async (stored, migrated) => {
    const db = await freshDatabase()
    await setThreshold(db, stored)
    const { error, log } = await migrate(db)
    expect(error).toBeUndefined()
    expect((await criteria(db))[0]?.min_core_match_percent).toBe(migrated)
    expect(log).toMatchObject({ storedThreshold: stored, minCoreMatchPercent: migrated })
  })

  it("@ac-7.4 with no stored threshold it uses 70 with empty lists", async () => {
    const db = await freshDatabase()
    await setThreshold(db, null)
    const { log } = await migrate(db)
    expect(await criteria(db)).toEqual([expect.objectContaining({ min_core_match_percent: 70, frameworks: [], technologies: [] })])
    expect(log).toMatchObject({ storedThreshold: null, minCoreMatchPercent: 70 })
  })

  it("@ac-7.4 @ac-5.3 @ac-5.4 0.655 re-decides 21 of 32 to weak_core_match, keeps others, and logs 1 change", async () => {
    const db = await freshDatabase()
    await setThreshold(db, "0.655")
    const initech = await seed(db, { status: "ranked", covered: 21, total: 32 })
    const globex = await seed(db, { status: "ranked", covered: 7, total: 10 })
    const hooli = await seed(db, { status: "skipped", skipReason: "weak_core_match", covered: 6, total: 10 })
    const pied = await seed(db, { status: "excluded", skipReason: "violated_rule", covered: 13, total: 20 })
    const mobile = await seed(db, { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", covered: 13, total: 20 })
    const { log } = await migrate(db)
    expect(await statusOf(db, initech)).toEqual({ status: "skipped", skip_reason: "weak_core_match" })
    const { rows } = await sql<{ verdict: string; weak_reason: string; threshold: string; covered_count: number; total_count: number }>`
      select verdict, weak_reason, threshold::text as threshold, covered_count, total_count from match_evidence where job_posting_id = ${initech}`.execute(db)
    expect(rows[0]).toEqual({ verdict: "weak", weak_reason: "coverage_below_threshold", threshold: "0.660", covered_count: 21, total_count: 32 })
    // The dashboard line: floor(21·100/32) = 65, below 66.
    expect(Math.floor((21 * 100) / 32)).toBe(65)
    expect(await statusOf(db, globex)).toEqual({ status: "ranked", skip_reason: null })
    expect(await statusOf(db, hooli)).toEqual({ status: "skipped", skip_reason: "weak_core_match" })
    expect(await statusOf(db, pied)).toEqual({ status: "excluded", skip_reason: "violated_rule" })
    expect(await statusOf(db, mobile)).toEqual({ status: "skipped", skip_reason: "uncovered_mandatory_prerequisite" })
    expect(log).toMatchObject({ changedPostings: 1 })
  })

  // QA-05: migration-and-compatibility.feature "The migration makes no AI call and no network fetch" and
  // "The migration's re-decision makes no AI call".
  it.each([["0.700", 0], ["0.655", 1]])("@ac-7.1 @ac-7.4 stored %s: 0012 writes no ai_call or spend row and makes no outbound request (%i re-decided)", async (stored, changed) => {
    const db = await freshDatabase()
    await setThreshold(db, stored)
    // 21 of 32 (65.6%) is strong at 0.655 under the old rule and weak at the migrated 66.
    await seed(db, stored === "0.655" ? { status: "ranked", covered: 21, total: 32 } : { status: "ranked", covered: 8, total: 10 })
    await seed(db, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    const count = async (table: string) => (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db)).rows[0]?.n
    const before = { aiCalls: await count("ai_call"), spend: await count("spend_entry"), months: await count("spend_month") }
    outbound.reset()
    const { error, log } = await migrate(db)
    expect(error).toBeUndefined()
    expect(log).toMatchObject({ changedPostings: changed })
    expect({ aiCalls: await count("ai_call"), spend: await count("spend_entry"), months: await count("spend_month") }).toEqual(before)
    expect(before.aiCalls).toBe(0)
    expect(outbound.urls).toEqual([])
  })

  it("@ac-7.4 a failure during the re-decision rolls back the whole migration", async () => {
    const db = await freshDatabase()
    await setThreshold(db, "0.655")
    const initech = await seed(db, { status: "ranked", covered: 21, total: 32 })
    await sql`create function fail_redecide() returns trigger language plpgsql as $$ begin raise exception 'injected migration failure'; end $$`.execute(db)
    await sql`create trigger fail_redecide before update on job_posting for each statement execute function fail_redecide()`.execute(db)
    const { error } = await migrate(db)
    expect(error).toBeDefined()
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_name = 'job_criteria'`.execute(db)
    expect(rows[0]?.n).toBe(0)
    expect(await statusOf(db, initech)).toEqual({ status: "ranked", skip_reason: null })
    const threshold = await sql<{ t: string }>`select match_threshold::text as t from evaluation_setting`.execute(db)
    expect(threshold.rows[0]?.t).toBe("0.655")
  })

  it("is idempotent: running the migrator again keeps saved criteria", async () => {
    const db = await freshDatabase()
    await migrate(db)
    await sql`update job_criteria set min_core_match_percent = 80, frameworks = '{React}', version = 2`.execute(db)
    const { error } = await new Migrator({ db, provider: { getMigrations: async () => through0012 } }).migrateToLatest()
    expect(error).toBeUndefined()
    expect(await criteria(db)).toEqual([expect.objectContaining({ min_core_match_percent: 80, frameworks: ["React"] })])
  })

  it("@ac-7.2 keeps the column with a superseded comment", async () => {
    const db = await freshDatabase()
    await migrate(db)
    const { rows } = await sql<{ comment: string | null }>`
      select col_description('evaluation_setting'::regclass, (select attnum from pg_attribute where attrelid = 'evaluation_setting'::regclass and attname = 'match_threshold')) as comment`.execute(db)
    expect(rows[0]?.comment).toBe("Superseded by job_criteria (EPIC-0004). Read by no code.")
  })
})

/**
 * Repair wave 1 (finding-rollback): the previous image's writes after 0012.
 * The SQL mirrors HEAD 14e50c4 `DiscoveryPipeline.storeOnce` and
 * `DiscoveryRepository.recordEvaluation`, which name none of the 0012 columns.
 */
describe("rollback to the previous image after 0012", () => {
  async function oldImageRecordEvaluation(db: Kysely<unknown>, id: string, covered: number) {
    await sql`insert into match_evidence (job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at)
      values (${id}, 1, 'strong', null, ${covered}, 10, ${"0.700"}, '[]', now())
      on conflict (job_posting_id) do update set career_profile_version = excluded.career_profile_version, verdict = excluded.verdict,
        weak_reason = excluded.weak_reason, covered_count = excluded.covered_count, total_count = excluded.total_count,
        threshold = excluded.threshold, items = excluded.items, evaluated_at = excluded.evaluated_at`.execute(db)
    await sql`update job_posting set status = 'ranked', skip_reason = null, skip_detail = null, role_family = 'senior_frontend', evaluation_failure = null, evaluated_at = now() where id = ${id}`.execute(db)
  }

  it("old-code posting and match_evidence writes (insert and upsert) succeed without the new columns", async () => {
    const db = await freshDatabase()
    expect((await migrate(db)).error).toBeUndefined()
    const fresh = await seed(db, { status: "checking", evidence: false })
    await oldImageRecordEvaluation(db, fresh, 8)
    await oldImageRecordEvaluation(db, fresh, 9)
    const { rows } = await sql<{ criteria_version: number; criteria_technologies: string[]; covered_count: number; technologies: unknown }>`
      select m.criteria_version, m.criteria_technologies, m.covered_count, p.technologies
      from match_evidence m join job_posting p on p.id = m.job_posting_id where p.id = ${fresh}`.execute(db)
    expect(rows[0]).toEqual({ criteria_version: 0, criteria_technologies: [], covered_count: 9, technologies: null })
  })

  it("the previous image's migrator refuses the database; the documented SQL step makes it run, and roll-forward restores the marker", async () => {
    const db = await freshDatabase()
    expect((await new Migrator({ db, provider: { getMigrations: async () => through0012 } }).migrateToLatest()).error).toBeUndefined()
    const old = new Migrator({ db, provider: { getMigrations: async () => before0012 } })
    const refused = await old.migrateToLatest()
    expect(String(refused.error)).toMatch(/previously executed migration 0012-job-criteria is missing/)

    // Rollback step (architecture.r1.md "Rollback"), then the old image's migrate.
    await sql`delete from kysely_migration where name = '0012-job-criteria'`.execute(db)
    const rolledBack = await old.migrateToLatest()
    expect(rolledBack.error).toBeUndefined()
    expect(rolledBack.results).toEqual([])

    // Roll forward: restore the marker; the new image has nothing pending and does not re-run 0012.
    await sql`insert into kysely_migration (name, timestamp) values ('0012-job-criteria', now()::text)`.execute(db)
    const forward = await new Migrator({ db, provider: { getMigrations: async () => through0012 } }).migrateToLatest()
    expect(forward.error).toBeUndefined()
    expect(forward.results).toEqual([])
  })
})

describe("@ac-7.2 only migration 0012 reads evaluation_setting.match_threshold", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url))
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry)
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") && !path.endsWith(".spec.ts") ? [path] : []
    })
  }

  it("no source file except migrations 0004 (creates it) and 0012 (reads it) names the column", () => {
    const naming = files(src).filter((path) => readFileSync(path, "utf8").includes("match_threshold")).map((path) => path.slice(src.length + 1))
    expect(naming.sort()).toEqual(["db/migrations/0004-discovery.ts", "db/migrations/0012-job-criteria.ts", "db/schema.ts"])
    // schema.ts names it only in the comment explaining its absence from the type.
    expect(readFileSync(join(src, "db/schema.ts"), "utf8")).not.toMatch(/^\s+match_threshold:/m)
  })
})
