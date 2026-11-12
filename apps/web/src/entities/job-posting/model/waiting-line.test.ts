import { describe, expect, it } from "vitest"

import { isCheckingTooLong, waitingLine } from "./waiting-line"

describe("waitingLine (C-LINK-10)", () => {
  it("names the save date and the 1st of next month in WAT", () => {
    expect(waitingLine("2026-10-19T09:00:00Z", new Date("2026-10-19T10:00:00Z"))).toBe(
      "Saved on 19 Oct 2026 while paid automation was paused for cost. It hasn't been checked for Eligibility or Match yet. That happens on 1 Nov 2026, or sooner if you raise this month's ceiling."
    )
  })

  it("uses the WAT month: 23:30 UTC on 31 Oct is already 1 Nov in Lagos", () => {
    expect(waitingLine("2026-10-31T23:30:00Z", new Date("2026-10-31T23:30:00Z"))).toContain("That happens on 1 Dec 2026")
  })

  it("rolls over the year", () => {
    expect(waitingLine("2026-12-05T09:00:00Z", new Date("2026-12-05T09:00:00Z"))).toContain("1 Jan 2027")
  })
})

describe("isCheckingTooLong", () => {
  it("is false at 10 minutes and true after", () => {
    const at = "2026-10-19T09:00:00Z"
    expect(isCheckingTooLong(at, new Date("2026-10-19T09:10:00Z"))).toBe(false)
    expect(isCheckingTooLong(at, new Date("2026-10-19T09:10:01Z"))).toBe(true)
  })
})
