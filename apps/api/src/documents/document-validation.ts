import { type DirectionAllowance, directionAllowance } from "./company-direction.js"
import { type CoverLetterContent, type DocumentContent, type DocumentLine, type ResumeContent } from "./document-model.js"
import { meaningKey } from "./line-text.js"
import { type ClaimContext, type DocumentValidation, type LineKind } from "./claim-types.js"
import { checkLine, kindedLines } from "./claim-line.js"
import { sentencesOfLine } from "./direction-sentences.js"
import { isMeaningChecked } from "./mechanical-line.js"

/**
 * AC 5.3, in code: every line must cite approved Career Profile facts, and
 * every claim in it (number, date, capitalised word, and the lower-case
 * skills, titles and qualifications in DOCUMENT_CLAIM_WORDS) must appear in
 * the text of the facts it cites. Rephrasing and reordering pass because only
 * claims are compared (claim-check). The first failing line blocks the whole
 * document and is returned.
 *
 * SEC-403 r2: in a cover letter, a model line that names the target employer
 * or role title is blocked (`names_target`), with no context exemption. The
 * backend's greeting, opening, closing line and sign-off are not model lines
 * (only the body paragraphs are checked) and are not validated.
 *
 * SEC-401: a line with an email, a phone number or an identifying contact line
 * is blocked (`contact_detail`).
 *
 * EPIC-0012 rule 2: with a `PostingGuard`, a line may borrow at most two lower-case posting terms, and
 * only in a summary, experience bullet or letter paragraph that the meaning check accepts. A number,
 * capitalised word, acronym, listed skill, title, qualification, ATS gap keyword, role noun or out of
 * place posting term fails in code and no meaning check can lend it.
 *
 * EPIC-0012 rule 4: a cover letter may quote one verified direction of the employer (design 2d, 2e). The
 * quoted span is removed before the claim and number checks; the rest of the line is checked as usual.
 *
 * EPIC-0012 Revision 3, R19: any quotation in a judged line must repeat a stored direction quote or a cited
 * fact's own words. A span no source backs is `unsourced_quote`, a hard fail in every flag state.
 *
 * `ctx.facts` must hold the approved version's facts only; a draft fact ID is
 * therefore "unknown_fact".
 */
export function validateDocument(content: DocumentContent, ctx: ClaimContext): DocumentValidation {
  // One direction allowance per pass over the letter (design 2d): a second quoted direction sentence fails.
  const allowance = directionAllowance()
  for (const { line, kind } of kindedLines(content)) {
    const failure = checkLine(line, ctx, kind, allowance)
    if (failure) return failure
  }
  return { ok: true }
}

/**
 * Lines worth a meaning check: they fail the word check only on lower-case wording, so every number,
 * listed skill, title, qualification and capitalised name in them already comes from their cited facts,
 * and they cite only known facts, hold no contact detail and don't name the target. Everything else is
 * decided by code alone. The line is checked with no verdicts, so `ctx.meaningChecked` is ignored.
 */
export function needsMeaningCheck(line: DocumentLine, ctx: ClaimContext, kind: LineKind = "experience_bullet"): boolean {
  if (line.factIds.length === 0) return false
  // Each check gets its own direction allowance: the meaning check judges this line alone, and the letter
  // wide cap is enforced when the letter is trimmed and validated (design 2d).
  const strict = checkLine(line, { ...ctx, meaningChecked: new Set() }, kind, directionAllowance())
  if (strict === null || strict.ok || strict.reason !== "unsupported_claim") return false
  const accepted = checkLine(line, { ...ctx, meaningChecked: new Set([meaningKey(line.text, line.factIds)]) }, kind, directionAllowance())
  return accepted === null
}

/**
 * EPIC-0014 D5: the same claim check for one sentence. `validateDocument` takes
 * a whole document; an Outreach line is checked alone, exactly as the cover
 * letter's sentences are repaired. Additive: it changes no documents decision.
 * Returns `ok: true` when the sentence passes, or the failure itself, so the
 * outreach pipeline can record the part's position and show nothing about it.
 */
export function checkSentence(line: DocumentLine, ctx: ClaimContext, kind: LineKind = "outreach_ask", extraOpeners: ReadonlySet<string> | null = null): DocumentValidation {
  return checkLine(line, ctx, kind, null, extraOpeners) ?? { ok: true }
}

/**
 * The sentence a blocked letter names: the first one in the first failing paragraph that fails on its own
 * under the verdicts the run holds. The stored claim is then the sentence the Candidate can act on, not the
 * paragraph that held it. Null when no single sentence fails (the paragraph as a whole does), so the caller
 * keeps the paragraph.
 */
export function refusedSentence(letter: CoverLetterContent, ctx: ClaimContext): string | null {
  for (const paragraph of letter.paragraphs) {
    if (checkLine(paragraph, ctx, "letter_paragraph", directionAllowance()) === null) continue
    for (const sentence of sentencesOfLine(paragraph)) {
      if (checkLine(sentence, ctx, "letter_paragraph", directionAllowance()) !== null) return sentence.text
    }
  }
  return null
}

/**
 * EPIC-0012 Revision 2, R16: true when a letter blocks only on lines that a failed meaning check never
 * judged. Any hard-fail line makes this false, so the letter still blocks on it.
 */
export function letterBlocksOnlyOnUnjudged(letter: CoverLetterContent, ctx: ClaimContext): boolean {
  const allowance = directionAllowance()
  let blocking = 0
  let unjudged = 0
  for (const paragraph of letter.paragraphs) {
    const trial: DirectionAllowance = { used: allowance.used }
    const failure = checkLine(paragraph, ctx, "letter_paragraph", trial)
    if (failure === null) {
      allowance.used = trial.used
      continue
    }
    blocking += 1
    if (needsMeaningCheck(paragraph, ctx, "letter_paragraph") && !isMeaningChecked(ctx.meaningChecked, paragraph)) unjudged += 1
  }
  return blocking > 0 && blocking === unjudged
}

/**
 * EPIC-0012 Revision 2, 2.3: how many draft lines (letter: sentences) fail for each hard-fail reason, run on
 * the model's draft before the meaning check. Counts only: no line text, no fact, no posting word. The draft
 * is checked with no verdicts, and only the letter may name `ctx.target`.
 */
export function hardFailCounts(resume: ResumeContent, letter: CoverLetterContent, ctx: ClaimContext): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  const count = (failure: DocumentValidation | null) => {
    if (failure !== null && !failure.ok && failure.hardFail !== undefined) counts[failure.hardFail] = (counts[failure.hardFail] ?? 0) + 1
  }
  const letterCtx: ClaimContext = { ...ctx, meaningChecked: new Set() }
  const resumeCtx: ClaimContext = { ...letterCtx, target: null }
  for (const { line, kind } of kindedLines(resume)) count(checkLine(line, resumeCtx, kind))
  // One allowance for the letter, as a validation pass has, so a second direction sentence is not stripped.
  // A letter line is a paragraph: the direction sentence is stripped from the paragraph, and a completion
  // word in another of its sentences is then visible (R11).
  const allowance = directionAllowance()
  for (const paragraph of letter.paragraphs) {
    count(checkLine(paragraph, letterCtx, "letter_paragraph", allowance))
  }
  return counts
}
