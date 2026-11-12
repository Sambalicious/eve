import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { migrationsFor } from "../src/db/migrations/index.js"

/**
 * QA-owned gap test (EPIC-0002 A1, run epic-0002-a0-a1c, qa-1). Independent of
 * multi-candidate-migration.int-spec.ts: it seeds the slice 7 and slice 8 state
 * that spec leaves out, and the r5 rows, at 0015 (the last migration on main),
 * applies 0016 to 0019 and checks values, counts, ownership and RLS.
 *
 * Gherkin: migration-and-operator-bootstrap.feature "The spend months and slice 7
 * pause state stay installation-wide until slice D", "Every spend month keeps
 * its ceiling and raise time", "Each month's spend total is equal...", "The
 * global pause keeps its value...", "The cost pause keeps its month...",
 * "Every Outcome keeps its type, source, excerpt and timestamps", "A minimal
 * record keeps its deletion time and final status", "The notification sender
 * state stays installation-wide", "The seeded migration test holds postings in
 * every role family and status", "Pre-filter skips stay skipped";
 * r5-new-tables-isolation.feature @slice-A1 migration scenarios.
 */
const OWNER_SUB = "google-sub-qa-0001"
/**
 * EPIC-0006 (architecture.r1 "Migration interplay"): this file proves EPIC-0002's chain (0016 to 0019,
 * and A2's 0022 and 0023), so it leaves out 0020-role-relevance, which reclassifies role families on
 * purpose; its own test is role-relevance-migration.int-spec.ts. It also leaves out EPIC-0007's
 * 0021-hiring-posts (run a2i), which adds four new tables and is tested by the hiring specs, and
 * EPIC-0008's 0024-alert-feed-candidate-verification (merged after A2), tested by the stack-feed specs, and
 * EPIC-0002 B1's 0027-preferences-version, tested by preferences-version-migration.int-spec.ts.
 * Before the renumbers (runs a2e and a2i) A2's migrations were 0020 and 0021.
 */
const OTHER_EPICS = new Set(["0020-role-relevance", "0021-hiring-posts", "0024-alert-feed-candidate-verification", "0025-apply-anyway", "0026-apply-anyway-bounds", "0027-preferences-version", "0028-ats-skills", "0029-ats-fit", "0030-ats-minimum", "0031-pasted-description", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0036-retry-failed-checks", "0037-retry-backfill", "0038-lead-pipeline", "0039-blocked-claim-cause", "0040-outreach-messages", "0041-lead-policy-binding"])
const throughEpic0002 = (migrations: ReturnType<typeof migrationsFor>) => Object.fromEntries(Object.entries(migrations).filter(([name]) => !OTHER_EPICS.has(name)))
const ALL = throughEpic0002(migrationsFor({ operatorGoogleSub: OWNER_SUB }))
const BEFORE = Object.fromEntries(Object.entries(ALL).filter(([name]) => name < "0016"))
const FAMILIES = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "backend", "mobile", "devops_platform", "people_management", "other"] as const
const STATUSES = ["checking", "waiting_to_be_checked", "ranked", "excluded", "skipped", "evaluation_failed"] as const
const T0 = "2026-10-20T08:00:00Z"

type Db = Kysely<unknown>
let cluster: Db
let db: Db
let name: string
const before = new Map<string, unknown>()

async function rows(table: string, order = "1"): Promise<Record<string, string | null>[]> {
  const cols = await sql<{ c: string }>`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name <> 'candidate_id' and column_name <> 'singleton' order by 1`.execute(db)
  const select = sql.join(cols.rows.map((r) => sql`${sql.ref(r.c)}::text as ${sql.id(r.c)}`))
  const { rows: out } = await sql<Record<string, string | null>>`select ${select} from ${sql.table(table)} order by ${sql.raw(order)}`.execute(db)
  return out
}

async function monthTotals(): Promise<Record<string, string>[]> {
  const { rows: out } = await sql<Record<string, string>>`
    select month::text as month, sum(case when status = 'settled' then actual_micros when status = 'reserved' then reserved_micros else 0 end)::text as micros
    from spend_entry group by month order by month`.execute(db)
  return out
}

beforeAll(async () => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
  name = `ja_qa_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  db = createDatabase(url.toString()) as unknown as Db
  const first = await new Migrator({ db, provider: { getMigrations: async () => BEFORE } }).migrateToLatest()
  if (first.error) throw first.error
  const q = (s: ReturnType<typeof sql>) => s.execute(db)

  // Slice 7: three months (an earlier unraised, a raised current one), entries in every category and status incl. form-agent and a reservation.
  await q(sql`insert into spend_month (month, ceiling_micros, raised_at, created_at) values ('2026-08-01', 40000000, null, ${T0}), ('2026-09-01', 40000000, null, ${T0}), ('2026-10-01', 60000000, ${T0}, ${T0})`)
  const categories = ["hosting", "ai", "browser", "discovery", "email"] as const
  for (const month of ["2026-08-01", "2026-09-01", "2026-10-01"]) {
    for (const category of categories) {
      await q(sql`insert into spend_entry (id, month, category, sub_budget, purpose, status, reserved_micros, actual_micros, application_id, attempt_id, created_at, settled_at)
        values (${randomUUID()}, ${month}, ${category}, null, ${category === "ai" ? "job_posting_evaluation" : category}, 'settled', 400000, ${category === "hosting" ? 400000 : 123457}, null, null, ${T0}, ${T0})`)
    }
  }
  await q(sql`insert into spend_entry (id, month, category, sub_budget, purpose, status, reserved_micros, actual_micros, application_id, attempt_id, created_at, settled_at) values
    (${randomUUID()}, '2026-10-01', 'browser', 'form_agent', 'form_agent', 'reserved', 30000, null, null, ${randomUUID()}, ${T0}, null),
    (${randomUUID()}, '2026-10-01', 'ai', 'form_agent', 'form_agent', 'released', 30000, null, null, ${randomUUID()}, ${T0}, null),
    (${randomUUID()}, '2026-10-01', 'ai', null, 'tailored_documents', 'reserved', 250000, null, null, null, now(), null)`)
  await q(sql`update control_state set global_paused = true, global_paused_at = ${T0}, cost_paused = true, cost_paused_at = ${T0},
    cost_paused_month = '2026-10-01', cost_pause_action = 'tailored_documents', cost_pause_estimate_micros = 250000, cost_pause_cleared_at = null`)
  await q(sql`insert into notification_sender_state (configured, updated_at) values (true, ${T0})`)

  // Slice 8 postings: every family in every status, an untitled one, a pre-filter skip; plus an Application with Outcomes and a minimal record.
  let n = 0
  for (const family of FAMILIES) {
    for (const status of STATUSES) {
      n += 1
      const url = `https://boards.greenhouse.io/qa/jobs/${n}`
      const reason = status === "skipped" ? (Math.ceil(n / STATUSES.length) % 2 === 0 ? "not_software_role" : "weak_core_match") : null
      await q(sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, status, skip_reason, role_family, discovered_at, evaluated_at)
        values (${randomUUID()}, ${url}, ${`Q-${n}`}, ${url}, 'greenhouse', 'automatic', ${(["employer_board", "remote_board", "pasted_link"] as const)[n % 3]}, ${`Role ${family} ${n}`}, ${`role ${family} ${n}`}, 'QA Co', '{}', ${status}, ${reason},
          ${reason === "not_software_role" ? null : family}, ${`2026-10-1${n % 10}T0${n % 10}:00:00.${String(n).padStart(6, "0")}Z`}, ${status === "checking" || status === "waiting_to_be_checked" ? null : T0})`)
    }
  }
  const untitledUrl = "https://jobs.lever.co/qa/untitled"
  await q(sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, status, role_family, discovered_at)
    values (${randomUUID()}, ${untitledUrl}, 'U-1', ${untitledUrl}, 'lever', 'automatic', 'employer_board', null, null, 'QA Co', '{}', 'waiting_to_be_checked', null, ${T0})`)
  const posting = randomUUID()
  const purl = "https://boards.greenhouse.io/qa/jobs/app"
  await q(sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, status, role_family, discovered_at, evaluated_at)
    values (${posting}, ${purl}, 'A-1', ${purl}, 'greenhouse', 'automatic', 'employer_board', 'Frontend', 'frontend', 'QA Co', '{}', 'ranked', 'senior_frontend', ${T0}, ${T0})`)
  const app = randomUUID()
  const minimal = randomUUID()
  await q(sql`insert into application (id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at)
    values (${app}, ${posting}, ${purl}, 'A-1', 'QA Co', 'Frontend', 'documents_ready', 1, ${T0}, ${T0}),
           (${minimal}, ${posting}, ${purl}, 'A-2', null, null, 'documents_ready', 1, ${T0}, ${T0})`)
  await q(sql`update application set details_deleted_at = ${T0}, final_status = 'rejection' where id = ${minimal}`)
  for (const type of ["confirmation", "rejection", "interview_invitation", "request_for_action"]) {
    await q(sql`insert into outcome (id, application_id, type, source, excerpt, created_at, updated_at) values (${randomUUID()}, ${app}, ${type}, 'candidate', ${`ex ${type}`}, ${T0}, '2026-10-21T08:00:00Z')`)
  }
  await q(sql`insert into notification_outbox (id, application_id, kind, created_at, status, payload) values
    (${randomUUID()}, null, 'cost_pause', ${T0}, 'sent', '{"month":"2026-10-01"}'), (${randomUUID()}, null, 'cost_pause', ${T0}, 'pending', '{"month":"2026-10-01"}')`)
  // r5: owner Job criteria at non-default values; verified technologies on a posting.
  await q(sql`update job_criteria set min_core_match_percent = 83, frameworks = '{React,Vue}', technologies = '{TypeScript}', version = 4`)
  await q(sql`update job_posting set technologies = '["React","TypeScript"]' where id = ${posting}`)
  await q(sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-10-19', 'QA basis', ${T0})`)

  for (const table of ["spend_month", "spend_entry", "control_state", "notification_sender_state", "outcome", "alert_feed_verification", "job_criteria"]) before.set(table, await rows(table))
  before.set("postings", await rows("job_posting", "id"))
  before.set("totals", await monthTotals())
  before.set("minimal", (await sql`select id::text, details_deleted_at::text, final_status from application where id = ${minimal}`.execute(db)).rows)

  const second = await new Migrator({ db, provider: { getMigrations: async () => ALL } }).migrateToLatest()
  if (second.error) throw second.error
})

afterAll(async () => {
  await db?.destroy()
  await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  await cluster.destroy()
})

describe("QA: slice 7 shared state through 0016-0019", () => {
  it("lands at the latest migration, 0023-runtime-no-temporary (run a2c repair wave 2; 0021 before run a2e, 0022 before run a2i)", async () => {
    const { rows: applied } = await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(db)
    expect(applied[0]?.name).toBe("0023-runtime-no-temporary")
  })

  it.each(["spend_month", "spend_entry", "control_state", "notification_sender_state", "alert_feed_verification"])("%s: rows byte-equal, no candidate_id column, no RLS (shared until slice D / r5 K6)", async (table) => {
    expect(await rows(table)).toEqual(before.get(table))
    const col = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_name = ${table} and column_name = 'candidate_id'`.execute(db)
    expect(col.rows[0]?.n).toBe(0)
    const rls = await sql<{ rls: boolean }>`select relrowsecurity as rls from pg_class where relname = ${table}`.execute(db)
    expect(rls.rows[0]?.rls).toBe(false)
  })

  it("each month's spend total is equal to the micro-USD", async () => {
    expect(await monthTotals()).toEqual(before.get("totals"))
    expect((before.get("totals") as unknown[]).length).toBe(3)
  })

  it("Outcomes keep type, source, excerpt and timestamps, owned by the owner, RLS forced", async () => {
    expect(await rows("outcome")).toEqual(before.get("outcome"))
    const own = await sql<{ n: number; owned: number }>`select count(*)::int as n, count(*) filter (where candidate_id = (select id from candidate where role = 'operator'))::int as owned from outcome`.execute(db)
    expect(own.rows[0]).toEqual({ n: 4, owned: 4 })
    const idx = await sql<{ def: string }>`select indexdef as def from pg_indexes where tablename = 'outcome'`.execute(db)
    expect(idx.rows.some((r) => /\(candidate_id\)/.test(r.def))).toBe(true)
  })

  it("a minimal record keeps its deletion time and final status", async () => {
    const { rows: now } = await sql`select id::text, details_deleted_at::text, final_status from application where final_status is not null`.execute(db)
    expect(now).toEqual(before.get("minimal"))
  })

  it("cost-pause outbox rows (sent and pending) belong to the owner", async () => {
    const { rows: out } = await sql<{ status: string; owner: boolean }>`select status, candidate_id = (select id from candidate where role = 'operator') as owner from notification_outbox where kind = 'cost_pause' order by status`.execute(db)
    expect(out).toEqual([{ status: "pending", owner: true }, { status: "sent", owner: true }])
  })
})

describe("QA: slice 8 postings through 0016-0019", () => {
  it("every posting's shared facts (title, title_folded, role_family, technologies) are byte-equal", async () => {
    const after = await rows("job_posting", "id")
    const pick = (r: Record<string, string | null>) => ({ id: r.id, title: r.title, title_folded: r.title_folded, role_family: r.role_family, technologies: r.technologies, application_url: r.application_url })
    expect(after.map(pick)).toEqual((before.get("postings") as Record<string, string | null>[]).map(pick))
  })

  it("every family x status combination has an owner candidate_posting row with the copied status", async () => {
    const { rows: out } = await sql<{ n: number; families: number; statuses: number }>`
      select count(*)::int as n, count(distinct p.role_family)::int as families, count(distinct cp.status)::int as statuses
      from candidate_posting cp join job_posting p on p.id = cp.job_posting_id join candidate c on c.id = cp.candidate_id and c.role = 'operator'`.execute(db)
    expect(out[0]).toEqual({ n: FAMILIES.length * STATUSES.length + 2, families: FAMILIES.length, statuses: STATUSES.length })
  })

  it("pre-filter skips become shared prefilter_skip facts and stay skipped for the owner", async () => {
    const { rows: out } = await sql<{ shared: number; owner_skipped: number }>`
      select count(*) filter (where p.prefilter_skip = 'not_software_role')::int as shared,
             count(*) filter (where cp.status = 'skipped' and cp.skip_reason = 'not_software_role')::int as owner_skipped
      from job_posting p join candidate_posting cp on cp.job_posting_id = p.id`.execute(db)
    expect(out[0]!.shared).toBeGreaterThan(0)
    expect(out[0]!.shared).toBe(out[0]!.owner_skipped)
  })
})

describe("QA: r5 rows through 0016-0019 (r5-new-tables-isolation.feature @slice-A1)", () => {
  it("the owner's Job criteria become the Operator's own row with every value kept", async () => {
    const { rows: out } = await sql<Record<string, unknown>>`
      select min_core_match_percent, frameworks::text, technologies::text, version, candidate_id = (select id from candidate where role = 'operator') as owner from job_criteria`.execute(db)
    expect(out).toEqual([{ min_core_match_percent: 83, frameworks: "{React,Vue}", technologies: "{TypeScript}", version: 4, owner: true }])
  })

  it("forces RLS on every candidate_id table; the policy keys on eve.candidate_id", async () => {
    const { rows: out } = await sql<{ t: string; forced: boolean; pol: number }>`
      select c.relname as t, c.relforcerowsecurity as forced, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as pol
      from pg_class c join information_schema.columns i on i.table_name = c.relname and i.column_name = 'candidate_id' and i.table_schema = 'public'
      where c.relkind = 'r' and c.relname <> 'dashboard_session' order by 1`.execute(db)
    expect(out.length).toBeGreaterThan(20)
    for (const row of out) {
      expect(row.forced, row.t).toBe(true)
      expect(row.pol, row.t).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("QA: preflight names both unsupported settings in one refusal (migration-and-operator-bootstrap.feature:960, AC 1.8)", () => {
  it("with hours 00:00 and work authorization 'Nigeria and Ghana' the error names hours_cutoff and work_authorization and nothing changes", async () => {
    const other = `ja_qa_pre_${randomUUID().replaceAll("-", "").slice(0, 16)}`
    await sql`create database ${sql.id(other)}`.execute(cluster)
    const url = new URL(inject("postgresAdminUrl"))
    url.pathname = `/${other}`
    const pre = createDatabase(url.toString()) as unknown as Db
    try {
      const first = await new Migrator({ db: pre, provider: { getMigrations: async () => BEFORE } }).migrateToLatest()
      if (first.error) throw first.error
      await sql`update evaluation_setting set hours_cutoff = '00:00'`.execute(pre)
      await sql`update candidate_setting set work_authorization = 'Nigeria and Ghana'`.execute(pre)
      const { error } = await new Migrator({ db: pre, provider: { getMigrations: async () => ALL } }).migrateToLatest()
      const message = String((error as Error | undefined)?.message ?? "")
      const { rows: last } = await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(pre)
      expect(last[0]?.name).toBe("0015-retention")
      expect(message).toMatch(/hours_cutoff/)
      expect(message).toMatch(/work_authorization/)
    } finally {
      await pre.destroy()
      await sql`drop database if exists ${sql.id(other)} with (force)`.execute(cluster)
    }
  })
})
