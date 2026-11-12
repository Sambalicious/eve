import { describe, expect, it } from "vitest"

import {
  apiErrorResponseSchema,
  sessionResponseSchema,
  signInPageQuerySchema,
} from "./index.js"

describe("contract schemas", () => {
  it("accepts the error envelope and rejects extra data fields", () => {
    expect(
      apiErrorResponseSchema.safeParse({
        error: { code: "unauthenticated", message: "Sign in to continue." },
      }).success
    ).toBe(true)
    expect(
      apiErrorResponseSchema.safeParse({
        error: { code: "unauthenticated", message: "x" },
        data: { settings: {} },
      }).success
    ).toBe(false)
  })

  it("v1.15.0 (SEC-006): accepts too_many_requests, which carries neither reason nor fieldErrors", () => {
    const message = "Too many requests. Wait a minute, then try again."
    expect(apiErrorResponseSchema.safeParse({ error: { code: "too_many_requests", message } }).success).toBe(true)
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: "too_many_requests", message, retryAfterSeconds: 40 } }).success
    ).toBe(false)
  })

  it("requires a csrf token in the session body and nothing else", () => {
    expect(sessionResponseSchema.safeParse({ csrfToken: "abc" }).success).toBe(true)
    expect(sessionResponseSchema.safeParse({}).success).toBe(false)
    expect(
      sessionResponseSchema.safeParse({ csrfToken: "abc", sub: "1" }).success
    ).toBe(false)
  })

  it("parses each sign-in error the backend can send", () => {
    for (const error of ["cancelled", "failed", "account_refused"]) {
      expect(signInPageQuerySchema.parse({ error }).error).toBe(error)
    }
    expect(signInPageQuerySchema.safeParse({ error: "nope" }).success).toBe(false)
  })
})
