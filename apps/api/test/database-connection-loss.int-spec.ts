import { type INestApplication, Logger } from "@nestjs/common"
import { type Kysely, sql } from "kysely"
import { type MockInstance, afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { JobQueue, sharedQueue } from "../src/worker/job-queue.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

let database: TestDatabase
let admin: Kysely<unknown>

beforeAll(async () => {
  database = await startMigratedDatabase()
  admin = createDatabase(database.adminUrl) as unknown as Kysely<unknown>
})

afterAll(async () => {
  await admin?.destroy()
  await database?.stop()
})

/** application_name of the transaction the QA-O8 test holds open. */
const HELD_TRANSACTION_APP = "qa-o8-held-transaction"
/** application_name of the pool whose idle connection the server ends. */
const IDLE_POOL_APP = "idle-pool-connection-loss"

function withApplicationName(url: string, name: string): string {
  const tagged = new URL(url)
  tagged.searchParams.set("application_name", name)
  return tagged.toString()
}

/** What Postgres does to every session on shutdown or restart: FATAL 57P01 on idle connections. */
async function terminateRuntimeConnections(): Promise<number> {
  const result = await sql<{ pid: number }>`
    select pg_terminate_backend(pid) as pid from pg_stat_activity
    where usename = ${database.roles.runtime.name} and datname = ${database.roles.database}`.execute(admin)
  return result.rows.length
}

/** Collects uncaught exceptions while `work` runs, then lets pending socket events settle. */
async function uncaughtDuring(work: () => Promise<void>): Promise<string[]> {
  const seen: string[] = []
  const record = (error: Error & { code?: string }) => void seen.push(`${error.code ?? error.name}`)
  process.on("uncaughtException", record)
  try {
    await work()
    await waitForNoConnectionsFrom(database.roles.runtime.name, "terminated")
  } finally {
    process.off("uncaughtException", record)
  }
  return seen
}

/** Polls until the terminated backends are gone, so their FATAL message has reached the client. */
async function waitForNoConnectionsFrom(role: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { rows } = await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity where usename = ${role} and state is not null and datname = ${database.roles.database}`.execute(admin)
    if (rows[0]?.n === "0") return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${label} connections of ${role} did not go away`)
}

// A database restart ends every pooled connection. That must not crash the api or worker.
describe("losing database connections", () => {
  it("an idle pooled connection ended by the server is not an uncaught exception, and the pool recovers", async () => {
    // Tagged so the test ends exactly this pool's session, in this file's database.
    const db = createDatabase(withApplicationName(database.url, IDLE_POOL_APP))
    const warnings = vi.spyOn(Logger.prototype, "warn")
    try {
      await sql`select 1`.execute(db)
      const pid = await waitForOwnSession(IDLE_POOL_APP, "idle")
      const seen = await uncaughtDuring(async () => {
        expect(await terminateBackend(pid)).toBe(true)
      })
      expect(seen).toEqual([])
      // The server side being gone (pg_stat_activity) does not mean this process has read
      // the FATAL from the socket yet. A query sent before that goes to the dead client
      // and fails with 57P01 (reproduced 28/40 straight after a terminate). Recovery is
      // asserted once the pool's own idle-error listener has discarded the client.
      await waitForWarning(warnings, "Idle database connection closed: 57P01")
      const { rows } = await sql<{ one: number }>`select 1 as one`.execute(db)
      expect(rows[0]?.one).toBe(1)
    } finally {
      warnings.mockRestore()
      await db.destroy()
    }
  })

  it("the running api keeps serving after its database connections are ended", async () => {
    const google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
    google.listen()
    const app: INestApplication = await createTestApp({ databaseUrl: database.url, clock: new TestClock(new Date()) })
    try {
      const browser = new Browser(app, google)
      const candidate = await signInCandidate(browser)
      const warnings = vi.spyOn(Logger.prototype, "warn")
      try {
        let ended = 0
        const seen = await uncaughtDuring(async () => {
          ended = await terminateRuntimeConnections()
          expect(ended).toBeGreaterThan(0)
        })
        expect(seen).toEqual([])
        // Requests are sent once the api's pool has handled every ended connection (see the idle test).
        await waitForWarnings(warnings, /^(Idle database connection closed|Database connection closed while in use): 57P01$/, ended)
      } finally {
        warnings.mockRestore()
      }
      await candidate.get("/v1/session").expect(200)
      await browser.http().get("/v1/health").expect(200)
    } finally {
      await app.close()
      google.close()
    }
  })

  it("the worker's job queue survives its connections being ended and keeps working", async () => {
    const queue = new JobQueue({ databaseUrl: database.url })
    await queue.onApplicationBootstrap()
    try {
      const probe = sharedQueue("connection-loss-probe")
      await queue.createQueue(probe)
      const errors = vi.spyOn(Logger.prototype, "error")
      try {
        let ended = 0
        const seen = await uncaughtDuring(async () => {
          ended = await terminateRuntimeConnections()
          expect(ended).toBeGreaterThan(0)
        })
        expect(seen).toEqual([])
        // pg-boss reports each ended pool connection through JobQueue's error listener.
        await waitForWarnings(errors, /^pg-boss: terminating connection due to administrator command$/, ended)
      } finally {
        errors.mockRestore()
      }
      // F-SEC-02: pg-boss is private to JobQueue, so the probe goes through its public send and work.
      const received = new Promise<string>((resolve) => void queue.workShared(probe, { pollingIntervalSeconds: 0.5 }, async ([job]) => resolve(job!.id)))
      const id = await queue.sendShared(probe, {})
      expect(await received).toBe(id)
    } finally {
      await queue.onApplicationShutdown()
    }
  })

  // QA-O8: a client checked out by a transaction has no pool-level listener.
  it("a connection held by an open transaction and ended by the server is not an uncaught exception", async () => {
    const db = createDatabase(database.url)
    try {
      let releaseTransaction: () => void = () => undefined
      const held = new Promise<void>((resolve) => (releaseTransaction = resolve))
      const transaction = db
        .transaction()
        .execute(async (trx) => {
          // Tags this session so the test ends exactly this backend, in this file's database.
          await sql`set local application_name = ${sql.lit(HELD_TRANSACTION_APP)}`.execute(trx)
          await held
          await sql`select 1`.execute(trx)
        })
        .then(
          () => "committed",
          (error: Error) => `failed: ${error.message}`
        )
      // The held transaction is released in `finally` whatever happens, so a failed
      // assertion can't leave db.destroy() waiting on it (that turned a miss into a hang).
      try {
        const pid = await waitForOwnSession(HELD_TRANSACTION_APP, "idle in transaction")
        const seen = await uncaughtDuring(async () => {
          expect(await terminateBackend(pid)).toBe(true)
        })
        expect(seen).toEqual([])
      } finally {
        releaseTransaction()
      }
      expect(await transaction).toMatch(/^failed:/)
      const { rows } = await sql<{ one: number }>`select 1 as one`.execute(db)
      expect(rows[0]?.one).toBe(1)
    } finally {
      await db.destroy()
    }
  })
})

/**
 * The backend pid of this test's own session: the one session in this file's
 * database, for the runtime role, with the given application_name and state. Every
 * integration file shares the cluster and the runtime role name, so filtering by
 * role alone picked up other files' sessions.
 */
async function waitForOwnSession(applicationName: string, state: "idle" | "idle in transaction"): Promise<number> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const { rows } = await sql<{ pid: number }>`select pid from pg_stat_activity
      where datname = ${database.roles.database} and usename = ${database.roles.runtime.name}
        and application_name = ${applicationName} and state = ${state}`.execute(admin)
    if (rows.length === 1) return rows[0]!.pid
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`this test's ${state} session (${applicationName}) did not appear`)
}

/** Waits until the product logged `message`, i.e. its pool listener has handled the event. */
async function waitForWarning(log: MockInstance, message: string): Promise<void> {
  await waitForWarnings(log, new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), 1)
}

/** Waits until the product logged a line matching `pattern` at least `count` times. */
async function waitForWarnings(log: MockInstance, pattern: RegExp, count: number): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (log.mock.calls.filter((call) => pattern.test(String(call[0]))).length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`the pool reported ${pattern} fewer than ${count} time(s)`)
}

async function terminateBackend(pid: number): Promise<boolean> {
  const { rows } = await sql<{ ended: boolean }>`select pg_terminate_backend(${pid}) as ended`.execute(admin)
  return rows[0]?.ended === true
}
