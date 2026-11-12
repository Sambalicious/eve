import { type INestApplication, RequestMethod } from "@nestjs/common"
import { DiscoveryService, MetadataScanner, ModulesContainer, Reflector } from "@nestjs/core"
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { IS_PUBLIC, IS_PUBLIC_WRITE } from "../src/auth/public.decorator.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * architecture.r1 7.2: the CSRF exemption is a closed class of one route. Lists
 * every controller handler in the real api app through Nest's DiscoveryService.
 * A new `@Public()` write or a second `@PublicWrite()` fails here and needs a
 * Security review.
 */
let database: TestDatabase
let app: INestApplication

type Handler = { controller: string; method: string; verb: string; path: string; isPublic: boolean; isPublicWrite: boolean }

beforeAll(async () => {
  database = await startMigratedDatabase()
  app = await createTestApp({ databaseUrl: database.url, clock: new TestClock(new Date()) })
})

afterAll(async () => {
  await app?.close()
  await database?.stop()
})

function handlers(): Handler[] {
  const discovery = new DiscoveryService(app.get(ModulesContainer))
  const reflector = app.get(Reflector)
  const scanner = new MetadataScanner()
  return discovery.getControllers().flatMap((wrapper) => {
    const instance = wrapper.instance as object | undefined
    if (!instance) return []
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>
    const base = String(Reflect.getMetadata(PATH_METADATA, wrapper.metatype as object) ?? "")
    return scanner.getAllMethodNames(prototype).flatMap((name) => {
      const fn = prototype[name] as object
      const verb = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined
      if (verb === undefined) return []
      const route = String(Reflect.getMetadata(PATH_METADATA, fn) ?? "")
      const flag = (key: string) => reflector.getAllAndOverride<boolean>(key, [fn as never, wrapper.metatype as never]) === true
      return [{ controller: wrapper.name, method: name, verb: RequestMethod[verb], path: normalizePath(base, route), isPublic: flag(IS_PUBLIC), isPublicWrite: flag(IS_PUBLIC_WRITE) }]
    })
  })
}

describe("public routes are a closed set", () => {
  it("finds the app's handlers", () => {
    expect(handlers().length).toBeGreaterThan(40)
  })

  it("every @Public() handler is a GET", () => {
    const publics = handlers().filter((h) => h.isPublic)
    expect(publics.map((h) => `${h.verb} ${h.path}`).sort()).toEqual([
      "GET /v1/auth/google/callback",
      "GET /v1/auth/google/start",
      "GET /v1/health",
      "GET /v1/public/access-requests/proof",
    ])
    expect(publics.every((h) => h.verb === "GET")).toBe(true)
  })

  it("exactly one handler carries @PublicWrite(): AccessRequestController.create, POST /v1/public/access-requests", () => {
    expect(handlers().filter((h) => h.isPublicWrite)).toEqual([
      { controller: "AccessRequestController", method: "create", verb: "POST", path: "/v1/public/access-requests", isPublic: false, isPublicWrite: true },
    ])
  })
})

function normalizePath(base: string, route: string): string {
  const joined = `/${[base, route].filter(Boolean).join("/")}`.replace(/\/+/g, "/")
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined
}
