import "reflect-metadata"

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiExceptionFilter } from "../http/api-exception.filter.js"
import { CLOCK } from "../shared/clock.js"
import { HiringPostsController } from "./hiring-posts.controller.js"
import { HiringPostsService } from "./hiring-posts.service.js"
import { StackPostsController } from "./stack-posts.controller.js"
import { StackPostsService } from "./stack-posts.service.js"

/**
 * Pins what the Stack posts and Hiring routes answer for a bad page, a non-JSON write and an invalid body:
 * status, code, message and the exact field errors. Both controllers share the field rules, so one table drives both.
 */

const TODAY = "2026-06-15"
const URL = "https://www.google.com/alerts/feeds/0123/4567"
const JSON_HEADERS = { "content-type": "application/json" }

const stackService = { posts: vi.fn(), today: vi.fn(), saveVerification: vi.fn(), register: vi.fn() }
const hiringService = { posts: vi.fn(), today: vi.fn(), saveVerification: vi.fn(), register: vi.fn() }

let app: NestFastifyApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [StackPostsController, HiringPostsController],
    providers: [
      { provide: StackPostsService, useValue: stackService },
      { provide: HiringPostsService, useValue: hiringService },
      { provide: CLOCK, useValue: { now: () => new Date(`${TODAY}T12:00:00Z`) } },
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
  stackService.today.mockReturnValue(TODAY)
  hiringService.today.mockReturnValue(TODAY)
})

const plain = { error: { code: "bad_request", message: "The request is not valid." } }
const withFields = (...fieldErrors: Array<{ field: string; problem: string }>) => ({
  error: { code: "bad_request", message: "The request is not valid.", fieldErrors: fieldErrors.map(({ field, problem }) => ({ field, position: null, problem })) },
})

const routes = [
  { name: "StackPostsController", service: stackService, postsUrl: "/v1/stack-posts", verificationUrl: "/v1/stack-posts/alert-feeds/verification", registerUrl: "/v1/stack-posts/alert-feeds" },
  { name: "HiringPostsController", service: hiringService, postsUrl: "/v1/stack-posts/hiring-posts", verificationUrl: "/v1/stack-posts/hiring-feeds/verification", registerUrl: "/v1/stack-posts/hiring-feeds" },
]

describe.each(routes)("$name", ({ service, postsUrl, verificationUrl, registerUrl }) => {
  describe("GET posts, the page", () => {
    it.each([
      ["", 1],
      ["?page=1", 1],
      ["?page=2", 2],
      ["?page=15", 15],
    ])("reads %j as page %i", async (query, page) => {
      service.posts.mockResolvedValue({ posts: [] })
      const response = await app.inject({ method: "GET", url: `${postsUrl}${query}` })
      expect(response.statusCode).toBe(200)
      expect(service.posts).toHaveBeenCalledWith(page)
    })

    it.each(["?page=0", "?page=01", "?page=-1", "?page=1.5", "?page=abc", "?page=", "?page=1e2", "?page=%201", "?page=1&page=2"])("refuses %s with a page field error", async (query) => {
      const response = await app.inject({ method: "GET", url: `${postsUrl}${query}` })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(withFields({ field: "page", problem: "invalid" }))
      expect(service.posts).not.toHaveBeenCalled()
    })
  })

  describe("PUT verification", () => {
    const valid = { verifiedOn: "2026-06-14", verificationBasis: "  Read the terms.  " }

    it("saves a valid body", async () => {
      service.saveVerification.mockResolvedValue({ ok: true })
      const response = await app.inject({ method: "PUT", url: verificationUrl, payload: valid, headers: JSON_HEADERS })
      expect(response.statusCode).toBe(200)
      expect(service.saveVerification).toHaveBeenCalledWith({ verifiedOn: "2026-06-14", verificationBasis: "Read the terms." })
    })

    it("accepts today's date and a JSON content type with a charset", async () => {
      service.saveVerification.mockResolvedValue({ ok: true })
      const response = await app.inject({ method: "PUT", url: verificationUrl, payload: { ...valid, verifiedOn: TODAY }, headers: { "content-type": "application/json; charset=utf-8" } })
      expect(response.statusCode).toBe(200)
    })

    it.each([
      ["a missing body", {}, [{ field: "verifiedOn", problem: "missing" }, { field: "verificationBasis", problem: "missing" }]],
      ["a null date and basis", { verifiedOn: null, verificationBasis: null }, [{ field: "verifiedOn", problem: "missing" }, { field: "verificationBasis", problem: "missing" }]],
      ["an empty date", { verifiedOn: "", verificationBasis: "x" }, [{ field: "verifiedOn", problem: "missing" }]],
      ["a date that is not on the calendar", { verifiedOn: "2026-02-30", verificationBasis: "x" }, [{ field: "verifiedOn", problem: "invalid" }]],
      ["a date that is not a string", { verifiedOn: 5, verificationBasis: 7 }, [{ field: "verifiedOn", problem: "invalid" }, { field: "verificationBasis", problem: "invalid" }]],
      ["a future date", { verifiedOn: "2026-06-16", verificationBasis: "x" }, [{ field: "verifiedOn", problem: "future_date" }]],
      ["a future date and a blank basis", { verifiedOn: "2026-06-16", verificationBasis: "   " }, [{ field: "verifiedOn", problem: "future_date" }, { field: "verificationBasis", problem: "missing" }]],
      ["a control character in the basis", { verifiedOn: "2026-06-14", verificationBasis: "a\u0000b" }, [{ field: "verificationBasis", problem: "invalid_characters" }]],
      ["a basis over 500 characters", { verifiedOn: "2026-06-14", verificationBasis: "x".repeat(501) }, [{ field: "verificationBasis", problem: "too_long" }]],
      ["a bad date and a long basis", { verifiedOn: "yesterday", verificationBasis: "x".repeat(501) }, [{ field: "verifiedOn", problem: "invalid" }, { field: "verificationBasis", problem: "too_long" }]],
    ])("answers %s with its field errors", async (_name, payload, fields) => {
      const response = await app.inject({ method: "PUT", url: verificationUrl, payload, headers: JSON_HEADERS })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(withFields(...fields))
      expect(service.saveVerification).not.toHaveBeenCalled()
    })

    it.each([
      ["an unknown key", { ...valid, extra: 1 }],
      ["an array", []],
      ["a string", "x"],
      ["null", null],
    ])("answers %s with a plain 400", async (_name, payload) => {
      const response = await app.inject({ method: "PUT", url: verificationUrl, payload: JSON.stringify(payload), headers: JSON_HEADERS })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(plain)
      expect(service.saveVerification).not.toHaveBeenCalled()
    })

    it("refuses a form body with a plain 400 before it is validated", async () => {
      const response = await app.inject({ method: "PUT", url: verificationUrl, payload: "verifiedOn=2026-06-14&verificationBasis=x", headers: { "content-type": "application/x-www-form-urlencoded" } })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(plain)
      expect(service.saveVerification).not.toHaveBeenCalled()
    })

    it("refuses a form body that would also have field errors with the plain 400", async () => {
      const response = await app.inject({ method: "PUT", url: verificationUrl, payload: "verifiedOn=nope", headers: { "content-type": "application/x-www-form-urlencoded" } })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(plain)
    })
  })

  describe("POST register", () => {
    it("registers a valid body, trimming the url and treating a blank label as none", async () => {
      service.register.mockResolvedValue({ ok: true })
      const response = await app.inject({ method: "POST", url: registerUrl, payload: { url: ` ${URL} `, label: "  " }, headers: JSON_HEADERS })
      expect(response.statusCode).toBe(201)
      expect(service.register).toHaveBeenCalledWith({ url: URL, label: null })
    })

    it.each([
      ["an empty body", {}, [{ field: "url", problem: "invalid_format" }]],
      ["a url that is not a feed", { url: "https://example.com/feed" }, [{ field: "url", problem: "invalid_format" }]],
      ["a url that is not a string", { url: 5 }, [{ field: "url", problem: "invalid_format" }]],
      ["a label that is not a string", { url: URL, label: 5 }, [{ field: "label", problem: "invalid" }]],
      ["a control character in the label", { url: URL, label: "a\nb" }, [{ field: "label", problem: "invalid_characters" }]],
      ["a label over 60 characters", { url: URL, label: "x".repeat(61) }, [{ field: "label", problem: "too_long" }]],
      ["a bad url and a bad label", { url: "nope", label: "x".repeat(61) }, [{ field: "url", problem: "invalid_format" }, { field: "label", problem: "too_long" }]],
    ])("answers %s with its field errors", async (_name, payload, fields) => {
      const response = await app.inject({ method: "POST", url: registerUrl, payload, headers: JSON_HEADERS })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(withFields(...fields))
      expect(service.register).not.toHaveBeenCalled()
    })

    it.each([
      ["an unknown key", { url: URL, extra: 1 }],
      ["an array", []],
      ["a string", "x"],
      ["null", null],
    ])("answers %s with a plain 400", async (_name, payload) => {
      const response = await app.inject({ method: "POST", url: registerUrl, payload: JSON.stringify(payload), headers: JSON_HEADERS })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(plain)
      expect(service.register).not.toHaveBeenCalled()
    })

    it("refuses a form body with a plain 400 before it is validated", async () => {
      const response = await app.inject({ method: "POST", url: registerUrl, payload: `url=${encodeURIComponent(URL)}`, headers: { "content-type": "application/x-www-form-urlencoded" } })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(plain)
      expect(service.register).not.toHaveBeenCalled()
    })

    it("refuses a form body that would also have field errors with the plain 400", async () => {
      const response = await app.inject({ method: "POST", url: registerUrl, payload: "url=nope", headers: { "content-type": "application/x-www-form-urlencoded" } })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(plain)
    })
  })
})
