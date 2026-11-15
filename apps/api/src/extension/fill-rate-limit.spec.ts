import { describe, expect, it } from "vitest"

import { EXTENSION_FILL_LIMIT, EXTENSION_FILL_WINDOW_MS, FillRateLimiter } from "./fill-rate-limit.js"

const CANDIDATE = "6f1c2a4e-0000-4000-8000-000000000001"

describe("the extension fill throttle (LOW 3: per Candidate, fixed window, per process)", () => {
  it("allows exactly 30 requests in a minute and refuses the 31st with a retry hint", () => {
    const limiter = new FillRateLimiter()
    const start = 1_000_000
    for (let index = 0; index < EXTENSION_FILL_LIMIT; index++) expect(limiter.check(CANDIDATE, start)).toBe(0)
    expect(limiter.check(CANDIDATE, start)).toBe(60)
    // Repeated refusals inside the window do not extend it.
    expect(limiter.check(CANDIDATE, start + 59_000)).toBe(1)
    expect(limiter.check(CANDIDATE, start + 59_500)).toBe(1)
  })

  it("starts a fresh window at the 60-second boundary", () => {
    const limiter = new FillRateLimiter(1, EXTENSION_FILL_WINDOW_MS)
    expect(limiter.check(CANDIDATE, 0)).toBe(0)
    expect(limiter.check(CANDIDATE, EXTENSION_FILL_WINDOW_MS - 1)).toBe(1)
    expect(limiter.check(CANDIDATE, EXTENSION_FILL_WINDOW_MS)).toBe(0)
  })

  it("keys the window per Candidate", () => {
    const limiter = new FillRateLimiter(1, EXTENSION_FILL_WINDOW_MS)
    expect(limiter.check(CANDIDATE, 0)).toBe(0)
    expect(limiter.check("another-candidate", 0)).toBe(0)
    expect(limiter.check(CANDIDATE, 0)).toBe(60)
  })
})
