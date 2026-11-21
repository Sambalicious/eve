import { normaliseForAts } from "../ats/ats-score.js"
import { gapWords, keywordInWords, matchedWords, singular } from "./keyword-match.js"

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

/** EPIC-0012 Revision 2, R10: a posting name in the line that no cited fact states in any case. */
export function borrowedNameIn(text: string, support: string, names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined
  const wanted = new Set(names)
  const cited = new Set(matchedWords(support))
  return matchedWords(text).find((word) => wanted.has(word) && !cited.has(word))
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
