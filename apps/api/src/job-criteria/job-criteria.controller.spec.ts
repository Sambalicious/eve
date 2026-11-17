import "reflect-metadata"

import { DEFAULT_SENIORITY_FLOOR, DEFAULT_TARGET_ROLE_FAMILIES } from "@eve/contracts"
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiExceptionFilter } from "../http/api-exception.filter.js"
import { JobCriteriaSaveLimitGuard } from "./job-criteria-save-limit.guard.js"
import { JobCriteriaController } from "./job-criteria.controller.js"
import { JobCriteriaService } from "./job-criteria.service.js"

/** Pins what `PUT /v1/candidate-settings/job-criteria` answers for a refused body: status, code, message and field errors. */

const service = { read: vi.fn(), save: vi.fn() }

let app: NestFastifyApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({ controllers: [JobCriteriaController], providers: [{ provide: JobCriteriaService, useValue: service }] })
    .overrideGuard(JobCriteriaSaveLimitGuard)
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

const ROLE_RELEVANCE_DEFAULTS = { targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: DEFAULT_SENIORITY_FLOOR }

const body = (over: Record<string, unknown> = {}) => ({
  minCoreMatchPercent: 70,
  frameworks: ["React"],
  technologies: ["TypeScript"],
  targetRoleFamilies: [...ROLE_RELEVANCE_DEFAULTS.targetRoleFamilies],
  seniorityFloor: ROLE_RELEVANCE_DEFAULTS.seniorityFloor,
  ...over,
})

const put = (payload: unknown) => app.inject({ method: "PUT", url: "/v1/candidate-settings/job-criteria", payload: JSON.stringify(payload), headers: { "content-type": "application/json" } })

describe("PUT /v1/candidate-settings/job-criteria", () => {
  it("saves a valid body", async () => {
    service.save.mockResolvedValue({ version: 2 })
    const response = await put(body())
    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(service.save).toHaveBeenCalledWith(expect.objectContaining({ minCoreMatchPercent: 70, frameworks: ["React"], technologies: ["TypeScript"] }))
  })

  it.each([
    ["an array", []],
    ["a string", "x"],
    ["null", null],
    ["an unknown key", body({ candidateId: "x" })],
  ])("answers %s with a plain 400", async (_name, payload) => {
    const response = await put(payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual(plain)
    expect(service.save).not.toHaveBeenCalled()
  })

  it.each([
    [
      "every field missing",
      {},
      [
        { field: "minCoreMatchPercent", problem: "invalid" },
        { field: "frameworks", problem: "invalid" },
        { field: "technologies", problem: "invalid" },
        { field: "targetRoleFamilies", problem: "invalid" },
        { field: "seniorityFloor", problem: "invalid" },
      ],
    ],
    [
      "one field present and the rest missing",
      { minCoreMatchPercent: 70 },
      [
        { field: "frameworks", problem: "invalid" },
        { field: "technologies", problem: "invalid" },
        { field: "targetRoleFamilies", problem: "invalid" },
        { field: "seniorityFloor", problem: "invalid" },
      ],
    ],
    ["a threshold of 0", body({ minCoreMatchPercent: 0 }), [{ field: "minCoreMatchPercent", problem: "invalid" }]],
    ["a threshold above 100", body({ minCoreMatchPercent: 101 }), [{ field: "minCoreMatchPercent", problem: "invalid" }]],
    ["a fractional threshold", body({ minCoreMatchPercent: 70.5 }), [{ field: "minCoreMatchPercent", problem: "invalid" }]],
    ["a string threshold", body({ minCoreMatchPercent: "70" }), [{ field: "minCoreMatchPercent", problem: "invalid" }]],
    ["a list that is not an array", body({ frameworks: "React" }), [{ field: "frameworks", problem: "invalid" }]],
    ["an empty entry", body({ frameworks: ["React", ""] }), [{ field: "frameworks", problem: "entry_empty", position: 2 }]],
    ["a non-string entry", body({ technologies: [5] }), [{ field: "technologies", problem: "invalid", position: 1 }]],
    ["an entry that is too long", body({ technologies: ["x".repeat(200)] }), [{ field: "technologies", problem: "entry_too_long", position: 1 }]],
    ["an entry with a control character", body({ frameworks: ["a\u0000b"] }), [{ field: "frameworks", problem: "entry_disallowed_characters", position: 1 }]],
    ["a technology repeated across lists", body({ frameworks: ["React"], technologies: ["react"] }), [{ field: "technologies", problem: "duplicate_entry", position: 1 }]],
    ["no target role family", body({ targetRoleFamilies: [] }), [{ field: "targetRoleFamilies", problem: "too_few_entries" }]],
    ["an unknown target role family", body({ targetRoleFamilies: ["nonsense"] }), [{ field: "targetRoleFamilies", problem: "unknown_entry", position: 1 }]],
    ["a repeated target role family", body({ targetRoleFamilies: [ROLE_RELEVANCE_DEFAULTS.targetRoleFamilies[0], ROLE_RELEVANCE_DEFAULTS.targetRoleFamilies[0]] }), [{ field: "targetRoleFamilies", problem: "duplicate_entry", position: 2 }]],
    ["a seniority floor that is not offered", body({ seniorityFloor: "ceo" }), [{ field: "seniorityFloor", problem: "invalid" }]],
    [
      "several bad fields at once",
      body({ minCoreMatchPercent: 0, frameworks: [""], seniorityFloor: 3 }),
      [
        { field: "minCoreMatchPercent", problem: "invalid" },
        { field: "frameworks", problem: "entry_empty", position: 1 },
        { field: "seniorityFloor", problem: "invalid" },
      ],
    ],
  ])("answers %s with its field errors", async (_name, payload, fields) => {
    const response = await put(payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual(withFields(...fields))
    expect(service.save).not.toHaveBeenCalled()
  })
})
