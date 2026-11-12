import { describe, expect, it } from "vitest"

import { decideGlobal, decidePerIp, secondsToNextUtcMidnight } from "./rate-limit.js"

const NOW = Date.parse("2026-10-21T11:00:00.000Z")
const limits = { perHour: 3, perDay: 10 }
const ago = (ms: number) => new Date(NOW - ms)
const MIN = 60_000
const HOUR = 3_600_000

describe("per-IP rate limit (AC 11.8, 11.12)", () => {
  it("the 3rd in an hour is allowed, the 4th refused", () => {
    expect(decidePerIp([ago(50 * MIN), ago(30 * MIN)], new Date(NOW), limits)).toEqual({ allowed: true })
    expect(decidePerIp([ago(50 * MIN), ago(30 * MIN), ago(10 * MIN)], new Date(NOW), limits).allowed).toBe(false)
  })

  it("Retry-After is 600 s when the oldest of the hour is 50 minutes old", () => {
    expect(decidePerIp([ago(50 * MIN), ago(30 * MIN), ago(10 * MIN)], new Date(NOW), limits)).toEqual({ allowed: false, retryAfterSeconds: 600 })
  })

  it("the hourly window is rolling: an entry exactly 1 hour old no longer counts", () => {
    expect(decidePerIp([ago(HOUR), ago(30 * MIN), ago(10 * MIN)], new Date(NOW), limits)).toEqual({ allowed: true })
    expect(decidePerIp([ago(HOUR - 1000), ago(30 * MIN), ago(10 * MIN)], new Date(NOW), limits)).toEqual({ allowed: false, retryAfterSeconds: 1 })
  })

  it("the 10th in a day is allowed, the 11th refused, with the daily Retry-After", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ago(23 * HOUR - i * HOUR))
    expect(decidePerIp(nine, new Date(NOW), limits)).toEqual({ allowed: true })
    const ten = [...nine, ago(2 * HOUR)]
    expect(decidePerIp(ten, new Date(NOW), limits)).toEqual({ allowed: false, retryAfterSeconds: 3600 })
  })

  it("the daily window is rolling: an entry exactly 24 hours old no longer counts", () => {
    const ten = [ago(24 * HOUR), ...Array.from({ length: 9 }, (_, i) => ago(20 * HOUR - i * HOUR))]
    expect(decidePerIp(ten, new Date(NOW), limits)).toEqual({ allowed: true })
  })

  it("when both rules fail, the larger Retry-After wins", () => {
    const entries = [...Array.from({ length: 7 }, (_, i) => ago(23 * HOUR - i * MIN)), ago(50 * MIN), ago(30 * MIN), ago(10 * MIN)]
    const decision = decidePerIp(entries, new Date(NOW), limits)
    expect(decision).toEqual({ allowed: false, retryAfterSeconds: 3600 })
  })

  it("unsorted input gives the same answer", () => {
    expect(decidePerIp([ago(10 * MIN), ago(50 * MIN), ago(30 * MIN)], new Date(NOW), limits)).toEqual({ allowed: false, retryAfterSeconds: 600 })
  })
})

describe("global daily cap (AC 11.9)", () => {
  it("allows below the cap and refuses at it with seconds to 00:00 UTC", () => {
    expect(decideGlobal(49, new Date(NOW), 50)).toEqual({ allowed: true })
    expect(decideGlobal(50, new Date(NOW), 50)).toEqual({ allowed: false, retryAfterSeconds: 13 * 3600 })
  })

  it("seconds to the next UTC midnight is at least 1 and rounds up", () => {
    expect(secondsToNextUtcMidnight(new Date("2026-10-21T23:59:59.500Z"))).toBe(1)
    expect(secondsToNextUtcMidnight(new Date("2026-10-21T00:00:00.000Z"))).toBe(86_400)
  })
})
