import "reflect-metadata"

import fastifyCookie from "@fastify/cookie"
import type { MeResponse } from "@eve/contracts"
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { ActiveSession } from "../auth/session.service.js"
import { ApiExceptionFilter } from "../http/api-exception.filter.js"
import { MeController } from "./me.controller.js"
import { MeService } from "./me.service.js"

const CANDIDATE_ID = "b2f7f4a0-6a5e-4a0e-8f5d-1d2f9b0c7e11"
const ME = { candidateId: CANDIDATE_ID } as unknown as MeResponse

const service = { read: vi.fn(), setAdvanced: vi.fn(), dismiss: vi.fn() }

let app: NestFastifyApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({ controllers: [MeController], providers: [{ provide: MeService, useValue: service }] }).compile()
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.useGlobalFilters(new ApiExceptionFilter())
  // The filter clears the session cookie on a 401.
  await app.register(fastifyCookie)
  // Stands in for the AuthGuard: the controller only reads the session it resolved.
  app.getHttpAdapter().getInstance().addHook("onRequest", (request, _reply, done) => {
    if (request.headers["x-test-signed-in"] === "1") request.dashboardSession = { candidateId: CANDIDATE_ID } as unknown as ActiveSession
    done()
  })
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  vi.resetAllMocks()
})

const signedIn = { "x-test-signed-in": "1" }
const badRequest = { error: { code: "bad_request", message: "The request is not valid." } }

describe("MeController", () => {
  describe("GET /v1/me", () => {
    it("reads the session Candidate with cache-control no-store", async () => {
      service.read.mockResolvedValue(ME)
      const response = await app.inject({ method: "GET", url: "/v1/me", headers: signedIn })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(ME)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(service.read).toHaveBeenCalledWith(CANDIDATE_ID)
    })

    it("answers 401 unauthenticated when no session was resolved", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/me" })
      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe("unauthenticated")
      expect(service.read).not.toHaveBeenCalled()
    })
  })

  describe("PUT /v1/me/advanced", () => {
    it.each([true, false])("passes enabled=%s and the session Candidate to the service", async (enabled) => {
      service.setAdvanced.mockResolvedValue(ME)
      const response = await app.inject({ method: "PUT", url: "/v1/me/advanced", headers: signedIn, payload: { enabled } })
      expect(response.statusCode).toBe(200)
      expect(service.setAdvanced).toHaveBeenCalledWith(CANDIDATE_ID, enabled)
    })

    it.each([{}, { enabled: "yes" }, { enabled: 1 }, { enabled: true, candidateId: "other" }])("answers 400 bad_request for the body %j, without calling the service", async (payload) => {
      const response = await app.inject({ method: "PUT", url: "/v1/me/advanced", headers: signedIn, payload })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(badRequest)
      expect(service.setAdvanced).not.toHaveBeenCalled()
    })
  })

  describe("POST /v1/me/notes/:note/dismiss", () => {
    it.each(["simpler_now", "improve_results"])("dismisses %s with a 200", async (note) => {
      service.dismiss.mockResolvedValue(ME)
      const response = await app.inject({ method: "POST", url: `/v1/me/notes/${note}/dismiss`, headers: signedIn })
      expect(response.statusCode).toBe(200)
      expect(service.dismiss).toHaveBeenCalledWith(CANDIDATE_ID, note)
    })

    it("answers 404 not_found for an unknown note, before anything is written", async () => {
      const response = await app.inject({ method: "POST", url: "/v1/me/notes/unknown/dismiss", headers: signedIn })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual({ error: { code: "not_found", message: "Not found." } })
      expect(service.dismiss).not.toHaveBeenCalled()
    })
  })
})
