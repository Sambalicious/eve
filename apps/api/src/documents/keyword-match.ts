import { stem } from "../career-profile/claim-check.js"

/**
 * FEAT-0017: the keyword matcher the posting gap check and the added-facts rules
 * share (moved unchanged from `document-claims.ts`, architecture "Keyword matcher
 * reuse"). `keywordNamed(text, term)` is the one rule behind OD-12, OD-19 and
 * AC 2.3: a term is named when all of its words occur within a window of the
 * term's word count plus three line words, in any order, compared as stems, or as
 * one joined word ("carbonaccounting").
 */

/** Words the gap matcher ignores, so "accounting for carbon" and "carbon accounting" are the same skill. */
export const GAP_STOPWORDS: ReadonlySet<string> = new Set(["a", "an", "and", "the", "of", "for", "in", "on", "to", "with"])

/**
 * Words compared case-insensitively, after dotted acronyms are joined ("e.s.g" to
 * "esg") and hyphens and slashes split into spaces ("carbon-accounting" to
 * "carbon accounting").
 */
export function matchedWords(text: string): string[] {
  return text
    .replace(/\b(?:\p{L}\.){2,}\p{L}\b/gu, (dotted) => dotted.replaceAll(".", ""))
    .toLowerCase()
    .replace(/[-/]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "")
}

/** The words for the gap matcher, compared as stems on both sides, so "accounted for carbon" matches "carbon accounting". */
export function gapWords(text: string): string[] {
  return matchedWords(text)
    .filter((word) => !GAP_STOPWORDS.has(word))
    .map((word) => stem(singular(word)))
}

/** A gap keyword is present when all its words occur in the line, in any order, or as one joined word. */
export function keywordInWords(words: readonly string[], wanted: readonly string[]): boolean {
  if (wanted.length === 0) return false
  if (words.includes(wanted.join(""))) return true
  const span = wanted.length + 3
  for (let start = 0; start < words.length; start++) {
    const remaining = [...wanted]
    for (const word of words.slice(start, start + span)) {
      const at = remaining.indexOf(word)
      if (at !== -1) remaining.splice(at, 1)
      if (remaining.length === 0) return true
    }
  }
  return false
}

/**
 * True when `text` names `term` by the gap check's own matcher. A one-word term
 * backs a multi-word requirement that contains it (OD-19).
 */
export function keywordNamed(text: string, term: string): boolean {
  const wanted = gapWords(term)
  return wanted.length > 0 && keywordInWords(gapWords(text), wanted)
}

/** "consultants" and "consultant" are one noun; "partnered" is a verb, not the noun "partner". */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}
