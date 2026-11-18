import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { SESSION_IDLE_TIMEOUT_MS } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { AuthTableCleanup } from "../src/auth/auth-table-cleanup.js"
import { SIGN_IN_ATTEMPT_TTL_MS } from "../src/auth/cookies.js"
import { SessionRepository } from "../src/auth/session.repository.js"
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../src/auth/session.service.js"
import type { SignInAttemptRepository } from "../src/auth/sign-in-attempt.repository.js"
import { anthropicConfig } from "../src/config/env.js"
import { CLOCK } from "../src/shared/clock.js"
import { AUTH_CLEANUP_CRON, AUTH_CLEANUP_QUEUE, AUTH_CLEANUP_TIME_ZONE, AuthCleanupJobs } from "../src/worker/auth-cleanup-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { CANDIDATE_SUB, OTHER_SUB, migratedStorageRoot } from "./support/test-app.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TestClock } from "./support/test-clock.js"

/**
 * `auth.cleanup` (worker only): stale `sign_in_attempt` rows and expired
 * `dashboard_session` rows (past the idle expiry or the absolute lifetime) are
 * removed once an hour, through the real worker module as the runtime role.
 * Neither table carries a Candidate scope, so the job deletes across every row
 * with the request path's cutoffs.
 */
let database: TestDatabase
let worker: INestApplicationContext | null = null
const clock = new TestClock("2026-10-20T12:00:00.000Z")

const ago = (ms: number) => new Date(clock.now().getTime() - ms)
const ATTEMPT_STALE = "a".repeat(64)
const ATTEMPT_FRESH = "b".repeat(64)
const SESSION_STALE = "c".repeat(64)
const SESSION_AT_BOUNDARY = "d".repeat(64)
const SESSION_FRESH = "e".repeat(64)

async function boot(): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), candidateStorageDir: migratedStorageRoot() })],
  })
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  worker = moduleRef
  await worker.init()
}

const schedule = () => sql<{ name: string; cron: string; timezone: string }>`select name, cron, timezone from pgboss.schedule where name = ${AUTH_CLEANUP_QUEUE}`.execute(database.db)

async function insertAttempt(idHash: string, createdAt: Date): Promise<void> {
  await database.db
    .insertInto("sign_in_attempt")
    .values({ id_hash: idHash, state: "state", nonce: "nonce", code_verifier: "verifier", return_path: "/dashboard", created_at: createdAt })
    .execute()
}

async function insertSession(idHash: string, lastActiveAt: Date, createdAt: Date = lastActiveAt): Promise<void> {
  await database.db
    .insertInto("dashboard_session")
    .values({ id_hash: idHash, csrf_token: "csrf", google_sub: CANDIDATE_SUB, candidate_id: database.operatorId, created_at: createdAt, last_active_at: lastActiveAt })
    .execute()
}

const attemptHashes = async () =>
  (await database.db.selectFrom("sign_in_attempt").select("id_hash").orderBy("id_hash").execute()).map((row) => row.id_hash)
const sessionHashes = async () =>
  (await database.db.selectFrom("dashboard_session").select("id_hash").orderBy("id_hash").execute()).map((row) => row.id_hash)

beforeAll(async () => {
  database = await startMigratedDatabase()
  await boot()
})

beforeEach(async () => {
  clock.set("2026-10-20T12:00:00.000Z")
  await database.db.deleteFrom("sign_in_attempt").execute()
  await database.db.deleteFrom("dashboard_session").execute()
})

afterAll(async () => {
  await worker?.close()
  await database?.stop()
})

describe("auth.cleanup schedule", () => {
  it("schedules auth.cleanup every hour on a singleton queue with retries off", async () => {
    expect((await schedule()).rows).toEqual([{ name: AUTH_CLEANUP_QUEUE, cron: AUTH_CLEANUP_CRON, timezone: AUTH_CLEANUP_TIME_ZONE }])
    expect(AUTH_CLEANUP_CRON).toBe("0 * * * *")
    const queue = await sql<{ policy: string; retry_limit: number }>`select policy, retry_limit from pgboss.queue where name = ${AUTH_CLEANUP_QUEUE}`.execute(database.db)
    expect(queue.rows).toEqual([{ policy: "singleton", retry_limit: 0 }])
  })
})

describe("auth.cleanup job", () => {
  it("deletes sign-in attempts past the 10 minute TTL and keeps fresher ones", async () => {
    await insertAttempt(ATTEMPT_STALE, ago(SIGN_IN_ATTEMPT_TTL_MS + 1))
    await insertAttempt(ATTEMPT_FRESH, ago(SIGN_IN_ATTEMPT_TTL_MS - 1))

    expect(await worker!.get(AuthCleanupJobs).run()).toEqual({ attempts: 1, sessions: 0 })
    expect(await attemptHashes()).toEqual([ATTEMPT_FRESH])
  })

  it("deletes sessions idle for longer than 14 days and keeps active ones, boundary included", async () => {
    await insertSession(SESSION_STALE, ago(SESSION_IDLE_TIMEOUT_MS + 1))
    // Exactly 14 days: `touchIfActive` already refuses it, and it goes when that cookie is presented again.
    await insertSession(SESSION_AT_BOUNDARY, ago(SESSION_IDLE_TIMEOUT_MS))
    await insertSession(SESSION_FRESH, ago(60 * 60 * 1000))

    expect(await worker!.get(AuthCleanupJobs).run()).toEqual({ attempts: 0, sessions: 1 })
    expect(await sessionHashes()).toEqual([SESSION_AT_BOUNDARY, SESSION_FRESH])
  })

  it("deletes a session used now once it is past the 30 day absolute lifetime", async () => {
    // Used a minute ago but signed in 30 days and a second ago: `resume` already refuses it.
    await insertSession(SESSION_STALE, ago(60 * 1000), ago(SESSION_ABSOLUTE_LIFETIME_MS + 1000))

    expect(await worker!.get(AuthCleanupJobs).run()).toEqual({ attempts: 0, sessions: 1 })
    expect(await sessionHashes()).toEqual([])
  })

  it("deletes both tables in one sweep, and writes nothing else", async () => {
    await insertAttempt(ATTEMPT_STALE, ago(SIGN_IN_ATTEMPT_TTL_MS + 1))
    await insertAttempt(ATTEMPT_FRESH, ago(0))
    await insertSession(SESSION_STALE, ago(SESSION_IDLE_TIMEOUT_MS + 1))
    await insertSession(SESSION_FRESH, ago(0))

    expect(await worker!.get(AuthCleanupJobs).run()).toEqual({ attempts: 1, sessions: 1 })
    expect(await attemptHashes()).toEqual([ATTEMPT_FRESH])
    expect(await sessionHashes()).toEqual([SESSION_FRESH])
  })

  it("sweeps every Candidate's idle sessions, not only the Operator's", async () => {
    const other = await database.db
      .insertInto("candidate")
      .values({ email: null, google_sub: OTHER_SUB, role: "candidate", onboarded_at: null, revoked_at: null })
      .returning("id")
      .executeTakeFirstOrThrow()
    await database.db
      .insertInto("dashboard_session")
      .values({ id_hash: SESSION_STALE, csrf_token: "csrf", google_sub: OTHER_SUB, candidate_id: other.id, last_active_at: ago(SESSION_IDLE_TIMEOUT_MS + 1) })
      .execute()
    try {
      expect(await worker!.get(AuthCleanupJobs).run()).toEqual({ attempts: 0, sessions: 1 })
      expect(await sessionHashes()).toEqual([])
    } finally {
      await database.db.deleteFrom("candidate").where("id", "=", other.id).execute()
    }
  })

  it("still deletes the other table when one delete fails", async () => {
    await insertAttempt(ATTEMPT_STALE, ago(SIGN_IN_ATTEMPT_TTL_MS + 1))
    await insertSession(SESSION_STALE, ago(SESSION_IDLE_TIMEOUT_MS + 1))

    const failingAttempts = {
      deleteCreatedBefore: () => Promise.reject(new Error("attempt delete failed")),
    } as unknown as SignInAttemptRepository
    const cleanup = new AuthTableCleanup(failingAttempts, new SessionRepository(database.db), clock)

    expect(await cleanup.run()).toEqual({ attempts: 0, sessions: 1 })
    // The failed table keeps its rows for the next hour's run.
    expect(await attemptHashes()).toEqual([ATTEMPT_STALE])
    expect(await sessionHashes()).toEqual([])
  })
})
