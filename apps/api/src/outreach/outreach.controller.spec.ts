import "reflect-metadata"

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiExceptionFilter } from "../http/api-exception.filter.js"
import { OutreachController } from "./outreach.controller.js"
import { OutreachService } from "./outreach.service.js"

/**
 * Pins the order `PUT …/outreach/:kind/reader-name` checks its input in: the Application id, then the kind slug, then the body.
 * A bad path answers `404 not_found` even when the body is also bad; a bad body on a good path is a plain 400.
 */

const ID = "6f1c1a52-3b0a-4f43-9a63-0d0f3a2f5c11"
const ITEM = { kind: "introduction" }
const service = { setReaderName: vi.fn() }

let app: NestFastifyApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({ controllers: [OutreachController], providers: [{ provide: OutreachService, useValue: service }] }).compile()
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
})

const notFound = { error: { code: "not_found", message: "Not found." } }
const badRequest = { error: { code: "bad_request", message: "The request is not valid." } }
const put = (id: string, kind: string, payload: unknown) =>
  app.inject({ method: "PUT", url: `/v1/applications/${id}/outreach/${kind}/reader-name`, payload: JSON.stringify(payload), headers: { "content-type": "application/json" } })

describe("PUT /v1/applications/:id/outreach/:kind/reader-name", () => {
  it.each([
    ["referral-request", "referral_request"],
    ["introduction", "introduction"],
    ["application-note", "application_note"],
  ])("saves the Reader name for the %s slug as kind %s", async (slug, kind) => {
    service.setReaderName.mockResolvedValue(ITEM)
    const response = await put(ID, slug, { readerName: "Ada" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(ITEM)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(service.setReaderName).toHaveBeenCalledWith(ID, kind, "Ada")
  })

  it("clears the Reader name with null", async () => {
    service.setReaderName.mockResolvedValue(ITEM)
    expect((await put(ID, "introduction", { readerName: null })).statusCode).toBe(200)
    expect(service.setReaderName).toHaveBeenCalledWith(ID, "introduction", null)
  })

  it.each([
    ["an array", []],
    ["a string", "x"],
    ["null", null],
    ["an empty object", {}],
    ["an unknown key", { readerName: "Ada", extra: 1 }],
    ["a name that is not a string", { readerName: 5 }],
    ["a name over the raw maximum", { readerName: "x".repeat(10_000) }],
  ])("answers a good path and %s with a plain 400", async (_name, payload) => {
    const response = await put(ID, "introduction", payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual(badRequest)
    expect(service.setReaderName).not.toHaveBeenCalled()
  })

  it.each(["not-a-uuid", "123", "6F1C1A52"])("answers the malformed id %s with 404 before the body is read", async (id) => {
    for (const payload of [{ readerName: "Ada" }, {}, []]) {
      const response = await put(id, "introduction", payload)
      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual(notFound)
    }
    expect(service.setReaderName).not.toHaveBeenCalled()
  })

  it.each(["referral_request", "Introduction", "unknown", "application", "0"])("answers the kind %s with 404 before the body is read", async (kind) => {
    for (const payload of [{ readerName: "Ada" }, {}, [], { readerName: 5 }]) {
      const response = await put(ID, kind, payload)
      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual(notFound)
    }
    expect(service.setReaderName).not.toHaveBeenCalled()
  })

  it("answers a malformed id and an unknown kind and a bad body with 404", async () => {
    const response = await put("nope", "unknown", [])
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual(notFound)
  })
})
