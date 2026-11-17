import { type DirectionAllowance, directionAllowance, sentencesOf } from "./company-direction.js"
import { type CoverLetterContent, type DocumentLine, type ResumeContent } from "./document-model.js"
import { type LetterKeywordCap } from "./letter-keyword-cap.js"
import { dedupeLines, meaningKey } from "./line-text.js"
import { type ClaimContext, type LineKind } from "./claim-types.js"
import { checkLine } from "./claim-line.js"
import { isDirectionSentence, isWholeParagraph, sentencesOfLine } from "./direction-sentences.js"
import { isMeaningChecked } from "./mechanical-line.js"

/**
 * The line's sentences that pass the claim check alone or hold a judged verdict, joined, or null when none
 * does or nothing was cut. The joined line passes with its own carved verdict, added to a copy of
 * `ctx.meaningChecked`.
 */
export function supportedSentences(
  line: DocumentLine,
  ctx: ClaimContext,
  kind: LineKind = "experience_bullet",
  allowance: DirectionAllowance | null = null
): DocumentLine | null {
  const sentences = sentencesOf(line.text)
  if (sentences.length < 2) return null
  // `working` lets only the first direction sentence pass on its own; `allowance` is committed only once
  // the joined line passes, because the joined line carries that same sentence and must strip it again.
  const working: DirectionAllowance = { used: allowance?.used ?? false }
  const passing = sentences.filter((sentence) => {
    const trial: DirectionAllowance = { used: working.used }
    const checked = checkLine({ text: sentence, factIds: line.factIds }, ctx, kind, allowance === null ? null : trial)
    if (checked !== null) return false
    working.used = trial.used
    return true
  })
  if (passing.length === 0 || passing.length === sentences.length) return null
  const joined: DocumentLine = { text: passing.join(" "), factIds: line.factIds }
  const committed: DirectionAllowance = { used: allowance?.used ?? false }
  // Every kept sentence was judged (or passes without one), so the joined text is judged too. Hard fails
  // still decide: the carve only answers the claim-wording question the judge answered for the parts.
  const carve = new Set(ctx.meaningChecked)
  carve.add(meaningKey(joined.text, joined.factIds))
  if (checkLine(joined, { ...ctx, meaningChecked: carve }, kind, allowance === null ? null : committed) !== null) return null
  if (allowance !== null) allowance.used = committed.used
  return joined
}

/**
 * Resume lines only: a tailored bullet that fails the claim check falls back to the approved wording of
 * the first fact it cites, which passes by construction, instead of blocking the whole resume; a failing
 * summary or skills line is dropped. A
 * fallback that would repeat a line already in its list is dropped. Lines with unknown or no facts, a
 * contact detail, or a fallback that still fails are left alone, so `validateDocument` blocks them as
 * before. Headings are never changed. Cover letters keep the whole-document block.
 *
 * `ctx.facts`: the validation map (fact text plus its section heading); `ctx.wording`: each fact's own text.
 * A resume never names a target, so `ctx.target` is ignored.
 */
export function fallBackToFactWording(resume: ResumeContent, ctx: ClaimContext): Readonly<{ resume: ResumeContent; replaced: number }> {
  const resumeCtx: ClaimContext = { ...ctx, target: null }
  // The sentence trim and the fallback itself are checked with no verdicts.
  const unjudged: ClaimContext = { ...resumeCtx, meaningChecked: new Set() }
  let replaced = 0
  // Bullets fall back to their fact's wording; a summary or skills line that fails is dropped, as a
  // role's fact would read wrongly there.
  const repair = (lines: readonly DocumentLine[], mode: "fallback" | "drop", kind: LineKind): DocumentLine[] => {
    const out: DocumentLine[] = []
    for (const line of lines) {
      const failure = checkLine(line, resumeCtx, kind)
      const first = line.factIds[0]
      const original = first === undefined ? undefined : ctx.wording?.get(first)
      if (failure === null || failure.ok || failure.reason !== "unsupported_claim" || first === undefined || original === undefined) {
        out.push(line)
        continue
      }
      // First keep the line's own sentences that pass; only when none does, use the fact's wording.
      const trimmed = supportedSentences(line, unjudged, kind)
      if (trimmed !== null) {
        replaced += 1
        out.push(trimmed)
        continue
      }
      if (mode === "drop") {
        replaced += 1
        continue
      }
      const fallback: DocumentLine = { text: original, factIds: [first] }
      if (checkLine(fallback, unjudged, kind) !== null) {
        out.push(line)
        continue
      }
      replaced += 1
      out.push(fallback)
    }
    // EPIC-0012 Revision 2, R13: dedupe the finished list, keeping the first copy and never emptying it.
    return dedupeLines(out)
  }
  return {
    resume: {
      ...resume,
      summary: repair(resume.summary, "drop", "summary"),
      experience: resume.experience.map((entry) => ({ ...entry, bullets: repair(entry.bullets, "fallback", "experience_bullet") })),
      skills: repair(resume.skills, "drop", "skills"),
      education: resume.education,
    },
    replaced,
  }
}

/**
 * Cover letters: a paragraph that fails the claim check keeps only its sentences that pass on their own
 * (an added "Leadership is a skill I rely on." goes, the facts around it stay). "Pass on their own" means
 * the sentence either passes the claim check outright or carries the meaning check's own `supported: true`
 * verdict: a refused paragraph is asked about sentence by sentence, so a refused sentence is the only one
 * that goes and its neighbours keep their verdict. A paragraph with no passing sentence is dropped while at
 * least one paragraph remains; otherwise it is kept and `validateDocument` blocks the letter as before.
 * Names-target, contact and unknown-fact failures are never trimmed.
 *
 * `checked` comes back with one carved verdict per kept subset: its sentences were each judged, so the
 * joined paragraph they make is judged too, and the later validation accepts it without a new call. The
 * same carve `settleCappedLetter` makes when the keyword cap trims a paragraph.
 */
export function dropUnsupportedSentences(
  letter: CoverLetterContent,
  ctx: ClaimContext
): Readonly<{ letter: CoverLetterContent; dropped: number; checked: ReadonlySet<string> }> {
  const { posting } = ctx
  let dropped = 0
  const kept: DocumentLine[] = []
  const checked = new Set(ctx.meaningChecked)
  // Every check below reads `checked` as it grows: the carve below adds to the very set `judged` holds.
  const judged: ClaimContext = { ...ctx, meaningChecked: checked }
  // One allowance for the whole letter (design 2d). A failed trial does not spend it, so trimming below
  // still sees it free; only a line that keeps its quoted direction commits the spend.
  const allowance = directionAllowance()
  letter.paragraphs.forEach((paragraph, index) => {
    const trial: DirectionAllowance = { used: allowance.used }
    const failure = checkLine(paragraph, judged, "letter_paragraph", trial)
    if (failure === null || failure.ok || failure.reason !== "unsupported_claim") {
      allowance.used = trial.used
      kept.push(paragraph)
      return
    }
    // Every sentence carries its own verdict (or passes without one): the paragraph is supported, it only
    // lacks a paragraph-level verdict because it was judged sentence by sentence. Carve it and keep it whole.
    // A direction paragraph is never split this way: its quote only means something next to the claim.
    const sentences = sentencesOfLine(paragraph)
    const passing = sentences.filter((sentence) => checkLine(sentence, judged, "letter_paragraph", directionAllowance()) === null)
    if (failure.hardFail === undefined && !isWholeParagraph(paragraph, posting) && passing.length === sentences.length) {
      allowance.used = trial.used
      kept.push(paragraph)
      checked.add(meaningKey(paragraph.text, paragraph.factIds))
      return
    }
    const trimmed = supportedSentences(paragraph, isWholeParagraph(paragraph, posting) ? { ...ctx, meaningChecked: new Set() } : judged, "letter_paragraph", allowance)
    dropped += 1
    if (trimmed !== null) {
      kept.push(trimmed)
      // The carve: each kept sentence was judged (or passes without a verdict), so the paragraph they make
      // is judged too. `validateDocument` then accepts it without sending it to the judge again.
      checked.add(meaningKey(trimmed.text, trimmed.factIds))
    } else if (kept.length === 0 && index === letter.paragraphs.length - 1) kept.push(paragraph)
  })
  return { letter: { ...letter, paragraphs: kept }, dropped, checked }
}

/**
 * EPIC-0012 Revision 3, R17: the cap never blocks. A paragraph the letter cap trimmed is re-checked as the
 * text the cap would store, and a trimmed paragraph that fails is dropped, or replaced by its untrimmed form
 * when it is the only body paragraph left (`restored`, so the letter goes back over the cap as R14 allows for
 * the last body text). A trimmed paragraph holding only direction sentences is dropped too (M1): it says
 * nothing about the Candidate. A paragraph the cap did not trim is kept as is, so a failure there blocks
 * exactly as it would have with no cap.
 *
 * `checked` is the meaning-check verdicts for the settled letter: a verdict carries from a judged paragraph
 * to the text the cap left of it, never from a mechanical one. Counts only for the caller's log line.
 */
export function settleCappedLetter(
  capped: LetterKeywordCap,
  ctx: ClaimContext
): Readonly<{ letter: CoverLetterContent; checked: ReadonlySet<string>; paragraphsDropped: number; restored: number }> {
  const { posting } = ctx
  // A carved verdict: the remaining sentences are a subset of the judged ones, so a hard fail still decides.
  const checked = new Set(ctx.meaningChecked)
  for (const { from, to } of capped.trimmed) {
    if (isMeaningChecked(ctx.meaningChecked, from)) checked.add(meaningKey(to.text, to.factIds))
  }
  const settling: ClaimContext = { ...ctx, meaningChecked: checked }
  const byParagraph = new Map(capped.trimmed.map((trimmed) => [trimmed.to, trimmed] as const))
  // First pass: which capped paragraphs pass on their capped text, with the direction allowance as
  // validateDocument reads the letter, and one M1 check for a paragraph left holding only quoted directions.
  const allowance = directionAllowance()
  const passes: boolean[] = []
  for (const paragraph of capped.letter.paragraphs) {
    const trial: DirectionAllowance = { used: allowance.used }
    const failure = checkLine(paragraph, settling, "letter_paragraph", trial)
    const onlyDirection =
      byParagraph.has(paragraph) && posting !== null && posting.direction.length > 0 && sentencesOf(paragraph.text).every((sentence) => isDirectionSentence(sentence, posting))
    const pass = failure === null && !onlyDirection
    if (pass) allowance.used = trial.used
    passes.push(pass)
  }
  // Second pass: keep what passes, drop a failing trimmed paragraph while another paragraph is kept, and
  // restore the untrimmed form only when it is all that is left, so the letter is never emptied.
  const paragraphs: DocumentLine[] = []
  let kept = capped.letter.paragraphs.filter((paragraph, index) => !byParagraph.has(paragraph) || passes[index] === true).length
  let paragraphsDropped = 0
  let restored = 0
  capped.letter.paragraphs.forEach((paragraph, index) => {
    const trimmed = byParagraph.get(paragraph)
    // A paragraph the cap did not trim is kept as is: validation blocks on it exactly as it would have.
    if (trimmed === undefined) {
      paragraphs.push(paragraph)
      return
    }
    if (passes[index] === true) {
      paragraphs.push(paragraph)
      return
    }
    if (kept > 0) {
      paragraphsDropped += 1
      return
    }
    restored += 1
    kept += 1
    paragraphs.push(trimmed.from)
  })
  return { letter: { ...capped.letter, paragraphs }, checked, paragraphsDropped, restored }
}
