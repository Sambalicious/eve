import { sentencesOf, unsourcedQuotationIn, withoutDirectionQuote } from "./company-direction.js"
import { type CoverLetterContent, type DocumentLine } from "./document-model.js"
import { type PostingGuard } from "./claim-types.js"

/** The line's sentences as lines of their own, each citing the paragraph's facts. */
export function sentencesOfLine(line: DocumentLine): DocumentLine[] {
  return sentencesOf(line.text).map((sentence) => ({ text: sentence, factIds: line.factIds }))
}

/**
 * True when one of the paragraph's sentences quotes the posting's direction span. Such a paragraph is judged
 * and reported as a whole: the quote and the claim about it only mean anything together, and a completion
 * word ("I met it") is a hard fail only next to its quote.
 */
export function holdsDirectionQuote(paragraph: DocumentLine, posting: PostingGuard | null): boolean {
  if (posting === null || posting.direction.length === 0) return false
  return sentencesOf(paragraph.text).some((sentence) => isDirectionSentence(sentence, posting))
}

/**
 * A letter paragraph is judged as one line, not sentence by sentence, when it holds a quotation (the posting's
 * direction or anything else in quote marks): "That target was met" only means something next to the sentence it
 * answers, so splitting them would keep the claim and drop the quote it was checked against.
 */
export function isWholeParagraph(paragraph: DocumentLine, posting: PostingGuard | null): boolean {
  if (holdsDirectionQuote(paragraph, posting)) return true
  // With no sources, the module's own quotation reader answers "does this paragraph quote anything at all",
  // with the same rules (all mark pairs, openers, closers) the claim check uses.
  return unsourcedQuotationIn(paragraph.text, []) !== null
}

/** True when the sentence is a direction sentence: it quotes a stored span inside the frame words (R3, R4). */
export function isDirectionSentence(sentence: string, posting: PostingGuard): boolean {
  return posting.direction.length > 0 && withoutDirectionQuote(sentence, posting.direction, { used: false }) !== null
}

/** How many letter paragraphs hold a direction sentence. Counts only, for `documents.direction_used`. */
export function directionParagraphCount(letter: CoverLetterContent, posting: PostingGuard | null): number {
  if (posting === null) return 0
  return letter.paragraphs.filter((paragraph) => sentencesOf(paragraph.text).some((sentence) => isDirectionSentence(sentence, posting))).length
}

/**
 * EPIC-0012 Revision 2 addendum, A6: after repair, a letter paragraph whose only sentence is the quoted
 * direction sentence says nothing, so it is dropped. The last body paragraph is kept (the letter is never
 * emptied) and counted as an orphan. Returns the letter, how many paragraphs were dropped, and the orphan flag.
 */
export function dropOrphanDirection(
  letter: CoverLetterContent,
  posting: PostingGuard | null
): Readonly<{ letter: CoverLetterContent; dropped: number; orphan: boolean }> {
  if (posting === null || posting.direction.length === 0) return { letter, dropped: 0, orphan: false }
  const isOrphan = (text: string) => {
    const sentences = sentencesOf(text)
    return sentences.length === 1 && isDirectionSentence(sentences[0] ?? text, posting)
  }
  const last = letter.paragraphs.length - 1
  let dropped = 0
  let orphan = false
  const paragraphs = letter.paragraphs.filter((paragraph, index) => {
    if (!isOrphan(paragraph.text)) return true
    if (index === last || letter.paragraphs.every((other, otherIndex) => otherIndex === index || isOrphan(other.text))) {
      orphan = true
      return true
    }
    dropped += 1
    return false
  })
  return { letter: dropped === 0 ? letter : { ...letter, paragraphs }, dropped, orphan }
}
