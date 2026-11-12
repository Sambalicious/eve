/**
 * Independent oracle for EPIC-0007 Phase 1 hiring links, written from
 * api-contract.md "Query construction (exact)" and hiring-search-links.feature
 * r2. It deliberately does not import @eve/contracts: a wrong phrase, order,
 * group size or encoding in the product builder fails the test instead of
 * being copied into the expectation. The AC 3.4 worked example is also pinned
 * as literal strings (AC34_*), so the oracle itself is anchored to the contract.
 */

export const LINKEDIN_BASE = "https://www.linkedin.com/search/results/content/"
export const GOOGLE_BASE = "https://www.google.com/search"
export const GOOGLE_ALERTS = "https://www.google.com/alerts"

/** D4 / SA-1: hiring groups hold 4 terms. Stack posts (EPIC-0005) keep 8. */
export const HIRING_GROUP = 4
export const STACK_GROUP = 8

export const HIRING_PHRASES = ["we're hiring", "we are hiring", "now hiring", "join our team"] as const

/** EPIC-0006 catalog (display) order, with the EPIC-0006 display labels. */
export const FAMILIES = [
  ["senior_frontend", "Frontend"],
  ["technical_lead", "Hands-on technical lead"],
  ["fullstack", "Fullstack"],
  ["product_engineering", "Product engineering"],
  ["software_engineering", "Software engineering"],
  ["backend", "Backend"],
  ["mobile", "Mobile"],
  ["platform_engineering", "Platform engineering"],
  ["devops_platform", "DevOps and SRE"],
  ["people_management", "Engineering management"],
  ["data_ml", "Data and ML"],
  ["solutions_customer", "Solutions and customer engineering"],
  ["other", "Other"],
] as const

export type Family = (typeof FAMILIES)[number][0]
export const FAMILY_KEYS: readonly Family[] = FAMILIES.map(([key]) => key)
export const familyLabel = (family: Family): string => FAMILIES.find(([key]) => key === family)![1]

/** AC 2.1, fixed. */
export const ROLE_PHRASES: Readonly<Record<Family, readonly string[]>> = {
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
}

export type HintPrefs = Readonly<{ remoteAccepted: boolean; relocationAccepted: boolean; sponsorshipNeededForRelocation: boolean }>
export type HintTerm = "remote" | "relocation" | "visa sponsorship"

/** AC 2.5. `null` = no Job Preferences row. */
export function hintTerms(prefs: HintPrefs | null): HintTerm[] {
  if (!prefs) return []
  const terms: HintTerm[] = []
  if (prefs.remoteAccepted) terms.push("remote")
  if (prefs.relocationAccepted) terms.push("relocation")
  if (prefs.relocationAccepted && prefs.sponsorshipNeededForRelocation) terms.push("visa sponsorship")
  return terms
}

/** AC 2.2: target families with phrases, catalog order. */
export function hiringFamilies(targets: readonly Family[]): Family[] {
  return FAMILY_KEYS.filter((family) => targets.includes(family) && ROLE_PHRASES[family].length > 0)
}

export const clause = (list: readonly string[]): string => (list.length === 0 ? "" : `(${list.map((t) => `"${t}"`).join(" OR ")})`)
export const HIRING_CLAUSE = clause(HIRING_PHRASES)

/** Contract decision C-1: encodeURIComponent plus ' → %27. */
export const enc = (value: string): string => encodeURIComponent(value).replace(/'/g, "%27")

export type ExpectedGroup = Readonly<{
  label: string
  terms: readonly string[]
  linkedinExpression: string
  googleExpression: string
  alertsQuery: string
  linkedin: string
  google: string
}>

export function expectedHiringGroups(input: { family: Family; frameworks: readonly string[]; technologies: readonly string[]; hints: readonly HintTerm[] }): ExpectedGroup[] {
  const phrases = ROLE_PHRASES[input.family]
  if (phrases.length === 0) return []
  const terms = [...input.frameworks, ...input.technologies]
  const chunks: string[][] = []
  if (terms.length === 0) chunks.push([])
  for (let i = 0; i < terms.length; i += HIRING_GROUP) chunks.push(terms.slice(i, i + HIRING_GROUP))
  return chunks.map((chunk) => {
    const clauses = [HIRING_CLAUSE, clause(phrases), clause(chunk), clause(input.hints)].filter(Boolean)
    const linkedinExpression = clauses.join(" AND ")
    const googleExpression = clauses.join(" ")
    const alertsQuery = `site:linkedin.com/posts ${googleExpression}`
    return {
      label: chunk.join(", "),
      terms: chunk,
      linkedinExpression,
      googleExpression,
      alertsQuery,
      linkedin: `${LINKEDIN_BASE}?keywords=${enc(linkedinExpression)}&sortBy=${enc('"date_posted"')}&datePosted=${enc('"past-week"')}`,
      google: `${GOOGLE_BASE}?q=${enc(alertsQuery)}&tbs=${enc("qdr:w")}`,
    }
  })
}

/** EPIC-0005 Stack posts links, byte for byte as built before EPIC-0007 (AC 3.1 regression oracle). */
export function expectedStackGroups(frameworks: readonly string[], technologies: readonly string[]) {
  const terms = [...frameworks, ...technologies]
  const groups = []
  const q = (params: [string, string][]) => params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
  for (let i = 0; i < terms.length; i += STACK_GROUP) {
    const chunk = terms.slice(i, i + STACK_GROUP)
    const expression = `(${chunk.map((t) => `"${t}"`).join(" OR ")})`
    const posts = `site:linkedin.com/posts ${expression} -hiring -job`
    const articles = `site:linkedin.com/pulse ${expression} -hiring -job`
    groups.push({
      label: chunk.join(", "),
      linkedin: `${LINKEDIN_BASE}?${q([["keywords", `${expression} NOT hiring`], ["sortBy", '"date_posted"'], ["datePosted", '"past-week"']])}`,
      googlePosts: `${GOOGLE_BASE}?${q([["q", posts], ["tbs", "qdr:w"]])}`,
      googleArticles: `${GOOGLE_BASE}?${q([["q", articles], ["tbs", "qdr:w"]])}`,
      alertsPostsQuery: posts,
      alertsArticlesQuery: articles,
    })
  }
  return groups
}

/** Raw (still encoded) query parameter values, in order, without URLSearchParams' "+" → space rule. */
export function rawParams(href: string): [string, string][] {
  const query = href.slice(href.indexOf("?") + 1)
  return query.split("&").map((pair) => {
    const at = pair.indexOf("=")
    return [pair.slice(0, at), pair.slice(at + 1)]
  })
}

export function decodedParam(href: string, name: string): string | undefined {
  const raw = rawParams(href).find(([key]) => key === name)?.[1]
  return raw === undefined ? undefined : decodeURIComponent(raw)
}

export function rawParam(href: string, name: string): string | undefined {
  return rawParams(href).find(([key]) => key === name)?.[1]
}

/** AC 3.4 worked example, pasted from api-contract.md (Frontend, React, TypeScript, all three hints). */
export const AC34_KEYWORDS =
  '("we\'re hiring" OR "we are hiring" OR "now hiring" OR "join our team") AND ("frontend engineer" OR "frontend developer" OR "front-end engineer") AND ("React" OR "TypeScript") AND ("remote" OR "relocation" OR "visa sponsorship")'
export const AC34_LINKEDIN =
  "https://www.linkedin.com/search/results/content/?keywords=(%22we%27re%20hiring%22%20OR%20%22we%20are%20hiring%22%20OR%20%22now%20hiring%22%20OR%20%22join%20our%20team%22)%20AND%20(%22frontend%20engineer%22%20OR%20%22frontend%20developer%22%20OR%20%22front-end%20engineer%22)%20AND%20(%22React%22%20OR%20%22TypeScript%22)%20AND%20(%22remote%22%20OR%20%22relocation%22%20OR%20%22visa%20sponsorship%22)&sortBy=%22date_posted%22&datePosted=%22past-week%22"
export const AC34_GOOGLE =
  "https://www.google.com/search?q=site%3Alinkedin.com%2Fposts%20(%22we%27re%20hiring%22%20OR%20%22we%20are%20hiring%22%20OR%20%22now%20hiring%22%20OR%20%22join%20our%20team%22)%20(%22frontend%20engineer%22%20OR%20%22frontend%20developer%22%20OR%20%22front-end%20engineer%22)%20(%22React%22%20OR%20%22TypeScript%22)%20(%22remote%22%20OR%20%22relocation%22%20OR%20%22visa%20sponsorship%22)&tbs=qdr%3Aw"
export const AC34_ALERTS =
  'site:linkedin.com/posts ("we\'re hiring" OR "we are hiring" OR "now hiring" OR "join our team") ("frontend engineer" OR "frontend developer" OR "front-end engineer") ("React" OR "TypeScript") ("remote" OR "relocation" OR "visa sponsorship")'

export const ALL_HINTS: HintPrefs = { remoteAccepted: true, relocationAccepted: true, sponsorshipNeededForRelocation: true }

/** `n` distinct Job criteria terms "<prefix>1".."<prefix>n", valid under JOB_CRITERIA_ENTRY_PATTERN. */
export const terms = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)
