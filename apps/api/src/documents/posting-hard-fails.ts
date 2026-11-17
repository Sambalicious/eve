import { normaliseForAts } from "../ats/ats-score.js"
import { stem } from "../career-profile/claim-check.js"

/** An ATS keyword the posting asks for, the profile does not state, and the line's cited facts don't state. */
export function gapKeywordIn(text: string, support: string, gaps: readonly string[]): string | undefined {
  if (gaps.length === 0) return undefined
  const line = gapWords(text)
  const cited = gapWords(support)
  return gaps.find((keyword) => {
    const wanted = gapWords(keyword)
    return keywordInWords(line, wanted) && !keywordInWords(cited, wanted)
  })
}

/** Words the gap matcher ignores, so "accounting for carbon" and "carbon accounting" are the same skill. */
const GAP_STOPWORDS: ReadonlySet<string> = new Set(["a", "an", "and", "the", "of", "for", "in", "on", "to", "with"])

/**
 * EPIC-0012 Revision 2, R10: words for the gap matcher, compared as stems on both sides, so "accounted
 * for carbon" matches the gap "carbon accounting". Singular first, then the shared stem.
 */
function gapWords(text: string): string[] {
  return matchedWords(text)
    .filter((word) => !GAP_STOPWORDS.has(word))
    .map((word) => stem(singular(word)))
}

/**
 * EPIC-0012 rule 2 (Revision 2, R10): a gap keyword is present when all its words occur within a window of
 * its word count plus 3 line words, in any order, compared as stems, or as one joined word
 * ("carbonaccounting"). Reordered and reworded gap words count: a reordered skill is the same skill.
 */
function keywordInWords(words: readonly string[], wanted: readonly string[]): boolean {
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

/** EPIC-0012 Revision 2, R10: a posting name in the line that no cited fact states in any case. */
export function borrowedNameIn(text: string, support: string, names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined
  const wanted = new Set(names)
  const cited = new Set(matchedWords(support))
  return matchedWords(text).find((word) => wanted.has(word) && !cited.has(word))
}

/**
 * EPIC-0012 rule 2 (Revision 1, R2): words compared case-insensitively, after dotted acronyms are joined
 * ("e.s.g" to "esg") and hyphens and slashes are split into spaces ("carbon-accounting" to "carbon accounting").
 */
function matchedWords(text: string): string[] {
  return text
    .replace(/\b(?:\p{L}\.){2,}\p{L}\b/gu, (dotted) => dotted.replaceAll(".", ""))
    .toLowerCase()
    .replace(/[-/]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "")
}

/** A role noun in the line that its cited facts do not state, matched whole and across a plural. */
export function roleNounIn(text: string, support: string, nouns: readonly string[]): string | undefined {
  if (nouns.length === 0) return undefined
  const cited = new Set(normaliseForAts(support).split(" ").map(singular))
  const wanted = new Set(nouns.map(singular))
  return normaliseForAts(text)
    .split(" ")
    .find((word) => wanted.has(singular(word)) && !cited.has(singular(word)))
}

/** "consultants" and "consultant" are one noun; "partnered" is a verb, not the noun "partner". */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}
