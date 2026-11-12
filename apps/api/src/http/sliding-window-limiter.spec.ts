import { describe, expect, it } from "vitest"

import { SlidingWindowLimiter } from "./sliding-window-limiter.js"

const MINUTE = 60_000
const T0 = Date.parse("2026-10-22T09:00:00.000Z")

function takeTimes(limiter: SlidingWindowLimiter, key: string, times: number, now = T0) {
  return Array.from({ length: times }, () => limiter.take(key, now))
}

describe("SlidingWindowLimiter (SEC-006)", () => {
  it("allows up to the limit inside one window and refuses the next with a Retry-After", () => {
    const limiter = new SlidingWindowLimiter(10, MINUTE)
    expect(takeTimes(limiter, "a", 10).every((decision) => decision.allowed)).toBe(true)
    expect(limiter.take("a", T0)).toEqual({ allowed: false, retryAfterSeconds: 60 })
  })

  it("a refused request is not recorded, so refusals never extend the wait", () => {
    const limiter = new SlidingWindowLimiter(2, MINUTE)
    takeTimes(limiter, "a", 2)
    takeTimes(limiter, "a", 50, T0 + 10_000)
    expect(limiter.take("a", T0 + MINUTE)).toEqual({ allowed: true })
  })

  it("Retry-After counts down to when the oldest request leaves the window, rounded up, at least 1", () => {
    const limiter = new SlidingWindowLimiter(1, MINUTE)
    limiter.take("a", T0)
    expect(limiter.take("a", T0 + 15_500)).toEqual({ allowed: false, retryAfterSeconds: 45 })
    expect(limiter.take("a", T0 + MINUTE - 1)).toEqual({ allowed: false, retryAfterSeconds: 1 })
  })

  it("resets once the window has passed: a request exactly one window later is allowed", () => {
    const limiter = new SlidingWindowLimiter(10, MINUTE)
    takeTimes(limiter, "a", 10)
    expect(limiter.take("a", T0 + MINUTE - 1).allowed).toBe(false)
    expect(limiter.take("a", T0 + MINUTE)).toEqual({ allowed: true })
  })

  it("slides: only requests inside the last window count", () => {
    const limiter = new SlidingWindowLimiter(3, MINUTE)
    limiter.take("a", T0)
    limiter.take("a", T0 + 30_000)
    limiter.take("a", T0 + 40_000)
    expect(limiter.take("a", T0 + 50_000)).toEqual({ allowed: false, retryAfterSeconds: 10 })
    expect(limiter.take("a", T0 + MINUTE)).toEqual({ allowed: true })
    expect(limiter.take("a", T0 + MINUTE + 1).allowed).toBe(false)
  })

  it("keys are isolated: one key at its limit does not affect another", () => {
    const limiter = new SlidingWindowLimiter(10, MINUTE)
    takeTimes(limiter, "a", 10)
    expect(limiter.take("a", T0).allowed).toBe(false)
    expect(takeTimes(limiter, "b", 10).every((decision) => decision.allowed)).toBe(true)
    expect(limiter.take("b", T0).allowed).toBe(false)
  })

  it("a clock that moves backwards forgets requests recorded in its future instead of locking the key out", () => {
    const limiter = new SlidingWindowLimiter(1, MINUTE)
    limiter.take("a", T0 + 10 * MINUTE)
    expect(limiter.take("a", T0)).toEqual({ allowed: true })
    expect(limiter.take("a", T0)).toEqual({ allowed: false, retryAfterSeconds: 60 })
  })

  it("forgets keys whose requests have all left the window", () => {
    const limiter = new SlidingWindowLimiter(1, MINUTE)
    for (let index = 0; index < 500; index += 1) limiter.take(`key-${index}`, T0)
    limiter.take("late", T0 + MINUTE)
    expect(limiter.trackedKeys()).toBe(1)
  })

  it("reset() clears every key", () => {
    const limiter = new SlidingWindowLimiter(1, MINUTE)
    limiter.take("a", T0)
    limiter.reset()
    expect(limiter.take("a", T0)).toEqual({ allowed: true })
  })

  it("refuses a non-positive limit or window", () => {
    expect(() => new SlidingWindowLimiter(0, MINUTE)).toThrow(RangeError)
    expect(() => new SlidingWindowLimiter(1, 0)).toThrow(RangeError)
    expect(() => new SlidingWindowLimiter(1.5, MINUTE)).toThrow(RangeError)
  })
})
