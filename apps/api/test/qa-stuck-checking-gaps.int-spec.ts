import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { sql } from "kysely"
import { HttpResponse, http } from "msw"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { DiscoveryPipeline } from "../src/discovery/discovery-pipeline.js"
import { DiscoveryRepository, evaluationLockKey } from "../src/discovery/discovery.repository.js"
import { stuckSql } from "../src/discovery/stuck.js"
import { CLOCK } from "../src/shared/clock.js"
import { DiscoveryJobs } from "../src/worker/discovery-jobs.js"
import { JobQueue } from "../src/worker/job-queue.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { clearPostings, resetCriteria, seed } from "./support/epic-0006.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, TEST_CLIENT_ID, TEST_CLIENT_SECRET, migratedStorageRoot } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA gate gap tests (run prc, independent QA). Two behaviours of the stuck
 * recovery that no existing test exercised; found by mutation on candidate
 * a244d10 (see .runs/prc/reports/qa-gate.md):
 *
 * 1. AC-7.14 / stuck-checking-recovery.feature:285: every existing scheduled-run
 *    test reaches `discover()` with the source read NOT started (employer list
 *    unapproved or global pause). Moving the re-queue inside the
 *    `!summary.started` branch passed all of them. Here the read starts, and the
 *    re-queue must still happen, before the read.
 * 2. AC-7.11 / architecture-stuck-checking.md "pg_locks is cluster-wide; the
 *    lookup filters on the current database": deleting that filter passed every
 *    test. Here the same key is held in another database of the cluster and
 *    must not count as a running evaluation.
 */
let database: TestDatabase
let google: FakeGoogle
let worker: INestApplicationContext
let adaId: string

const at = (time: string) => new Date(`2026-10-29T${time}+01:00`)
const clock = new TestClock(at("08:00:00"))
const sent: { candidateId: string; postingId: string; options: unknown }[] = []
const recordingQueue = {
  sendForCandidate: async (_queue: unknown, candidateId: string, data: { postingId: string }, options?: unknown) => {
    sent.push({ candidateId, postingId: data.postingId, options })
    return "recorded"
  },
  sendShared: async () => "recorded",
  createQueue: async () => undefined,
  schedule: async () => undefined,
  unschedule: async () => undefined,
  workShared: async () => "recorded",
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  adaId = database.operatorId
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  worker = await Test.createTestingModule({
    imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL), candidateStorageDir: migratedStorageRoot() })],
  })
    .overrideProvider(JobQueue)
    .useValue(recordingQueue)
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
})

beforeEach(async () => {
  clock.set(at("08:00:00"))
  sent.length = 0
  google.server.resetHandlers()
  await clearPostings(database.db)
  await resetCriteria(database.db)
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false, cost_paused_month: null }).execute()
})

afterAll(async () => {
  await worker?.close()
  google?.close()
  await database?.stop()
})

describe("QA gap: the scheduled run re-queues stuck postings when the source read starts (AC-7.14)", () => {
  it("stuck:285 (read started) re-queues the stuck posting before the source read, and the read still runs", async () => {
    const stuckId = await seed(database.db, adaId, {}, { status: "checking", checkingSince: at("07:00:00") })
    const recentId = await seed(database.db, adaId, {}, { status: "checking", checkingSince: at("07:55:00") })
    // The employer list is approved, so the read starts; every board answers with no postings.
    await database.db.updateTable("employer_list_state").set({ approved_at: at("07:00:00") }).execute()
    await database.db.updateTable("employer_board").set({ last_read_at: null }).execute()
    await database.db.updateTable("remote_board").set({ enabled: false }).execute()
    google.server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", () => HttpResponse.json({ jobs: [] })),
      http.get("https://api.lever.co/v0/postings/:token", () => HttpResponse.json([])),
      http.get("https://api.ashbyhq.com/posting-api/job-board/:token", () => HttpResponse.json({ jobs: [] }))
    )
    const requeue = vi.spyOn(worker.get(DiscoveryRepository), "requeueStuck")
    const read = vi.spyOn(worker.get(DiscoveryPipeline), "runDaily")
    try {
      await worker.get(DiscoveryJobs).runDiscovery()
      const summary = await read.mock.results[0]!.value
      expect(summary.started, "the source read started").toBe(true)
      expect(requeue).toHaveBeenCalledTimes(1)
      expect(requeue.mock.invocationCallOrder[0]!).toBeLessThan(read.mock.invocationCallOrder[0]!)
    } finally {
      requeue.mockRestore()
      read.mockRestore()
    }
    expect(sent.filter((job) => job.postingId === stuckId)).toEqual([{ candidateId: adaId, postingId: stuckId, options: undefined }])
    expect(sent.filter((job) => job.postingId === recentId)).toEqual([])
  })
})

describe("QA gap: a lock held in another database of the cluster is not a running evaluation (AC-7.11)", () => {
  it("the same advisory key held in another database leaves the row stuck; held in this database it is not stuck", async () => {
    const id = await seed(database.db, adaId, {}, { status: "checking", checkingSince: at("07:00:00") })
    const key = String(evaluationLockKey(adaId, id))
    const stuckNow = async () =>
      (await sql<{ stuck: boolean }>`select ${stuckSql("cp", at("08:00:00"))} as stuck from candidate_posting cp where cp.candidate_id = ${adaId}::uuid and cp.job_posting_id = ${id}::uuid`.execute(database.db)).rows[0]!.stuck

    const other = new URL(inject("postgresAdminUrl"))
    other.pathname = "/postgres"
    const elsewhere = new pg.Client({ connectionString: other.toString() })
    const here = new pg.Client({ connectionString: database.adminUrl })
    await elsewhere.connect()
    await here.connect()
    try {
      expect((await elsewhere.query<{ db: string }>("select current_database() as db")).rows[0]!.db).not.toBe((await here.query<{ db: string }>("select current_database() as db")).rows[0]!.db)
      await elsewhere.query("select pg_advisory_lock($1::bigint)", [key])
      expect(await stuckNow(), "a lock in another database does not count").toBe(true)
      await here.query("select pg_advisory_lock($1::bigint)", [key])
      expect(await stuckNow(), "the lock in this database counts").toBe(false)
    } finally {
      await elsewhere.end()
      await here.end()
    }
  })
})
