/**
 * The documents claim guard's public surface. The checks live in focused modules that take a `ClaimContext`:
 *
 * - `claim-types`: the shared types and the `ClaimContext` itself
 * - `posting-guard`, `posting-hard-fails`: the posting side of the guard and its hard-fail detectors
 * - `mechanical-line`: which lines pass without the meaning check
 * - `claim-line`: the one-line claim check
 * - `direction-sentences`: quoted-direction sentences and orphan paragraphs
 * - `claim-repair`: resume fallback and letter trimming
 * - `document-validation`: whole-document validation and monitoring
 *
 * The functions below keep the positional signatures that the Outreach module, the specs and the live checks
 * call; each only builds the `ClaimContext` and delegates. The documents service calls the modules directly.
 */
import { type CoverLetterContent, type ContactHeader, type DocumentContent, type DocumentLine, type ResumeContent } from "./document-model.js"
import { type LetterKeywordCap } from "./letter-keyword-cap.js"
import { type ClaimContext, type DocumentValidation, type FactWording, type LetterTarget, type LineKind, type PostingGuard } from "./claim-types.js"
import { dropUnsupportedSentences as dropUnsupportedSentencesIn, fallBackToFactWording as fallBackToFactWordingIn, settleCappedLetter as settleCappedLetterIn } from "./claim-repair.js"
import {
  checkSentence as checkSentenceIn,
  hardFailCounts as hardFailCountsIn,
  letterBlocksOnlyOnUnjudged as letterBlocksOnlyOnUnjudgedIn,
  needsMeaningCheck as needsMeaningCheckIn,
  refusedSentence as refusedSentenceIn,
  validateDocument as validateDocumentIn,
} from "./document-validation.js"

export type { ClaimContext, ClaimFailureReason, DocumentValidation, FactWording, HardFailCode, LetterTarget, LineKind, PostingGuard } from "./claim-types.js"
export { namesTarget, postingTerms } from "./claim-line.js"
export { directionParagraphCount, dropOrphanDirection, holdsDirectionQuote, isWholeParagraph, sentencesOfLine } from "./direction-sentences.js"
export { POSTING_TERM_LIMIT, ROLE_NOUNS, postingGuard } from "./posting-guard.js"

const claimContext = (
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string>,
  posting: PostingGuard | null,
  wording: FactWording
): ClaimContext => ({ facts, target, contact, meaningChecked, posting, wording })

export function validateDocument(
  content: DocumentContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null = null,
  contact: ContactHeader | null = null,
  meaningChecked: ReadonlySet<string> = new Set(),
  posting: PostingGuard | null = null,
  wording: FactWording = null
): DocumentValidation {
  return validateDocumentIn(content, claimContext(facts, target, contact, meaningChecked, posting, wording))
}

export function fallBackToFactWording(
  resume: ResumeContent,
  facts: ReadonlyMap<string, string>,
  wording: ReadonlyMap<string, string>,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string> = new Set(),
  posting: PostingGuard | null = null
): Readonly<{ resume: ResumeContent; replaced: number }> {
  return fallBackToFactWordingIn(resume, claimContext(facts, null, contact, meaningChecked, posting, wording))
}

export function needsMeaningCheck(
  line: DocumentLine,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null,
  contact: ContactHeader | null,
  kind: LineKind = "experience_bullet",
  posting: PostingGuard | null = null,
  wording: FactWording = null
): boolean {
  return needsMeaningCheckIn(line, claimContext(facts, target, contact, new Set(), posting, wording), kind)
}

export function checkSentence(
  line: DocumentLine,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null = null,
  contact: ContactHeader | null = null,
  meaningChecked: ReadonlySet<string> = new Set(),
  kind: LineKind = "outreach_ask",
  posting: PostingGuard | null = null,
  wording: FactWording = null,
  extraOpeners: ReadonlySet<string> | null = null
): DocumentValidation {
  return checkSentenceIn(line, claimContext(facts, target, contact, meaningChecked, posting, wording), kind, extraOpeners)
}

export function dropUnsupportedSentences(
  letter: CoverLetterContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string> = new Set(),
  posting: PostingGuard | null = null,
  wording: FactWording = null
): Readonly<{ letter: CoverLetterContent; dropped: number; checked: ReadonlySet<string> }> {
  return dropUnsupportedSentencesIn(letter, claimContext(facts, target, contact, meaningChecked, posting, wording))
}

export function refusedSentence(
  letter: CoverLetterContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string>,
  posting: PostingGuard | null = null,
  wording: FactWording = null
): string | null {
  return refusedSentenceIn(letter, claimContext(facts, target, contact, meaningChecked, posting, wording))
}

export function letterBlocksOnlyOnUnjudged(
  letter: CoverLetterContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string>,
  posting: PostingGuard | null = null,
  wording: FactWording = null
): boolean {
  return letterBlocksOnlyOnUnjudgedIn(letter, claimContext(facts, target, contact, meaningChecked, posting, wording))
}

export function hardFailCounts(
  resume: ResumeContent,
  letter: CoverLetterContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null,
  contact: ContactHeader | null,
  posting: PostingGuard | null,
  wording: FactWording
): Readonly<Record<string, number>> {
  return hardFailCountsIn(resume, letter, claimContext(facts, target, contact, new Set(), posting, wording))
}

export function settleCappedLetter(
  capped: LetterKeywordCap,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string>,
  posting: PostingGuard | null,
  wording: FactWording
): Readonly<{ letter: CoverLetterContent; checked: ReadonlySet<string>; paragraphsDropped: number; restored: number }> {
  return settleCappedLetterIn(capped, claimContext(facts, target, contact, meaningChecked, posting, wording))
}
