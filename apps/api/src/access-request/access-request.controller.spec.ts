import "reflect-metadata"

import { ACCESS_REQUEST_PATH } from "@eve/contracts"
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { APP_CONFIG } from "../config/config.module.js"
import type { AppConfig } from "../config/env.js"
import { ApiExceptionFilter } from "../http/api-exception.filter.js"
import { CLOCK } from "../shared/clock.js"
import { accessRequestKeys } from "./access-request-keys.js"
import { AccessRequestController } from "./access-request.controller.js"
import { AccessRequestRepository } from "./access-request.repository.js"
import { AccessRequestService } from "./access-request.service.js"
import { issueProof } from "./fill-proof.js"

/**
 * Pins what `POST /v1/public/access-requests` answers for a refused body: status, code, message and the field codes.
 * The real service runs over a stub repository, so the pin holds wherever the validation lives.
 */

const NOW = new Date("2026-10-21T10:00:00.000Z")
const keys = accessRequestKeys("unit-test-access-request-secret-000000")
const config = { accessRequest: { trustProxy: 1, limits: { perIpHour: 3, perIpDay: 10, globalDay: 50 }, keys } } as unknown as AppConfig
const repository = { submit: vi.fn() }

let app: NestFastifyApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [AccessRequestController],
    providers: [
      AccessRequestService,
      { provide: APP_CONFIG, useValue: config },
      { provide: CLOCK, useValue: { now: () => NOW } },
      { provide: AccessRequestRepository, useValue: repository },
    ],
  }).compile()
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.useGlobalFilters(new ApiExceptionFilter())
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  vi.resetAllMocks()
  repository.submit.mockResolvedValue({ kind: "accepted", windowId: "w", newWindow: true })
})

const proof = () => issueProof(NOW.getTime() - 5_000, keys.proofKey())
const invalid = (...fields: string[]) => ({ error: { code: "access_request_invalid", message: "Check the highlighted fields.", fields } })
const post = (payload: string) => app.inject({ method: "POST", url: ACCESS_REQUEST_PATH, payload, headers: { "content-type": "application/json" } })

describe("POST /v1/public/access-requests", () => {
  it("accepts a valid body with the same 202 as every accepted request", async () => {
    const response = await post(JSON.stringify({ email: "  Ada@Example.com ", note: "Hello\r\nthere", proof: proof(), kiwi: "" }))
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ status: "received" })
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(repository.submit).toHaveBeenCalledWith(expect.objectContaining({ email: "Ada@Example.com", emailKey: "ada@example.com", note: "Hello\nthere", drop: null }))
  })

  it("drops a honeypot or a bad proof silently with the same 202", async () => {
    repository.submit.mockResolvedValue({ kind: "dropped" })
    expect((await post(JSON.stringify({ email: "ada@example.com", kiwi: "x", proof: proof() }))).statusCode).toBe(202)
    expect((await post(JSON.stringify({ email: "ada@example.com" }))).statusCode).toBe(202)
    expect(repository.submit.mock.calls.map(([input]) => (input as { drop: string | null }).drop)).toEqual(["honeypot", "fill_time"])
  })

  it.each([
    ["an array", "[]", ["body.invalid_json"]],
    ["a string", '"x"', ["body.invalid_json"]],
    ["null", "null", ["body.invalid_json"]],
    ["malformed JSON", "{", ["body.invalid_json"]],
    ["an unknown field", JSON.stringify({ email: "ada@example.com", extra: 1 }), ["body.unknown_field"]],
    ["an unknown field alongside a bad email", JSON.stringify({ email: "nope", extra: 1 }), ["body.unknown_field"]],
    ["no email", JSON.stringify({}), ["email.required"]],
    ["a blank email", JSON.stringify({ email: "  " }), ["email.required"]],
    ["an email that is not a string", JSON.stringify({ email: 5 }), ["email.format"]],
    ["an email that is not an address", JSON.stringify({ email: "nope" }), ["email.format"]],
    ["an email over 254 characters", JSON.stringify({ email: `${"a".repeat(250)}@example.com` }), ["email.too_long"]],
    ["a note that is not a string", JSON.stringify({ email: "ada@example.com", note: 5 }), ["note.format"]],
    ["a note over 500 characters", JSON.stringify({ email: "ada@example.com", note: "x".repeat(501) }), ["note.too_long"]],
    ["a bad email and a bad note", JSON.stringify({ email: "nope", note: "x".repeat(501) }), ["email.format", "note.too_long"]],
  ])("answers %s with its field codes and stores nothing", async (_name, payload, fields) => {
    const response = await post(payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual(invalid(...fields))
    expect(repository.submit).not.toHaveBeenCalled()
  })
})
