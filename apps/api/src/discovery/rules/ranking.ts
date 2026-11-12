import type { RoleFamilyValue } from "@eve/contracts"

import { foldForKeywords } from "./rule-result.js"

/**
 * Role families for Role Preference (AC 4.11, 4.12). Families in the first tier
 * rank above the second. `people_management`, `other` and (slice 8, 8R.2)
 * `backend`, `mobile` and `devops_platform` are ranked last, never excluded
 * for their family. EPIC-0006 (AC-1.1, AC-1.4) adds `software_engineering`,
 * `platform_engineering`, `data_ml` and `solutions_customer`, all in the last
 * tier, and narrows `devops_platform` (platform engineering moves out).
 */
export type RoleFamily = RoleFamilyValue

/** The one tier table. SQL ordering (job-postings-query.ts) is generated from it, so the two cannot drift. */
export const TIER: Readonly<Record<RoleFamily, number>> = {
  senior_frontend: 0,
  technical_lead: 0,
  fullstack: 1,
  product_engineering: 1,
  software_engineering: 2,
  backend: 2,
  mobile: 2,
  platform_engineering: 2,
  devops_platform: 2,
  people_management: 2,
  data_ml: 2,
  solutions_customer: 2,
  other: 2,
}

const words = (list: readonly string[]) => new RegExp(`\\b(${list.join("|")})\\b`)

// EPIC-0006 (AC-1.3, P9): decided first, from the title only, before the management and lead rules.
const SOLUTIONS_CUSTOMER = words([
  "solutions? architect(ure)?", "sales architect", "pre-?sales architect", "customer architect",
  "technical account manag(er|ement)", "tam", "solutions? engineer(ing)?", "customer engineer(ing)?",
])
const DATA_ML = words([
  "data engineer(ing)?", "data scien(ce|tist)", "data analyst", "analytics engineer", "machine learning", "ml", "mlops",
  "ai engineer", "ai/ml", "ai ml", "deep learning", "applied scientist", "business intelligence", "bi engineer",
])
const MANAGEMENT_TITLE = /\b(engineering manager|manager,? engineering|head of engineering|director|vp|vice president|people manager)\b/
const MANAGEMENT_DUTIES = /\b(hiring|performance reviews?|line management|people management|direct reports|career development of)\b/
const HANDS_ON = /\b(code|coding|hands-on|hands on|build|implement|write|ship|react|typescript|frontend|front-end)\b/
const LEAD = /\b(tech(nical)? lead|lead engineer|lead developer|team lead|engineering lead|lead (frontend|front-end|software))\b/
const FRONTEND = /\b(frontend|front-end|front end|ui engineer|web engineer|react)\b/
const FULLSTACK = /\b(full[- ]?stack)\b/
const PRODUCT = /\b(product engineer(ing)?)\b/
// Slice 8 (8R.5): title words for the new families, whole words after folding.
const MOBILE = /\b(ios|android|mobile|flutter|swiftui|react native|xamarin|kotlin multiplatform)\b/
const BACKEND = /\b(backend|back-end|back end|server-side|server side)\b/
// EPIC-0006 (P8): platform engineering titles leave the DevOps list. "platform reliability" is a Gherkin r4 fixture
// (role-family-catalog: "Platform Reliability Engineer" is platform_engineering, ahead of DevOps' "reliability engineer").
const PLATFORM_ENGINEERING = words(["platform engineer(ing)?", "platform reliability"])
const DEVOPS_PLATFORM = words([
  "devops", "dev ops", "site reliability", "sre", "reliability engineer", "infrastructure", "infra engineer", "cloud engineer", "cloud infrastructure",
])
/** Engineering titles that are not software engineering (AC-1.3: "QA Automation Engineer" is other). */
const NOT_SOFTWARE_ENGINEERING = words([
  "qa", "quality assurance", "sdet", "in test", "test engineer", "test automation", "developer relations", "developer advocate", "devrel",
])
/** Generic software titles, plus the pre-filter's 8D developer words (French, Spanish, Portuguese, German). */
const SOFTWARE_ENGINEERING = words([
  "software", "developer", "programmer", "sde", "staff engineer", "principal engineer", "member of technical staff", "mts",
  "developpeur", "developpeuse", "programmeur", "programmeuse",
  // The 8e inclusive forms the pre-filter passes: Ingénieur(e), Ingénieur·e, Ingénieur-e, Ingénieure.
  "ingenieur(?:\\(e\\)|\u00b7e|-e|e)? (?:logiciel|developpement)",
  "desarrollador", "desarrolladora", "programador", "programadora", "ingenier[oa] de software",
  "desenvolvedor", "desenvolvedora", "engenheir[oa] de software",
  "entwickler", "entwicklerin", "softwareentwickler", "softwareentwicklerin", "webentwickler", "webentwicklerin",
  "anwendungsentwickler", "anwendungsentwicklerin", "programmierer", "programmiererin", "softwareingenieur", "softwareingenieurin",
])

/**
 * Classifies by title first, then core responsibilities. Manager roles without
 * hands-on work are never "technical lead". Order (EPIC-0006 AC-1.3):
 * solutions and customer, data and ML (title only), then the slice 8 rules in
 * their order (management, lead, fullstack, product, frontend, mobile,
 * backend), then platform engineering, DevOps and SRE, the non-software
 * engineering titles (other), software engineering, and other. Duties decide
 * only between management and lead; no other family reads them.
 */
export function classifyRoleFamily(title: string, coreResponsibilities: readonly string[]): RoleFamily {
  const folded = foldForKeywords(title)
  if (SOLUTIONS_CUSTOMER.test(folded)) return "solutions_customer"
  if (DATA_ML.test(folded)) return "data_ml"
  const duties = foldForKeywords(coreResponsibilities.join(". "))
  const managing = MANAGEMENT_TITLE.test(folded) || (MANAGEMENT_DUTIES.test(duties) && !HANDS_ON.test(duties))
  if (managing && !LEAD.test(folded)) return "people_management"
  if (LEAD.test(folded)) return MANAGEMENT_DUTIES.test(duties) && !HANDS_ON.test(duties) ? "people_management" : "technical_lead"
  if (FULLSTACK.test(folded)) return "fullstack"
  if (PRODUCT.test(folded)) return "product_engineering"
  // Every frontend IC title ranks in the first tier; the Candidate targets senior roles but a plain title is not excluded.
  if (FRONTEND.test(folded)) return "senior_frontend"
  if (MOBILE.test(folded)) return "mobile"
  if (BACKEND.test(folded)) return "backend"
  if (PLATFORM_ENGINEERING.test(folded)) return "platform_engineering"
  if (DEVOPS_PLATFORM.test(folded)) return "devops_platform"
  if (NOT_SOFTWARE_ENGINEERING.test(folded)) return "other"
  if (SOFTWARE_ENGINEERING.test(folded)) return "software_engineering"
  return "other"
}

/** EPIC-0006 (AC-1.8): the family a posting gets when first stored, from its title alone. */
export function classifyTitle(title: string): RoleFamily {
  return classifyRoleFamily(title, [])
}

/**
 * EPIC-0006 (AC-1.8): the family recorded after an evaluation. Only a move
 * between technical lead and people management is taken from the evaluation
 * (the duty rule); otherwise the store-time family stays. `stored` is null only
 * for an untitled posting, which takes the evaluated family.
 */
export function reconcileRoleFamily(stored: RoleFamily | null, evaluated: RoleFamily): RoleFamily {
  const leadOrManagement = (family: RoleFamily | null) => family === "technical_lead" || family === "people_management"
  if (stored === null) return evaluated
  return leadOrManagement(stored) && leadOrManagement(evaluated) ? evaluated : stored
}

export type Rankable = Readonly<{
  id: string
  family: RoleFamily
  coverage: number
  /** ATS fit 0 to 100; absent or -1 sorts last within its tier. Ranked right after the tier. */
  atsFit?: number | null
  discoveredAt: Date
  /** Found on an employer board (Greenhouse, Lever, Ashby) from the employer list, rather than on a remote board or a pasted link. */
  fromEmployerBoard: boolean
}>

/**
 * Role Preference tier, then higher Match coverage, then (slice 5 prework) an
 * employer-board posting before an equally matched one from a remote board,
 * then earlier discovery, then id for stability. EPIC-0002 B1: `tiers` is the
 * Candidate's sort keys (`rankTiersOf(preferences.roleFamilyTiers)`); the built
 * `TIER` (the Operator's migrated tiers) is the default.
 */
export function rankPostings(postings: readonly Rankable[], tiers: Readonly<Record<RoleFamily, number>> = TIER): string[] {
  return [...postings]
    .sort(
      (a, b) =>
        (tiers[a.family] ?? tiers.other) - (tiers[b.family] ?? tiers.other) ||
        (b.atsFit ?? -1) - (a.atsFit ?? -1) ||
        b.coverage - a.coverage ||
        Number(b.fromEmployerBoard) - Number(a.fromEmployerBoard) ||
        a.discoveredAt.getTime() - b.discoveredAt.getTime() ||
        a.id.localeCompare(b.id)
    )
    .map((posting) => posting.id)
}
