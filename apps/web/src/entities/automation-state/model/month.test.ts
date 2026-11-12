import { describe, expect, it } from "vitest"

import { firstOfNextMonth, monthLabel } from "./month"

describe("month labels for C-COST-5, C-COST-7 and C-CONFIRM-18", () => {
  it("names the WAT month", () => {
    expect(monthLabel("2026-10-01")).toBe("October 2026")
  })
  it("the 1st of next month, also across a year end", () => {
    expect(firstOfNextMonth("2026-10-01")).toBe("2026-11-01")
    expect(firstOfNextMonth("2026-12-01")).toBe("2027-01-01")
  })
})
