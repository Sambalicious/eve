import { describe, expect, it } from "vitest"

import { skipLine } from "./copy"
import type { JobPosting } from "./job-posting"

const row = (overrides: Partial<Pick<JobPosting, "skipReason" | "skipDetail" | "coverage">>) => ({
  skipReason: null,
  skipDetail: null,
  applicationSystem: "Greenhouse",
  coverage: null,
  ...overrides,
})

describe("skipLine (EPIC-0004 C-JC-SKIP-WEAK, C-JC-SKIP-TECH)", () => {
  it.each([
    [70, 6, 10, "Your profile backs only 60% of the core responsibilities. Your minimum is 70%."],
    [70, 6, 9, "Your profile backs only 66% of the core responsibilities. Your minimum is 70%."],
    [67, 2, 3, "Your profile backs only 66% of the core responsibilities. Your minimum is 67%."],
    [70, 16, 23, "Your profile backs only 69% of the core responsibilities. Your minimum is 70%."],
    [100, 9, 10, "Your profile backs only 90% of the core responsibilities. Your minimum is 100%."],
    [1, 0, 5, "Your profile backs only 0% of the core responsibilities. Your minimum is 1%."],
    [66, 21, 32, "Your profile backs only 65% of the core responsibilities. Your minimum is 66%."],
  ])("weak_core_match at minimum %i with %i of %i reads %j (rounded down)", (thresholdPercent, covered, total, line) => {
    expect(skipLine(row({ skipReason: "weak_core_match", coverage: { covered, total, thresholdPercent } }))).toBe(line)
  })

  it("falls back to C-SKIP-4 when a weak_core_match row has no Match numbers", () => {
    expect(skipLine(row({ skipReason: "weak_core_match" }))).toBe("Your profile doesn't back enough of the core responsibilities.")
  })

  it("names technology_mismatch with \"doesn't mention\"", () => {
    expect(skipLine(row({ skipReason: "technology_mismatch", coverage: { covered: 8, total: 10, thresholdPercent: 70 } }))).toBe(
      "This job doesn't mention the technologies you told Eve to look for."
    )
  })
})
