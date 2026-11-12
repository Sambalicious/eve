import type { INestApplication } from "@nestjs/common"
import { ANTHROPIC_TERMS, aiProviderResponseSchema } from "@eve/contracts"
import { z } from "zod"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { ModelGateway } from "../src/ai/model-gateway.js"
import { anthropicConfig } from "../src/config/env.js"
import { DEFAULT_DOCUMENTS_AI_PRICES, DEFAULT_SPEND_CONFIG, aiEstimateMicros } from "../src/spend/spend-math.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { CANDIDATE_EMAIL, TEST_ANTHROPIC_KEY, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
const clock = new TestClock(new Date("2026-10-16T09:00:00.000Z"))
const probeSchema = z.object({ facts: z.array(z.string()) }).strict()

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  await database.db.deleteFrom("ai_call").execute()
  await database.db.deleteFrom("ai_provider_approval").execute()
  outbound.reset()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

function draftThroughGateway(gateway: ModelGateway) {
  return gateway.generateObject({
    purpose: "probe",
    system: "Extract facts.",
    prompt: "Ada Okafor. Led a team of 4 frontend engineers.",
    schema: probeSchema,
    maxOutputTokens: 100,
    timeoutMs: 5_000,
  })
}

describe("GET /v1/ai-provider", () => {
  it("shows Anthropic, the terms summary with its checked date and sources, and no approval", async () => {
    const response = await candidate.get("/v1/ai-provider").expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    const body = aiProviderResponseSchema.parse(response.body)
    expect(body).toEqual({ provider: "anthropic", name: "Anthropic", terms: { ...ANTHROPIC_TERMS }, approval: null })
    expect(body.terms.trainingLine).toBe(
      "Training: Anthropic doesn't train on API inputs and outputs by default. Thumbs-up or thumbs-down feedback is kept for 5 years and may be used."
    )
  })

  it("refuses an unauthenticated request", async () => {
    const response = await browser.http().get("/v1/ai-provider").expect(401)
    expect(response.body.error.code).toBe("unauthenticated")
  })
})

describe("POST /v1/ai-provider/approval", () => {
  it("records Anthropic with the served training, retention and what's-sent lines and the time", async () => {
    const response = await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    expect(response.body.approval).toEqual({
      approvedAt: "2026-10-16T09:00:00.000Z",
      termsCheckedOn: "2026-10-16",
      trainingLine: ANTHROPIC_TERMS.trainingLine,
      retentionLine: ANTHROPIC_TERMS.retentionLine,
      whatsSentLine: ANTHROPIC_TERMS.whatsSentLine,
    })
    const rows = await database.db.selectFrom("ai_provider_approval").selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.retention_line).toBe(
      "Retention: inputs and outputs are deleted within 30 days, except content flagged under Anthropic's Usage Policy, which can be kept up to 2 years."
    )
    expect(outbound.urls).toEqual([])
  })

  it("approving twice keeps the first record", async () => {
    await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    clock.set("2026-10-16T09:01:00.000Z")
    const second = await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    expect(second.body.approval.approvedAt).toBe("2026-10-16T09:00:00.000Z")
    clock.set("2026-10-16T09:00:00.000Z")
  })

  it.each([
    ["a stale terms date", { termsCheckedOn: "2026-01-01" }],
    ["client-supplied terms text", { termsCheckedOn: "2026-10-16", trainingLine: "Anthropic trains on everything" }],
    ["no body", undefined],
  ])("refuses %s with 400 and records nothing", async (_label, body) => {
    const response = await candidate.post("/v1/ai-provider/approval").send(body).expect(400)
    expect(response.body.error.code).toBe("bad_request")
    expect(await database.db.selectFrom("ai_provider_approval").selectAll().execute()).toEqual([])
  })

  it("refuses an unauthenticated request and records nothing", async () => {
    await browser.http().post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(401)
    expect(await database.db.selectFrom("ai_provider_approval").selectAll().execute()).toEqual([])
  })

  it("refuses a signed-in request without the CSRF token and records nothing", async () => {
    await browser
      .http()
      .post("/v1/ai-provider/approval")
      .set("cookie", candidate.cookie)
      .send({ termsCheckedOn: "2026-10-16" })
      .expect(403)
    expect(await database.db.selectFrom("ai_provider_approval").selectAll().execute()).toEqual([])
  })
})

describe("ModelGateway (ADR 0006)", () => {
  it("makes zero outbound requests and no metering row when Anthropic is not approved", async () => {
    anthropic.replyWithObject({ facts: ["x"] })
    const result = await draftThroughGateway(asOperator(app, app.get(ModelGateway)))
    expect(result).toEqual({ ok: false, failure: "not_approved" })
    expect(anthropic.requests).toHaveLength(0)
    expect(outbound.urls).toEqual([])
    expect(await database.db.selectFrom("ai_call").selectAll().execute()).toEqual([])
  })

  it("after approval sends exactly one request to Anthropic with the env key and records its usage", async () => {
    await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    anthropic.replyWithObject({ facts: ["Led a team of 4 frontend engineers."] }, { input: 1234, output: 56 })
    const result = await draftThroughGateway(asOperator(app, app.get(ModelGateway)))
    expect(result).toEqual({ ok: true, object: { facts: ["Led a team of 4 frontend engineers."] } })
    expect(outbound.urls).toEqual(["POST https://api.anthropic.com/v1/messages"])
    expect(anthropic.requests[0]?.apiKey).toBe(TEST_ANTHROPIC_KEY)
    expect(anthropic.requests[0]?.body.model).toBe("claude-haiku-5-5")
    const [call] = await database.db.selectFrom("ai_call").selectAll().execute()
    expect(call).toMatchObject({
      purpose: "probe",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      status: "succeeded",
      input_tokens: 1234,
      output_tokens: 56,
    })
  })

  it("rejects output that fails the schema, still meters it, and does not retry", async () => {
    await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    anthropic.replyWithObject({ facts: "not an array" }, { input: 900, output: 20 })
    const result = await draftThroughGateway(asOperator(app, app.get(ModelGateway)))
    expect(result).toEqual({ ok: false, failure: "invalid_output" })
    expect(anthropic.requests).toHaveLength(1)
    const [call] = await database.db.selectFrom("ai_call").selectAll().execute()
    expect(call).toMatchObject({ status: "invalid_output", input_tokens: 900, output_tokens: 20 })
  })

  it("records a provider error once without retrying", async () => {
    await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    anthropic.replyWithStatus(529)
    anthropic.replyWithStatus(529)
    const result = await draftThroughGateway(asOperator(app, app.get(ModelGateway)))
    expect(result).toEqual({ ok: false, failure: "provider_error" })
    expect(anthropic.requests).toHaveLength(1)
    const [call] = await database.db.selectFrom("ai_call").selectAll().execute()
    expect(call?.status).toBe("provider_error")
  })

  it("records a timeout when Anthropic does not answer in time", async () => {
    await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
    anthropic.replyByHanging()
    const result = await asOperator(app, app.get(ModelGateway)).generateObject({
      purpose: "probe",
      system: "s",
      prompt: "p",
      schema: probeSchema,
      maxOutputTokens: 10,
      timeoutMs: 300,
    })
    expect(result).toEqual({ ok: false, failure: "timed_out" })
    expect(anthropic.requests).toHaveLength(1)
    const [call] = await database.db.selectFrom("ai_call").selectAll().execute()
    expect(call?.status).toBe("timed_out")
    anthropic.release()
  })

  it("with no key configured makes zero outbound requests even when approved", async () => {
    const keyless = await createTestApp({
      databaseUrl: database.url,
      clock,
      config: { anthropic: anthropicConfig(undefined, "claude-haiku-5-5") },
    })
    try {
      await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
      const result = await draftThroughGateway(asOperator(keyless, keyless.get(ModelGateway)))
      expect(result).toEqual({ ok: false, failure: "not_configured" })
      expect(outbound.urls).toEqual([])
    } finally {
      await keyless.close()
    }
  })

  describe("model tiers", () => {
    let tiered: INestApplication

    beforeAll(async () => {
      tiered = await createTestApp({
        databaseUrl: database.url,
        clock,
        config: { anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, "claude-haiku-5-5", "claude-sonnet-5-5") },
      })
    })

    beforeEach(async () => {
      await database.db.deleteFrom("spend_entry").execute()
    })

    afterAll(async () => {
      await tiered?.close()
    })

    const tieredRequest = (overrides: Partial<Parameters<ModelGateway["generateObject"]>[0]> = {}) =>
      asOperator(tiered, tiered.get(ModelGateway)).generateObject({
        purpose: "probe",
        system: "Extract facts.",
        prompt: "Ada Okafor. Led a team of 4 frontend engineers.",
        schema: probeSchema,
        maxOutputTokens: 1_000,
        timeoutMs: 5_000,
        ...overrides,
      })

    it("sends a documents-tier call to the documents model and reserves at its prices", async () => {
      await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
      anthropic.replyWithObject({ facts: ["x"] }, { input: 100, output: 10 })
      const result = await tieredRequest({ tier: "documents" })
      expect(result.ok).toBe(true)
      expect(anthropic.requests[0]?.body.model).toBe("claude-sonnet-5-5")
      const [call] = await database.db.selectFrom("ai_call").selectAll().execute()
      expect(call?.model).toBe("claude-sonnet-5-5")
      const [entry] = await database.db.selectFrom("spend_entry").selectAll().where("purpose", "=", "probe").execute()
      const chars = "Extract facts.".length + "Ada Okafor. Led a team of 4 frontend engineers.".length
      expect(Number(entry?.reserved_micros)).toBe(aiEstimateMicros(DEFAULT_DOCUMENTS_AI_PRICES, chars, 1_000))
    })

    it("keeps default-tier calls on the scoring model at its prices", async () => {
      await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
      anthropic.replyWithObject({ facts: ["x"] }, { input: 100, output: 10 })
      await tieredRequest()
      expect(anthropic.requests[0]?.body.model).toBe("claude-haiku-5-5")
      const [entry] = await database.db.selectFrom("spend_entry").selectAll().where("purpose", "=", "probe").execute()
      const chars = "Extract facts.".length + "Ada Okafor. Led a team of 4 frontend engineers.".length
      expect(Number(entry?.reserved_micros)).toBe(aiEstimateMicros(DEFAULT_SPEND_CONFIG.ai, chars, 1_000))
    })

    it("settles a documents-tier call at the documents model's prices", async () => {
      await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
      anthropic.replyWithObject({ facts: ["x"] }, { input: 1_000, output: 500 })
      await tieredRequest({ tier: "documents" })
      const [entry] = await database.db.selectFrom("spend_entry").selectAll().where("purpose", "=", "probe").execute()
      // 1,000 x $2 + 500 x $10 per million tokens = $0.007.
      expect(Number(entry?.actual_micros)).toBe(7_000)
    })

    it("prices one model used for everything at its own list price, not the scoring price", async () => {
      const single = await createTestApp({
        databaseUrl: database.url,
        clock,
        config: { anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, "claude-sonnet-5-5", "claude-sonnet-5-5") },
      })
      try {
        await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
        anthropic.replyWithObject({ facts: ["x"] })
        await asOperator(single, single.get(ModelGateway)).generateObject({ purpose: "probe", system: "s", prompt: "p", schema: probeSchema, maxOutputTokens: 1_000, timeoutMs: 5_000 })
        expect(anthropic.requests[0]?.body.model).toBe("claude-sonnet-5-5")
        const [entry] = await database.db.selectFrom("spend_entry").selectAll().where("purpose", "=", "probe").execute()
        expect(Number(entry?.reserved_micros)).toBe(aiEstimateMicros(DEFAULT_DOCUMENTS_AI_PRICES, 2, 1_000))
      } finally {
        await single.close()
      }
    })

    it("sends the requested effort, and none when unset", async () => {
      await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
      anthropic.replyWithObject({ facts: ["x"] })
      anthropic.replyWithObject({ facts: ["x"] })
      await tieredRequest({ effort: "low" })
      await tieredRequest()
      expect((anthropic.requests[0]?.body.output_config as { effort?: string } | undefined)?.effort).toBe("low")
      expect((anthropic.requests[1]?.body.output_config as { effort?: string } | undefined)?.effort).toBeUndefined()
    })
  })

  it("never returns the API key from any endpoint", async () => {
    const response = await candidate.get("/v1/ai-provider").expect(200)
    expect(JSON.stringify(response.body)).not.toContain(TEST_ANTHROPIC_KEY)
    expect(JSON.stringify(response.headers)).not.toContain(TEST_ANTHROPIC_KEY)
  })
})

it("the signed-in Candidate is the installation's Google account", () => {
  expect(candidate.email).toBe(CANDIDATE_EMAIL)
})
