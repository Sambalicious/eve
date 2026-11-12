import { DEFAULT_ROLE_FAMILY_TIERS, type FamilyTier, type RoleFamilyValue, roleFamilySchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { TIER_HASH, tierMapHash } from "../posting-cursor.js"
import { decidePreferenceSkip, familyRule, keywordRule, rankTiersOf } from "./preference-rules.js"
import { TIER, rankPostings } from "./ranking.js"

/**
 * EPIC-0002 B1 (api-contract-b1 v1.25.0 "Evaluation order", "Skip reasons and
 * tabs"; architecture r4 "B: saved keyword as a skip rule", "B: rank under the
 * Candidate's tiers"): the pure rules over a Candidate's Job Preferences.
 */
const FAMILIES = roleFamilySchema.options
/** The Operator's migrated version 2 tiers (0018 nine keys + the four EPIC-0006 keys at 3, migration 0027). */
const OPERATOR_TIERS: Record<RoleFamilyValue, FamilyTier> = { ...DEFAULT_ROLE_FAMILY_TIERS }

describe("rankTiersOf: every one of the 13 catalog families", () => {
  it("covers exactly roleFamilySchema.options", () => {
    expect(Object.keys(rankTiersOf(OPERATOR_TIERS)).sort()).toEqual([...FAMILIES].sort())
  })

  it("the Operator's migrated tiers give the built TIER, so the Operator's ranking and cursor hash are unchanged", () => {
    expect(rankTiersOf(OPERATOR_TIERS)).toEqual(TIER)
    expect(tierMapHash(rankTiersOf(OPERATOR_TIERS))).toBe(TIER_HASH)
  })

  it.each(FAMILIES)("%s alone at tier 1 ranks above every other family", (family) => {
    const tiers = Object.fromEntries(FAMILIES.map((key) => [key, key === family ? 1 : 3])) as Record<RoleFamilyValue, FamilyTier>
    const rank = rankTiersOf(tiers)
    for (const other of FAMILIES) if (other !== family) expect(rank[family]).toBeLessThan(rank[other])
    const at = new Date("2026-10-20T09:00:00Z")
    const order = rankPostings(
      FAMILIES.map((key) => ({ id: key, family: key, coverage: 0.5, discoveredAt: at, fromEmployerBoard: false })),
      rank
    )
    expect(order[0]).toBe(family)
  })

  it("tiers 1, 2, 3 keep their order; an excluded family sorts after every tiered one", () => {
    const rank = rankTiersOf({ ...OPERATOR_TIERS, backend: 1, mobile: "excluded", other: 2 })
    expect(rank.backend).toBe(0)
    expect(rank.other).toBe(1)
    expect(rank.data_ml).toBe(2)
    expect(rank.mobile).toBe(3)
  })

  it("a different tier map has a different hash; the same map written in another key order has the same hash", () => {
    expect(tierMapHash(rankTiersOf({ ...OPERATOR_TIERS, backend: 1 }))).not.toBe(TIER_HASH)
    const reversed = Object.fromEntries(Object.entries(OPERATOR_TIERS).reverse()) as Record<RoleFamilyValue, FamilyTier>
    expect(tierMapHash(rankTiersOf(reversed))).toBe(TIER_HASH)
  })
})

describe("rankPostings under a Candidate's tiers (ranking follows each Candidate's own tiers)", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 9, minute))
  const rows = [
    { id: "frontend", family: "senior_frontend" as const, coverage: 0.8, discoveredAt: at(0), fromEmployerBoard: false },
    { id: "backend", family: "backend" as const, coverage: 0.8, discoveredAt: at(1), fromEmployerBoard: false },
  ]

  it("opposite tiers give opposite orders; the default argument is the built TIER", () => {
    expect(rankPostings(rows)).toEqual(["frontend", "backend"])
    expect(rankPostings(rows, rankTiersOf({ ...OPERATOR_TIERS, backend: 1, senior_frontend: 3 }))).toEqual(["backend", "frontend"])
  })

  it("within a tier, higher coverage first, then earlier discovery", () => {
    const tiers = rankTiersOf({ ...OPERATOR_TIERS, backend: 1, senior_frontend: 1 })
    expect(rankPostings([{ ...rows[0]!, coverage: 0.7 }, rows[1]!], tiers)).toEqual(["backend", "frontend"])
    expect(rankPostings(rows, tiers)).toEqual(["frontend", "backend"])
  })
})

describe("keywordRule: title only, literal substring after foldForKeywords", () => {
  it("no keyword, or one that folds to nothing, applies no rule", () => {
    expect(keywordRule(null, "senior vue engineer")).toBe("not_applicable")
    expect(keywordRule("\u200B", "senior vue engineer")).toBe("not_applicable")
    expect(keywordRule("\u200B\u200D", null)).toBe("not_applicable")
    expect(keywordRule("   ", null)).toBe("not_applicable")
  })

  it("an untitled posting (stored fold null) is a mismatch when a keyword is set", () => {
    expect(keywordRule("react", null)).toBe("mismatch")
  })

  it("matches the folded title case- and accent-insensitively; anything else is a mismatch", () => {
    expect(keywordRule("React", "senior react engineer")).toBe("passes")
    expect(keywordRule("Réact", "senior react engineer")).toBe("passes")
    expect(keywordRule("  REACT  ", "senior react engineer")).toBe("passes")
    expect(keywordRule("react", "senior vue engineer")).toBe("mismatch")
  })

  it("regex characters are literal: c++ matches c++, .* matches only .*", () => {
    expect(keywordRule("C++", "senior c++ engineer")).toBe("passes")
    expect(keywordRule(".*", "senior c++ engineer")).toBe("mismatch")
    expect(keywordRule("(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab")).toBe("mismatch")
  })

  it("TM ReDoS: a pathological keyword against a 100,000-character title answers in well under 50 ms", () => {
    const title = `${"a".repeat(100_000)}!`
    const started = performance.now()
    expect(keywordRule(`${"(a+)+".repeat(16)}$`.slice(0, 100), title)).toBe("mismatch")
    expect(keywordRule("a".repeat(99) + "b", title)).toBe("mismatch")
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe("familyRule and the order of steps 2 and 3", () => {
  const excludedMobile = { ...OPERATOR_TIERS, mobile: "excluded" as const }

  it("an excluded family is excluded; a tiered one passes; a null family is never excluded", () => {
    expect(familyRule(excludedMobile, "mobile")).toBe("excluded")
    expect(familyRule(excludedMobile, "backend")).toBe("passes")
    expect(familyRule({ ...OPERATOR_TIERS, other: "excluded" }, null)).toBe("passes")
  })

  it("family first, then keyword: excluded and mismatched is excluded_role_family", () => {
    const prefs = { roleFamilyTiers: excludedMobile, titleKeyword: "react" }
    expect(decidePreferenceSkip(prefs, { roleFamily: "mobile", titleFolded: "senior android engineer" })).toBe("excluded_role_family")
    expect(decidePreferenceSkip(prefs, { roleFamily: "backend", titleFolded: "senior go engineer" })).toBe("keyword_mismatch")
    expect(decidePreferenceSkip(prefs, { roleFamily: "senior_frontend", titleFolded: "senior react engineer" })).toBeNull()
  })

  it("no preferences record applies neither rule", () => {
    expect(decidePreferenceSkip(null, { roleFamily: "mobile", titleFolded: null })).toBeNull()
  })
})
