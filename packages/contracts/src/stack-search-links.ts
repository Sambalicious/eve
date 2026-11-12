import { z } from "zod"

import { type RoleFamilyValue, roleFamilySchema } from "./discovery.js"

/**
 * EPIC-0005 AC 2.1-2.6: search links and Google Alerts query strings built from
 * the saved Job criteria. Pure: no request, no write. The web page and the
 * daily summary email both call this one function, so their links are equal.
 *
 * v1.19.0 (EPIC-0007 Phase 1): hiring search links, `buildHiringSearchGroups`.
 * ADR 0012 / SEC P1-3: this file makes no network request; the contracts
 * ESLint config forbids `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
 * `node:http`, `node:https` and `undici` here.
 */
export const STACK_SEARCH_GROUP_SIZE = 8

export const LINKEDIN_CONTENT_SEARCH_BASE = "https://www.linkedin.com/search/results/content/"
export const GOOGLE_SEARCH_BASE = "https://www.google.com/search"
export const GOOGLE_ALERTS_URL = "https://www.google.com/alerts"

export type StackSearchGroup = Readonly<{
  /** Terms joined with ", " (AC 2.2). */
  label: string
  terms: readonly string[]
  /** `("A" OR "B")` (AC 2.3). */
  expression: string
  /** AC 2.4: keywords = expression + " NOT hiring", sortBy "date_posted", datePosted "past-week", each percent-encoded. */
  linkedin: string
  /** AC 2.5: q = alertsPostsQuery, tbs = qdr:w. */
  googlePosts: string
  /** AC 2.5: q = alertsArticlesQuery, tbs = qdr:w. */
  googleArticles: string
  /** AC 2.6, unencoded: `site:linkedin.com/posts ("A" OR "B") -hiring -job`. */
  alertsPostsQuery: string
  /** AC 2.6, unencoded: `site:linkedin.com/pulse ("A" OR "B") -hiring -job`. */
  alertsArticlesQuery: string
}>

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")
}

function group(terms: readonly string[]): StackSearchGroup {
  // EPIC-0004 AC 3.1 forbids `"` in an entry, so no quote escaping is needed (AC 2.3).
  const expression = `(${terms.map((term) => `"${term}"`).join(" OR ")})`
  const alertsPostsQuery = `site:linkedin.com/posts ${expression} -hiring -job`
  const alertsArticlesQuery = `site:linkedin.com/pulse ${expression} -hiring -job`
  return {
    label: terms.join(", "),
    terms,
    expression,
    linkedin: `${LINKEDIN_CONTENT_SEARCH_BASE}?${query([
      ["keywords", `${expression} NOT hiring`],
      ["sortBy", '"date_posted"'],
      ["datePosted", '"past-week"'],
    ])}`,
    googlePosts: `${GOOGLE_SEARCH_BASE}?${query([["q", alertsPostsQuery], ["tbs", "qdr:w"]])}`,
    googleArticles: `${GOOGLE_SEARCH_BASE}?${query([["q", alertsArticlesQuery], ["tbs", "qdr:w"]])}`,
    alertsPostsQuery,
    alertsArticlesQuery,
  }
}

/**
 * Frameworks then Technologies, in saved order and entered form, in groups of 8
 * (AC 2.1, 2.2). Empty input gives `[]`, which is the AC 2.9 empty state.
 */
export function buildStackSearchGroups(frameworks: readonly string[], technologies: readonly string[]): StackSearchGroup[] {
  const terms = [...frameworks, ...technologies]
  const groups: StackSearchGroup[] = []
  for (let start = 0; start < terms.length; start += STACK_SEARCH_GROUP_SIZE) {
    groups.push(group(terms.slice(start, start + STACK_SEARCH_GROUP_SIZE)))
  }
  return groups
}

// ── EPIC-0007 Phase 1: hiring search links (contract v1.19.0) ──────────────

/** D4: groups of 4 technologies for hiring links. Practitioner links keep STACK_SEARCH_GROUP_SIZE = 8. */
export const HIRING_SEARCH_GROUP_SIZE = 4

/** AC 2.4, fixed order. Straight apostrophe. */
export const HIRING_PHRASES = ["we're hiring", "we are hiring", "now hiring", "join our team"] as const

/** AC 2.1. Shared, fixed, not editable. No phrase contains `"` or a seniority word. */
export const ROLE_FAMILY_HIRING_PHRASES: Readonly<Record<RoleFamilyValue, readonly string[]>> = Object.freeze({
  senior_frontend: ["frontend engineer", "frontend developer", "front-end engineer"],
  technical_lead: ["tech lead", "technical lead", "lead engineer"],
  fullstack: ["full stack engineer", "fullstack engineer", "full-stack developer"],
  product_engineering: ["product engineer"],
  software_engineering: ["software engineer", "software developer"],
  backend: ["backend engineer", "backend developer", "back-end engineer"],
  mobile: ["mobile engineer", "iOS engineer", "Android engineer"],
  platform_engineering: ["platform engineer"],
  devops_platform: ["DevOps engineer", "site reliability engineer", "SRE"],
  people_management: ["engineering manager", "head of engineering"],
  data_ml: ["data engineer", "machine learning engineer", "ML engineer"],
  solutions_customer: ["solutions architect", "customer architect"],
  other: [],
})

/** AC 2.5: the only hint terms, in this order. */
export const hiringHintTermSchema = z.enum(["remote", "relocation", "visa sponsorship"])
export type HiringHintTerm = z.infer<typeof hiringHintTermSchema>

/** The three Job Preferences booleans Phase 1 reads (architecture r1, SA-4). */
export type HiringHintPreferences = Readonly<{
  remoteAccepted: boolean
  relocationAccepted: boolean
  sponsorshipNeededForRelocation: boolean
}>

/**
 * AC 2.5. `null` (no Job Preferences row, or an unreadable one) gives [].
 * "remote" if remoteAccepted; "relocation" if relocationAccepted;
 * "visa sponsorship" if relocationAccepted && sponsorshipNeededForRelocation.
 */
export function hiringHintTerms(prefs: HiringHintPreferences | null): HiringHintTerm[] {
  if (prefs === null) return []
  const terms: HiringHintTerm[] = []
  if (prefs.remoteAccepted) terms.push("remote")
  if (prefs.relocationAccepted) terms.push("relocation")
  if (prefs.relocationAccepted && prefs.sponsorshipNeededForRelocation) terms.push("visa sponsorship")
  return terms
}

/** AC 2.2: the targets that have at least one phrase, in roleFamilySchema (catalog) order, unique. */
export function hiringFamilies(targets: readonly RoleFamilyValue[]): RoleFamilyValue[] {
  return roleFamilySchema.options.filter((family) => targets.includes(family) && ROLE_FAMILY_HIRING_PHRASES[family].length > 0)
}

/**
 * AC 2.2, 3.7: `requested` if it is in hiringFamilies(targets); else the first of
 * hiringFamilies(targets); else null (the no-family empty state). `requested` is the
 * raw `?family=` value; anything that is not a valid key falls back (SEC P1-5:
 * compared by equality against the allowed list, never used as an object key).
 */
export function resolveHiringFamily(targets: readonly RoleFamilyValue[], requested: string | null | undefined): RoleFamilyValue | null {
  const families = hiringFamilies(targets)
  return families.find((family) => family === requested) ?? families[0] ?? null
}

export type HiringSearchInput = Readonly<{
  family: RoleFamilyValue
  frameworks: readonly string[]
  technologies: readonly string[]
  hintTerms: readonly HiringHintTerm[]
}>

export type HiringSearchGroup = Readonly<{
  /** Technology terms joined with ", ". "" for the any-technology group (the UI shows C-HP-GROUP-ANY). */
  label: string
  /** This group's technology terms, entered form, saved order. [] for the any-technology group. */
  terms: readonly string[]
  /** Clauses joined with " AND " (AC 3.2). */
  linkedinExpression: string
  /** Clauses joined with " " (AC 3.2). */
  googleExpression: string
  /** AC 3.4. */
  linkedin: string
  /** AC 3.5. */
  google: string
  /** AC 3.6, unencoded: `site:linkedin.com/posts ` + googleExpression. Equal to the decoded `q` of `google`. */
  alertsQuery: string
}>

/**
 * SEC-E7-04 / threat model P1-2: the builder does not trust upstream validation.
 * Every `"` is removed from a term before quoting, and a term left blank is
 * dropped, so no term can close its quoted phrase and add search operators.
 * SEC-P1-02: control characters (`\p{Cc}`: C0, DEL, C1) and the line and
 * paragraph separators U+2028/U+2029 are removed too, so a term cannot break
 * a line in the label, the expressions or the plain-text email.
 */
const STRIPPED_FROM_TERMS = /["\p{Cc}\u2028\u2029]/gu

function unquoted(terms: readonly string[]): string[] {
  return terms.map((term) => term.replace(STRIPPED_FROM_TERMS, "")).filter((term) => term.trim() !== "")
}

/** `("a" OR "b")`, or null for an empty list (the clause is left out). */
function clause(list: readonly string[]): string | null {
  return list.length === 0 ? null : `(${list.map((term) => `"${term}"`).join(" OR ")})`
}

/** Decision C-1: `encodeURIComponent` plus `'` as `%27`, so the raw values carry no literal apostrophe. */
function hiringQuery(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/'/g, "%27")}`).join("&")
}

function hiringGroup(chunk: readonly string[], fixed: Readonly<{ hiring: string | null; role: string | null; hints: string | null }>): HiringSearchGroup {
  const clauses = [fixed.hiring, fixed.role, clause(chunk), fixed.hints].filter((part): part is string => part !== null)
  const linkedinExpression = clauses.join(" AND ")
  const googleExpression = clauses.join(" ")
  const alertsQuery = `site:linkedin.com/posts ${googleExpression}`
  return {
    label: chunk.join(", "),
    terms: chunk,
    linkedinExpression,
    googleExpression,
    linkedin: `${LINKEDIN_CONTENT_SEARCH_BASE}?${hiringQuery([
      ["keywords", linkedinExpression],
      ["sortBy", '"date_posted"'],
      ["datePosted", '"past-week"'],
    ])}`,
    google: `${GOOGLE_SEARCH_BASE}?${hiringQuery([["q", alertsQuery], ["tbs", "qdr:w"]])}`,
    alertsQuery,
  }
}

/**
 * Pure. No I/O, no AI, no write. The Hiring view and the daily summary both call
 * it (AC 3.1). Frameworks then Technologies, saved order, entered form, no
 * dedupe, in groups of HIRING_SEARCH_GROUP_SIZE; no terms give exactly one
 * any-technology group (AC 3.3). Clauses: hiring, role, technology, hint (AC 3.2).
 * A family with no phrases (`other`) gives [].
 */
export function buildHiringSearchGroups(input: HiringSearchInput): HiringSearchGroup[] {
  // Own keys only, so a runtime value such as "__proto__" cannot reach an inherited property.
  const phrases = Object.hasOwn(ROLE_FAMILY_HIRING_PHRASES, input.family) ? unquoted(ROLE_FAMILY_HIRING_PHRASES[input.family]) : []
  if (phrases.length === 0) return []
  const fixed = { hiring: clause(unquoted(HIRING_PHRASES)), role: clause(phrases), hints: clause(unquoted(input.hintTerms)) }
  const terms = unquoted([...input.frameworks, ...input.technologies])
  if (terms.length === 0) return [hiringGroup([], fixed)]
  const groups: HiringSearchGroup[] = []
  for (let start = 0; start < terms.length; start += HIRING_SEARCH_GROUP_SIZE) {
    groups.push(hiringGroup(terms.slice(start, start + HIRING_SEARCH_GROUP_SIZE), fixed))
  }
  return groups
}
