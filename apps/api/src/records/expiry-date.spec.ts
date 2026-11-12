import { describe, expect, it } from "vitest"

import { addDays, creationDate, dueCreatedBefore, effectiveExpiry, expiryDate, graceEndFrom, isDue } from "./expiry-date.js"

const HALF_HOUR_MS = 30 * 60 * 1000

describe("expiry date (automatic-expiry.feature E1, PRD E1.1 to E1.7)", () => {
  it.each([
    ["2025-10-19T23:30:00Z", "2025-10-20", "2026-10-20"],
    ["2025-10-19T22:59:59Z", "2025-10-19", "2026-10-19"],
    ["2025-10-19T23:00:00Z", "2025-10-20", "2026-10-20"],
    ["2025-12-31T23:30:00Z", "2026-01-01", "2027-01-01"],
    ["2025-12-31T22:30:00Z", "2025-12-31", "2026-12-31"],
    ["2024-02-28T23:30:00Z", "2024-02-29", "2025-02-28"],
  ])("E1.4: created %s has WAT creation date %s and expiry date %s", (created, creation, expiry) => {
    expect(creationDate(new Date(created))).toBe(creation)
    expect(expiryDate(new Date(created))).toBe(expiry)
  })

  it.each([
    ["2024-02-29T10:00:00+01:00", "2025-02-28"],
    ["2028-02-29T10:00:00+01:00", "2029-02-28"],
    ["2024-02-28T10:00:00+01:00", "2025-02-28"],
    ["2024-03-01T10:00:00+01:00", "2025-03-01"],
    ["2027-02-28T10:00:00+01:00", "2028-02-28"],
    ["2025-10-20T09:15:00+01:00", "2026-10-20"],
  ])("E1.2, E1.3 (D-E1): created %s expires on %s", (created, expiry) => {
    expect(expiryDate(new Date(created))).toBe(expiry)
  })

  it("E1.5: due from 00:00 WAT on the expiry date, not on the day before", () => {
    const created = new Date("2025-10-20T09:15:00+01:00")
    expect(isDue(created, "2026-10-19")).toBe(false)
    expect(isDue(created, "2026-10-20")).toBe(true)
    expect(isDue(created, "2026-10-21")).toBe(true)
    expect(dueCreatedBefore("2026-10-20").toISOString()).toBe("2025-10-20T23:00:00.000Z")
  })

  it("E1.3: on 28 Feb after a leap year the bound includes 29 Feb; on 29 Feb of a leap year it is 28 Feb + 1 day", () => {
    expect(dueCreatedBefore("2025-02-28").toISOString()).toBe("2024-02-29T23:00:00.000Z")
    expect(isDue(new Date("2024-02-29T10:00:00+01:00"), "2025-02-27")).toBe(false)
    expect(isDue(new Date("2024-02-29T10:00:00+01:00"), "2025-02-28")).toBe(true)
    expect(dueCreatedBefore("2028-02-29").toISOString()).toBe("2027-02-28T23:00:00.000Z")
  })

  it("E1.7: the result does not depend on the process time zone", () => {
    const before = process.env.TZ
    process.env.TZ = "America/New_York"
    try {
      expect(expiryDate(new Date("2025-10-20T09:15:00+01:00"))).toBe("2026-10-20")
      expect(dueCreatedBefore("2026-10-20").toISOString()).toBe("2025-10-20T23:00:00.000Z")
    } finally {
      process.env.TZ = before
    }
  })

  it("E4.6 (D-E5): the grace ends 30 days after the first run's WAT date and moves earlier expiry dates to it", () => {
    expect(graceEndFrom("2026-11-01")).toBe("2026-12-01")
    expect(addDays("2026-11-15", 30)).toBe("2026-12-15")
    expect(effectiveExpiry(new Date("2025-11-15T10:00:00+01:00"), "2026-12-01")).toBe("2026-12-01")
    expect(effectiveExpiry(new Date("2025-11-30T10:00:00+01:00"), "2026-12-01")).toBe("2026-12-01")
    expect(effectiveExpiry(new Date("2025-12-01T10:00:00+01:00"), "2026-12-01")).toBe("2026-12-01")
    expect(effectiveExpiry(new Date("2025-12-02T10:00:00+01:00"), "2026-12-01")).toBe("2026-12-02")
  })
})

/**
 * The guard against a day-early delete (architecture R1): the SQL bound and the
 * date rule agree everywhere. Every 30-minute instant from 2023 to 2029 is
 * checked against the run dates on either side of its expiry date, the bound
 * is checked on both sides for every run date, and seeded random pairs cover
 * dates far apart.
 */
describe("property: isDue(c, d) === (c < dueCreatedBefore(d))", () => {
  const start = Date.parse("2023-01-01T00:00:00Z")
  const end = Date.parse("2030-01-01T00:00:00Z")

  it("holds for every 30-minute creation instant at the run dates around its expiry", () => {
    // Cost control (split gate): the run dates and SQL bounds depend only on the
    // expiry date (~2,550 distinct values), so they are computed once per date.
    // isDue itself still runs for every instant and run date, which is what the
    // property tests. Per-instant asserts are plain throws, not expect(), because
    // 120k expect() calls dominated the runtime under gate load.
    const aroundExpiry = new Map<string, { runDate: string; bound: number }[]>()
    const around = (expiry: string) => {
      let runs = aroundExpiry.get(expiry)
      if (!runs) {
        runs = [addDays(expiry, -1), expiry, addDays(expiry, 1)].map((runDate) => ({ runDate, bound: dueCreatedBefore(runDate).getTime() }))
        aroundExpiry.set(expiry, runs)
      }
      return runs
    }
    let checked = 0
    let instants = 0
    for (let t = start; t < end; t += HALF_HOUR_MS) {
      const created = new Date(t)
      const runs = around(expiryDate(created))
      for (const { runDate, bound } of runs) {
        if (isDue(created, runDate) !== t < bound) throw new Error(`mismatch at ${created.toISOString()} on ${runDate}`)
        checked++
      }
      // Never due the day before its expiry date (the day-early delete guard).
      if (isDue(created, runs[0]!.runDate)) throw new Error(`due a day early at ${created.toISOString()} on ${runs[0]!.runDate}`)
      instants++
    }
    expect(instants).toBe((end - start) / HALF_HOUR_MS)
    expect(checked).toBe(instants * 3)
  })

  it("the bound sits exactly between the last due instant and the first not-due one, for every run date", () => {
    for (let day = "2024-01-01"; day < "2030-01-01"; day = addDays(day, 1)) {
      const bound = dueCreatedBefore(day).getTime()
      expect(isDue(new Date(bound - 1), day)).toBe(true)
      expect(isDue(new Date(bound), day)).toBe(false)
    }
  })

  it("holds for 200,000 seeded random pairs", () => {
    let seed = 0x2026_1022
    const next = () => ((seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0) / 2 ** 32)
    for (let i = 0; i < 200_000; i++) {
      const created = new Date(start + Math.floor(next() * (end - start)))
      const runDate = addDays("2023-01-01", Math.floor(next() * 2_555))
      if (isDue(created, runDate) !== created.getTime() < dueCreatedBefore(runDate).getTime()) throw new Error(`mismatch at ${created.toISOString()} on ${runDate}`)
    }
  })
})
