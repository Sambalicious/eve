import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { OWNER_CRITERIA_SNAPSHOT_FILE, buildOwnerCriteriaSnapshot } from "./owner-criteria-regression.js"
import { OWNER_POSTINGS, OWNER_TECHNOLOGY_POSTINGS } from "./owner-postings.js"

const SNAPSHOT = fileURLToPath(new URL(OWNER_CRITERIA_SNAPSHOT_FILE, import.meta.url))

type Entry = Readonly<{ id: string; technologyState: string; status: string; skipReason: string | null; droppedTechnologyCount: number }>
type Part = Readonly<{ postings: Entry[]; ranking: string[] }>
type Snapshot = Readonly<{ capturedOn: string; criteriaSet2: unknown; underCriteriaSet2: Part; technologyPostingsUnderOwnerCriteria: Part }>

function snapshot(): Snapshot {
  return JSON.parse(buildOwnerCriteriaSnapshot()) as Snapshot
}

function outcome(part: Part, id: string): string {
  const found = part.postings.find((posting) => posting.id === id)
  return `${found?.status}/${found?.skipReason}`
}

describe("owner Job criteria golden (EPIC-0002 A0, r5; r5-new-tables-isolation.feature @slice-A0 @ac-6.3)", () => {
  it("adds at least 6 fixtures carrying technologies as null, [] and a verified list", () => {
    expect(OWNER_TECHNOLOGY_POSTINGS.length).toBeGreaterThanOrEqual(6)
    const states = snapshot().technologyPostingsUnderOwnerCriteria.postings.map((posting) => posting.technologyState)
    expect(new Set(states)).toEqual(new Set(["not_checked", "none_found", "listed"]))
  })

  it("records a verdict under criteria set 2 for every fixture, under the fixed values", () => {
    const { criteriaSet2, underCriteriaSet2 } = snapshot()
    expect(criteriaSet2).toEqual({ minCoreMatchPercent: 80, frameworks: ["React"], technologies: ["TypeScript"] })
    expect(underCriteriaSet2.postings.map((posting) => posting.id)).toEqual([...OWNER_POSTINGS, ...OWNER_TECHNOLOGY_POSTINGS].map((posting) => posting.id))
  })

  // Expected outcomes worked out by hand from EPIC-0004 AC 5.1 steps 4 and 5, not from the code.
  it.each([
    ["golden-62", "4 of 4, not checked", "ranked/null"],
    ["golden-63", "3 of 4 is below 80", "skipped/weak_core_match"],
    ["golden-64", "4 of 4, checked with none found", "skipped/technology_mismatch"],
    ["golden-65", "3 of 4 with none found: step 4 decides first", "skipped/weak_core_match"],
    ["golden-66", "React listed", "ranked/null"],
    ["golden-67", "4 of 5 meets 80 exactly; TS is TypeScript", "ranked/null"],
    ["golden-68", "Vue only", "skipped/technology_mismatch"],
    ["golden-69", "React quote not in the posting is dropped; Python only", "skipped/technology_mismatch"],
    ["golden-70", "US only: excluded before step 4", "excluded/violated_rule"],
    ["golden-71", "3 of 5 is below 80 although TypeScript is listed", "skipped/weak_core_match"],
  ])("criteria set 2: %s (%s) is %s", (id, _why, expected) => {
    expect(outcome(snapshot().underCriteriaSet2, id)).toBe(expected)
  })

  it.each([
    ["golden-63", "ranked/null"],
    ["golden-64", "ranked/null"],
    ["golden-68", "ranked/null"],
    ["golden-71", "skipped/weak_core_match"],
  ])("owner criteria (70%%, empty lists, step 5 off): %s is %s", (id, expected) => {
    expect(outcome(snapshot().technologyPostingsUnderOwnerCriteria, id)).toBe(expected)
  })

  it("drops a technology whose quote is not in the posting (AC 4.2)", () => {
    expect(snapshot().underCriteriaSet2.postings.find((posting) => posting.id === "golden-69")?.droppedTechnologyCount).toBe(1)
  })

  it("an owner fixture without technology data is never skipped for technology under set 2", () => {
    const owner = new Set(OWNER_POSTINGS.map((posting) => posting.id))
    const fromOwner = snapshot().underCriteriaSet2.postings.filter((posting) => owner.has(posting.id))
    expect(fromOwner.every((posting) => posting.technologyState === "not_checked" && posting.skipReason !== "technology_mismatch")).toBe(true)
  })

  it("the snapshot header names the base commit it was captured on", () => {
    expect(snapshot().capturedOn).toMatch(/^main [0-9a-f]{7}\b/)
  })

  it("is byte-equal to the committed snapshot", () => {
    const current = buildOwnerCriteriaSnapshot()
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(SNAPSHOT, current)
    expect(current).toBe(readFileSync(SNAPSHOT, "utf8"))
  })
})
