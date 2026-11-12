/**
 * Rule 3 (EPIC-0012), Revision 2 R14: the cover letter holds at most three mentions of one keyword (owner
 * decision D4), enforced in code and never by blocking. Mentions are counted across the body paragraphs in
 * reading order, and the sentence holding the fourth and later mention of a keyword is dropped.
 *
 * A paragraph left without a sentence is dropped too, while another body paragraph remains. The letter's
 * last body sentence is never dropped: when the cap would empty the body, that sentence stays and the result
 * reports `overCap` for the log line. Stuffing is trimmed, never a claim check.
 *
 * Only the body paragraphs are counted and trimmed. The greeting, opening, closing line and sign-off are
 * backend text, not model lines: a keyword there is neither counted nor changed.
 *
 * A mention is one sentence the keyword appears in, matched with the resume's whole-word matcher
 * (`containsKeyword`), so aliases count like the keyword itself and two forms of one keyword count once.
 */
import { type AtsKeyword, containsKeyword, normaliseForAts } from "../ats/ats-score.js"
import { sentencesOf } from "./company-direction.js"
import type { CoverLetterContent, DocumentLine } from "./document-model.js"

/** At most this many mentions of one keyword in a letter's body paragraphs (owner decision D4). */
export const LETTER_KEYWORD_LIMIT = 3

export type LetterKeywordCap = Readonly<{
  letter: CoverLetterContent
  /** Keyword mentions counted in the body paragraphs before any sentence was dropped. */
  mentions: number
  /** Body sentences dropped because their keyword was already at the limit. */
  dropped: number
  /** True when the cap would have emptied the body, so one over-cap sentence stayed (R14). */
  overCap: boolean
  /**
   * Paragraphs whose sentences were trimmed: the paragraph as it came in and as it left. The caller carries
   * a judge verdict from `from` to `to`, since a subset of judged sentences is still judged (R14 fix).
   */
  trimmed: ReadonlyArray<Readonly<{ from: DocumentLine; to: DocumentLine }>>
}>

/** Drops the body sentences holding the fourth and later mentions of a keyword. Never blocks. */
export function capLetterKeywords(letter: CoverLetterContent, keywords: readonly AtsKeyword[]): LetterKeywordCap {
  const distinct = distinctKeywords(keywords)
  // Mentions kept so far, per normalised keyword form. A dropped sentence is not counted: the cap is
  // already reached, so every later sentence holding that keyword is dropped as well.
  const counted = new Map<string, number>()
  let mentions = 0
  let dropped = 0
  const trimmed: Array<{ from: DocumentLine; to: DocumentLine }> = []
  const capped = letter.paragraphs.map((paragraph): DocumentLine | null => {
    const sentences = sentencesOf(paragraph.text)
    const kept: string[] = []
    for (const sentence of sentences) {
      const holding = keywordsIn(sentence, distinct)
      mentions += holding.length
      if (holding.some((keyword) => atLimit(counted, keyword))) {
        dropped += 1
        continue
      }
      for (const keyword of holding) countMention(counted, keyword)
      kept.push(sentence)
    }
    if (kept.length === 0) return null
    if (kept.length === sentences.length) return paragraph
    const to = { ...paragraph, text: kept.join(" ") }
    trimmed.push({ from: paragraph, to })
    return to
  })
  const paragraphs = capped.filter((paragraph): paragraph is DocumentLine => paragraph !== null)
  if (paragraphs.length > 0) return { letter: { ...letter, paragraphs }, mentions, dropped, overCap: false, trimmed }
  // Never drop the letter's last body sentence: the body stays, over the cap, and the caller logs `overCap`.
  const last = letter.paragraphs[letter.paragraphs.length - 1]
  if (last === undefined) return { letter, mentions, dropped, overCap: false, trimmed: [] }
  const lastSentences = sentencesOf(last.text)
  const lastSentence = lastSentences[lastSentences.length - 1] ?? last.text
  // Revision 3, R17: the trimmed object is built once, so the caller can identify it by identity.
  const trimmedLast = { ...last, text: lastSentence }
  return {
    letter: { ...letter, paragraphs: [trimmedLast] },
    mentions,
    dropped: Math.max(0, dropped - 1),
    overCap: true,
    trimmed: lastSentence === last.text ? [] : [{ from: last, to: trimmedLast }],
  }
}

function keywordsIn(sentence: string, keywords: readonly AtsKeyword[]): string[] {
  const normalised = normaliseForAts(sentence)
  return keywords.filter(({ keyword }) => containsKeyword(normalised, keyword)).map(({ keyword }) => keyword)
}

function atLimit(counted: ReadonlyMap<string, number>, keyword: string): boolean {
  return (counted.get(normaliseForAts(keyword)) ?? 0) >= LETTER_KEYWORD_LIMIT
}

function countMention(counted: Map<string, number>, keyword: string): void {
  const form = normaliseForAts(keyword)
  counted.set(form, (counted.get(form) ?? 0) + 1)
}

function distinctKeywords(keywords: readonly AtsKeyword[]): AtsKeyword[] {
  const seen = new Set<string>()
  return keywords.filter(({ keyword }) => {
    const form = normaliseForAts(keyword)
    if (seen.has(form)) return false
    seen.add(form)
    return true
  })
}
