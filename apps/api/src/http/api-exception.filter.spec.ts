import type { ArgumentsHost } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { ApiExceptionFilter, withCandidate } from "./api-exception.filter.js"
import { ApiException } from "./api-exception.js"

function fakeReply() {
  const reply = { status: vi.fn(), header: vi.fn(), send: vi.fn(), clearCookie: vi.fn() }
  reply.status.mockReturnValue(reply)
  reply.header.mockReturnValue(reply)
  return reply
}

function hostFor(reply: ReturnType<typeof fakeReply>): ArgumentsHost {
  // EPIC-0003: the filter reads the request route (access-request invalid JSON); any other route is fine here.
  return { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({}) }) } as unknown as ArgumentsHost
}

describe("ApiExceptionFilter and too_many_requests (SEC-006, contract v1.15.0)", () => {
  it("sends 429, the envelope with no extra keys, and Retry-After in whole seconds", () => {
    const reply = fakeReply()
    new ApiExceptionFilter().catch(ApiException.tooManyRequests(42), hostFor(reply))
    expect(reply.status).toHaveBeenCalledWith(429)
    expect(reply.header).toHaveBeenCalledWith("retry-after", "42")
    expect(reply.send).toHaveBeenCalledWith({
      error: { code: "too_many_requests", message: "Too many requests. Wait a minute, then try again." },
    })
  })

  it("sends Retry-After on service_unavailable when set (EPIC-0005 r4, contract v1.15.2), never in the body", () => {
    const reply = fakeReply()
    new ApiExceptionFilter().catch(ApiException.serviceUnavailable(5), hostFor(reply))
    expect(reply.status).toHaveBeenCalledWith(503)
    expect(reply.header).toHaveBeenCalledWith("retry-after", "5")
    expect(reply.send).toHaveBeenCalledWith({ error: { code: "service_unavailable", message: "The service is unavailable. Try again shortly." } })
  })

  it("sends no Retry-After on service_unavailable without a value", () => {
    const reply = fakeReply()
    new ApiExceptionFilter().catch(new ApiException("service_unavailable"), hostFor(reply))
    expect(reply.header).not.toHaveBeenCalled()
  })

  it("sends no Retry-After on any other error", () => {
    const reply = fakeReply()
    new ApiExceptionFilter().catch(new ApiException("bad_request"), hostFor(reply))
    expect(reply.header).not.toHaveBeenCalled()
  })
})

describe("withCandidate (EPIC-0002 A2, SEC-803)", () => {
  it("adds the session's Candidate ID to a 500 log line, and nothing without a session", () => {
    expect(withCandidate("Database error 57014", "00000000-0000-4000-8000-000000000001")).toBe("Database error 57014 for Candidate 00000000-0000-4000-8000-000000000001")
    expect(withCandidate("Database error 57014", undefined)).toBe("Database error 57014")
  })
})
