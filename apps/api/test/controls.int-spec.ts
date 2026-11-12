import type { INestApplication } from "@nestjs/common"
import { CONTROLS_PATH, GLOBAL_PAUSE_PATH, MONTHLY_CEILING_PATH, controlsSchema, raiseCeilingResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { TenantDatabase } from "../src/db/tenant-database.js"
import { DiscoveryPipeline } from "../src/discovery/discovery-pipeline.js"
import { SpendLedger } from "../src/spend/spend-ledger.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * Pause and cost controls through the real api (global-pause.feature,
 * cost-ceiling.feature dashboard and validation scenarios), real Postgres.
 */
const USD = 1_000_000
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate
let anonymous: Browser
const clock = new TestClock("2026-10-20T09:00:00.000Z")

async function seedSpend(micros: number, month = "2026-10-01"): Promise<void> {
  await app.get(SpendLedger).month()
  await database.db
    .insertInto("spend_entry")
    .values({ id: crypto.randomUUID(), month, category: "ai", sub_budget: null, purpose: "seed", status: "settled", reserved_micros: micros, actual_micros: micros, application_id: null, attempt_id: null, created_at: clock.now(), settled_at: clock.now() })
    .execute()
}

async function costPauseNow(estimate = 0.3 * USD): Promise<void> {
  expect((await app.get(SpendLedger).reserve({ category: "browser", purpose: "t", estimateMicros: estimate, action: "form filling" })).ok).toBe(false)
}

const controls = async () => controlsSchema.parse((await candidate.get(CONTROLS_PATH).expect(200)).body)
const raise = (ceiling: string, month = "2026-10-01") => candidate.put(MONTHLY_CEILING_PATH).send({ month, ceiling })
async function raised(ceiling: string) {
  const body = raiseCeilingResponseSchema.parse((await raise(ceiling).expect(200)).body)
  if (body.result !== "raised") throw new Error(`expected a raise, got ${body.refusal}`)
  return body
}
async function refused(ceiling: string) {
  const body = raiseCeilingResponseSchema.parse((await raise(ceiling).expect(200)).body)
  if (body.result !== "refused") throw new Error("expected a refusal")
  return body
}

/** Direct pipeline, evaluator and repository calls run in the owner's (Operator's) scope, as the worker and the session give it. */
const asOwner = <T>(work: () => Promise<T>) => app.get(TenantDatabase).asOperator(work)

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  anonymous = new Browser(app, google)
  candidate = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  clock.set("2026-10-20T09:00:00.000Z")
  await database.db.deleteFrom("notification_outbox").execute()
  await database.db.deleteFrom("spend_entry").execute()
  await database.db.deleteFrom("spend_month").execute()
  await database.db
    .updateTable("control_state")
    .set({ global_paused: false, global_paused_at: null, cost_paused: false, cost_paused_at: null, cost_paused_month: null, cost_pause_action: null, cost_pause_estimate_micros: null, cost_pause_cleared_at: null })
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("GET /v1/controls: spend against this month's ceiling (dashboard.feature, cost-ceiling.feature)", () => {
  it("shows this month's spend, the USD 50.00 ceiling, the category breakdown and the hosting accrual", async () => {
    await seedSpend(0.4 * USD)
    const body = await controls()
    expect(body.spend).toMatchObject({ month: "2026-10-01", ceiling: "50.00", defaultCeiling: "50.00", raised: false, maxCeiling: "100.00", canRaise: true })
    expect(body.spend.byCategory).toEqual({ hosting: "24.00", ai: "0.40", browser: "0.00", discovery: "0.00", email: "0.00" })
    expect(body.spend.spent).toBe("24.40")
    expect(body.spend.percentUsed).toBe(48)
    expect(body).toMatchObject({ globalPaused: false, globalPausedAt: null, costPause: null })
  })

  it("shows the cost pause with its automatic resume at 00:00 WAT on the 1st and the refused action", async () => {
    clock.set("2026-10-25T10:00:00+01:00")
    await seedSpend(25.8 * USD)
    await costPauseNow()
    expect((await controls()).costPause).toEqual({
      pausedAt: "2026-10-25T09:00:00.000Z",
      month: "2026-10-01",
      resumesAt: "2026-10-31T23:00:00.000Z",
      nextAction: "form filling",
      nextActionEstimate: "0.30",
    })
  })

  it("a new month starts with zero tracked spend apart from hosting, and the cost pause cleared", async () => {
    await seedSpend(25.8 * USD)
    await costPauseNow()
    clock.set("2026-11-01T00:00:00+01:00")
    const body = await controls()
    expect(body.costPause).toBeNull()
    expect(body.spend).toMatchObject({ month: "2026-11-01", spent: "24.00", ceiling: "50.00" })
  })

  it("refuses an unauthenticated request with no data", async () => {
    const response = await anonymous.http().get(CONTROLS_PATH).expect(401)
    expect(Object.keys(response.body)).toEqual(["error"])
  })
})

describe("the global pause (global-pause.feature, AC 10.1)", () => {
  it("turning it on twice keeps it on and keeps the first time; turning it off clears it (@duplicate)", async () => {
    const on = controlsSchema.parse((await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: true }).expect(200)).body)
    expect(on).toMatchObject({ globalPaused: true, globalPausedAt: "2026-10-20T09:00:00.000Z" })
    clock.set("2026-10-20T10:00:00.000Z")
    const again = controlsSchema.parse((await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: true }).expect(200)).body)
    expect(again.globalPausedAt).toBe("2026-10-20T09:00:00.000Z")
    const off = controlsSchema.parse((await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: false }).expect(200)).body)
    expect(off).toMatchObject({ globalPaused: false, globalPausedAt: null })
  })

  it("resuming the global pause does not clear the cost pause, and turning it on does not change it (@ac-10.2 @r2)", async () => {
    await seedSpend(25.8 * USD)
    await costPauseNow()
    await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: true }).expect(200)
    expect((await controls()).costPause).not.toBeNull()
    const resumed = controlsSchema.parse((await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: false }).expect(200)).body)
    expect(resumed.globalPaused).toBe(false)
    expect(resumed.costPause).not.toBeNull()
    expect((await app.get(SpendLedger).reserve({ category: "ai", purpose: "t", estimateMicros: 1, action: null })).ok).toBe(false)
  })

  it("unpausing leaves the Activation Gate recorded and automatic submission as it was (@ac-2.5)", async () => {
    await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
    await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: true }).expect(200)
    await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: false }).expect(200)
    const activation = await database.db.selectFrom("activation_state").selectAll().executeTakeFirstOrThrow()
    expect(activation.gate_passed_at?.toISOString()).toBe("2026-10-19T12:00:00.000Z")
    expect(activation.automatic_enabled).toBe(true)
  })

  it("while paused, discovery does not start; nothing resumes until unpaused (@ac-10.1)", async () => {
    await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: true }).expect(200)
    clock.set("2026-10-21T08:00:00+01:00")
    expect(await asOwner(() => app.get(DiscoveryPipeline).runDaily({ ignoreApproval: true }))).toMatchObject({ started: false, reason: "global_paused" })
  })

  it("while cost-paused, discovery does not start, with no Job Source read (SEC-306)", async () => {
    await seedSpend(25.8 * USD)
    await costPauseNow()
    expect(await asOwner(() => app.get(DiscoveryPipeline).runDaily({ ignoreApproval: true }))).toMatchObject({ started: false, reason: "cost_paused" })
  })

  it("an unauthenticated request cannot change it, and a request without the CSRF token is refused (@permission)", async () => {
    await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: true }).expect(200)
    await anonymous.http().put(GLOBAL_PAUSE_PATH).send({ paused: false }).expect(401)
    await anonymous.http().put(GLOBAL_PAUSE_PATH).set("cookie", candidate.cookie).send({ paused: false }).expect(403)
    expect((await controls()).globalPaused).toBe(true)
  })

  it("refuses a body that is not exactly { paused: boolean }", async () => {
    await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: "yes" }).expect(400)
    await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: true, costPaused: false }).expect(400)
  })
})

describe("raising this month's ceiling (cost-ceiling.feature @r2 @r3)", () => {
  it("raising with room clears the cost pause and returns the new ceiling", async () => {
    await seedSpend(25.8 * USD)
    await costPauseNow()
    const body = await raised("60.00")
    expect(body.costPauseCleared).toBe(true)
    expect(body.controls.spend).toMatchObject({ ceiling: "60.00", raised: true })
    expect(body.controls.costPause).toBeNull()
  })

  it("raising without enough room keeps the cost pause on and names the new ceiling", async () => {
    await seedSpend(25.8 * USD)
    await costPauseNow()
    const body = await raised("50.05")
    expect(body.costPauseCleared).toBe(false)
    expect(body.controls.spend.ceiling).toBe("50.05")
    expect(body.controls.costPause).not.toBeNull()
  })

  it("can be raised while not paused; it can be raised again only higher", async () => {
    await raised("70.00")
    expect(await refused("65.00")).toEqual({ result: "refused", refusal: "ceiling_not_above_current", message: "Enter more than USD 70.00, this month's current ceiling." })
    await raised("80.00")
    expect((await controls()).spend.ceiling).toBe("80.00")
  })

  it.each([
    ["", "ceiling_empty", "Enter the new ceiling in USD."],
    ["sixty", "ceiling_invalid", "Enter an amount like 60 or 62.50."],
    ["60.505", "ceiling_invalid", "Enter an amount like 60 or 62.50."],
    ["50.00", "ceiling_not_above_current", "Enter more than USD 50.00, this month's current ceiling."],
    ["45.00", "ceiling_not_above_current", "Enter more than USD 50.00, this month's current ceiling."],
    ["100.01", "ceiling_above_limit", "Enter USD 100.00 or less. That's the most this month's ceiling can be."],
    ["9999.99", "ceiling_above_limit", "Enter USD 100.00 or less. That's the most this month's ceiling can be."],
    ["10000.00", "ceiling_above_limit", "Enter USD 100.00 or less. That's the most this month's ceiling can be."],
  ])("refuses %j with %s and leaves the ceiling at USD 50.00", async (input, refusal, message) => {
    expect(await refused(input)).toEqual({ result: "refused", refusal, message })
    expect((await controls()).spend.ceiling).toBe("50.00")
  })

  it("refuses an entry below reconciled spend that is above the ceiling (C-VAL-COST-5)", async () => {
    await seedSpend(28.4 * USD)
    expect((await controls()).spend.spent).toBe("52.40")
    expect((await refused("51.00")).message).toBe(
      "This month's spend is already USD 52.40, above the current ceiling of USD 50.00. Enter more than USD 52.40 so there's room for the next paid action."
    )
    expect((await controls()).spend.ceiling).toBe("50.00")
  })

  it("refuses a raise for any month but the current WAT month", async () => {
    await raise("80.00", "2026-11-01").expect(400)
    clock.set("2026-11-01T00:00:00+01:00")
    expect((await controls()).spend.ceiling).toBe("50.00")
  })

  it("an unauthenticated request cannot raise it (@permission)", async () => {
    await anonymous.http().put(MONTHLY_CEILING_PATH).send({ month: "2026-10-01", ceiling: "100.00" }).expect(401)
    expect((await controls()).spend.ceiling).toBe("50.00")
  })

  it("at USD 100.00 no raise is possible (C-COST-9)", async () => {
    await raised("100.00")
    expect((await controls()).spend.canRaise).toBe(false)
  })
})
