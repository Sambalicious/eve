import "reflect-metadata"

import { DEFAULT_ROLE_FAMILY_TIERS, PREFERENCES_VERSIONS_DEFAULT_LIMIT } from "@eve/contracts"
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiExceptionFilter } from "../http/api-exception.filter.js"
import { PreferencesSaveLimitGuard } from "./preferences-save-limit.guard.js"
import { PreferencesController } from "./preferences.controller.js"
import { PreferencesService } from "./preferences.service.js"

/** Pins what the three Job Preferences routes answer for a refused query or body: status, code, message and field errors. */

const service = { read: vi.fn(), save: vi.fn(), versions: vi.fn() }

let app: NestFastifyApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({ controllers: [PreferencesController], providers: [{ provide: PreferencesService, useValue: service }] })
    .overrideGuard(PreferencesSaveLimitGuard)
    .useValue({ canActivate: () => true })
    .compile()
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

const plain = { error: { code: "bad_request", message: "The request is not valid." } }
const withFields = (...fieldErrors: Array<{ field: string; problem: string; position?: number }>) => ({
  error: { code: "bad_request", message: "The request is not valid.", fieldErrors: fieldErrors.map(({ field, problem, position }) => ({ field, position: position ?? null, problem })) },
})

const values = (over: Record<string, unknown> = {}) => ({
  homeCountry: "KE",
  timeZone: "Africa/Nairobi",
  latestWorkHour: "23:00",
  workAuthorizedCountries: ["KE"],
  remoteAccepted: true,
  relocationAccepted: true,
  sponsorshipNeededForRelocation: true,
  excludedRelocationCountries: [],
  excludedIndustries: [],
  payFloor: { amount: "4000.00", currency: "EUR", period: "month", basis: "gross" },
  preferredPay: { amount: "5500.00", currency: "EUR", period: "month", basis: "net" },
  roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS },
  titleKeyword: null,
  seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
  employmentTypes: ["direct", "employer_of_record", "contract"],
  dailyCap: 3,
  emphasisThemes: [],
  ...over,
})

describe("GET /v1/me/preferences", () => {
  it("reads with cache-control no-store when there is no query", async () => {
    service.read.mockResolvedValue({ version: null })
    const response = await app.inject({ method: "GET", url: "/v1/me/preferences" })
    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it.each(["?candidateId=1", "?x", "?x=", "?a=1&b=2", "?page=1"])("refuses the query %s with a plain 400", async (query) => {
    const response = await app.inject({ method: "GET", url: `/v1/me/preferences${query}` })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual(plain)
    expect(service.read).not.toHaveBeenCalled()
  })
})

describe("GET /v1/me/preferences/versions", () => {
  it.each([
    ["", PREFERENCES_VERSIONS_DEFAULT_LIMIT, null],
    ["?limit=5", 5, null],
    ["?before=7", PREFERENCES_VERSIONS_DEFAULT_LIMIT, 7],
    ["?limit=100&before=2147483647", 100, 2_147_483_647],
  ])("reads %j", async (query, limit, before) => {
    service.versions.mockResolvedValue({ versions: [], nextBefore: null })
    const response = await app.inject({ method: "GET", url: `/v1/me/preferences/versions${query}` })
    expect(response.statusCode).toBe(200)
    expect(service.versions).toHaveBeenCalledWith(limit, before)
  })

  it.each(["?limit=0", "?limit=101", "?limit=abc", "?limit=", "?limit=01", "?limit=1&limit=2", "?before=0", "?before=99999999999", "?before=", "?candidateId=1", "?limit=5&x=1"])(
    "refuses %s with a plain 400",
    async (query) => {
      const response = await app.inject({ method: "GET", url: `/v1/me/preferences/versions${query}` })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(plain)
      expect(service.versions).not.toHaveBeenCalled()
    }
  )
})

describe("PUT /v1/me/preferences", () => {
  const put = (payload: unknown) => app.inject({ method: "PUT", url: "/v1/me/preferences", payload: JSON.stringify(payload), headers: { "content-type": "application/json" } })

  it("saves a valid body with the base version and the normalised values", async () => {
    service.save.mockResolvedValue({ version: 2 })
    const response = await put({ baseVersion: null, values: values() })
    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(service.save).toHaveBeenCalledTimes(1)
    expect(service.save.mock.calls[0]?.[0]).toBeNull()
    expect(service.save.mock.calls[0]?.[1]).toMatchObject({ homeCountry: "KE", timeZone: "Africa/Nairobi", dailyCap: 3 })
    await put({ baseVersion: 4, values: values() })
    expect(service.save.mock.calls[1]?.[0]).toBe(4)
  })

  it.each([
    ["an array", []],
    ["a string", "x"],
    ["null", null],
    ["an empty object", {}],
    ["no values", { baseVersion: null }],
    ["no base version", { values: values() }],
    ["an unknown top-level key", { baseVersion: null, values: values(), candidateId: "x" }],
    ["an unknown values key", { baseVersion: null, values: values({ extra: 1 }) }],
    ["a zero base version", { baseVersion: 0, values: values() }],
    ["a fractional base version", { baseVersion: 1.5, values: values() }],
    ["a string base version", { baseVersion: "1", values: values() }],
    ["a base version past the integer bound", { baseVersion: 2_147_483_648, values: values() }],
    ["values that are not an object", { baseVersion: null, values: [] }],
    ["a list longer than 64", { baseVersion: null, values: values({ workAuthorizedCountries: Array.from({ length: 65 }, () => "KE") }) }],
    ["an emphasis list longer than 64", { baseVersion: null, values: values({ emphasisThemes: Array.from({ length: 65 }, () => "x") }) }],
  ])("answers %s with a plain 400", async (_name, payload) => {
    const response = await put(payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual(plain)
    expect(service.save).not.toHaveBeenCalled()
  })

  it.each([
    ["an unsupported home country", values({ homeCountry: "ZZ", workAuthorizedCountries: ["KE"] }), [{ field: "homeCountry", problem: "unsupported_country" }]],
    ["a home country that is not a string", values({ homeCountry: 5 }), [{ field: "homeCountry", problem: "invalid" }]],
    ["a time zone that is not IANA", values({ timeZone: "Nowhere/City" }), [{ field: "timeZone", problem: "invalid" }]],
    ["a bad latest work hour", values({ latestWorkHour: "25:00" }), [{ field: "latestWorkHour", problem: "invalid" }]],
    ["a work-authorized list without the home country", values({ workAuthorizedCountries: ["NG"] }), [{ field: "workAuthorizedCountries", problem: "home_country_missing" }]],
    ["an unsupported entry in a country list", values({ workAuthorizedCountries: ["KE", "ZZ"] }), [{ field: "workAuthorizedCountries", problem: "unsupported_country", position: 2 }]],
    ["no work arrangement selected", values({ remoteAccepted: false, relocationAccepted: false }), [{ field: "workArrangement", problem: "none_selected" }]],
    [
      "several bad fields at once",
      values({ homeCountry: "ZZ", timeZone: "Nowhere/City", remoteAccepted: "yes" }),
      [
        { field: "homeCountry", problem: "unsupported_country" },
        { field: "timeZone", problem: "invalid" },
        { field: "workArrangement", problem: "invalid" },
      ],
    ],
  ])("answers %s with its field errors", async (_name, body, fields) => {
    const response = await put({ baseVersion: null, values: body })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual(withFields(...fields))
    expect(service.save).not.toHaveBeenCalled()
  })
})
