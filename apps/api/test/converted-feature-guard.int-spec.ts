import type { INestApplication } from "@nestjs/common"
import { ME_PATH, apiErrorResponseSchema, meResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { CONVERTED } from "../src/shared/converted-features.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { GUARDED_ROUTES, UNGUARDED_CANDIDATE_ROUTES } from "./converted-feature.cases.js"

/**
 * EPIC-0002 A2 (architecture r3/r4 "Fail closed before conversion", AC 6.6, 6.7):
 * every route behind ConvertedFeatureGuard refuses a non-Operator with 409
 * `feature_not_yet_available` and its feature while `CONVERTED` is false, and
 * writes nothing; the Operator passes; `/v1/me.capabilities` reports the same
 * rule. Kofi is seeded directly (slice C builds invites) and signs in over HTTP.
 *
 * Gherkin: data-isolation.feature:587, :596, :649, :657, :678, :686, :698, :480;
 * spend-ceilings.feature:138; pauses-caps-and-activation-gate.feature:592.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let kofi: SignedInCandidate
let kofiId: string
const clock = new TestClock("2026-10-21T09:00:00.000Z")
const KOFI_SUB = "200000000000000000a21"
const KOFI_EMAIL = "kofi.a2@example.test"
const SOME_ID = "00000000-0000-4000-8000-0000000000a2"

/** Every row count a guarded call could change, for the "nothing is written" checks. */
async function writeFingerprint(): Promise<string> {
  const counts: Record<string, unknown> = {}
  for (const table of ["application", "activation_state", "submission_day", "submission_event", "notification_outbox", "existing_application", "control_state", "spend_month", "spend_entry"] as const) {
    counts[table] = await database.db.selectFrom(table).selectAll().execute()
  }
  return JSON.stringify(counts)
}

function call(who: SignedInCandidate, method: string, path: string) {
  const concrete = path.replace(":id", SOME_ID)
  switch (method) {
    case "GET":
      return who.get(concrete)
    case "PUT":
      return who.put(concrete).send({})
    case "POST":
      return who.post(concrete).send({})
    default:
      throw new Error(`unexpected method ${method}`)
  }
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  kofiId = (await database.db.insertInto("candidate").values({ email: KOFI_EMAIL, google_sub: KOFI_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  // Slice C's onboarding writes an invitee's per-Candidate singletons; seeded here as A2 has no invite flow.
  await database.db.insertInto("activation_state").values({ candidate_id: kofiId, existing_applications_completed_at: null, gate_passed_at: null }).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: KOFI_SUB, email: KOFI_EMAIL, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  kofi = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, KOFI_EMAIL)
})

beforeEach(() => {
  clock.set("2026-10-21T09:00:00.000Z")
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("CONVERTED in slice A (architecture r3)", () => {
  it("all three features are unconverted", () => {
    expect(CONVERTED).toEqual({ submission: false, notifications: false, spend: false })
  })
})

describe("a non-Operator gets 409 feature_not_yet_available on every guarded route and nothing is written", () => {
  it.each(GUARDED_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))("%s", async (_name, route) => {
    const before = await writeFingerprint()
    const response = await call(kofi, route.method, route.path)
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body)).toEqual({
      error: { code: "feature_not_yet_available", message: "This feature isn't available for your account yet.", feature: route.feature },
    })
    expect(await writeFingerprint()).toBe(before)
  })

  it("the controls refusal reveals no spend figure (data-isolation.feature:587)", async () => {
    await database.db.insertInto("spend_month").values({ month: "2026-10-01", ceiling_micros: 50_000_000, raised_at: null, created_at: new Date() }).onConflict((oc) => oc.column("month").doUpdateSet({ ceiling_micros: 50_000_000 })).execute()
    const response = await kofi.get("/v1/controls").expect(409)
    expect(JSON.stringify(response.body)).not.toMatch(/50\.00|50000000|ceiling|spent/i)
  })
})

describe("the Operator passes the guard (no 409 on any guarded route)", () => {
  it.each(GUARDED_ROUTES.filter((route) => route.method === "GET").map((route) => [`${route.method} ${route.path}`, route] as const))("%s", async (_name, route) => {
    const response = await call(ada, route.method, route.path)
    expect(response.status).not.toBe(409)
    expect(response.body?.error?.code).not.toBe("feature_not_yet_available")
  })
})

describe("unguarded Candidate routes serve a non-Operator (data-isolation.feature:698, :480)", () => {
  it.each(UNGUARDED_CANDIDATE_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))("%s is not refused with feature_not_yet_available", async (_name, route) => {
    const response = await call(kofi, route.method, route.path)
    expect(response.body?.error?.code).not.toBe("feature_not_yet_available")
  })

  it("GET /v1/existing-applications is 200 for Kofi", async () => {
    await kofi.get("/v1/existing-applications").expect(200)
  })
})

describe("GET /v1/me reports capabilities as isOperator || CONVERTED (data-isolation.feature:596, :686)", () => {
  it("the Operator: every capability available", async () => {
    const body = meResponseSchema.parse((await ada.get(ME_PATH).expect(200)).body)
    expect(body).toEqual({ candidateId: database.operatorId, email: expect.any(String), isOperator: true, capabilities: { submission: "available", notifications: "available", spend: "available" }, advancedEnabled: true, advancedLocked: false, simplerNoteDue: false, improveListDismissed: false })
  })

  it("an invitee: every capability not_yet, own ID and email only", async () => {
    const response = await kofi.get(ME_PATH).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(meResponseSchema.parse(response.body)).toEqual({ candidateId: kofiId, email: KOFI_EMAIL, isOperator: false, capabilities: { submission: "not_yet", notifications: "not_yet", spend: "not_yet" }, advancedEnabled: false, advancedLocked: false, simplerNoteDue: false, improveListDismissed: false })
    expect(JSON.stringify(response.body)).not.toContain(database.operatorId)
  })

  it("is not served without a session", async () => {
    const response = await new Browser(app, google).http().get(ME_PATH)
    expect(response.status).toBe(401)
  })
})
