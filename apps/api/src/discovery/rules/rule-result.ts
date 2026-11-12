/** One Eligibility rule's result (AC 4.1). `not_applicable`: sponsorship that does not apply, and (D44) seniority or employment type when every value is accepted. */
export type RuleResult = "met" | "unverified" | "violated" | "not_applicable"

export type RuleName = "location" | "sponsorship" | "pay" | "hours" | "industry" | "seniority" | "employment_type"

/** Stored and labelled order (contract v1.25.0, D44: seniority and employment type follow industry). */
export const RULE_NAMES: readonly RuleName[] = ["location", "sponsorship", "pay", "hours", "industry", "seniority", "employment_type"]

export type RuleOutcome = Readonly<{
  result: RuleResult
  /** Verbatim posting text that supports the result, or null when the posting doesn't say. */
  quote: string | null
}>

/**
 * Lower-cased, accents folded, whitespace collapsed, dotted initialisms undotted ("U.S." to "us"): the form keyword
 * floors match against. Slice 8d: the one definition is in `@eve/contracts` (shared with the web). Its backfill rule
 * applies here too: any change to the fold ships a migration that recomputes `job_posting.title_folded` (8d.19).
 */
export { foldForKeywords } from "@eve/contracts"

/** The sentence (or line) of `text` that contains the match at `index`, trimmed. */
export function sentenceAround(text: string, index: number, length: number): string {
  const boundary = /[.!?\n;]/
  let start = index
  while (start > 0 && !boundary.test(text[start - 1] as string)) start -= 1
  let end = index + length
  while (end < text.length && !boundary.test(text[end] as string)) end += 1
  return text.slice(start, end).trim()
}

/**
 * A full stop that ends an abbreviation, not a sentence (CR3B-02): dotted
 * initialisms (U.S., U.K., E.U., U.A.E., e.g., i.e.), single capitals, and
 * common short forms with their full stop (Inc., Ltd., Dr., etc.: CR3B-06).
 * "No." is left out: it ends sentences ("Remote? No.") more often than it
 * abbreviates "number". The split never happens right after one of these.
 */
const ABBREVIATION_BEFORE = /(?:\b(?:[A-Za-z]\.){2,}|\b[A-Z]\.|\b(?:etc|vs|approx|incl|Inc|Ltd|Co|Corp|St|Mr|Mrs|Ms|Dr|Sr|Jr)\.)$/

/**
 * The sentences (or lines) of `text`, trimmed and without their final full
 * stop. Each is still a substring. Abbreviations do not end a sentence, so
 * "Remote, U.S. only." stays one sentence.
 */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = []
  let start = 0
  for (const match of text.matchAll(/(?<=[.!?;])\s+|\n+/g)) {
    const before = text.slice(start, match.index)
    if (!match[0].includes("\n") && before.endsWith(".") && ABBREVIATION_BEFORE.test(before)) continue
    sentences.push(before)
    start = match.index + match[0].length
  }
  sentences.push(text.slice(start))
  return sentences.map((sentence) => sentence.trim().replace(/[.;]$/, "")).filter((sentence) => sentence !== "")
}
