import { normaliseForAts } from "../ats/ats-score.js"
import { GENERIC_SECTION_WORDS, MONTH_AND_DAY_NAMES, OPENING_WORDS } from "../career-profile/claim-check.js"
import { type PostingGuard } from "./claim-types.js"

/**
 * EPIC-0012 rule 2 (design 1c): role nouns a line may not add. The posting's own title adds its last
 * meaningful word at the call site. These are hard fails, so the meaning check never lends them.
 */
export const ROLE_NOUNS: ReadonlySet<string> = new Set([
  "consultant", "analyst", "engineer", "developer", "designer", "specialist", "officer", "advisor", "adviser",
  "associate", "coordinator", "scientist", "researcher", "administrator", "accountant", "auditor", "strategist",
  "executive", "partner", "technician", "assistant",
])

/** At most this many posting terms per line (design 1b). A line with more falls back instead of borrowing. */
export const POSTING_TERM_LIMIT = 2

/** The posting window the generation prompt uses; posting terms are drawn from the same first 12,000 characters. */
const POSTING_TEXT_LIMIT = 12_000

/** Title words that carry no role meaning ("Head of Finance" ends on "finance"). */
const POSTING_STOPWORDS: ReadonlySet<string> = new Set(["a", "an", "and", "the", "of", "at", "in", "for", "to", "with", "on", "or"])

/** A title's level or revision, not a role noun: "Engineer II" ends on "engineer". */
const TITLE_NUMBER = /^(?:\d+|i{1,3}|iv|v|vi{0,3}|ix|x)$/

/**
 * Builds the posting side of the guard. `hasKeywords` is false for a pasted posting whose keywords are not
 * known yet: risk R2 says it lends no posting terms, since the gap list cannot run either.
 */
export function postingGuard(
  postingText: string,
  roleTitle: string | null,
  gapKeywords: readonly string[] = [],
  hasKeywords = true,
  direction: readonly string[] = []
): PostingGuard {
  // "(m/f/d)" and "[remote]" are not title words.
  const title = (roleTitle ?? "").replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")
  const words = normaliseForAts(title)
    .split(" ")
    .filter((word) => word.length > 1 && !POSTING_STOPWORDS.has(word) && !TITLE_NUMBER.test(word))
  const titleNoun = words.at(-1)
  return {
    text: hasKeywords ? normaliseForAts(postingText.slice(0, POSTING_TEXT_LIMIT)) : "",
    gaps: gapKeywords,
    roleNouns: [...new Set([...(titleNoun === undefined ? [] : [titleNoun]), ...ROLE_NOUNS])],
    names: borrowedNames(postingText.slice(0, POSTING_TEXT_LIMIT)),
    direction,
  }
}

/**
 * EPIC-0012 Revision 2, R10: the words the raw posting writes as names. A word counts when the posting
 * writes it at least once with a capital first letter or in all caps and never writes it in lower case,
 * wherever it stands: a line start, after ":", or in a list. Position no longer matters, so a posting
 * that lists "Tableau experience is a plus." or "Tools: Snowflake, …" lends neither word. Stop words,
 * `OPENING_WORDS`, generic section labels and month and day names are not names. A domain word a posting
 * only writes capitalised ("Sustainability consulting firm.") cannot be lent, which fails safe.
 */
function borrowedNames(postingText: string): string[] {
  // Dotted acronyms are one word ("E.S.G." is "ESG"), as in `matchedWords`.
  const text = postingText.replace(/\b(?:\p{L}\.){2,}\p{L}\b/gu, (dotted) => dotted.replaceAll(".", ""))
  const matches = [...text.matchAll(/[\p{L}\p{N}]+/gu)]
  const writtenLowerCase = new Set(matches.filter((match) => match[0] === match[0].toLowerCase()).map((match) => match[0]))
  const names = new Set<string>()
  for (const match of matches) {
    const word = match[0]
    if (word.length < 2 || !/\p{Lu}/u.test(word)) continue
    const lower = word.toLowerCase()
    if (writtenLowerCase.has(lower) || isOrdinaryWord(lower)) continue
    names.add(lower)
  }
  return [...names]
}

/** Words a posting may capitalise without lending a name (Revision 2, R10). */
function isOrdinaryWord(word: string): boolean {
  return (
    POSTING_STOPWORDS.has(word) ||
    OPENING_WORDS.has(word) ||
    GENERIC_SECTION_WORDS.has(word) ||
    MONTH_AND_DAY_NAMES.has(word)
  )
}
