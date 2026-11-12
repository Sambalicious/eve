import { jobPostingCopy, roleFamilyLabel } from "./copy"

/**
 * Job Postings copy from copy-deck-slice-08-postings-paging-filter.r1.md, keyed
 * by its slot IDs: `postingsCopy.count.filteredPartial` is the deck's
 * `postings.count.filteredPartial`. Templates keep the deck's placeholders
 * (`{n}`, `{loaded}`, `{k}`, `{count}`, `{countLine}`); fill them with
 * `formatCopy`, which groups numbers the en-US way. `postings-copy.test.ts`
 * checks every slot against the deck.
 */
export const postingsCopy = {
  filterBar: { landmark: "Filter Job Postings" },
  search: {
    label: "Search job titles",
    placeholder: "e.g. React",
    clear: "Clear title search",
  },
  familyMenu: {
    trigger: "Role family",
    badgeCount: "{count}",
    triggerSelected: " selected",
    title: "Role family",
    close: "Close",
    groupLabel: "Show these role families",
    showAll: "Show all role families",
  },
  family: roleFamilyLabel,
  clearFilters: { button: "Clear filters" },
  count: {
    all: "{n} postings",
    allOne: "1 posting",
    partial: "Showing {loaded} of {n} postings",
    filteredAll: "{n} matching postings",
    filteredAllOne: "1 matching posting",
    filteredPartial: "Showing {loaded} of {n} matching postings",
  },
  rankHint: { filtered: "Ranks are positions in the full Ranked list, so they can skip numbers here." },
  loadMore: {
    idle: "Load more",
    busy: "Loading…",
    retry: "Try again",
    error: "Couldn't load more postings. The ones above are still here.",
  },
  announce: {
    viewSettled: "{countLine}",
    filterEmpty: "No postings match these filters",
    loadedMore: "{k} more postings loaded. Showing {loaded} of {n}.",
    loadedMoreOne: "1 more posting loaded. Showing {loaded} of {n}.",
    loadedAll: "{k} more postings loaded. All {n} are shown.",
    loadedAllOne: "1 more posting loaded. All {n} are shown.",
    nothingNew: "No new postings on that page. Load more to keep going.",
    loadFailed: "Couldn't load more postings. The ones above are still here.",
    restarted: "The list started over from the top. {countLine}.",
  },
  filterEmpty: {
    title: "No postings match these filters",
    text: "Try fewer words in the title search or more role families.",
    action: "Clear filters",
  },
  // Existing r4 slots this page renders.
  loadError: { alert: "Couldn't load this page.", retry: "Try again" },
  firstRun: jobPostingCopy.emptyFirstRun,
  rankedEmpty: jobPostingCopy.emptyRanked,
  list: { familyColumn: jobPostingCopy.roleFamilyLabel },
} as const

type CopyValue = number | string

/** Fills `{name}` placeholders; numbers get en-US grouping ("1,204"). */
export function formatCopy(template: string, values: Readonly<Record<string, CopyValue>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name]
    if (value === undefined) return whole
    return typeof value === "number" ? value.toLocaleString("en-US") : value
  })
}

export interface CountLineInput {
  /** `totalCount` of the latest page. */
  readonly total: number
  /** Rows on screen after dedupe. */
  readonly loaded: number
  /** `nextCursor` is set. Never decided by comparing `loaded` with `total`. */
  readonly hasMore: boolean
  /** `families` or `keyword` is set. */
  readonly filtered: boolean
}

/** The `postings.count.*` slot for the view, filled in. */
export function countLine({ total, loaded, hasMore, filtered }: CountLineInput): string {
  const { count } = postingsCopy
  if (hasMore) return formatCopy(filtered ? count.filteredPartial : count.partial, { loaded, n: total })
  if (total === 1) return filtered ? count.filteredAllOne : count.allOne
  return formatCopy(filtered ? count.filteredAll : count.all, { n: total })
}

/** `postings.announce.loadedMore*` or `loadedAll*` after a Load more that added `added` rows (at least 1). */
export function loadedAnnouncement({ added, loaded, total, hasMore }: {
  added: number
  loaded: number
  total: number
  hasMore: boolean
}): string {
  const { announce } = postingsCopy
  const template = hasMore
    ? added === 1 ? announce.loadedMoreOne : announce.loadedMore
    : added === 1 ? announce.loadedAllOne : announce.loadedAll
  return formatCopy(template, { k: added, loaded, n: total })
}
