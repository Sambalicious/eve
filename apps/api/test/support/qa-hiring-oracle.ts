/**
 * QA-authored independent oracle for EPIC-0007 Phase 1 hiring links, from
 * api-contract.md "Query construction (exact)". Not imported from
 * @eve/contracts on purpose (a wrong builder must not become the expectation).
 * Mirrors apps/e2e/support/hiring-oracle.ts; both reproduce the contract's
 * literal AC 3.4 example (AC34_LINKEDIN / AC34_GOOGLE).
 */
export const HIRING_PHRASES = ["we're hiring", "we are hiring", "now hiring", "join our team"] as const

export const ROLE_PHRASES = {
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
} as const satisfies Record<string, readonly string[]>

export type Family = keyof typeof ROLE_PHRASES
export type Hint = "remote" | "relocation" | "visa sponsorship"

const clause = (list: readonly string[]) => (list.length === 0 ? "" : `(${list.map((t) => `"${t}"`).join(" OR ")})`)
const enc = (value: string) => encodeURIComponent(value).replace(/'/g, "%27")

export function hiringGroups(family: Family, frameworks: readonly string[], technologies: readonly string[], hints: readonly Hint[]) {
  const phrases = ROLE_PHRASES[family]
  if (phrases.length === 0) return []
  const terms = [...frameworks, ...technologies]
  const chunks: string[][] = terms.length === 0 ? [[]] : []
  for (let i = 0; i < terms.length; i += 4) chunks.push(terms.slice(i, i + 4))
  return chunks.map((chunk) => {
    const clauses = [clause(HIRING_PHRASES), clause(phrases), clause(chunk), clause(hints)].filter(Boolean)
    const linkedinExpression = clauses.join(" AND ")
    const alertsQuery = `site:linkedin.com/posts ${clauses.join(" ")}`
    return {
      label: chunk.join(", "),
      linkedinExpression,
      alertsQuery,
      linkedin: `https://www.linkedin.com/search/results/content/?keywords=${enc(linkedinExpression)}&sortBy=${enc('"date_posted"')}&datePosted=${enc('"past-week"')}`,
      google: `https://www.google.com/search?q=${enc(alertsQuery)}&tbs=${enc("qdr:w")}`,
    }
  })
}

export const AC34_LINKEDIN =
  "https://www.linkedin.com/search/results/content/?keywords=(%22we%27re%20hiring%22%20OR%20%22we%20are%20hiring%22%20OR%20%22now%20hiring%22%20OR%20%22join%20our%20team%22)%20AND%20(%22frontend%20engineer%22%20OR%20%22frontend%20developer%22%20OR%20%22front-end%20engineer%22)%20AND%20(%22React%22%20OR%20%22TypeScript%22)%20AND%20(%22remote%22%20OR%20%22relocation%22%20OR%20%22visa%20sponsorship%22)&sortBy=%22date_posted%22&datePosted=%22past-week%22"
export const AC34_GOOGLE =
  "https://www.google.com/search?q=site%3Alinkedin.com%2Fposts%20(%22we%27re%20hiring%22%20OR%20%22we%20are%20hiring%22%20OR%20%22now%20hiring%22%20OR%20%22join%20our%20team%22)%20(%22frontend%20engineer%22%20OR%20%22frontend%20developer%22%20OR%20%22front-end%20engineer%22)%20(%22React%22%20OR%20%22TypeScript%22)%20(%22remote%22%20OR%20%22relocation%22%20OR%20%22visa%20sponsorship%22)&tbs=qdr%3Aw"

/** copy-deck.r1.md, email rows (C-HP-EMAIL-*, C-HP-GROUP-ANY, C-HP-LINK-*). */
export const EMAIL_COPY = {
  title: "Hiring search links",
  intro: (family: string) => `Past-week search hints for ${family} roles. Some results won't fit, and Eve can't check pay, hours or sponsorship from them.`,
  other: "Searches for your other role families",
  noFamily: "Hiring searches need job titles, and Other has none. Choose another role family in your job criteria.",
  noFamilyLink: "Choose role families",
  groupAny: "Any technology",
  linkLi: "LinkedIn posts",
  linkG: "Google posts",
} as const
