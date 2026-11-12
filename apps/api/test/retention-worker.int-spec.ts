import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { sql } from "kysely"
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CLOCK } from "../src/shared/clock.js"
import { RETENTION_CRON, RETENTION_DAILY_QUEUE } from "../src/worker/retention-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { migratedStorageRoot } from "./support/test-app.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TestClock } from "./support/test-clock.js"

/**
 * automatic-expiry.feature E3.1 (03:00 WAT, singleton, no retry) and E3.8 (the
 * operator switch RETENTION_JOB_DISABLED=1 unschedules it; anything else schedules it),
 * through the real worker module as the runtime role.
 */
let database: TestDatabase
let worker: INestApplicationContext | null = null
const clock = new TestClock("2026-10-19T12:00:00.000Z")

async function boot(retentionJobDisabled: boolean): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), candidateStorageDir: migratedStorageRoot(), retentionJobDisabled })],
  })
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  worker = moduleRef
  await worker.init()
}

const schedule = () => sql<{ name: string; cron: string; timezone: string }>`select name, cron, timezone from pgboss.schedule where name = ${RETENTION_DAILY_QUEUE}`.execute(database.db)

beforeAll(async () => {
  database = await startMigratedDatabase()
})

afterEach(async () => {
  await worker?.close()
  worker = null
})

afterAll(async () => {
  await database?.stop()
})

describe("retention.daily schedule (E3.1, E3.8, D-E8)", () => {
  it("schedules retention.daily at 03:00 Africa/Lagos on a singleton queue with retries off", async () => {
    await boot(false)
    expect((await schedule()).rows).toEqual([{ name: RETENTION_DAILY_QUEUE, cron: RETENTION_CRON, timezone: "Africa/Lagos" }])
    expect(RETENTION_CRON).toBe("0 3 * * *")
    const queue = await sql<{ policy: string; retry_limit: number }>`select policy, retry_limit from pgboss.queue where name = ${RETENTION_DAILY_QUEUE}`.execute(database.db)
    expect(queue.rows).toEqual([{ policy: "singleton", retry_limit: 0 }])
  })

  it("RETENTION_JOB_DISABLED=1 removes the schedule at start; restarting without it schedules again", async () => {
    await boot(false)
    await worker!.close()
    worker = null
    await boot(true)
    expect((await schedule()).rows).toEqual([])
    await worker!.close()
    worker = null
    await boot(false)
    expect((await schedule()).rows).toHaveLength(1)
  })
})
