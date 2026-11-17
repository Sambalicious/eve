import "reflect-metadata"

import type { Lead } from "@eve/contracts"
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"
import { Test } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiExceptionFilter } from "../http/api-exception.filter.js"
import { LeadsController } from "./leads.controller.js"
import { LeadsService } from "./leads.service.js"

const ID = "6f1c1a52-3b0a-4f43-9a63-0d0f3a2f5c11"
const LEAD = { jobPostingId: ID, stage: "saved" } as unknown as Lead

const service = {
  list: vi.fn(),
  setStage: vi.fn(),
  remove: vi.fn(),
}

let app: NestFastifyApplication

beforeAll(async () => {
  const module = await Test.createTestingModule({ controllers: [LeadsController], providers: [{ provide: LeadsService, useValue: service }] }).compile()
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

const badRequest = { error: { code: "bad_request", message: "The request is not valid." } }

describe("LeadsController", () => {
  it("lists leads with cache-control no-store", async () => {
    service.list.mockResolvedValue({ leads: [] })
    const response = await app.inject({ method: "GET", url: "/v1/leads" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ leads: [] })
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  describe("PUT /v1/leads/:jobPostingId", () => {
    it("sets the stage and returns the lead", async () => {
      service.setStage.mockResolvedValue(LEAD)
      const response = await app.inject({ method: "PUT", url: `/v1/leads/${ID}`, payload: { stage: "applied" } })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(LEAD)
      expect(service.setStage).toHaveBeenCalledWith(ID, "applied")
    })

    it("answers 400 bad_request for a malformed posting id, without calling the service", async () => {
      const response = await app.inject({ method: "PUT", url: "/v1/leads/not-a-uuid", payload: { stage: "saved" } })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(badRequest)
      expect(service.setStage).not.toHaveBeenCalled()
    })

    it.each([{}, { stage: "archived" }, { stage: "saved", extra: true }, { stage: 3 }])("answers 400 bad_request for the body %j", async (payload) => {
      const response = await app.inject({ method: "PUT", url: `/v1/leads/${ID}`, payload })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(badRequest)
      expect(service.setStage).not.toHaveBeenCalled()
    })

    it("answers 404 not_found when the Candidate does not hold the posting", async () => {
      service.setStage.mockResolvedValue(undefined)
      const response = await app.inject({ method: "PUT", url: `/v1/leads/${ID}`, payload: { stage: "saved" } })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual({ error: { code: "not_found", message: "Not found." } })
    })
  })

  describe("DELETE /v1/leads/:jobPostingId", () => {
    it("answers 204 with no body", async () => {
      service.remove.mockResolvedValue(true)
      const response = await app.inject({ method: "DELETE", url: `/v1/leads/${ID}` })
      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(service.remove).toHaveBeenCalledWith(ID)
    })

    it("answers 400 bad_request for a malformed posting id, without calling the service", async () => {
      const response = await app.inject({ method: "DELETE", url: "/v1/leads/123" })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual(badRequest)
      expect(service.remove).not.toHaveBeenCalled()
    })
  })
})
