import { DEFAULT_ROLE_FAMILY_TIERS } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { type RedecideRow, redecideForSave, stepsTwoAndThree } from "./redecide.js"

/**
 * EPIC-0002 B1 unit 5 (architecture.r6 "Save and re-decision" step 4 in B1:
 * steps 2 and 3 only; job-criteria-in-preferences.feature :446 to :602).
 */
const TIERS = { ...DEFAULT_ROLE_FAMILY_TIERS }
const prefs = (over: Partial<{ titleKeyword: string | null; roleFamilyTiers: typeof TIERS }> = {}) => ({ titleKeyword: null, roleFamilyTiers: TIERS, ...over })
const row = (id: string, over: Partial<RedecideRow> = {}): RedecideRow => ({ id, status: "ranked", skipReason: null, roleFamily: "senior_frontend", titleFolded: "senior vue engineer", ...over })

describe("redecideForSave (B1: steps 2 and 3)", () => {
  it(":446 a keyword skips a ranked posting whose title lacks it", () => {
    expect(redecideForSave([row("vue")], prefs({ titleKeyword: "react" }))).toEqual([{ id: "vue", status: "skipped", skipReason: "keyword_mismatch", previousStatus: "ranked", previousReason: null }])
  })

  it(":455 an excluded family skips its ranked postings", () => {
    expect(redecideForSave([row("ios", { roleFamily: "mobile", titleFolded: "senior ios engineer" })], prefs({ roleFamilyTiers: { ...TIERS, mobile: "excluded" } }))).toEqual([
      { id: "ios", status: "skipped", skipReason: "excluded_role_family", previousStatus: "ranked", previousReason: null },
    ])
  })

  it(":463 and :586 an Eligibility exclusion is overridden by a family or keyword skip", () => {
    const excluded = row("android", { status: "excluded", skipReason: "violated_rule", roleFamily: "mobile", titleFolded: "senior android engineer" })
    expect(redecideForSave([excluded], prefs({ roleFamilyTiers: { ...TIERS, mobile: "excluded" } }))[0]).toMatchObject({ status: "skipped", skipReason: "excluded_role_family" })
    expect(redecideForSave([row("vue", { status: "excluded", skipReason: "violated_rule" })], prefs({ titleKeyword: "react" }))[0]).toMatchObject({ status: "skipped", skipReason: "keyword_mismatch" })
  })

  it(":469 clearing the keyword returns keyword mismatches to waiting", () => {
    const rows = [1, 2, 3, 4].map((n) => row(`m${n}`, { status: "skipped", skipReason: "keyword_mismatch" }))
    const changed = redecideForSave(rows, prefs())
    expect(changed).toHaveLength(4)
    for (const change of changed) expect(change).toMatchObject({ status: "waiting_to_be_checked", skipReason: null })
  })

  it(":477 un-excluding a family returns its postings to waiting", () => {
    const rows = [1, 2, 3].map((n) => row(`f${n}`, { status: "skipped", skipReason: "excluded_role_family", roleFamily: "mobile" }))
    expect(redecideForSave(rows, prefs({ roleFamilyTiers: { ...TIERS, mobile: 2 } })).map((c) => c.status)).toEqual(["waiting_to_be_checked", "waiting_to_be_checked", "waiting_to_be_checked"])
  })

  it(":484 changing the keyword skips new mismatches and returns old ones that now match; :493 an old mismatch missing the new keyword is unchanged", () => {
    const rows = [
      row("vue", { status: "skipped", skipReason: "keyword_mismatch", titleFolded: "senior vue engineer" }),
      row("react", { titleFolded: "react engineer" }),
      row("angular", { status: "skipped", skipReason: "keyword_mismatch", titleFolded: "senior angular engineer" }),
    ]
    expect(redecideForSave(rows, prefs({ titleKeyword: "vue" }))).toEqual([
      { id: "vue", status: "waiting_to_be_checked", skipReason: null, previousStatus: "skipped", previousReason: "keyword_mismatch" },
      { id: "react", status: "skipped", skipReason: "keyword_mismatch", previousStatus: "ranked", previousReason: null },
    ])
  })

  it("a keyword mismatch that now fails the family becomes excluded_role_family (step 2 first)", () => {
    const rows = [row("x", { status: "skipped", skipReason: "keyword_mismatch", roleFamily: "mobile" })]
    expect(redecideForSave(rows, prefs({ titleKeyword: "react", roleFamilyTiers: { ...TIERS, mobile: "excluded" } }))[0]).toMatchObject({ status: "skipped", skipReason: "excluded_role_family" })
  })

  it(":533/:541 Eligibility, Match and technology outcomes that pass both steps keep their row; untitled with a keyword is a mismatch", () => {
    const rows = [
      row("weak", { status: "skipped", skipReason: "weak_core_match", titleFolded: "react engineer" }),
      row("tech", { status: "skipped", skipReason: "technology_mismatch", titleFolded: "react engineer" }),
      row("pay", { status: "excluded", skipReason: "violated_rule", titleFolded: "react engineer" }),
      row("ranked", { titleFolded: "react engineer" }),
    ]
    expect(redecideForSave(rows, prefs({ titleKeyword: "react" }))).toEqual([])
    expect(redecideForSave([row("untitled", { titleFolded: null, roleFamily: null })], prefs({ titleKeyword: "react" }))[0]).toMatchObject({ skipReason: "keyword_mismatch" })
  })

  it(":573/:580 unchanged values or no rows change nothing", () => {
    expect(redecideForSave([row("a"), row("b", { status: "skipped", skipReason: "weak_core_match" })], prefs())).toEqual([])
    expect(redecideForSave([], prefs({ titleKeyword: "react" }))).toEqual([])
  })

  it("stepsTwoAndThree is the shared step (unit 7's criteria save reuses it)", () => {
    expect(stepsTwoAndThree(prefs({ titleKeyword: "react" }), { roleFamily: "backend", titleFolded: "go engineer" })).toBe("keyword_mismatch")
    expect(stepsTwoAndThree(prefs(), { roleFamily: "backend", titleFolded: "go engineer" })).toBeNull()
  })
})
