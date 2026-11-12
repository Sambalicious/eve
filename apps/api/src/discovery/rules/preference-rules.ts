import { type FamilyTier, type PreferencesValues, type RoleFamilyValue, foldForKeywords, keywordFoldsToEmpty, roleFamilySchema } from "@eve/contracts"

import type { RoleFamily } from "./ranking.js"

/**
 * EPIC-0002 B1: the evaluation steps that read a Candidate's Job Preferences
 * and need no AI call (api-contract-b1 v1.25.0 "Evaluation order", R6-2):
 * step 2 the excluded role family, step 3 the saved title keyword. Pure, so
 * the evaluator and (unit 5) the save's re-decision apply the same rules.
 */

/** The part of the preferences these steps read. */
export type PreferenceSkipInput = Readonly<Pick<PreferencesValues, "roleFamilyTiers" | "titleKeyword">>

export type PreferenceSkipReason = "excluded_role_family" | "keyword_mismatch"

/**
 * Sort keys for `tierSql` and `rankPostings`: tier 1 is 0, 2 is 1, 3 is 2, and
 * `excluded` 3, after every tiered family (a ranked row of an excluded family
 * exists only until the save re-decides it). The Operator's migrated tiers
 * (1, 1, 2, 2, then 3) give exactly the built `TIER`, so their ranking and
 * cursor hash are unchanged.
 */
export function rankTiersOf(tiers: Readonly<Record<RoleFamilyValue, FamilyTier>>): Readonly<Record<RoleFamily, number>> {
  return Object.fromEntries(roleFamilySchema.options.map((family) => [family, sortKeyOf(tiers[family])])) as Record<RoleFamily, number>
}

function sortKeyOf(tier: FamilyTier | undefined): number {
  return tier === 1 ? 0 : tier === 2 ? 1 : tier === 3 ? 2 : 3
}

/** Step 2. A posting with no stored family (untitled, not yet classified) is never excluded for its family. */
export function familyRule(tiers: Readonly<Record<RoleFamilyValue, FamilyTier>>, family: string | null): "excluded" | "passes" {
  return family !== null && tiers[family as RoleFamilyValue] === "excluded" ? "excluded" : "passes"
}

/**
 * Step 3, over the title only (r4 D15): the stored `title_folded` must contain
 * the folded keyword as a literal substring. No regular expression is built
 * from the keyword (threat model: ReDoS), so the cost is one linear
 * `String.includes`. No keyword, or one that folds to nothing (zero-width,
 * combining marks only), applies no rule. An untitled posting (null fold) is a
 * mismatch when a keyword is set.
 */
export function keywordRule(titleKeyword: string | null, titleFolded: string | null): "not_applicable" | "passes" | "mismatch" {
  if (titleKeyword === null || keywordFoldsToEmpty(titleKeyword)) return "not_applicable"
  if (titleFolded === null) return "mismatch"
  return titleFolded.includes(foldForKeywords(titleKeyword.trim())) ? "passes" : "mismatch"
}

/** Steps 2 then 3, first match wins: excluded and mismatched is `excluded_role_family`. Null preferences apply neither. */
export function decidePreferenceSkip(
  preferences: PreferenceSkipInput | null,
  posting: Readonly<{ roleFamily: string | null; titleFolded: string | null }>
): PreferenceSkipReason | null {
  if (preferences === null) return null
  if (familyRule(preferences.roleFamilyTiers, posting.roleFamily) === "excluded") return "excluded_role_family"
  if (keywordRule(preferences.titleKeyword, posting.titleFolded) === "mismatch") return "keyword_mismatch"
  return null
}
