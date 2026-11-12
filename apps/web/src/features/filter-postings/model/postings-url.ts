import { keywordFoldsToEmpty, postingKeywordSchema } from "@eve/contracts"

import { ROLE_FAMILIES, type PostingFilter, type PostingsTab, type RoleFamily } from "@/entities/job-posting"

/** The tabs the page shows (AC-4.5). The API tabs behind them are unchanged: Good matches is `ranked`, Not a match is `skipped` plus `excluded_family`. */
export type PostingsWebTab = "good" | "manual" | "not_a_match" | "all"
export const POSTINGS_TABS: readonly PostingsWebTab[] = ["good", "manual", "not_a_match", "all"]

/** Old URL values map onto the new ones; `excluded_family` also scrolls to its section. */
const LEGACY_TABS: Readonly<Record<string, PostingsWebTab>> = { ranked: "good", skipped: "not_a_match", excluded_family: "not_a_match" }

/** Where each web tab reads from. Not a match reads `skipped` first, then `excluded_family`. */
export const API_TABS: Readonly<Record<PostingsWebTab, readonly PostingsTab[]>> = {
  good: ["ranked"],
  manual: ["manual"],
  not_a_match: ["skipped", "excluded_family"],
  all: ["all"],
}

export interface PostingsView {
  /** Good matches when the URL has none or an unknown one. */
  readonly tab: PostingsWebTab
  /** The URL used the old `excluded_family` value: scroll to that section. */
  readonly legacyExcluded: boolean
  /** Whether the URL named a valid tab; `/postings` stays without one. */
  readonly hasTab: boolean
  readonly filter: PostingFilter
}

/**
 * Reads the tab and the Posting filter from `/postings` search params (8W.3,
 * 8W.6). Invalid values are dropped without an error: unknown, wrong-case or
 * empty family items, a keyword the API would refuse (`postingKeywordSchema`,
 * v1.12.1: over 100 characters after trimming, or a non-whitespace control character),
 * and a keyword that folds to empty (`keywordFoldsToEmpty`, v1.13.1: only zero-width,
 * format or combining characters), which the API treats as no keyword.
 */
export function readPostingsView(params: URLSearchParams): PostingsView {
  const rawTab = params.get("tab")
  const tab = POSTINGS_TABS.find((value) => value === rawTab) ?? (rawTab === null ? undefined : LEGACY_TABS[rawTab])
  return { tab: tab ?? "good", legacyExcluded: rawTab === "excluded_family", hasTab: tab !== undefined, filter: readFilter(params) }
}

function readFilter(params: URLSearchParams): PostingFilter {
  const items = new Set((params.get("families") ?? "").split(","))
  const families = ROLE_FAMILIES.filter((family) => items.has(family))
  const parsed = postingKeywordSchema.safeParse(params.get("keyword") ?? "")
  const keyword = parsed.success ? toKeyword(parsed.data) : null
  return { families, keyword }
}

/** The keyword in force for typed or read text: trimmed, or null when it folds to empty (8d.15). */
export function toKeyword(text: string): string | null {
  const trimmed = text.trim()
  return keywordFoldsToEmpty(trimmed) ? null : trimmed
}

/**
 * The search string (no "?") in the order tab, families, keyword, families in
 * Role Preference order and joined by a literal comma, as the API spells them
 * (`tab=good&families=backend,mobile&keyword=react`).
 */
export function postingsSearch(view: { tab: PostingsWebTab | null; filter: PostingFilter }): string {
  const parts: string[] = []
  if (view.tab !== null) parts.push(`tab=${view.tab}`)
  const families = ROLE_FAMILIES.filter((family: RoleFamily) => view.filter.families.includes(family))
  if (families.length > 0) parts.push(`families=${families.join(",")}`)
  const keyword = toKeyword(view.filter.keyword ?? "")
  if (keyword !== null) parts.push(`keyword=${encodeURIComponent(keyword)}`)
  return parts.join("&")
}

export const NO_FILTER: PostingFilter = { families: [], keyword: null }
