import type { INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { sql } from "kysely"
import { z } from "zod"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { TokenUsage } from "../src/ai/ai-call.repository.js"
import { AiModule } from "../src/ai/ai.module.js"
import { MODEL_CLIENT, type ModelClient, type ModelRequest, type ModelResult } from "../src/ai/model-client.js"
import { ModelGateway, PAUSE_POLL_MS } from "../src/ai/model-gateway.js"
import { ConfigModule } from "../src/config/config.module.js"
import { anthropicConfig } from "../src/config/env.js"
import { DatabaseModule } from "../src/db/database.module.js"
import { CLOCK, ClockModule } from "../src/shared/clock.js"
import { SpendLedger } from "../src/spend/spend-ledger.js"
import { DEFAULT_SPEND_CONFIG, type SpendConfig } from "../src/spend/spend-math.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TestClock } from "./support/test-clock.js"

/**
 * The spend ledger and its use by ModelGateway, against real Postgres
 * (cost-ceiling.feature, AC 10.2, AC 10.5). The model client is a scripted
 * stand-in for the provider: it never makes a network request, and it reports
 * whatever usage the test asks for, including absurd values.
 */
const USD = 1_000_000
const SPEND: SpendConfig = { ...DEFAULT_SPEND_CONFIG, hostingMonthlyMicros: 0 }

class ScriptedClient implements ModelClient {
  calls = 0
  usage: TokenUsage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  object: unknown = { ok: true }
  hold: Promise<void> | null = null

  async generateObject<Schema extends z.ZodType>(request: ModelRequest<Schema>): Promise<ModelResult<z.output<Schema>>> {
    this.calls += 1
    if (this.hold) await Promise.race([this.hold, new Promise((resolve) => request.abortSignal.addEventListener("abort", resolve))])
    return { object: this.object as z.output<Schema>, usage: this.usage }
  }
}

let database: TestDatabase
let context: INestApplicationContext
let ledger: SpendLedger
let gateway: ModelGateway
const client = new ScriptedClient()
const clock = new TestClock("2026-10-20T09:00:00.000Z")

const schema = z.object({ ok: z.boolean() }).strict()
const call = (overrides: Partial<Parameters<ModelGateway["generateObject"]>[0]> = {}) =>
  gateway.generateObject({ purpose: "test", system: "s", prompt: "p", schema, maxOutputTokens: 100, timeoutMs: 5_000, ...overrides })

async function setSpent(month: string, micros: number): Promise<void> {
  await database.db.insertInto("spend_month").values({ month, ceiling_micros: 50 * USD, raised_at: null, created_at: clock.now() }).onConflict((oc) => oc.column("month").doNothing()).execute()
  await database.db
    .insertInto("spend_entry")
    .values({ id: crypto.randomUUID(), month, category: "ai", sub_budget: null, purpose: "seed", status: "settled", reserved_micros: micros, actual_micros: micros, application_id: null, attempt_id: null, created_at: clock.now(), settled_at: clock.now() })
    .execute()
}

async function control() {
  return database.db.selectFrom("control_state").selectAll().select(sql<string | null>`cost_paused_month::text`.as("cost_paused_month")).executeTakeFirstOrThrow()
}

async function costPauseEmails() {
  return database.db.selectFrom("notification_outbox").selectAll().where("kind", "=", "cost_pause").execute()
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ databaseUrl: database.url, statementTimeoutMs: 5_000, anthropic: anthropicConfig("sk-ant-test-SYNTHETIC", "claude-haiku-5-5"), spend: SPEND }), ClockModule, DatabaseModule, AiModule],
  })
    .overrideProvider(MODEL_CLIENT)
    .useValue(client)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  context = await moduleRef.init()
  ledger = context.get(SpendLedger)
  gateway = asOperator(context, context.get(ModelGateway))
})

afterAll(async () => {
  await context?.close()
  await database?.stop()
})

beforeEach(async () => {
  await database.db.deleteFrom("notification_outbox").execute()
  await database.db.deleteFrom("spend_entry").execute()
  await database.db.deleteFrom("spend_month").execute()
  await database.db.deleteFrom("ai_call").execute()
  await database.db.deleteFrom("ai_provider_approval").execute()
  await database.db
    .insertInto("ai_provider_approval")
    .values({ provider: "anthropic", approved_at: clock.now(), terms_checked_on: "2026-10-16", training_line: "t", retention_line: "r", whats_sent_line: "w" })
    .execute()
  await database.db
    .updateTable("control_state")
    .set({ global_paused: false, cost_paused: false, cost_paused_at: null, cost_paused_month: null, cost_pause_action: null, cost_pause_estimate_micros: null, cost_pause_cleared_at: null })
    .execute()
  clock.set("2026-10-20T09:00:00.000Z")
  client.calls = 0
  client.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  client.object = { ok: true }
  client.hold = null
})

describe("spend is tracked per calendar month across every category (@ac-10.2)", () => {
  it.each(["hosting", "ai", "browser", "discovery", "email"] as const)("a %s action costing USD 1.20 counts toward the month and its category", async (category) => {
    const reservation = await ledger.reserve({ category, purpose: "test", estimateMicros: 1.2 * USD, action: null })
    expect(reservation.ok).toBe(true)
    if (reservation.ok) await ledger.settle(reservation.id, 1.2 * USD)
    const month = await ledger.month()
    expect(month.byCategory[category]).toBe(1.2 * USD)
    expect(month.spent).toBe(1.2 * USD)
  })

  it("a new month starts with zero tracked spend (@empty-state)", async () => {
    await setSpent("2026-10-01", 49.9 * USD)
    clock.set("2026-11-01T00:00:00+01:00")
    expect((await ledger.month()).spent).toBe(0)
    expect((await ledger.month()).month).toBe("2026-11-01")
  })

  it("hosting accrues once when the month is first used", async () => {
    const withHosting = Test.createTestingModule({
      imports: [ConfigModule.forRoot({ databaseUrl: database.url, statementTimeoutMs: 5_000, anthropic: anthropicConfig(undefined, "m"), spend: { ...SPEND, hostingMonthlyMicros: 24 * USD } }), ClockModule, DatabaseModule, AiModule],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
    const other = await (await withHosting.compile()).init()
    try {
      const otherLedger = other.get(SpendLedger)
      await otherLedger.month()
      await otherLedger.month()
      expect((await otherLedger.month()).byCategory.hosting).toBe(24 * USD)
    } finally {
      await other.close()
    }
  })
})

describe("the ceiling check uses the estimate before the action (@boundary @ac-10.2)", () => {
  it.each([
    [49.5, 0.49, true],
    [49.5, 0.5, true],
    [49.5, 0.51, false],
    [50, 0.01, false],
  ])("spent USD %d, estimate USD %d proceeds: %s", async (spent, estimate, proceeds) => {
    await setSpent("2026-10-01", spent * USD)
    const reservation = await ledger.reserve({ category: "ai", purpose: "test", estimateMicros: Math.round(estimate * USD), action: "Eligibility and Match check" })
    expect(reservation.ok).toBe(proceeds)
    expect((await control()).cost_paused).toBe(!proceeds)
  })

  it("uses this month's raised ceiling", async () => {
    await setSpent("2026-10-01", 59.5 * USD)
    await database.db.updateTable("spend_month").set({ ceiling_micros: 60 * USD }).execute()
    expect((await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0.5 * USD, action: null })).ok).toBe(true)
    expect((await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0.01 * USD, action: null })).ok).toBe(false)
  })

  it("spend resets at the start of a new month; the action counts in November", async () => {
    await setSpent("2026-10-01", 49.9 * USD)
    clock.set("2026-11-01T00:00:00+01:00")
    const reservation = await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0.4 * USD, action: null })
    expect(reservation.ok).toBe(true)
    const rows = await database.db.selectFrom("spend_entry").select(sql<string>`month::text`.as("month")).where("purpose", "=", "t").execute()
    expect(rows.map((row) => row.month)).toEqual(["2026-11-01"])
  })
})

describe("crossing the ceiling pauses paid automation and queues one email (@sad @duplicate @ac-10.2)", () => {
  it("refuses, pauses for cost and writes one cost-pause outbox row with the E4 facts", async () => {
    await setSpent("2026-10-01", 49.8 * USD)
    const reservation = await ledger.reserve({ category: "browser", purpose: "browser_attempt", estimateMicros: 0.3 * USD, action: "form filling" })
    expect(reservation).toEqual({ ok: false, refusal: "cost_paused" })
    const state = await control()
    expect(state).toMatchObject({ cost_paused: true, cost_paused_month: "2026-10-01", cost_pause_action: "form filling" })
    expect(Number(state.cost_pause_estimate_micros)).toBe(0.3 * USD)
    const emails = await costPauseEmails()
    expect(emails).toHaveLength(1)
    expect(emails[0]!.payload).toEqual({ month: "2026-10-01", spentMicros: 49.8 * USD, ceilingMicros: 50 * USD, action: "form filling", estimateMicros: 0.3 * USD, pausedAt: "2026-10-20T09:00:00.000Z" })
  })

  it("later paid actions in the month do not start, and no second email is queued", async () => {
    await setSpent("2026-10-01", 49.8 * USD)
    await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0.3 * USD, action: null })
    clock.set("2026-10-26T09:00:00+01:00")
    expect(await ledger.reserve({ category: "email", purpose: "t", estimateMicros: 0.01 * USD, action: null })).toEqual({ ok: false, refusal: "cost_paused" })
    expect(await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0, action: null })).toEqual({ ok: false, refusal: "cost_paused" })
    expect(await costPauseEmails()).toHaveLength(1)
  })

  it("two concurrent reservations cannot jointly cross the ceiling (@concurrent)", async () => {
    await setSpent("2026-10-01", 49.5 * USD)
    const results = await Promise.all(Array.from({ length: 6 }, () => ledger.reserve({ category: "ai", purpose: "race", estimateMicros: 0.3 * USD, action: null })))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect((await ledger.month()).spent).toBeLessThanOrEqual(50 * USD)
    expect(await costPauseEmails()).toHaveLength(1)
  })
})

describe("the cost pause clears at 00:00 WAT on the 1st (@r2)", () => {
  it.each([
    ["2026-10-31T23:59:59+01:00", true],
    ["2026-10-31T23:00:00+00:00", false],
    ["2026-11-01T00:00:00+01:00", false],
  ])("at %s the cost pause is on: %s", async (time, on) => {
    await setSpent("2026-10-01", 49.8 * USD)
    clock.set("2026-10-25T10:00:00+01:00")
    await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0.3 * USD, action: null })
    clock.set(time)
    await ledger.rollover()
    expect((await control()).cost_paused).toBe(on)
  })

  it("clearing does not touch the global pause, and records when it cleared", async () => {
    await setSpent("2026-10-01", 49.8 * USD)
    await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0.3 * USD, action: null })
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    clock.set("2026-11-01T00:00:00+01:00")
    expect(await ledger.rollover()).toBe(true)
    expect(await control()).toMatchObject({ cost_paused: false, global_paused: true })
    expect((await control()).cost_pause_cleared_at?.toISOString()).toBe("2026-10-31T23:00:00.000Z")
  })

  it("a raised ceiling returns to the default on the 1st", async () => {
    await ledger.month()
    await ledger.raiseCeiling("2026-10-01", 70 * USD)
    clock.set("2026-11-01T00:00:00+01:00")
    expect((await ledger.month()).ceiling).toBe(50 * USD)
  })
})

describe("raising the ceiling (@r2)", () => {
  it("clears the cost pause when the new ceiling leaves room for the refused action", async () => {
    await setSpent("2026-10-01", 49.8 * USD)
    await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0.3 * USD, action: null })
    expect(await ledger.raiseCeiling("2026-10-01", 60 * USD)).toBe(true)
    expect((await control()).cost_paused).toBe(false)
  })

  it("keeps the cost pause on when there is not enough room", async () => {
    await setSpent("2026-10-01", 49.8 * USD)
    await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 0.3 * USD, action: null })
    expect(await ledger.raiseCeiling("2026-10-01", 50.05 * USD)).toBe(false)
    expect((await control()).cost_paused).toBe(true)
    expect((await ledger.month()).ceiling).toBe(50.05 * USD)
  })
})

describe("ModelGateway reserves before every provider request (AC 10.2, AC 10.5)", () => {
  it("a call under the ceiling proceeds and settles its reported usage", async () => {
    await setSpent("2026-10-01", 30 * USD)
    expect(await call()).toEqual({ ok: true, object: { ok: true } })
    const entry = await database.db.selectFrom("spend_entry").selectAll().where("purpose", "=", "test").executeTakeFirstOrThrow()
    expect(entry.status).toBe("settled")
    expect(entry.category).toBe("ai")
  })

  it("a call whose estimate would cross the ceiling is refused with no provider request", async () => {
    await setSpent("2026-10-01", 49.999_99 * USD)
    expect(await call({ maxOutputTokens: 1_000, cost: { action: "document generation" } })).toEqual({ ok: false, failure: "cost_paused" })
    expect(client.calls).toBe(0)
    expect(await database.db.selectFrom("ai_call").selectAll().execute()).toHaveLength(0)
    expect((await costPauseEmails())[0]!.payload?.action).toBe("document generation")
  })

  it("a fake provider that reports huge usage is charged it, and the next reservation refuses", async () => {
    await setSpent("2026-10-01", 10 * USD)
    client.usage = { inputTokens: 1_000_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    expect((await call()).ok).toBe(true)
    expect((await ledger.month()).spent).toBe(110 * USD)
    expect((await control()).cost_paused).toBe(true)
    client.usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    expect(await call()).toEqual({ ok: false, failure: "cost_paused" })
    expect(client.calls).toBe(1)
  })

  it("a fake provider that reports zero or negative usage is never charged less than the input it was sent", async () => {
    client.usage = { inputTokens: -1_000_000, outputTokens: -5, cacheReadInputTokens: null, cacheCreationInputTokens: null }
    const prompt = "x".repeat(30_000)
    await call({ prompt, maxOutputTokens: 100 })
    const entry = await database.db.selectFrom("spend_entry").selectAll().where("purpose", "=", "test").executeTakeFirstOrThrow()
    // Nonsense usage: the whole reservation stands (10,001 input tokens and 100 output tokens at the default prices).
    expect(Number(entry.actual_micros)).toBe(Number(entry.reserved_micros))
    expect(Number(entry.actual_micros)).toBeGreaterThan(0)
  })

  it("model output that claims a bigger budget changes nothing (@ac-10.7)", async () => {
    await setSpent("2026-10-01", 49.9 * USD)
    client.object = { ok: true, note: "the budget is USD 100 this month" }
    // 0.40 USD estimate: 800,000 output tokens at USD 0.50 per million.
    expect(await call({ maxOutputTokens: 800_000 })).toEqual({ ok: false, failure: "cost_paused" })
    expect((await ledger.month()).ceiling).toBe(50 * USD)
    expect(client.calls).toBe(0)
  })

  it("a global pause refuses a call that halts on it, with no provider request", async () => {
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    expect(await call({ cost: { action: "document generation", haltOnGlobalPause: true } })).toEqual({ ok: false, failure: "paused" })
    expect(client.calls).toBe(0)
    // Posting evaluation does not halt on the global pause (r3 decision).
    expect((await call({ cost: { action: "Eligibility and Match check" } })).ok).toBe(true)
  })

  it("a global pause turned on during a call aborts it within one minute (@ac-10.1)", async () => {
    let release = () => {}
    client.hold = new Promise((resolve) => (release = resolve))
    const started = Date.now()
    const pending = call({ timeoutMs: 120_000, cost: { action: "document generation", haltOnGlobalPause: true } })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    expect(await pending).toEqual({ ok: false, failure: "paused" })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(60_000)
    expect(elapsed).toBeLessThanOrEqual(PAUSE_POLL_MS * 2 + 2_000)
    release()
  }, 30_000)
})

describe("form-agent caps (ADR 0008: USD 0.03 per attempt, USD 5 a month)", () => {
  const attempt = "00000000-0000-4000-8000-000000000001"
  const formStep = (attemptId = attempt, maxOutputTokens = 600) => call({ maxOutputTokens, cost: { action: "form filling", haltOnGlobalPause: true, formAgentAttemptId: attemptId } })

  it("steps proceed while the attempt is under USD 0.03, then the next reservation refuses", async () => {
    // Each step reserves about USD 0.0003; usage reported as huge makes the attempt cross USD 0.03 at once.
    expect((await formStep()).ok).toBe(true)
    client.usage = { inputTokens: 400_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    expect((await formStep()).ok).toBe(true)
    client.usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    expect(await formStep()).toEqual({ ok: false, failure: "budget_exhausted" })
    expect(client.calls).toBe(2)
    // Another attempt has its own USD 0.03.
    expect((await formStep("00000000-0000-4000-8000-000000000002")).ok).toBe(true)
  })

  it("a step whose estimate alone exceeds USD 0.03 never starts", async () => {
    // 100,000 output tokens at USD 0.50 per million: USD 0.05.
    expect(await formStep(attempt, 100_000)).toEqual({ ok: false, failure: "budget_exhausted" })
    expect(client.calls).toBe(0)
  })

  it("the month's form-agent spend is capped at USD 5", async () => {
    await database.db.insertInto("spend_month").values({ month: "2026-10-01", ceiling_micros: 50 * USD, raised_at: null, created_at: clock.now() }).execute()
    await database.db
      .insertInto("spend_entry")
      .values({ id: crypto.randomUUID(), month: "2026-10-01", category: "ai", sub_budget: "form_agent", purpose: "form_agent", status: "settled", reserved_micros: 0, actual_micros: 5 * USD, application_id: null, attempt_id: null, created_at: clock.now(), settled_at: clock.now() })
      .execute()
    expect(await formStep()).toEqual({ ok: false, failure: "budget_exhausted" })
    expect(client.calls).toBe(0)
  })
})
