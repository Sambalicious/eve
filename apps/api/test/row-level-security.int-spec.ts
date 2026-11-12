import { randomUUID } from "node:crypto"

import { Controller, Get, type INestApplication, NotFoundException, Param } from "@nestjs/common"
import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { CANDIDATE_TABLES } from "../src/db/migrations/0016-multi-candidate.js"
import { INSTALLATION_TABLES, MIXED_TABLES, RLS_TABLES as RLS_TABLES_0017 } from "../src/db/migrations/0017-row-level-security.js"
import { OWNER_PREFERENCE_TABLES } from "../src/db/migrations/0018-owner-preferences.js"
import { CANDIDATE_POSTING_TABLES } from "../src/db/migrations/0019-candidate-posting.js"
import { HIRING_TABLES } from "../src/db/migrations/0021-hiring-posts.js"
import { STACK_FEED_VERIFICATION_TABLES } from "../src/db/migrations/0024-alert-feed-candidate-verification.js"
import { SIMPLIFY_EVE_TABLES } from "../src/db/migrations/0033-simplify-eve.js"
import { LEAD_TABLES } from "../src/db/migrations/0038-lead-pipeline.js"
import { OUTREACH_TABLES } from "../src/db/migrations/0040-outreach-messages.js"

/** Every table with RLS: 0017's, plus the Candidate tables 0018, 0019, 0021, 0022 and 0040 create with their policy. */
const RLS_TABLES: readonly string[] = [...RLS_TABLES_0017, ...OWNER_PREFERENCE_TABLES, ...CANDIDATE_POSTING_TABLES, ...HIRING_TABLES, ...STACK_FEED_VERIFICATION_TABLES, ...SIMPLIFY_EVE_TABLES, ...LEAD_TABLES, ...OUTREACH_TABLES]
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor } from "./support/candidate-posting.js"

/**
 * EPIC-0002 A1 unit 3 (architecture r2, "Proof (tests that fail the build)").
 * RLS is the enforcement behind app scoping: a query that forgets
 * `where candidate_id = ?` sees only the scope's rows, and the API answers 404.
 */

/** Every table, classified (architecture r2 table classification). A new table fails the catalog test until it is listed. */
const SHARED_TABLES = [
  "employer_board", "remote_board", "employer_list_state", "evaluation_setting", "control_state",
  "notification_sender_state", "ai_provider_approval", "spend_month", "spend_entry", "ai_terms_record",
  // Legacy, unread since EPIC-0008, dropped later (kept for rollback path A, AR-5).
  "alert_feed_verification",
]
/** EPIC-0010 (0031): the shared posting table is owner-scoped, not candidate_id-scoped: forced RLS, policy job_posting_owner. */
const OWNER_SCOPED_TABLES = ["job_posting"]
const IDENTITY_TABLES = ["candidate", "dashboard_session", "sign_in_attempt", "migration_marker"]
const BOOKKEEPING_TABLES = ["kysely_migration", "kysely_migration_lock"]

/**
 * The only `security definer` functions allowed in the application schema (architecture r2: console, spend, dispatcher, email claim, deletion; none exist in A1).
 * A2 repair wave 3 (migration 0022): the Candidate binding's writer and reader, reviewed with F-SEC-10.
 */
const ALLOWED_DEFINER_FUNCTIONS: readonly string[] = ["bind_candidate(uuid)", "bound_candidate()"]

/**
 * A handler that forgets the Candidate predicate on purpose: it reads an
 * Application by ID alone, as a buggy repository would.
 */
@Controller("v1/rls-probe")
class MissedPredicateController {
  constructor(private readonly tenant: TenantDatabase) {}

  @Get("applications/:id")
  async application(@Param("id") id: string): Promise<{ id: string; role_title: string | null }> {
    const row = await this.tenant.run((tx) => tx.selectFrom("application").select(["id", "role_title"]).where("id", "=", id).executeTakeFirst())
    if (!row) throw new NotFoundException()
    return row
  }
}

let database: TestDatabase
let runtime: Kysely<Database>
let owner: Kysely<Database>
let tenant: TenantDatabase
let google: FakeGoogle
let app: INestApplication
let signedIn: SignedInCandidate
let otherId: string
const clock = new TestClock("2026-10-16T09:00:00.000Z")
const OTHER_APPLICATION = "00000000-0000-4000-8000-0000000000d1"
const OWN_APPLICATION = "00000000-0000-4000-8000-0000000000d2"

async function application(id: string, candidateId: string, roleTitle: string): Promise<void> {
  const postingId = randomUUID()
  const url = `https://boards.greenhouse.io/rls/jobs/${id.slice(-4)}`
  await insertPostingFor(database.db, candidateId, { id: postingId, application_url: url, requisition_id: id.slice(-4), apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: roleTitle, company: "RLS Co", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date("2026-10-01"), evaluated_at: new Date("2026-10-01") })
  await database.db
    .insertInto("application")
    .values({ id, candidate_id: candidateId, job_posting_id: postingId, application_url: url, requisition_id: id.slice(-4), company: "RLS Co", role_title: roleTitle, state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date("2026-10-01T10:00:00Z"), updated_at: new Date("2026-10-01T10:00:00Z") })
    .execute()
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  owner = createDatabase(database.ownerUrl)
  tenant = new TenantDatabase(runtime)
  otherId = await insertSecondCandidate(database.db)
  await application(OTHER_APPLICATION, otherId, "OTHER-SECRET-ROLE")
  await application(OWN_APPLICATION, database.operatorId, "Own Role")
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, extraControllers: [MissedPredicateController] })
  signedIn = await signInCandidate(new Browser(app, google))
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await runtime?.destroy()
  await owner?.destroy()
  await database?.stop()
})

describe("a missed Candidate predicate fails closed (AC 6)", () => {
  it("the API answers 404 for the other Candidate's Application, not its row", async () => {
    const response = await signedIn.get(`/v1/rls-probe/applications/${OTHER_APPLICATION}`).expect(404)
    expect(JSON.stringify(response.body)).not.toContain("OTHER-SECRET-ROLE")
  })

  it("the same handler still serves the session's own Application", async () => {
    const response = await signedIn.get(`/v1/rls-probe/applications/${OWN_APPLICATION}`).expect(200)
    expect(response.body).toEqual({ id: OWN_APPLICATION, role_title: "Own Role" })
  })

  it("a query with no predicate in one Candidate's scope sees only that Candidate's rows", async () => {
    const rows = await tenant.forCandidate(database.operatorId, (tx) => tx.selectFrom("application").select("id").execute())
    expect(rows).toEqual([{ id: OWN_APPLICATION }])
  })

  it.each(RLS_TABLES)("%s: a raw transaction without set_config sees zero rows", async (table) => {
    const total = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(database.db)
    const seen = await runtime.transaction().execute((trx) => sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(trx))
    expect(seen.rows[0]?.n).toBe(0)
    if (table === "application") expect(total.rows[0]?.n).toBeGreaterThan(0)
  })

  it("the migration owner role is bound by the policies too (FORCE)", async () => {
    const seen = await sql<{ n: number }>`select count(*)::int as n from application`.execute(owner)
    expect(seen.rows[0]?.n).toBe(0)
  })
})

describe("writes outside the scope are refused", () => {
  it("a Candidate scope cannot write a row for another Candidate", async () => {
    const write = tenant.forCandidate(database.operatorId, (tx) =>
      tx.updateTable("application").set({ role_title: "hijacked" }).where("id", "=", OTHER_APPLICATION).executeTakeFirst()
    )
    expect(Number((await write).numUpdatedRows)).toBe(0)
    const insert = tenant.forCandidate(database.operatorId, (tx) =>
      tx.insertInto("approved_answer").values({ id: randomUUID(), candidate_id: otherId, answer_key: "k-foreign", answer_group: "custom", topic: null, skill: null, question: "q", value: "v", created_at: new Date(), updated_at: new Date() }).execute()
    )
    await expect(insert).rejects.toThrow(/row-level security/)
  })

  it("a write that names no Candidate is refused: the owner default is gone", async () => {
    const insert = tenant.forCandidate(database.operatorId, (tx) =>
      sql`insert into approved_answer (id, answer_key, answer_group, question, value, created_at, updated_at) values (${randomUUID()}, 'k-none', 'custom', 'q', 'v', now(), now())`.execute(tx)
    )
    // Postgres checks the policy before the not-null constraint; either refuses the row.
    await expect(insert).rejects.toThrow(/row-level security|null value in column "candidate_id"/)
    const defaults = await sql<{ table: string }>`
      select table_name as table from information_schema.columns
      where table_schema = 'public' and column_name = 'candidate_id' and column_default is not null order by table_name`.execute(database.db)
    expect(defaults.rows.map((row) => row.table)).toEqual([])
  })

  it("ai_call: a shared scope reads and writes only rows with no Candidate", async () => {
    const id = randomUUID()
    await tenant.forShared((tx) => tx.insertInto("ai_call").values({ id, candidate_id: null, purpose: "posting_extraction", provider: "anthropic", model: "m", status: "started", resume_upload_id: null, job_posting_id: null, application_id: null, started_at: new Date() }).execute())
    await database.db.insertInto("ai_call").values({ id: randomUUID(), candidate_id: otherId, purpose: "match", provider: "anthropic", model: "m", status: "started", resume_upload_id: null, job_posting_id: null, application_id: null, started_at: new Date() }).execute()
    const shared = await tenant.forShared((tx) => tx.selectFrom("ai_call").select("id").execute())
    expect(shared).toEqual([{ id }])
    await expect(
      tenant.forShared((tx) => tx.insertInto("ai_call").values({ id: randomUUID(), candidate_id: otherId, purpose: "x", provider: "anthropic", model: "m", status: "started", resume_upload_id: null, job_posting_id: null, application_id: null, started_at: new Date() }).execute())
    ).rejects.toThrow(/row-level security/)
    const candidate = await tenant.forCandidate(database.operatorId, (tx) => tx.selectFrom("ai_call").select("id").execute())
    expect(candidate).toEqual([])
  })
})

describe("RLS catalog (architecture r2, catalog test)", () => {
  it("every table with a candidate_id column forces RLS and has <table>_candidate; only the mixed table also has <table>_shared", async () => {
    const { rows } = await sql<{ table: string; enabled: boolean; forced: boolean; policies: string[] }>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        coalesce(array_agg(p.polname::text order by p.polname) filter (where p.polname is not null), '{}')::text[] as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'candidate_id' and not a.attisdropped)
        and c.relname <> 'dashboard_session'
      group by c.relname, c.relrowsecurity, c.relforcerowsecurity order by c.relname`.execute(database.db)
    expect(rows.map((row) => row.table)).toEqual([...RLS_TABLES].sort())
    for (const row of rows) {
      // C36: the outbox also holds installation rows (null candidate_id) under its installation policy.
      const second = MIXED_TABLES.includes(row.table) ? [`${row.table}_shared`] : row.table === "notification_outbox" ? [`${row.table}_installation`] : []
      const expected = [`${row.table}_candidate`, ...second]
      expect({ table: row.table, enabled: row.enabled, forced: row.forced, policies: row.policies }).toEqual({ table: row.table, enabled: true, forced: true, policies: expected })
    }
  })

  it("every Candidate table's policy keys on the transaction's Candidate binding and eve.candidate_id", async () => {
    const { rows } = await sql<{ table: string; using: string; check: string }>`
      select c.relname as table, pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
      from pg_policy p join pg_class c on c.oid = p.polrelid where p.polname = c.relname || '_candidate'`.execute(database.db)
    expect(rows).toHaveLength(RLS_TABLES.length)
    for (const row of rows) {
      // 0022: the transaction's Candidate binding AND the setting, so a changed setting cannot switch Candidates.
      expect(row.using, row.table).toMatch(/candidate_id = \( SELECT bound_candidate\(\) AS bound_candidate\)\) AND \(candidate_id = \(?NULLIF\(current_setting\('eve\.candidate_id'::text, true\), ''::text\)\)?::uuid/)
      expect(row.check, row.table).toBe(row.using)
    }
  })

  it("every application table is classified, so a new table cannot skip the decision", async () => {
    const { rows } = await sql<{ name: string }>`select tablename as name from pg_tables where schemaname = 'public' order by tablename`.execute(database.db)
    const classified = [...CANDIDATE_TABLES, ...OWNER_PREFERENCE_TABLES, ...CANDIDATE_POSTING_TABLES, ...HIRING_TABLES, ...STACK_FEED_VERIFICATION_TABLES, ...SIMPLIFY_EVE_TABLES, ...LEAD_TABLES, ...OUTREACH_TABLES, ...MIXED_TABLES, ...OWNER_SCOPED_TABLES, ...SHARED_TABLES, ...IDENTITY_TABLES, ...INSTALLATION_TABLES, ...BOOKKEEPING_TABLES].sort()
    expect(rows.map((row) => row.name)).toEqual(classified)
  })

  it("shared and identity tables have no RLS (they hold no Candidate data or are read by auth only)", async () => {
    const { rows } = await sql<{ name: string }>`
      select relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`.execute(database.db)
    for (const row of rows) expect([...RLS_TABLES, ...INSTALLATION_TABLES, ...OWNER_SCOPED_TABLES], row.name).toContain(row.name)
  })

  it("job_posting forces RLS under its owner policy (shared rows plus the session Candidate's pasted rows)", async () => {
    const { rows } = await sql<{ enabled: boolean; forced: boolean; policies: string[] }>`
      select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        coalesce(array_agg(p.polname::text order by p.polname) filter (where p.polname is not null), '{}')::text[] as policies
      from pg_class c left join pg_policy p on p.polrelid = c.oid
      where c.relname = 'job_posting' and c.relnamespace = 'public'::regnamespace
      group by c.relrowsecurity, c.relforcerowsecurity`.execute(database.db)
    expect(rows).toEqual([{ enabled: true, forced: true, policies: ["job_posting_owner"] }])
  })
})

describe("database roles under RLS (architecture r2: the runtime role stays non-owner and nobypassrls)", () => {
  it("the runtime role owns no table and cannot bypass RLS", async () => {
    const role = await sql<{ bypass: boolean; superuser: boolean }>`select rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = current_user`.execute(runtime)
    expect(role.rows[0]).toEqual({ bypass: false, superuser: false })
    const owned = await sql<{ n: number }>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'pgboss') and pg_get_userbyid(c.relowner) = current_user`.execute(runtime)
    expect(owned.rows[0]?.n).toBe(0)
  })

  it("the migration owner cannot bypass RLS either", async () => {
    const role = await sql<{ bypass: boolean; superuser: boolean }>`select rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = current_user`.execute(owner)
    expect(role.rows[0]).toEqual({ bypass: false, superuser: false })
  })

  it("the runtime role cannot turn RLS off or drop a policy", async () => {
    await expect(sql`alter table application disable row level security`.execute(runtime)).rejects.toThrow(/must be owner/)
    await expect(sql`drop policy application_candidate on application`.execute(runtime)).rejects.toThrow(/must be owner/)
  })
})

describe("security definer audit (architecture r2: the only RLS bypasses are reviewed definer functions)", () => {
  it("lists only the allowed security definer functions in the application schemas", async () => {
    const { rows } = await sql<{ signature: string }>`
      select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'pgboss') and p.prosecdef order by 1`.execute(database.db)
    expect(rows.map((row) => row.signature)).toEqual([...ALLOWED_DEFINER_FUNCTIONS])
  })
})
