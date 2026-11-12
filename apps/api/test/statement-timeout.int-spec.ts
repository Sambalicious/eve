import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { type INestApplication, Logger } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { jobPostingsResponseSchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { ConfigModule } from "../src/config/config.module.js"
import { parseConfig } from "../src/config/env.js"
import { API_STATEMENT_TIMEOUT_MS, WORKER_STATEMENT_TIMEOUT_MS, createDatabase } from "../src/db/create-database.js"
import { DATABASE, DatabaseModule } from "../src/db/database.module.js"
import type { Database } from "../src/db/schema.js"
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js"
import { BROWSER_MUTEX_KEY, BrowserMutex } from "../src/submission/browser-mutex.js"
import { parseWorkerConfig } from "../src/worker/worker.config.js"
import { workerAppConfig } from "../src/worker/worker.module.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_ACCESS_REQUEST_SECRET, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor } from "./support/candidate-posting.js"

/**
 * Slice 8d (8d.9 to 8d.12, D8d-4, SEC-803; PF-75 to PF-79): `statement_timeout`
 * is a per-process connection setting. Real api app, real worker config, real
 * Postgres; the timeout cancels real queries.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
const clock = new TestClock("2026-10-21T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const apiDb = () => app.get<Kysely<Database>>(DATABASE)
const showTimeout = async (db: Kysely<Database>) => (await sql<{ statement_timeout: string }>`show statement_timeout`.execute(db)).rows[0]!.statement_timeout
const sqlState = (error: unknown) => (error as { code?: string }).code

/** The worker process's DATABASE provider, built from its real config path (parseWorkerConfig, workerAppConfig). */
async function withWorkerDb<T>(work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const config = parseWorkerConfig({ DATABASE_URL: database.url })
  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(workerAppConfig(config)), DatabaseModule] }).compile()
  try {
    return await work(moduleRef.get<Kysely<Database>>(DATABASE))
  } finally {
    await moduleRef.close()
  }
}

/** The migrate step and role provisioning call createDatabase with no options (migrate-and-grant.ts, provision-roles.cli.ts). */
async function withOwnerDb<T>(url: string, work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const db = createDatabase(url)
  try {
    return await work(db)
  } finally {
    await db.destroy()
  }
}

describe("each process's pool has its own statement timeout (PF-75, 8d.9, 8d.11)", () => {
  it("the api config sets 5,000 ms and the worker 60,000 ms", () => {
    expect(API_STATEMENT_TIMEOUT_MS).toBe(5_000)
    expect(WORKER_STATEMENT_TIMEOUT_MS).toBe(60_000)
    const env = { DATABASE_URL: database.url, PUBLIC_ORIGIN: "https://x.test", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", ACCESS_REQUEST_SECRET: TEST_ACCESS_REQUEST_SECRET }
    expect(parseConfig(env).statementTimeoutMs).toBe(5_000)
    expect(workerAppConfig(parseWorkerConfig({ DATABASE_URL: database.url })).statementTimeoutMs).toBe(60_000)
  })

  it("api: show statement_timeout is 5s", async () => {
    expect(await showTimeout(apiDb())).toBe("5s")
  })

  it("worker: show statement_timeout is 1min", async () => {
    expect(await withWorkerDb(showTimeout)).toBe("1min")
  })

  it("migrate step (owner role) and role provisioning (admin): 0", async () => {
    expect(await withOwnerDb(database.ownerUrl, showTimeout)).toBe("0")
    expect(await withOwnerDb(database.adminUrl, showTimeout)).toBe("0")
  })

  it("the migrate step and provisioning source pass no timeout to createDatabase", () => {
    for (const file of ["migrate-and-grant.ts", "provision-roles.cli.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../src/db/${file}`, import.meta.url)), "utf8")
      const calls = [...source.matchAll(/createDatabase\(([^)]*)\)/g)].map((match) => match[1]!)
      expect(calls.length, file).toBeGreaterThan(0)
      for (const args of calls) expect(args, file).not.toContain(",")
    }
  })
})

describe("the api pool cancels a long statement and keeps working (PF-76, 8d.11)", () => {
  it("select pg_sleep(6) fails with 57014 after about 5 s; the next query on the pool succeeds", async () => {
    const started = Date.now()
    const error = await sql`select pg_sleep(6)`.execute(apiDb()).then(
      () => null,
      (caught: unknown) => caught
    )
    const elapsed = Date.now() - started
    expect(sqlState(error)).toBe("57014")
    expect(elapsed).toBeGreaterThanOrEqual(4_900)
    expect(elapsed).toBeLessThan(6_000)
    expect((await sql<{ one: number }>`select 1 as one`.execute(apiDb())).rows).toEqual([{ one: 1 }])
  })
})

describe("the worker and the migrate step allow statements longer than 5 s (PF-77, 8d.9, 8d.10)", () => {
  it("worker: select pg_sleep(6) succeeds", async () => {
    await withWorkerDb(async (db) => {
      await expect(sql`select pg_sleep(6)`.execute(db)).resolves.toBeDefined()
    })
  })

  it("migrate step: select pg_sleep(6) succeeds", async () => {
    await withOwnerDb(database.ownerUrl, async (db) => {
      await expect(sql`select pg_sleep(6)`.execute(db)).resolves.toBeDefined()
    })
  })
})

describe("the timeout is a connection setting, not a role setting or a migration (PF-78, 8d.10)", () => {
  it("no role or role-in-database setting stores statement_timeout", async () => {
    const roles = await sql<{ rolname: string }>`select rolname from pg_roles where array_to_string(rolconfig, ',') like '%statement_timeout%'`.execute(database.db)
    expect(roles.rows).toEqual([])
    const settings = await sql<{ setrole: string }>`select setrole::text from pg_db_role_setting where array_to_string(setconfig, ',') like '%statement_timeout%'`.execute(database.db)
    expect(settings.rows).toEqual([])
  })

  it("no migration sets statement_timeout", () => {
    const dir = fileURLToPath(new URL("../src/db/migrations/", import.meta.url))
    const files = readdirSync(dir).filter((file) => file.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) expect(readFileSync(`${dir}${file}`, "utf8"), file).not.toMatch(/statement_timeout/i)
  })
})

describe("the worker's browser lease wait is not cut off by its statement timeout (D8d-4)", () => {
  it("withLock waits longer than the pool's timeout for a held lease, then every pooled connection has the timeout again", async () => {
    const db = createDatabase(database.url, { statementTimeoutMs: 1_000 })
    const holder = createDatabase(database.url)
    try {
      let release: () => void = () => undefined
      const released = new Promise<void>((resolve) => (release = resolve))
      let locked: () => void = () => undefined
      const isLocked = new Promise<void>((resolve) => (locked = resolve))
      const held = holder.connection().execute(async (connection) => {
        await sql`select pg_advisory_lock(${BROWSER_MUTEX_KEY})`.execute(connection)
        locked()
        await released
        await sql`select pg_advisory_unlock(${BROWSER_MUTEX_KEY})`.execute(connection)
      })
      await isLocked
      setTimeout(release, 2_500)
      const started = Date.now()
      expect(await new BrowserMutex(db).withLock(async () => "done")).toBe("done")
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000)
      await held
      // pg's pool holds at most 10 connections: check them all at once.
      const timeouts = await Promise.all(Array.from({ length: 10 }, () => db.connection().execute((connection) => showTimeout(connection))))
      expect(new Set(timeouts)).toEqual(new Set(["1s"]))
    } finally {
      await db.destroy()
      await holder.destroy()
    }
  })
})

describe("CR8D-06: a failed timeout reset never returns a lock-holding, no-timeout connection to the pool", () => {
  it("ends the session, so the lease is free and every pooled connection has the startup timeout", async () => {
    const db = createDatabase(database.url, { statementTimeoutMs: 1_000 })
    const other = createDatabase(database.url)
    // The plugin makes exactly the RESET statement fail before it is sent; every other statement runs normally.
    const failingReset = db.withPlugin({
      transformQuery: (args) => {
        const raw = args.node.kind === "RawNode" ? args.node.sqlFragments.join("") : ""
        if (raw.includes("reset statement_timeout")) throw new Error("simulated RESET failure")
        return args.node
      },
      transformResult: async (args) => args.result,
    })
    try {
      const work = vi.fn(async () => "never")
      await expect(new BrowserMutex(failingReset).withLock(work)).rejects.toThrow("simulated RESET failure")
      expect(work).not.toHaveBeenCalled()
      const free = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${BROWSER_MUTEX_KEY}) as locked`.execute(other)
      expect(free.rows[0]?.locked).toBe(true)
      await sql`select pg_advisory_unlock(${BROWSER_MUTEX_KEY})`.execute(other)
      const timeouts = await Promise.all(Array.from({ length: 10 }, () => db.connection().execute((connection) => showTimeout(connection))))
      expect(new Set(timeouts)).toEqual(new Set(["1s"]))
    } finally {
      await db.destroy()
      await other.destroy()
    }
  })
})

describe("a list request cancelled by the timeout (PF-79, 8d.12)", () => {
  it("returns the generic error envelope, logs code 57014 without the SQL or parameters, and the api keeps serving", async () => {
    await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
    for (let index = 0; index < 30; index++) {
      const id = crypto.randomUUID()
      const url = `https://boards.greenhouse.io/acme/jobs/${id}`
      await insertPostingFor(database.db, database.operatorId, { id, application_url: url, requisition_id: id, apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", title_folded: "senior frontend engineer", company: "Acme", posting_text: "Remote.", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date(Date.UTC(2026, 9, 1, 8, index)), evaluated_at: null })
    }
    const repository = app.get(DiscoveryRepository)
    const SECRET_PARAMETER = "sleep-param-sentinel-8d12"
    vi.spyOn(repository, "listPage").mockImplementationOnce(async () => {
      await sql`select pg_sleep(6), ${SECRET_PARAMETER}::text as marker`.execute(apiDb())
      throw new Error("unreachable: the statement timeout fires first")
    })
    const errors = vi.spyOn(Logger.prototype, "error")
    try {
      const started = Date.now()
      const response = await candidate.get("/v1/job-postings?tab=ranked")
      expect(Date.now() - started).toBeLessThan(6_000)
      expect(response.status).toBe(500)
      expect(response.body).toEqual({ error: { code: "internal_error", message: "Something went wrong." } })
      const logged = errors.mock.calls.map((call) => String(call[0]))
      // A2 (job-postings-per-candidate.feature:255): the line names the requesting Candidate, nothing of the posting.
      expect(logged).toContain(`Database error 57014 for Candidate ${database.operatorId}`)
      for (const line of logged) {
        expect(line).not.toMatch(/pg_sleep|select|sentinel/i)
      }
    } finally {
      errors.mockRestore()
      vi.restoreAllMocks()
    }
    const started = Date.now()
    const next = jobPostingsResponseSchema.parse((await candidate.get("/v1/job-postings?tab=ranked").expect(200)).body)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(next.postings).toHaveLength(25)
  })
})

describe("A2 boundary: a list request that finishes inside the timeout (job-postings-per-candidate.feature:264)", () => {
  it("a 4 s query under the 5 s api timeout returns 200", async () => {
    const repository = app.get(DiscoveryRepository)
    const original = repository.listPage.bind(repository)
    vi.spyOn(repository, "listPage").mockImplementationOnce(async (...args: Parameters<typeof repository.listPage>) => {
      await sql`select pg_sleep(4)`.execute(apiDb())
      return original(...args)
    })
    try {
      const response = await candidate.get("/v1/job-postings?tab=ranked")
      expect(response.status).toBe(200)
      jobPostingsResponseSchema.parse(response.body)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
