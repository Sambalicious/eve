import { factClaimsMissing, numbersIn, postingTermsIn, supportInflationVerb, unsupportedScopeVerbs } from "../career-profile/claim-check.js"
import { type DirectionAllowance, completionWordIn, sentencesOf, unsourcedQuotationIn, withoutDirectionQuote } from "./company-direction.js"
import { containsContactDetail } from "./contact-detail.js"
import { type DocumentContent, type DocumentLine } from "./document-model.js"
import { type ClaimContext, type DocumentValidation, type HardFailCode, type LetterTarget, type LineKind, type PostingGuard } from "./claim-types.js"
import { factTextOf, isMeaningChecked, isMechanicalLine } from "./mechanical-line.js"
import { POSTING_TERM_LIMIT } from "./posting-guard.js"
import { borrowedNameIn, gapKeywordIn, roleNounIn } from "./posting-hard-fails.js"

/** Only prose lines may lend a posting term; a skills, education or heading line may not. */
const POSTING_TERM_KINDS: ReadonlySet<LineKind> = new Set(["summary", "experience_bullet", "letter_paragraph"])

/**
 * The claim check for one line: null when it passes, else the failure. Everything but the line comes from the
 * `ClaimContext`; `kind` is where the line sits, `allowance` the letter-wide direction allowance (null for none)
 * and `extraOpeners` the Outreach opener words.
 */
export function checkLine(
  line: DocumentLine,
  ctx: ClaimContext,
  kind: LineKind = "experience_bullet",
  allowance: DirectionAllowance | null = null,
  extraOpeners: ReadonlySet<string> | null = null
): DocumentValidation | null {
  const { facts, target, contact, meaningChecked, posting, wording } = ctx
  if (containsContactDetail(line.text, contact)) return { ok: false, reason: "contact_detail", claim: line.text, unsupported: [] }
  if (line.factIds.some((id) => !facts.has(id))) return { ok: false, reason: "unknown_fact", claim: line.text, unsupported: [] }
  if (target !== null && namesTarget(line.text, target)) return { ok: false, reason: "names_target", claim: line.text, unsupported: [], hardFail: "names_target" }
  // EPIC-0012 Revision 3, R19: a quotation must come from somewhere. Checked before the direction span is
  // stripped, on every kind the judge can see: an unsourced span is a hard fail, so no judge answer releases
  // it. Headings and education never hold a quotation.
  if (kind !== "experience_heading" && kind !== "education") {
    const unsourced = unsourcedQuotationIn(line.text, quotationSources(line, facts, posting))
    if (unsourced !== null) return unsupportedClaim(line, [unsourced], "unsourced_quote")
  }
  // EPIC-0012 rule 4 (design 2e): names_target ran on the full line first. Then one exactly quoted
  // direction span is removed before the claim and number checks, so the employer's goal is not read as a
  // claim about the Candidate. An unquoted or altered quote stays in and fails as before.
  const stripped =
    posting !== null && allowance !== null && kind === "letter_paragraph"
      ? withoutDirectionQuote(line.text, posting.direction, allowance)
      : null
  const checked = stripped ?? line.text
  // EPIC-0012 Revision 2, R11: a direction paragraph can never be mechanical, so it always needs the
  // judge, and a completion word outside the quoted span is a hard fail no judge answer can release.
  const directionUsed = stripped !== null
  const completion = directionUsed ? completionWordIn(checked) : null
  if (completion !== null) return unsupportedClaim(line, [completion], "completion_word")
  const support = supportText(line, facts)
  if (posting !== null) {
    // EPIC-0012 rule 2 (design 1c): hard fails, checked before the meaning check can lend anything.
    const gap = gapKeywordIn(checked, support, posting.gaps)
    if (gap !== undefined) return unsupportedClaim(line, [gap], "gap")
    const noun = roleNounIn(checked, support, posting.roleNouns)
    if (noun !== undefined) return unsupportedClaim(line, [noun], "role_noun")
    // Revision 2, R10: a name the posting writes capitalised or in all caps, and never in lower case, is
    // never lent, in any case, even when the model wrote it in lower case as the generation prompt asks.
    const name = borrowedNameIn(checked, support, posting.names)
    if (name !== undefined) return unsupportedClaim(line, [name], "borrowed_name")
    const terms = postingTermsIn(checked, support, posting.text)
    if (terms.length > POSTING_TERM_LIMIT || (terms.length > 0 && !POSTING_TERM_KINDS.has(kind))) return unsupportedClaim(line, terms, "posting_term")
  }
  // EPIC-0012 Revision 2, R8: support-role inflation, a hard fail no judge answer can release. Facts are
  // read from their own wording only, never the validation value's heading or employer.
  const citedWording = line.factIds.map((id) => factTextOf(id, facts, wording))
  const inflation = supportInflationVerb(checked, citedWording)
  if (inflation !== null) return unsupportedClaim(line, [inflation], "support_inflation")
  const alreadyJudged = isMeaningChecked(meaningChecked, line)
  // EPIC-0012 Revision 2, 2.1: only a mechanical line passes without the judge; every other line the
  // meaning check can see needs an explicit supported: true. Headings and education are not sent to the
  // judge, so they keep the claim check alone (the backend writes headings; education is claim-checked).
  const mechanical = !directionUsed && isMechanicalLine(checked, line.factIds, facts, wording, kind)
  // EPIC-0014 D5: an Ask is claim-checked with nothing to cite and, like education, never demands a judge verdict here.
  const judgedKind = kind !== "experience_heading" && kind !== "education" && kind !== "outreach_ask"
  const unsupported = factClaimsMissing(checked, support, {
    documentWords: true,
    meaningChecked: alreadyJudged,
    ...(extraOpeners === null ? {} : { extraOpeners }),
  })
  if (unsupported.length === 0) {
    // EPIC-0012 rule 2 (Revision 2, R8): an added scope verb only passes unjudged inside a mechanical line.
    const cited = line.factIds.map((id) => facts.get(id) ?? "")
    const scope = mechanical || alreadyJudged || !judgedKind ? [] : unsupportedScopeVerbs(checked, cited)
    if (scope.length === 0 && numbersFromOneFact(checked, cited)) {
      if (mechanical || alreadyJudged || !judgedKind) return null
      // A reword with no unsupported word still needs the judge: pass a failure it can release.
      return unsupportedClaim(line, [])
    }
    return unsupportedClaim(line, scope.length > 0 ? scope : numbersIn(checked), scope.length > 0 ? undefined : "number")
  }
  if (line.factIds.length === 0) return { ok: false, reason: "no_fact", claim: line.text, unsupported }
  return unsupportedClaim(line, unsupported, "claim_word")
}

/** The posting terms a line would borrow, for the meaning-check prompt (EPIC-0012 rule 2, design 1a). */
export function postingTerms(line: DocumentLine, facts: ReadonlyMap<string, string>, posting: PostingGuard | null): string[] {
  return posting === null ? [] : postingTermsIn(line.text, supportText(line, facts), posting.text)
}

export function supportText(line: DocumentLine, facts: ReadonlyMap<string, string>): string {
  return line.factIds.map((id) => facts.get(id) ?? "").join(". ")
}

/**
 * EPIC-0012 Revision 3, R19: what a document line may quote. Only the posting's verified direction quotes
 * (`posting.direction`, already empty with the direction flag off) and the validation text of the facts the
 * line cites. The posting text itself is not a source, so with the flag off nothing may be quoted from it.
 */
export function quotationSources(line: DocumentLine, facts: ReadonlyMap<string, string>, posting: PostingGuard | null): string[] {
  return [...(posting?.direction ?? []), ...line.factIds.map((id) => facts.get(id) ?? "")]
}

export function unsupportedClaim(line: DocumentLine, unsupported: string[], hardFail?: HardFailCode): DocumentValidation {
  return hardFail === undefined
    ? { ok: false, reason: "unsupported_claim", claim: line.text, unsupported }
    : { ok: false, reason: "unsupported_claim", claim: line.text, unsupported, hardFail }
}

/** Every claim-bearing line of a document with the section it sits in, for the bridge allowance and its hard fails. */
export function kindedLines(content: DocumentContent): Array<Readonly<{ line: DocumentLine; kind: LineKind }>> {
  if (content.kind === "cover_letter") return content.paragraphs.map((line) => ({ line, kind: "letter_paragraph" }))
  return [
    ...content.summary.map((line) => ({ line, kind: "summary" as const })),
    ...content.experience.flatMap((entry) => [
      { line: entry.heading, kind: "experience_heading" as const },
      ...entry.bullets.map((line) => ({ line, kind: "experience_bullet" as const })),
    ]),
    ...content.skills.map((line) => ({ line, kind: "skills" as const })),
    ...content.education.map((line) => ({ line, kind: "education" as const })),
  ]
}

/**
 * CR4-01 (Candidate default): a line's numbers must all come from a single
 * cited fact, in the order that fact states them, so a swapped number ("from 3
 * weeks to 2 days") or one borrowed from another fact ("from 6 weeks") blocks.
 *
 * Deviation, recorded in the slice 5 backend report: when the whole line
 * fails, each clause is tried on its own, so "I cut our release cycle from 2
 * weeks to 3 days and mentored 6 junior developers" (two facts, one clause
 * each) still passes. Clauses split at a sentence end, at ";" and at "and",
 * "while", "which", "where" or a comma before a subject pronoun, never at a
 * bare comma, so "from 3 weeks, to 2 days" is still one clause. Design 2.1 b
 * joins whole fact wordings with ". ", so two fact sentences are two claims,
 * not one (EPIC-0012 QA8-B2).
 */
function numbersFromOneFact(text: string, cited: readonly string[]): boolean {
  const factNumbers = cited.map(numbersIn)
  const fits = (part: string) => {
    const numbers = numbersIn(part)
    return numbers.length === 0 || factNumbers.some((fact) => isOrderedSubsequence(numbers, fact))
  }
  return fits(text) || clausesOf(text).every(fits)
}

function clausesOf(text: string): string[] {
  // A sentence is its own clause: design 2.1 b joins whole fact wordings with ". ", so a paragraph of two fact
  // sentences is two claims, and numbers from two facts in two sentences are not one mixed claim (QA8-B2).
  return sentencesOf(text).flatMap((sentence) => sentence.split(/;|,?\s+(?:and|while|which|where)\s+|,\s+(?=(?:i|we|he|she|they|it|my|our)\b)/i))
}

function isOrderedSubsequence(numbers: readonly string[], fact: readonly string[]): boolean {
  let at = 0
  for (const value of fact) if (at < numbers.length && numbers[at] === value) at += 1
  return at === numbers.length
}

/**
 * SEC-403 r2: the model never names the target employer or role; the backend
 * writes every sentence that does. A model line names the target when, after
 * folding case, accents, invisible characters and whitespace, it contains the
 * whole employer name or the whole role title as words. Partial use ("Senior",
 * "Staff Engineer" from a longer title) is not exempt either: those words are
 * claims and must come from the cited facts like any other.
 */
export function namesTarget(text: string, target: LetterTarget): boolean {
  const line = ` ${foldWords(text)} `
  return [target.employer, target.roleTitle].some((name) => {
    const words = foldWords(name)
    return words !== "" && line.includes(` ${words} `)
  })
}

/** Lower case, accents and invisible characters removed, every non-letter/digit run as one space. */
function foldWords(text: string): string {
  return text
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}
