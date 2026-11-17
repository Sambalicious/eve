import "reflect-metadata"

import { Controller, Get, Post, Res } from "@nestjs/common"
import type { NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import type { FastifyReply } from "fastify"
import { afterEach, describe, expect, it } from "vitest"

import { accessRequestKeys } from "../access-request/access-request-keys.js"
import { generateRequestId } from "./access-log.js"
import { configureHttpApp, createFastifyAdapter } from "./create-http-app.js"

const COOKIE_SECRET = "eve_session=SESSION-COOKIE-SENTINEL-7f3a"
const BEARER_SECRET = "Bearer AUTHORIZATION-SENTINEL-91bc"
const CSRF_SECRET = "CSRF-TOKEN-SENTINEL-55de"
const BODY_SECRET = "REQUEST-BODY-SENTINEL-c0ffee"
const QUERY_SECRET = "OAUTH-CODE-SENTINEL-4d4d"
const SET_COOKIE_SECRET = "SET-COOKIE-SENTINEL-be11"

@Controller("probe")
class ProbeController {
  @Get()
  read(@Res({ passthrough: true }) reply: FastifyReply): { ok: true } {
    void reply.header("set-cookie", `eve_session=${SET_COOKIE_SECRET}; HttpOnly`)
    return { ok: true }
  }

  @Post()
  write(): { ok: true } {
    return { ok: true }
  }
}

const accessRequest = { trustProxy: 0, limits: { perIpHour: 3, perIpDay: 10, globalDay: 50 }, keys: accessRequestKeys("k".repeat(32)) }

async function boot(accessLog: boolean): Promise<{ app: NestFastifyApplication; lines: () => string[] }> {
  const written: string[] = []
  const config = { accessLog, accessRequest, publicOrigin: "https://dashboard.test" }
  const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
  const app = module.createNestApplication<NestFastifyApplication>(createFastifyAdapter(config, { write: (line) => void written.push(line) }))
  await configureHttpApp(app, config)
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return { app, lines: () => written }
}

describe("access log", () => {
  let app: NestFastifyApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  const credentials = {
    cookie: COOKIE_SECRET,
    authorization: BEARER_SECRET,
    "x-csrf-token": CSRF_SECRET,
  }

  it("never writes cookies, authorization, csrf tokens, query strings or bodies", async () => {
    const booted = await boot(true)
    app = booted.app
    await app.inject({ method: "GET", url: `/probe?code=${QUERY_SECRET}`, headers: credentials })
    await app.inject({ method: "POST", url: "/probe", headers: { ...credentials, "content-type": "application/json" }, payload: JSON.stringify({ secret: BODY_SECRET }) })
    await app.inject({ method: "GET", url: "/probe/unknown", headers: credentials })

    const output = booted.lines().join("")
    expect(output.length).toBeGreaterThan(0)
    for (const secret of [COOKIE_SECRET, BEARER_SECRET, CSRF_SECRET, BODY_SECRET, QUERY_SECRET, SET_COOKIE_SECRET, "SESSION-COOKIE-SENTINEL", "AUTHORIZATION-SENTINEL", "CSRF-TOKEN-SENTINEL", "OAUTH-CODE-SENTINEL"]) {
      expect(output).not.toContain(secret)
    }
    expect(output.toLowerCase()).not.toContain("cookie")
    expect(output.toLowerCase()).not.toContain("authorization")
  })

  it("logs the method, path, status and request id for each request", async () => {
    const booted = await boot(true)
    app = booted.app
    const response = await app.inject({ method: "GET", url: `/probe?code=${QUERY_SECRET}`, headers: { "x-request-id": "trace-abc.123" } })

    const entries = booted.lines().map((line) => JSON.parse(line) as { reqId?: string; req?: { method: string; url: string }; res?: { statusCode: number } })
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries.every((entry) => entry.reqId === "trace-abc.123")).toBe(true)
    expect(entries.find((entry) => entry.req)?.req).toEqual({ method: "GET", url: "/probe" })
    expect(entries.find((entry) => entry.res)?.res).toEqual({ statusCode: 200 })
    expect(response.headers["x-request-id"]).toBe("trace-abc.123")
  })

  it("replaces a client request id that is not short and plain", async () => {
    const booted = await boot(true)
    app = booted.app
    const response = await app.inject({ method: "GET", url: "/probe", headers: { "x-request-id": 'x"},"injected":"line' } })
    const sent = response.headers["x-request-id"]
    expect(sent).toMatch(/^[0-9a-f-]{36}$/)
    expect(booted.lines().join("")).not.toContain("injected")
  })

  it("writes nothing and adds no header when the access log is off", async () => {
    const booted = await boot(false)
    app = booted.app
    const response = await app.inject({ method: "GET", url: "/probe", headers: credentials })
    expect(booted.lines()).toEqual([])
    expect(response.headers["x-request-id"]).toBeUndefined()
  })
})

describe("generateRequestId", () => {
  it("keeps a plain id and makes a new one otherwise", () => {
    expect(generateRequestId({ headers: { "x-request-id": "abc_DEF-1.2" } })).toBe("abc_DEF-1.2")
    expect(generateRequestId({ headers: { "x-request-id": "a".repeat(65) } })).toMatch(/^[0-9a-f-]{36}$/)
    expect(generateRequestId({ headers: { "x-request-id": ["a", "b"] } })).toMatch(/^[0-9a-f-]{36}$/)
    expect(generateRequestId({ headers: {} })).toMatch(/^[0-9a-f-]{36}$/)
  })
})
