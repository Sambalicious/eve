import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { NOTIFICATION_STATUS_PATH } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { NotificationStatusService } from "../src/notification/notification-status.service.js"
import { AccessRequestRetention } from "../src/worker/access-request-jobs.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 C36 (architecture r4, Table classification "Installation-only data",
 * Tenancy 2a; gherkin data-isolation.feature r4, AC 6.11). EPIC-0003's
 * `access_request`, `access_request_drop` and the `access_request` /
 * `access_request_cap` outbox rows are installation data: no Candidate ID, and
 * RLS admits them only inside `TenantDatabase.forInstallation`. Every Candidate
 * scope, the shared scope and a transaction with no scope read zero of them.
 */
let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let adaId: string
let kofiId: string
const clock = new TestClock("2026-10-21T10:00:00.000Z")
const HASH = "a".repeat(64)

type Source = "access_request" | "access_request_drop" | "outbox:access_request" | "outbox:access_request_cap"

async function countIn(tx: Kysely<Database>, source: Source): Promise<number> {
  const query =
    source === "access_request" || source === "access_request_drop"
      ? sql<{ n: number }>`select count(*)::int as n from ${sql.table(source)}`
      : sql<{ n: number }>`select count(*)::int as n from notification_outbox where kind = ${source.slice("outbox:".length)}`
  return (await query.execute(tx)).rows[0]!.n
}

/** 2 access requests (one hash nulled), 1 silent drop, 1 access_request and 1 access_request_cap outbox row, and 3 of Kofi's own outbox rows. */
async function seed(): Promise<void> {
  for (const table of ["notification_outbox", "access_request", "access_request_drop"] as const) await database.db.deleteFrom(table).execute()
  const first = randomUUID()
  const second = randomUUID()
  await sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id, status) values
    (${first}, 'tunde.bello@gmail.com', 'tunde.bello@gmail.com', 'hello', now(), ${HASH}, ${first}, 'waiting'),
    (${second}, 'kofi.mensah@gmail.com', 'kofi.mensah@gmail.com', 'before invite', now(), null, ${second}, 'sent')`.execute(database.db)
  await sql`insert into access_request_drop (id, ip_hash, reason, created_at) values (${randomUUID()}, ${HASH}, 'honeypot', now())`.execute(database.db)
  await sql`insert into notification_outbox (id, application_id, kind, created_at, status, access_request_window_id) values (${randomUUID()}, null, 'access_request', now(), 'pending', ${first})`.execute(database.db)
  await sql`insert into notification_outbox (id, application_id, kind, created_at, status, local_day) values (${randomUUID()}, null, 'access_request_cap', now(), 'failed', '2026-10-21')`.execute(database.db)
  for (const day of ["2026-10-18", "2026-10-19", "2026-10-20"]) {
    await sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, local_day) values (${kofiId}, ${randomUUID()}, null, 'daily_summary', now(), ${day})`.execute(database.db)
  }
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  tenant = new TenantDatabase(runtime)
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  adaId = database.operatorId
  kofiId = await insertSecondCandidate(database.db, "kofi.mensah@gmail.com")
})

beforeEach(async () => {
  await seed()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await runtime?.destroy()
  await database?.stop()
})

describe("data-isolation.feature @ac-6.11 @slice-A1: No Candidate scope can read access-request data", () => {
  const scopes: Record<string, (source: Source) => Promise<number>> = {
    "Kofi's Candidate scope": (source) => tenant.forCandidate(kofiId, (tx) => countIn(tx, source)),
    "Ada's Candidate scope": (source) => tenant.forCandidate(adaId, (tx) => countIn(tx, source)),
    "the shared scope": (source) => tenant.forShared((tx) => countIn(tx, source)),
    "a transaction with no scope set": (source) => runtime.transaction().execute((tx) => countIn(tx, source)),
  }

  it.each([
    ["Kofi's Candidate scope", "access_request"],
    ["Kofi's Candidate scope", "access_request_drop"],
    ["Kofi's Candidate scope", "outbox:access_request"],
    ["Kofi's Candidate scope", "outbox:access_request_cap"],
    ["Ada's Candidate scope", "access_request"],
    ["Ada's Candidate scope", "access_request_drop"],
    ["Ada's Candidate scope", "outbox:access_request"],
    ["Ada's Candidate scope", "outbox:access_request_cap"],
    ["the shared scope", "access_request"],
    ["the shared scope", "access_request_drop"],
    ["the shared scope", "outbox:access_request"],
    ["the shared scope", "outbox:access_request_cap"],
    ["a transaction with no scope set", "access_request"],
    ["a transaction with no scope set", "access_request_drop"],
    ["a transaction with no scope set", "outbox:access_request"],
  ] as const)("code running in %s reads zero rows of %s", async (scope, source) => {
    expect(await countIn(database.db, source)).toBeGreaterThan(0)
    expect(await scopes[scope]!(source)).toBe(0)
  })

  it("a Candidate scope cannot write an access request either", async () => {
    const id = randomUUID()
    await expect(
      tenant.forCandidate(kofiId, (tx) => sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id) values (${id}, 'x@y.co', 'x@y.co', '', now(), null, ${id})`.execute(tx))
    ).rejects.toThrow(/row-level security/)
  })
})

describe("data-isolation.feature @ac-6.11 @slice-A1: The installation scope reads every access-request row and no Candidate row", () => {
  it("reads 2 access requests, 1 silent-drop row and 2 outbox rows, and none of Kofi's outbox rows", async () => {
    const counts = await tenant.forInstallation(async (tx) => ({
      requests: await countIn(tx, "access_request"),
      drops: await countIn(tx, "access_request_drop"),
      outbox: (await sql<{ n: number }>`select count(*)::int as n from notification_outbox`.execute(tx)).rows[0]!.n,
      kofi: (await sql<{ n: number }>`select count(*)::int as n from notification_outbox where candidate_id = ${kofiId}`.execute(tx)).rows[0]!.n,
    }))
    expect(counts).toEqual({ requests: 2, drops: 1, outbox: 2, kofi: 0 })
  })

  it("sets eve.scope = 'installation' and never sets eve.candidate_id", async () => {
    const values = await tenant.forInstallation(async (tx) => ({
      scope: (await sql<{ v: string | null }>`select current_setting('eve.scope', true) as v`.execute(tx)).rows[0]?.v,
      candidate: (await sql<{ v: string | null }>`select current_setting('eve.candidate_id', true) as v`.execute(tx)).rows[0]?.v,
    }))
    expect(values.scope).toBe("installation")
    expect(values.candidate ?? "").toBe("")
  })

  it("cannot write a Candidate row", async () => {
    await expect(
      tenant.forInstallation((tx) => sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, local_day) values (${kofiId}, ${randomUUID()}, null, 'daily_summary', now(), '2026-10-10')`.execute(tx))
    ).rejects.toThrow(/row-level security/)
  })
})

describe("data-isolation.feature @ac-6.11 @slice-A1: Every installation-only table has row security and exactly one installation policy", () => {
  const policies = async (table: string) =>
    (
      await sql<{ name: string; using: string; check: string }>`
        select p.polname as name, pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
        from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = ${table} order by p.polname`.execute(database.db)
    ).rows

  it.each(["access_request", "access_request_drop"])("%s has forced row security and exactly one policy, the installation policy", async (table) => {
    const { rows } = await sql<{ enabled: boolean; forced: boolean }>`select relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where relname = ${table}`.execute(database.db)
    expect(rows[0]).toEqual({ enabled: true, forced: true })
    const found = await policies(table)
    expect(found.map((p) => p.name)).toEqual([`${table}_installation`])
    expect(found[0]!.using).toMatch(/current_setting\('eve\.scope'::text, true\) = 'installation'::text/)
    expect(found[0]!.check).toBe(found[0]!.using)
  })

  it("the notification outbox has the Candidate policy and the installation policy and no shared policy", async () => {
    const found = await policies("notification_outbox")
    expect(found.map((p) => p.name)).toEqual(["notification_outbox_candidate", "notification_outbox_installation"])
    expect(found[1]!.using).toMatch(/candidate_id IS NULL/)
    expect(found[1]!.using).toMatch(/'installation'::text/)
  })
})

describe("data-isolation.feature @validation @ac-6.11 @slice-A1: An outbox row's Candidate ID must match its kind", () => {
  const write = (kind: string, candidateId: string | null) => {
    const extra = kind === "access_request" ? sql`${randomUUID()}::uuid` : sql`null`
    const day = kind === "daily_summary" || kind === "access_request_cap" ? `2026-09-${String(10 + Math.floor(Math.random() * 18))}` : null
    return sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, local_day, access_request_window_id)
      values (${candidateId}, ${randomUUID()}, null, ${kind}, now(), ${day}, ${extra})`.execute(database.db)
  }

  it.each([
    ["access_request", "without", true],
    ["access_request_cap", "without", true],
    ["access_request", "with Kofi's", false],
    ["confirmed", "without", false],
    ["daily_summary", "with Kofi's", true],
  ] as const)("a %s row written %s Candidate ID is %s", async (kind, withOrWithout, accepted) => {
    const result = write(kind, withOrWithout === "without" ? null : kofiId)
    if (accepted) await expect(result).resolves.toBeDefined()
    else await expect(result).rejects.toThrow()
  })
})

describe("data-isolation.feature @permission @ac-6.11: No Candidate reads an access request or its count through any route", () => {
  it("the notification status for Kofi (an invitee) has no accessRequests key and no access-request content", async () => {
    const status = await CandidateScope.run(kofiId, () => app.get(NotificationStatusService).status())
    expect(status).not.toHaveProperty("accessRequests")
    expect(status.pendingCount).toBe(3)
    expect(JSON.stringify(status)).not.toMatch(/tunde|kofi\.mensah|hello|before invite/)
  })

  it("the Operator's (Ada's) status route still counts them, from the installation scope, with no content", async () => {
    const body = (await ada.get(NOTIFICATION_STATUS_PATH).expect(200)).body as { accessRequests?: { waiting: number; failed: number }; pendingCount: number }
    expect(body.accessRequests).toEqual({ waiting: 1, failed: 1 })
    expect(body.pendingCount).toBe(0)
    expect(JSON.stringify(body)).not.toMatch(/tunde|kofi\.mensah|hello|before invite/)
  })
})

describe("data-isolation.feature @permission @ac-6.11: A visitor who later becomes a Candidate does not get their earlier request", () => {
  it("Kofi's earlier request is still installation data with no Candidate ID and is not in his scope", async () => {
    expect(await tenant.forCandidate(kofiId, (tx) => countIn(tx, "access_request"))).toBe(0)
    const stored = await database.db.selectFrom("access_request").select("email").where("email", "=", "kofi.mensah@gmail.com").execute()
    expect(stored).toHaveLength(1)
    const columns = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_name = 'access_request' and column_name = 'candidate_id'`.execute(database.db)
    expect(columns.rows[0]!.n).toBe(0)
  })
})

describe("data-isolation.feature @ac-6.11 @slice-A1: The access-request retention jobs keep their schedules in the installation scope", () => {
  it("clears hashes older than 24 hours and deletes 90-day-old requests and their orphaned outbox rows, without touching Kofi's rows", async () => {
    await database.db.updateTable("access_request").set({ created_at: new Date("2026-07-01T00:00:00Z") }).execute()
    await database.db.updateTable("access_request_drop").set({ created_at: new Date("2026-10-19T00:00:00Z") }).execute()
    const retention = new AccessRequestRetention(tenant)
    expect(await retention.clearIpHashes(clock.now())).toEqual({ cleared: 1, drops: 1 })
    expect(await retention.deleteExpired(clock.now())).toEqual({ requests: 2, outbox: 1 })
    const kofi = await database.db.selectFrom("notification_outbox").select("id").where("candidate_id", "=", kofiId).execute()
    expect(kofi).toHaveLength(3)
  })
})
