/**
 * ATS scoring (owner decision 2026-11-01: "ATS scoring must be the heart of everything"). Pure and
 * deterministic: the same posting keywords and texts always give the same score. An applicant tracking
 * system matches keywords as written, so this does too, forgiving only case, punctuation inside names
 * ("Next.js" = "NextJS"), plurals and a short list of common aliases ("JS" = "JavaScript").
 */

/**
 * A posting keyword: a technology or a key skill, as the posting writes it. `group` joins alternatives:
 * keywords quoted from one "X, Y or Z" list form one requirement that any of them meets.
 */
export type AtsKeyword = Readonly<{ keyword: string; kind: "technology" | "skill"; group: string }>

export type AtsScore = Readonly<{
  /** Requirements met as a share of all requirements, 0 to 100. A requirement is one keyword or one list of alternatives. */
  score: number
  /** How many requirements. */
  total: number
  /** Keywords found in the document. */
  matched: string[]
  /** Requirements not in the document that the Career Profile meets: tailoring could have used them. */
  missing: string[]
  /** Requirements the Career Profile doesn't meet either: real gaps no document may claim. Alternatives as "A / B". */
  gaps: string[]
}>

/** Common aliases, by normalised form. Each list holds forms an ATS treats as one keyword. */
const ALIASES: ReadonlyArray<readonly string[]> = [
  // No alias that is an everyday word or two letters ("next", "go", "node", "ts", "ci"): they would match prose.
  ["javascript", "js"],
  ["kubernetes", "k8s"],
  ["postgresql", "postgres"],
  ["nodejs", "node js"],
  ["reactjs", "react", "react js"],
  ["nextjs", "next js"],
  ["vuejs", "vue", "vue js"],
  ["amazon web services", "aws"],
  ["google cloud platform", "gcp", "google cloud"],
  ["cicd", "ci cd", "continuous integration and continuous delivery", "continuous integration and delivery"],
  ["graphql", "graph ql"],
]

/** Lower case, accents folded, punctuation inside a word removed ("next.js" -> "nextjs"), other punctuation a space. */
export function normaliseForAts(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/(\p{L}|\p{N})[.\-/_+#](?=\p{L}|\p{N})/gu, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** The forms a keyword may take in a document: itself, its aliases, and simple plurals. */
function variants(keyword: string): string[] {
  const base = normaliseForAts(keyword)
  const group = ALIASES.find((forms) => forms.includes(base))
  const forms = new Set(group ? [base, ...group] : [base])
  // Plurals only for longer words: "aws" must not also match "aw".
  for (const form of [...forms]) {
    if (form.length < 5) continue
    forms.add(form.endsWith("s") ? form.slice(0, -1) : `${form}s`)
  }
  return [...forms].filter((form) => form.length > 0)
}

/** True when the keyword, in any of its forms, appears in the text as whole words. */
export function containsKeyword(normalisedText: string, keyword: string): boolean {
  const padded = ` ${normalisedText} `
  return variants(keyword).some((form) => padded.includes(` ${form} `))
}

/** A quote listing alternatives: "Vue, React or Angular", "PostgreSQL/Redis", "either ... or ...". */
const ALTERNATIVES = /\bor\b|\/|\beither\b/i

/**
 * The posting's keywords, deduplicated by normalised form, without the employer's own name ("GitLab"
 * at GitLab is not a skill) and without one-letter forms. Keywords quoted from the same list of
 * alternatives share a group; every other keyword is its own group.
 */
export function atsKeywords(
  technologies: ReadonlyArray<Readonly<{ name: string; quote?: string }>> | null,
  skills: ReadonlyArray<Readonly<{ name: string; quote?: string }>> | null,
  employer: string | null
): AtsKeyword[] {
  const employerForm = employer ? normaliseForAts(employer) : ""
  const seen = new Set<string>()
  const out: AtsKeyword[] = []
  const add = (item: Readonly<{ name: string; quote?: string }>, kind: AtsKeyword["kind"]) => {
    const form = normaliseForAts(item.name)
    if (form.length < 2 || form === employerForm || seen.has(form)) return
    seen.add(form)
    const quote = item.quote ?? ""
    out.push({ keyword: item.name.trim(), kind, group: ALTERNATIVES.test(quote) ? `list:${normaliseForAts(quote)}` : `one:${form}` })
  }
  for (const technology of technologies ?? []) add(technology, "technology")
  for (const skill of skills ?? []) add(skill, "skill")
  return out
}

/** Keywords by group, in first-seen order. */
function groupsOf(keywords: readonly AtsKeyword[]): AtsKeyword[][] {
  const groups = new Map<string, AtsKeyword[]>()
  for (const keyword of keywords) groups.set(keyword.group, [...(groups.get(keyword.group) ?? []), keyword])
  return [...groups.values()]
}

/** Scores a document's text against the posting's requirements, telling missing (in the profile) from gaps (not). */
export function scoreAts(keywords: readonly AtsKeyword[], documentText: string, profileText: string): AtsScore {
  const document = normaliseForAts(documentText)
  const profile = normaliseForAts(profileText)
  const matched: string[] = []
  const missing: string[] = []
  const gaps: string[] = []
  let met = 0
  const groups = groupsOf(keywords)
  for (const group of groups) {
    const inDocument = group.filter(({ keyword }) => containsKeyword(document, keyword))
    matched.push(...inDocument.map(({ keyword }) => keyword))
    const label = group.map(({ keyword }) => keyword).join(" / ")
    if (inDocument.length > 0) met += 1
    else if (group.some(({ keyword }) => containsKeyword(profile, keyword))) missing.push(label)
    else gaps.push(label)
  }
  const total = groups.length
  return { score: total === 0 ? 0 : Math.round((met / total) * 100), total, matched, missing, gaps }
}

/** ATS fit before any document: the share of the posting's requirements the Career Profile meets, 0 to 100. */
export function atsFit(keywords: readonly AtsKeyword[], profileText: string): number {
  const groups = groupsOf(keywords)
  if (groups.length === 0) return 0
  const profile = normaliseForAts(profileText)
  const met = groups.filter((group) => group.some(({ keyword }) => containsKeyword(profile, keyword))).length
  return Math.round((met / groups.length) * 100)
}
