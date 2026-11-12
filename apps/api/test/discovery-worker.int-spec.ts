import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { sql } from "kysely"
import { setupServer } from "msw/node"
import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CLOCK } from "../src/shared/clock.js"
import { DISCOVERY_CRON, DISCOVERY_DAILY_QUEUE, DiscoveryJobs, EVALUATE_POSTING_QUEUE, SPEND_TICK_CRON, SPEND_TICK_QUEUE } from "../src/worker/discovery-jobs.js"
import { SUBMISSION_DAILY_QUEUE, SubmissionJobs } from "../src/worker/submission-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { migratedStorageRoot } from "./support/test-app.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor } from "./support/candidate-posting.js"

let database: TestDatabase
let worker: INestApplicationContext
const outbound: string[] = []
const server = setupServer()
const clock = new TestClock("2026-10-20T07:00:00.000Z")

beforeAll(async () => {
  server.listen({ onUnhandledFrame: "bypass" })
  server.events.on("request:start", ({ request }) => {
    if (!["127.0.0.1", "localhost"].includes(new URL(request.url).hostname)) outbound.push(request.url)
  })
  database = await startMigratedDatabase()
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
})

afterAll(async () => {
  await worker?.close()
  server.close()
  await database?.stop()
})

describe("worker discovery jobs (AC 3.1, 3.2)", () => {
  it("boots as the runtime role and schedules discovery.daily at 08:00 Africa/Lagos with the singleton policy", async () => {
    const schedule = await sql<{ name: string; cron: string; timezone: string }>`
      select name, cron, timezone from pgboss.schedule where name = ${DISCOVERY_DAILY_QUEUE}`.execute(database.db)
    expect(schedule.rows).toEqual([{ name: DISCOVERY_DAILY_QUEUE, cron: DISCOVERY_CRON, timezone: "Africa/Lagos" }])
    const queues = await sql<{ name: string; policy: string }>`
      select name, policy from pgboss.queue where name in (${DISCOVERY_DAILY_QUEUE}, ${EVALUATE_POSTING_QUEUE}) order by name`.execute(database.db)
    expect(queues.rows).toEqual([
      { name: DISCOVERY_DAILY_QUEUE, policy: "singleton" },
      { name: EVALUATE_POSTING_QUEUE, policy: "standard" },
    ])
  })

  it("the scheduled handler reads no board until the employer list is approved", async () => {
    outbound.length = 0
    await worker.get(DiscoveryJobs).runDiscovery()
    expect(outbound).toEqual([])
    expect(await database.db.selectFrom("job_posting").select("id").execute()).toEqual([])
  })
})

describe("worker submission job (slice 5, ADR 0005)", () => {
  it("registers the submission queue with retries off, and the job submits nothing before the gate", async () => {
    const queue = await sql<{ name: string; policy: string; retry_limit: number }>`
      select name, policy, retry_limit from pgboss.queue where name = ${SUBMISSION_DAILY_QUEUE}`.execute(database.db)
    expect(queue.rows).toEqual([{ name: SUBMISSION_DAILY_QUEUE, policy: "singleton", retry_limit: 0 }])
    expect(await worker.get(SubmissionJobs).runSubmissions()).toEqual({ submitted: 0, carriedOver: 0, stoppedBy: "gate_not_passed" })
  })

  it("the daily sample step prepares nothing without an approved Career Profile and opens no browser", async () => {
    expect(await worker.get(SubmissionJobs).runSamples()).toEqual({ prepared: { created: 0, stoppedBy: "career_profile_not_approved" }, formsRead: 0 })
  })
})

describe("slice 7: the spend tick (cost-ceiling.feature @r2, @r4)", () => {
  // EPIC-0006 (AC-7.4): spend.tick releases only visible waiting postings, so the fixture is untitled (never
  // off-target) and dated inside 60 days; `postedAt: null` makes it undated, so hidden.
  const waitingPosting = async (postedAt: Date | null = new Date("2026-10-20T09:00:00Z")) => {
    const id = randomUUID()
    await insertPostingFor(database.db, database.operatorId, { id, application_url: `https://jobs.lever.co/globex/${id}`, requisition_id: id, apply_url: `https://jobs.lever.co/globex/${id}`, application_system: "lever", apply_mode: "automatic", origin: "pasted_link", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: null, company: "Globex", status: "waiting_to_be_checked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: null, discovered_at: new Date(), evaluated_at: null, posted_at: postedAt, posted_date_kind: postedAt === null ? null : "published" })
    return id
  }
  const queuedEvaluations = async (id: string) => {
    const rows = await sql<{ n: number }>`select count(*)::int as n from pgboss.job where name = ${EVALUATE_POSTING_QUEUE} and singleton_key = ${id}`.execute(database.db)
    return rows.rows[0]!.n
  }

  it("is scheduled every minute in Africa/Lagos", async () => {
    const schedule = await sql<{ cron: string; timezone: string }>`select cron, timezone from pgboss.schedule where name = ${SPEND_TICK_QUEUE}`.execute(database.db)
    expect(schedule.rows).toEqual([{ cron: SPEND_TICK_CRON, timezone: "Africa/Lagos" }])
  })

  it("while cost-paused, a saved link is not released; at 00:00 WAT on the 1st the pause clears and it is queued for evaluation", async () => {
    clock.set("2026-10-26T09:00:00+01:00")
    await database.db.updateTable("control_state").set({ cost_paused: true, cost_paused_month: "2026-10-01", global_paused: true }).execute()
    const id = await waitingPosting()
    expect(await worker.get(DiscoveryJobs).spendTick()).toBe(0)
    expect(await queuedEvaluations(id)).toBe(0)
    clock.set("2026-11-01T00:00:00+01:00")
    expect(await worker.get(DiscoveryJobs).spendTick()).toBeGreaterThanOrEqual(1)
    expect(await queuedEvaluations(id)).toBe(1)
    const control = await database.db.selectFrom("control_state").select(["cost_paused", "global_paused"]).executeTakeFirstOrThrow()
    // The global pause is untouched by the cost rollover.
    expect(control).toEqual({ cost_paused: false, global_paused: true })
    await database.db.updateTable("control_state").set({ global_paused: false }).execute()
  })

  it("EPIC-0006 (AC-7.1, AC-7.4): a hidden waiting posting is not released and stays waiting", async () => {
    clock.set("2026-11-02T09:00:00+01:00")
    const undated = await waitingPosting(null)
    await worker.get(DiscoveryJobs).spendTick()
    expect(await queuedEvaluations(undated)).toBe(0)
    const row = await database.db.selectFrom("candidate_posting").select("status").where("job_posting_id", "=", undated).executeTakeFirstOrThrow()
    expect(row.status).toBe("waiting_to_be_checked")
  })
})

describe("EPIC-0006 evaluate.posting job scope (contract 'Worker job payloads'; threat model TM-01)", () => {
  it.each([
    ["an unknown Candidate", () => randomUUID()],
    ["a malformed id", () => "not-a-uuid"],
  ])("drops a job naming %s with no write and no model call", async (_name, candidate) => {
    outbound.length = 0
    const before = await database.db.selectFrom("candidate_posting").selectAll().execute()
    await worker.get(DiscoveryJobs).evaluateJob({ postingId: randomUUID(), candidateId: candidate() })
    expect(outbound).toEqual([])
    expect(await database.db.selectFrom("candidate_posting").selectAll().execute()).toEqual(before)
  })

  it.each([["candidate", "active"], ["operator", "revoked"]])("drops a job for a %s Candidate who is %s before any spend", async (role, state) => {
    const email = `${role}-${state}@example.test`
    // One Operator per installation: the revoked-Operator case revokes the real one and restores it after.
    const id =
      role === "operator"
        ? database.operatorId
        : (await database.db.insertInto("candidate").values({ email, google_sub: `sub-${email}`, role, state } as never).returning("id").executeTakeFirstOrThrow()).id
    if (role === "operator") await database.db.updateTable("candidate").set({ state: "revoked" }).where("id", "=", id).execute()
    onTestFinished(async () => {
      await database.db.updateTable("candidate").set({ state: "active" }).where("id", "=", database.operatorId).execute()
    })
    const posting = randomUUID()
    await insertPostingFor(database.db, id, { id: posting, application_url: `https://jobs.lever.co/g/${posting}`, requisition_id: posting, apply_url: `https://jobs.lever.co/g/${posting}`, application_system: "lever", apply_mode: "automatic", origin: "pasted_link", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: null, company: "G", status: "checking", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: null, discovered_at: new Date(), evaluated_at: null, posted_at: new Date("2026-10-30T00:00:00Z"), posted_date_kind: "published" })
    const spend = await sql<{ n: number }>`select count(*)::int as n from spend_entry`.execute(database.db)
    outbound.length = 0
    await worker.get(DiscoveryJobs).evaluateJob({ postingId: posting, candidateId: id })
    expect(outbound).toEqual([])
    expect((await sql<{ n: number }>`select count(*)::int as n from spend_entry`.execute(database.db)).rows).toEqual(spend.rows)
    // The worker drops the job before the evaluator, so the row is untouched.
    expect((await database.db.selectFrom("candidate_posting").select("status").where("candidate_id", "=", id).where("job_posting_id", "=", posting).executeTakeFirstOrThrow()).status).toBe("checking")
  })
})
