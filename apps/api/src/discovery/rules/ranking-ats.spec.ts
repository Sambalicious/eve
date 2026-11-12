import { describe, expect, it } from "vitest"

import { type RoleFamily, rankPostings } from "./ranking.js"

describe("ATS fit ranks right after the Candidate's tier", () => {
  const at = new Date("2026-10-01T00:00:00Z")
  const posting = (id: string, family: RoleFamily, atsFit: number | null, coverage: number) => ({ id, family, atsFit, coverage, discoveredAt: at, fromEmployerBoard: true })

  it("orders by tier, then ATS fit (missing last), then coverage", () => {
    const order = rankPostings([
      posting("low-fit-full-coverage", "senior_frontend", 20, 1),
      posting("high-fit", "senior_frontend", 80, 0.5),
      posting("no-fit", "senior_frontend", null, 1),
      posting("other-tier-high-fit", "other", 100, 1),
    ])
    expect(order.slice(0, 3)).toEqual(["high-fit", "low-fit-full-coverage", "no-fit"])
    expect(order.at(-1)).toBe("other-tier-high-fit")
  })
})
