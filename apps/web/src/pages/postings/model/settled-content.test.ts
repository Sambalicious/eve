import { describe, expect, it } from "vitest"

import type { JobPostingPage } from "@/entities/job-posting"
import { settledContent } from "./use-postings-view"

/** EPIC-0006 design-spec.r1 B4 precedence. */
function page(totalCount: number, hiddenTotal: number, criteriaEmptyState = false): JobPostingPage {
  return {
    postings: [],
    waitingToBeCheckedCount: 0,
    nextCursor: null,
    totalCount,
    criteriaEmptyState,
    hiddenCounts: { offTarget: hiddenTotal, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, total: hiddenTotal },
    recheckableCount: 0,
    targetRoleFamilies: ["senior_frontend"],
    waitingReason: null,
  }
}
const base = { rows: 0, isPlaceholder: false, isFiltered: false, anyPending: false, anyExists: undefined as boolean | undefined }

describe("settledContent", () => {
  it("filter empty wins over all hidden", () => {
    expect(settledContent({ ...base, latest: page(0, 10), isFiltered: true, tab: "all" })).toBe("filterEmpty")
  })

  it("rows win over everything after the filter", () => {
    expect(settledContent({ ...base, latest: page(3, 10), rows: 3, tab: "ranked" })).toBe("list")
  })

  it("All with no rows and hidden postings is all hidden; with none it is first run", () => {
    expect(settledContent({ ...base, latest: page(0, 10), tab: "all" })).toBe("allHidden")
    expect(settledContent({ ...base, latest: page(0, 0), tab: "all" })).toBe("firstRun")
  })

  it("Ranked or Skipped waits for the any-visible check while something is hidden", () => {
    expect(settledContent({ ...base, latest: page(0, 10), tab: "ranked", anyPending: true })).toBeUndefined()
    expect(settledContent({ ...base, latest: page(0, 10), tab: "skipped", anyExists: false })).toBe("allHidden")
    expect(settledContent({ ...base, latest: page(0, 10), tab: "ranked", anyExists: false })).toBe("allHidden")
  })

  it("a visible posting on another tab keeps the tab's own empty state", () => {
    expect(settledContent({ ...base, latest: page(0, 10), tab: "ranked", anyExists: true })).toBe("rankedEmpty")
    expect(settledContent({ ...base, latest: page(0, 10, true), tab: "ranked", anyExists: true })).toBe("criteriaEmpty")
  })
})

describe("settledContent, four tabs (EPIC-0002 B1)", () => {
  it("Skipped by rules and Excluded families get their own empty states once something exists", () => {
    expect(settledContent({ ...base, latest: page(0, 0), tab: "skipped", anyExists: true })).toBe("skippedEmpty")
    expect(settledContent({ ...base, latest: page(0, 0), tab: "excluded_family", anyExists: true })).toBe("excludedEmpty")
  })

  it("first run shows on every tab", () => {
    for (const tab of ["ranked", "skipped", "excluded_family"] as const) {
      expect(settledContent({ ...base, latest: page(0, 0), tab, anyExists: false })).toBe("firstRun")
    }
  })

  it("the criteria empty state is Ranked only", () => {
    expect(settledContent({ ...base, latest: page(0, 0, true), tab: "skipped", anyExists: true })).toBe("skippedEmpty")
  })
})
