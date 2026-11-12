import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { AiCallRepository, NO_USAGE } from "../src/ai/ai-call.repository.js"
import { ModelGateway } from "../src/ai/model-gateway.js"
import { CandidateScope, MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 A1 unit 2 (AI group): each `ai_call` row belongs to the Candidate
 * whose scope made the call. One Candidate's scope can't finish (rewrite the
 * usage of) another Candidate's call, and a gateway call outside any scope is
 * refused before a provider request or a metering row.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let otherId: string
let operatorId: string
const clock = new TestClock("2026-10-16T09:00:00.000Z")
const OTHER_CALL = "00000000-0000-4000-8000-0000000000a1"
const probe = z.object({ facts: z.array(z.string()) })

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  otherId = await insertSecondCandidate(database.db)
  operatorId = (await database.db.selectFrom("candidate").select("id").where("role", "=", "operator").executeTakeFirstOrThrow()).id
})

beforeEach(async () => {
  anthropic.install()
  anthropic.reset()
  outbound.reset()
  await database.db.deleteFrom("ai_call").execute()
  await database.db.deleteFrom("ai_provider_approval").execute()
  await database.db.insertInto("ai_provider_approval").values({ provider: "anthropic", approved_at: clock.now(), terms_checked_on: "2026-10-16", training_line: "t", retention_line: "r", whats_sent_line: "w" }).execute()
  await database.db.insertInto("ai_call").values({ candidate_id: otherId, id: OTHER_CALL, purpose: "probe", provider: "anthropic", model: "m", status: "started", resume_upload_id: null, started_at: clock.now() }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const request = { purpose: "probe", system: "Extract facts.", prompt: "Ada Okafor.", schema: probe, maxOutputTokens: 100, timeoutMs: 5_000 }

describe("AI group meters each call to its own Candidate", () => {
  it("a call in the Operator's scope writes an ai_call row owned by the Operator", async () => {
    anthropic.replyWithObject({ facts: ["x"] }, { input: 10, output: 5 })
    const result = await CandidateScope.run(operatorId, () => app.get(ModelGateway).generateObject(request))
    expect(result.ok).toBe(true)
    const rows = await database.db.selectFrom("ai_call").select(["candidate_id", "status"]).where("id", "!=", OTHER_CALL).execute()
    expect(rows).toEqual([{ candidate_id: operatorId, status: "succeeded" }])
  })

  it("the Operator's scope cannot finish the other Candidate's call", async () => {
    await CandidateScope.run(operatorId, () => app.get(AiCallRepository).finish(OTHER_CALL, "succeeded", { ...NO_USAGE, inputTokens: 999_999 }, clock.now()))
    const row = await database.db.selectFrom("ai_call").select(["status", "input_tokens"]).where("id", "=", OTHER_CALL).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: "started", input_tokens: null })
  })

  it("a gateway call outside any scope is refused with no provider request and no metering row", async () => {
    await expect(app.get(ModelGateway).generateObject(request)).rejects.toBeInstanceOf(MissingCandidateScopeError)
    expect(outbound.urls).toEqual([])
    expect(anthropic.requests).toEqual([])
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([{ id: OTHER_CALL }])
  })
})
