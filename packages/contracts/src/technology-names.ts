/**
 * EPIC-0004 alias table and normaliser (architecture.md "Alias table and
 * normaliser"). One table serves API validation (AC 3.7), extraction checks
 * (AC 4.2), matching (AC 3.5) and the UI's duplicate refusal (AC 3.3). The
 * Candidate cannot edit it; additions are a code change.
 *
 * Keys are stripped forms (see `stripTechnologyName`); values are canonical
 * forms. Canonical forms are stored in `match_evidence.criteria_technologies`,
 * so never rename one: only add rows.
 */
export const TECHNOLOGY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  reactjs: "react",
  vuejs: "vue",
  next: "nextjs",
  nuxtjs: "nuxt",
  node: "nodejs",
  expressjs: "express",
  ts: "typescript",
  js: "javascript",
  ecmascript: "javascript",
  golang: "go",
  postgres: "postgresql",
  k8s: "kubernetes",
  tailwindcss: "tailwind",
  rn: "reactnative",
  gql: "graphql",
  amazonwebservices: "aws",
  googlecloud: "gcp",
  googlecloudplatform: "gcp",
})

/**
 * NFKC, trim, lower case, then remove whitespace, `.`, `-` and `_`. `#`, `+`
 * and `/` are kept, so "C#", "C" and "C++" stay different.
 */
export function stripTechnologyName(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase().replace(/[\s.\-_]/gu, "")
}

/**
 * The canonical form two names are compared in (AC 3.5): stripped, then mapped
 * through the alias table. Two names match only when these are equal;
 * substrings never match ("java" is not "javascript").
 */
export function normaliseTechnologyName(raw: string): string {
  const stripped = stripTechnologyName(raw)
  return TECHNOLOGY_ALIASES[stripped] ?? stripped
}

/** Every stripped form the table knows: alias keys and canonical forms. */
export const KNOWN_TECHNOLOGY_FORMS: ReadonlySet<string> = new Set([
  ...Object.keys(TECHNOLOGY_ALIASES),
  ...Object.values(TECHNOLOGY_ALIASES),
])
