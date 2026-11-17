import "reflect-metadata"

import { Controller, Delete, Put } from "@nestjs/common"
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { ApiExceptionFilter } from "./api-exception.filter.js"
import { ApiException } from "./api-exception.js"
import { UuidParam, UuidPipe, parseUuid } from "./uuid-param.js"
import { ZodBody } from "./zod-request.js"

const ID = "6f1c1a52-3b0a-4f43-9a63-0d0f3a2f5c11"
const bodySchema = z.object({ ok: z.boolean() }).strict()

@Controller("probe")
class ProbeController {
  @Delete("missing/:id")
  notFound(@UuidParam("id", "not_found") id: string): { id: string } {
    return { id }
  }

  @Delete("invalid/:id")
  badRequest(@UuidParam("id", "bad_request") id: string): { id: string } {
    return { id }
  }

  @Put("both/:id")
  both(@UuidParam("id", "not_found") id: string, @ZodBody(bodySchema) body: z.output<typeof bodySchema>): { id: string; ok: boolean } {
    return { id, ok: body.ok }
  }
}

describe("parseUuid", () => {
  it("returns a UUID unchanged", () => {
    expect(parseUuid(ID, "not_found")).toBe(ID)
  })

  it.each(["not_found", "bad_request"] as const)("throws %s for a malformed id", (policy) => {
    for (const value of ["", "123", "not-a-uuid", undefined, 5]) {
      expect(() => parseUuid(value, policy)).toThrow(ApiException)
      try {
        parseUuid(value, policy)
      } catch (error) {
        expect((error as ApiException).code).toBe(policy)
      }
    }
  })

  it("exposes the policy on the pipe", () => {
    expect(new UuidPipe("bad_request").transform(ID)).toBe(ID)
    expect(() => new UuidPipe("not_found").transform("x")).toThrow(ApiException)
  })
})

describe("UuidParam on a route", () => {
  let app: NestFastifyApplication

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useGlobalFilters(new ApiExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  const call = (method: "DELETE" | "PUT", url: string, payload?: unknown) => app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) })

  it("passes a UUID through", async () => {
    const response = await call("DELETE", `/probe/missing/${ID}`)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: ID })
  })

  it("answers 404 not_found for a malformed id under the not_found policy", async () => {
    const response = await call("DELETE", "/probe/missing/not-a-uuid")
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: { code: "not_found", message: "Not found." } })
  })

  it("answers 400 bad_request for a malformed id under the bad_request policy", async () => {
    const response = await call("DELETE", "/probe/invalid/not-a-uuid")
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
  })

  it("answers a malformed id before a malformed body", async () => {
    const response = await call("PUT", "/probe/both/not-a-uuid", { nope: 1 })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe("not_found")
  })

  it("answers a malformed body once the id is valid", async () => {
    const response = await call("PUT", `/probe/both/${ID}`, { nope: 1 })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("bad_request")
  })

  it("accepts a valid id and body", async () => {
    const response = await call("PUT", `/probe/both/${ID}`, { ok: true })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: ID, ok: true })
  })
})
