import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { OWNER_POSTINGS } from "./owner-postings.js"
import { OWNER_SNAPSHOT_FILE, buildOwnerSnapshot } from "./owner-regression.js"

const SNAPSHOT = fileURLToPath(new URL(OWNER_SNAPSHOT_FILE, import.meta.url))

type Entry = Readonly<{
  id: string
  title: string
  preFilter: string
  titleFolded: string
  status: string
  roleFamily: string
  unverifiedLabels: string[]
  employmentType: string | null
  rules: Record<string, { result: string }>
}>
type Snapshot = Readonly<{ capturedOn: string; postings: Entry[]; ranking: string[] }>

const FAMILIES = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "backend", "mobile", "devops_platform", "people_management", "other"]

function snapshot(): Snapshot {
  return JSON.parse(buildOwnerSnapshot()) as Snapshot
}

function titled(pattern: RegExp): Entry[] {
  return snapshot().postings.filter((posting) => pattern.test(posting.title))
}

describe("owner Eligibility golden (EPIC-0002 A0)", () => {
  it("covers at least 30 postings and every outcome", () => {
    const { postings } = snapshot()
    expect(OWNER_POSTINGS.length).toBeGreaterThanOrEqual(30)
    expect(new Set(postings.map((p) => p.status))).toEqual(new Set(["ranked", "excluded", "skipped"]))
    expect(new Set(postings.map((p) => p.roleFamily)).size).toBeGreaterThanOrEqual(7)
    expect(postings.some((p) => p.unverifiedLabels.length > 0)).toBe(true)
  })

  // A0 definition item 1 (architecture r4; golden-capture.feature :24, :30, :46, :53, :71, :83).
  it("item 1: holds at least 40 fixtures", () => {
    expect(OWNER_POSTINGS.length).toBeGreaterThanOrEqual(40)
  })

  it.each([
    ["location", ["met", "violated", "unverified"]],
    ["sponsorship", ["met", "violated", "unverified", "not_applicable"]],
    ["pay", ["met", "violated", "unverified"]],
    ["hours", ["met", "violated", "unverified"]],
    ["industry", ["met", "violated", "unverified"]],
  ])("item 1: the %s rule reaches every result", (rule, results) => {
    const seen = new Set(snapshot().postings.map((p) => p.rules[rule]?.result))
    for (const result of results) expect(seen, `${rule} ${result}`).toContain(result)
  })

  it("item 1: records each employment type the built code accepts, and an unknown one", () => {
    expect(new Set(snapshot().postings.map((p) => p.employmentType))).toEqual(new Set(["direct", "employer_of_record", "contract", null]))
  })

  it("item 1: one fixture publishes pay in a currency with no exchange rate, and its pay is Unverified", () => {
    const noRate = titled(/./).filter((p) => /\bNGN\b/.test(OWNER_POSTINGS.find((f) => f.id === p.id)?.postingText ?? ""))
    expect(noRate.length).toBeGreaterThanOrEqual(1)
    for (const entry of noRate) expect(entry.rules.pay?.result).toBe("unverified")
  })

  // EPIC-0006 (P8): A0's devops_platform titles split into devops_platform and platform_engineering, so the
  // A0 nine-family coverage rule counts both for devops_platform. The four new families need no A0 coverage.
  const A0_FAMILY: Readonly<Record<string, string>> = { platform_engineering: "devops_platform" }
  it.each(FAMILIES)("item 1: at least 2 fixtures classify as %s (A0 catalog)", (family) => {
    expect(snapshot().postings.filter((p) => (A0_FAMILY[p.roleFamily] ?? p.roleFamily) === family).length).toBeGreaterThanOrEqual(2)
  })

  it("item 1: the classifier precedence cases are covered", () => {
    const managers = snapshot().postings.filter((p) => p.roleFamily === "people_management")
    expect(managers.some((p) => /\blead\b/i.test(p.title)), "a lead title with management duties is people management").toBe(true)
    expect(managers.some((p) => !/\blead\b/i.test(p.title)), "a manager title that is not a lead").toBe(true)
    expect(snapshot().postings.some((p) => p.roleFamily === "technical_lead" && /\blead\b/i.test(p.title))).toBe(true)
    const reactNative = titled(/react native/i)
    expect(reactNative.length).toBeGreaterThanOrEqual(1)
    for (const entry of reactNative) expect(entry.roleFamily).toBe("senior_frontend")
  })

  it.each([
    ["sales engineer", /\bsales engineer\b/i, "not_software_role"],
    ["support engineer", /\bsupport engineer\b/i, "not_software_role"],
    ["customer engineer", /\bcustomer engineer\b/i, "not_software_role"],
    ["solutions engineer", /\bsolutions engineer\b/i, "not_software_role"],
    ["field engineer", /\bfield engineer\b/i, "not_software_role"],
    ["HR title without engineer", /^HR\b(?!.*engineer)/i, "not_software_role"],
    ["HR title with engineer", /^HR\b.*engineer/i, "pass"],
    ["non-software title", /^(Data Analyst|Account Executive)$/, "not_software_role"],
  ])("item 1: a pre-filter fixture for %s", (_form, pattern, result) => {
    const found = titled(pattern)
    expect(found.length).toBeGreaterThanOrEqual(1)
    for (const entry of found) expect(entry.preFilter).toBe(result)
  })

  it("item 1: a title that passes the pre-filter", () => {
    expect(snapshot().postings.filter((p) => p.preFilter === "pass").length).toBeGreaterThanOrEqual(1)
    expect(snapshot().postings.filter((p) => p.preFilter !== "pass").length).toBeGreaterThanOrEqual(8)
  })

  // A0 definition item 2 (golden-capture.feature :110, :150).
  it("item 2: every entry records the pre-filter result and the folded title, and the header names the base commit", () => {
    const { capturedOn, postings } = snapshot()
    expect(capturedOn).toMatch(/^main [0-9a-f]{7}\b/)
    for (const entry of postings) {
      expect(["pass", "not_software_role"]).toContain(entry.preFilter)
      expect(typeof entry.titleFolded).toBe("string")
    }
    expect(titled(/^React Native/).every((p) => p.titleFolded === p.title.toLowerCase())).toBe(true)
  })

  it("is byte-equal to the committed snapshot", () => {
    const current = buildOwnerSnapshot()
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(SNAPSHOT, current)
    expect(current).toBe(readFileSync(SNAPSHOT, "utf8"))
  })
})
