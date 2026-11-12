import { normaliseForAts } from "../ats/ats-score.js"
import { GENERIC_SECTION_WORDS, MONTH_AND_DAY_NAMES, OPENING_WORDS, factClaimsMissing, numbersIn, postingTermsIn, stem, supportInflationVerb, unsupportedScopeVerbs } from "../career-profile/claim-check.js"
import { type DirectionAllowance, completionWordIn, directionAllowance, sentencesOf, unsourcedQuotationIn, withoutDirectionQuote } from "./company-direction.js"
import { containsContactDetail } from "./contact-detail.js"
import { type ContactHeader, type CoverLetterContent, type DocumentContent, type DocumentLine, type ResumeContent } from "./document-model.js"
import { type LetterKeywordCap } from "./letter-keyword-cap.js"
import { dedupeLines, meaningKey, mechanicalKey } from "./line-text.js"

export type ClaimFailureReason = "unsupported_claim" | "unknown_fact" | "no_fact" | "contact_detail" | "names_target"

/**
 * EPIC-0012 Revision 2, 2.3: the reason code of a hard fail, for count-only monitoring. A hard fail is a
 * failure no meaning-check answer can release (the claim and number checks count too, as the design lists).
 */
export type HardFailCode =
  | "borrowed_name"
  | "gap"
  | "role_noun"
  | "support_inflation"
  | "completion_word"
  | "posting_term"
  | "number"
  | "claim_word"
  | "names_target"
  | "unsourced_quote"

export type DocumentValidation =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false
      reason: ClaimFailureReason
      /** The document line that failed, shown in C-DOC-3 as "Claim: …". */
      claim: string
      /** The words or numbers in it that no cited fact supports. */
      unsupported: string[]
      /** Set when the failure is a hard fail (see `HardFailCode`); never carries line text. */
      hardFail?: HardFailCode
    }>

/** What a cover letter may name without a fact: the employer and role it is addressed to. */
export type LetterTarget = Readonly<{ employer: string; roleTitle: string }>

/**
 * EPIC-0012 rule 2 (design 1c): role nouns a line may not add. The posting's own title adds its last
 * meaningful word at the call site. These are hard fails, so the meaning check never lends them.
 */
export const ROLE_NOUNS: ReadonlySet<string> = new Set([
  "consultant", "analyst", "engineer", "developer", "designer", "specialist", "officer", "advisor", "adviser",
  "associate", "coordinator", "scientist", "researcher", "administrator", "accountant", "auditor", "strategist",
  "executive", "partner", "technician", "assistant",
])

/** At most this many posting terms per line (design 1b). A line with more falls back instead of borrowing. */
export const POSTING_TERM_LIMIT = 2

/** The posting window the generation prompt uses; posting terms are drawn from the same first 12,000 characters. */
const POSTING_TEXT_LIMIT = 12_000

/**
 * EPIC-0012 Revision 2, R8: each cited fact's own wording. The service passes the `wording` map; callers
 * that only have the validation map ("fact text. heading") fall back to the text before the heading.
 */
export type FactWording = ReadonlyMap<string, string> | null

/** One cited fact's own text, never its section heading. */
function factTextOf(id: string, facts: ReadonlyMap<string, string>, wording: FactWording): string {
  const exact = wording?.get(id)
  if (exact !== undefined) return exact
  const value = facts.get(id) ?? ""
  const headingAt = value.indexOf(". ")
  return headingAt === -1 ? value : value.slice(0, headingAt)
}

/**
 * EPIC-0012 Revision 2, 2.1: a line passes without the judge only when it is mechanical: one cited
 * fact's own wording, two or more whole fact wordings joined, or a reordered or reduced list from one
 * fact's list. Everything else is a reword and reaches the meaning check.
 */
function isMechanicalLine(
  text: string,
  factIds: readonly string[],
  facts: ReadonlyMap<string, string>,
  wording: FactWording,
  kind: LineKind
): boolean {
  if (factIds.length === 0) return false
  const line = mechanicalKey(text, kind === "letter_paragraph")
  if (line === "") return false
  const wordings = factIds.map((id) => mechanicalKey(factTextOf(id, facts, wording), kind === "letter_paragraph"))
  if (wordings.some((fact) => fact !== "" && fact === line)) return true
  return joinedFactWordings(line, wordings) || listFromOneFact(line, wordings, kind)
}

/** Two or more whole fact wordings joined by ", and ", " and ", "; " or ". " (Revision 2, 2.1). */
function joinedFactWordings(line: string, wordings: readonly string[]): boolean {
  const facts = [...new Set(wordings.filter((fact) => fact !== ""))]
  const separators = [", and ", " and ", "; ", ". "]
  const walk = (rest: string, used: number): boolean => {
    if (used >= 2 && rest === "") return true
    for (const fact of facts) {
      if (!rest.startsWith(fact)) continue
      const after = rest.slice(fact.length)
      if (after === "" && used + 1 >= 2) return true
      for (const separator of separators) {
        if (after.startsWith(separator) && walk(after.slice(separator.length), used + 1)) return true
      }
    }
    return false
  }
  return walk(line, 0)
}

/** Labels a technologies bullet may use and still be a "Label: a, b, c" list (Revision 2, 2.1). */
const TECHNOLOGY_LABELS: ReadonlySet<string> = new Set([
  "language", "languages", "tool", "tools", "technology", "technologies", "tech", "stack", "skill", "skills",
  "framework", "frameworks", "library", "libraries", "platform", "platforms", "database", "databases", "cloud",
  "devops", "testing", "methodology", "methodologies", "technical", "core", "key", "other",
])

/** A skills line, or a "Label: a, b, c" bullet, whose comma items all sit in one cited fact's list (2.1). */
function listFromOneFact(line: string, wordings: readonly string[], kind: LineKind): boolean {
  let body = line
  if (kind !== "skills") {
    const colon = body.indexOf(":")
    if (colon === -1) return false
    const label = body.slice(0, colon).trim().split(/\s+/)
    if (label.length === 0 || !label.every((word) => TECHNOLOGY_LABELS.has(word))) return false
    body = body.slice(colon + 1)
  }
  const items = listItems(body)
  if (items.length === 0) return false
  return wordings.some((fact) => {
    const factItems = listItems(fact)
    return factItems.length >= 2 && items.every((item) => factItems.includes(item))
  })
}

function listItems(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter((item) => item !== "")
}

/** True when a meaning-check verdict exists for this line text and its fact ids (Revision 2, R15). */
function isMeaningChecked(meaningChecked: ReadonlySet<string>, line: DocumentLine): boolean {
  return meaningChecked.has(meaningKey(line.text, line.factIds))
}

/** Title words that carry no role meaning ("Head of Finance" ends on "finance"). */
const POSTING_STOPWORDS: ReadonlySet<string> = new Set(["a", "an", "and", "the", "of", "at", "in", "for", "to", "with", "on", "or"])

/** A title's level or revision, not a role noun: "Engineer II" ends on "engineer". */
const TITLE_NUMBER = /^(?:\d+|i{1,3}|iv|v|vi{0,3}|ix|x)$/

/**
 * EPIC-0012 rule 2 (design 1a, 1c): what the posting lends the truth guard. `text` is normalised and empty
 * when the posting lends no terms; `gaps` are the posting's ATS keywords the profile does not state;
 * `roleNouns` are the posting title's last meaningful word plus `ROLE_NOUNS`; `names` are the words the raw
 * posting writes with a capital first letter or in all caps and never in lower case, wherever they stand,
 * which no line may borrow in any case (Revision 2, R10); `direction` holds the posting's verified
 * forward-looking quotes as the posting row stores them (rule 4, design 2b). Only the generation prompt
 * drops the quotes that name the target, so a stored quote may still name it: `namesTarget` runs on the
 * full line before any span is stripped, so a letter that quotes one that way is still blocked.
 */
export type PostingGuard = Readonly<{
  text: string
  gaps: readonly string[]
  roleNouns: readonly string[]
  names: readonly string[]
  direction: readonly string[]
}>

/**
 * Builds the posting side of the guard. `hasKeywords` is false for a pasted posting whose keywords are not
 * known yet: risk R2 says it lends no posting terms, since the gap list cannot run either.
 */
export function postingGuard(
  postingText: string,
  roleTitle: string | null,
  gapKeywords: readonly string[] = [],
  hasKeywords = true,
  direction: readonly string[] = []
): PostingGuard {
  // "(m/f/d)" and "[remote]" are not title words.
  const title = (roleTitle ?? "").replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")
  const words = normaliseForAts(title)
    .split(" ")
    .filter((word) => word.length > 1 && !POSTING_STOPWORDS.has(word) && !TITLE_NUMBER.test(word))
  const titleNoun = words.at(-1)
  return {
    text: hasKeywords ? normaliseForAts(postingText.slice(0, POSTING_TEXT_LIMIT)) : "",
    gaps: gapKeywords,
    roleNouns: [...new Set([...(titleNoun === undefined ? [] : [titleNoun]), ...ROLE_NOUNS])],
    names: borrowedNames(postingText.slice(0, POSTING_TEXT_LIMIT)),
    direction,
  }
}

/**
 * Where a line sits: the bridge allowance differs by section (design 1b, 1c).
 * EPIC-0014 D5 adds `outreach_ask`: one Ask sentence of an Outreach text, which
 * cites no facts. It is treated like `education` for `judgedKind` (the claim
 * check alone; it never demands a judge verdict on its own), so any number, date,
 * capitalised name, listed skill, title or qualification in it still fails. No
 * documents line uses it, so every existing decision is unchanged (AC 13.1).
 */
export type LineKind = "summary" | "experience_heading" | "experience_bullet" | "skills" | "education" | "letter_paragraph" | "outreach_ask"

/** Only prose lines may lend a posting term; a skills, education or heading line may not. */
const POSTING_TERM_KINDS: ReadonlySet<LineKind> = new Set(["summary", "experience_bullet", "letter_paragraph"])

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
 * `facts` must hold the approved version's facts only; a draft fact ID is
 * therefore "unknown_fact".
 */
export function validateDocument(
  content: DocumentContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null = null,
  contact: ContactHeader | null = null,
  meaningChecked: ReadonlySet<string> = new Set(),
  posting: PostingGuard | null = null,
  wording: FactWording = null
): DocumentValidation {
  // One direction allowance per pass over the letter (design 2d): a second quoted direction sentence fails.
  const allowance = directionAllowance()
  for (const { line, kind } of kindedLines(content)) {
    const failure = checkLine(line, facts, target, contact, meaningChecked, kind, posting, allowance, wording)
    if (failure) return failure
  }
  return { ok: true }
}

/**
 * Resume lines only: a tailored bullet that fails the claim check falls back to the approved wording of
 * the first fact it cites, which passes by construction, instead of blocking the whole resume; a failing
 * summary or skills line is dropped. A
 * fallback that would repeat a line already in its list is dropped. Lines with unknown or no facts, a
 * contact detail, or a fallback that still fails are left alone, so `validateDocument` blocks them as
 * before. Headings are never changed. Cover letters keep the whole-document block.
 *
 * `facts`: the validation map (fact text plus its section heading); `wording`: each fact's own text.
 */
export function fallBackToFactWording(
  resume: ResumeContent,
  facts: ReadonlyMap<string, string>,
  wording: ReadonlyMap<string, string>,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string> = new Set(),
  posting: PostingGuard | null = null
): Readonly<{ resume: ResumeContent; replaced: number }> {
  let replaced = 0
  // Bullets fall back to their fact's wording; a summary or skills line that fails is dropped, as a
  // role's fact would read wrongly there.
  const repair = (lines: readonly DocumentLine[], mode: "fallback" | "drop", kind: LineKind): DocumentLine[] => {
    const out: DocumentLine[] = []
    for (const line of lines) {
      const failure = checkLine(line, facts, null, contact, meaningChecked, kind, posting, null, wording)
      const first = line.factIds[0]
      const original = first === undefined ? undefined : wording.get(first)
      if (failure === null || failure.ok || failure.reason !== "unsupported_claim" || first === undefined || original === undefined) {
        out.push(line)
        continue
      }
      // First keep the line's own sentences that pass; only when none does, use the fact's wording.
      const trimmed = supportedSentences(line, facts, contact, null, kind, posting, null, wording)
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
      if (checkLine(fallback, facts, null, contact, new Set(), kind, posting, null, wording) !== null) {
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
 * Lines worth a meaning check: they fail the word check only on lower-case wording, so every number,
 * listed skill, title, qualification and capitalised name in them already comes from their cited facts,
 * and they cite only known facts, hold no contact detail and don't name the target. Everything else is
 * decided by code alone.
 */
export function needsMeaningCheck(
  line: DocumentLine,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null,
  contact: ContactHeader | null,
  kind: LineKind = "experience_bullet",
  posting: PostingGuard | null = null,
  wording: FactWording = null
): boolean {
  if (line.factIds.length === 0) return false
  // Each check gets its own direction allowance: the meaning check judges this line alone, and the letter
  // wide cap is enforced when the letter is trimmed and validated (design 2d).
  const strict = checkLine(line, facts, target, contact, new Set(), kind, posting, directionAllowance(), wording)
  if (strict === null || strict.ok || strict.reason !== "unsupported_claim") return false
  const accepted = checkLine(line, facts, target, contact, new Set([meaningKey(line.text, line.factIds)]), kind, posting, directionAllowance(), wording)
  return accepted === null
}

/**
 * EPIC-0014 D5: the same claim check for one sentence. `validateDocument` takes
 * a whole document; an Outreach line is checked alone, exactly as the cover
 * letter's sentences are repaired. Additive: it changes no documents decision.
 * Returns `ok: true` when the sentence passes, or the failure itself, so the
 * outreach pipeline can record the part's position and show nothing about it.
 */
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
  return checkLine(line, facts, target, contact, meaningChecked, kind, posting, null, wording, extraOpeners) ?? { ok: true }
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
  facts: ReadonlyMap<string, string>,
  target: LetterTarget,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string> = new Set(),
  posting: PostingGuard | null = null,
  wording: FactWording = null
): Readonly<{ letter: CoverLetterContent; dropped: number; checked: ReadonlySet<string> }> {
  let dropped = 0
  const kept: DocumentLine[] = []
  const checked = new Set(meaningChecked)
  // One allowance for the whole letter (design 2d). A failed trial does not spend it, so trimming below
  // still sees it free; only a line that keeps its quoted direction commits the spend.
  const allowance = directionAllowance()
  letter.paragraphs.forEach((paragraph, index) => {
    const trial: DirectionAllowance = { used: allowance.used }
    const failure = checkLine(paragraph, facts, target, contact, checked, "letter_paragraph", posting, trial, wording)
    if (failure === null || failure.ok || failure.reason !== "unsupported_claim") {
      allowance.used = trial.used
      kept.push(paragraph)
      return
    }
    // Every sentence carries its own verdict (or passes without one): the paragraph is supported, it only
    // lacks a paragraph-level verdict because it was judged sentence by sentence. Carve it and keep it whole.
    // A direction paragraph is never split this way: its quote only means something next to the claim.
    const sentences = sentencesOfLine(paragraph)
    const passing = sentences.filter((sentence) => checkLine(sentence, facts, target, contact, checked, "letter_paragraph", posting, directionAllowance(), wording) === null)
    if (failure.hardFail === undefined && !isWholeParagraph(paragraph, posting) && passing.length === sentences.length) {
      allowance.used = trial.used
      kept.push(paragraph)
      checked.add(meaningKey(paragraph.text, paragraph.factIds))
      return
    }
    const trimmed = supportedSentences(paragraph, facts, contact, target, "letter_paragraph", posting, allowance, wording, isWholeParagraph(paragraph, posting) ? new Set() : checked)
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

/**
 * The sentence a blocked letter names: the first one in the first failing paragraph that fails on its own
 * under the verdicts the run holds. The stored claim is then the sentence the Candidate can act on, not the
 * paragraph that held it. Null when no single sentence fails (the paragraph as a whole does), so the caller
 * keeps the paragraph.
 */
export function refusedSentence(
  letter: CoverLetterContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string>,
  posting: PostingGuard | null = null,
  wording: FactWording = null
): string | null {
  for (const paragraph of letter.paragraphs) {
    if (checkLine(paragraph, facts, target, contact, meaningChecked, "letter_paragraph", posting, directionAllowance(), wording) === null) continue
    for (const sentence of sentencesOfLine(paragraph)) {
      if (checkLine(sentence, facts, target, contact, meaningChecked, "letter_paragraph", posting, directionAllowance(), wording) !== null) return sentence.text
    }
  }
  return null
}

/**
 * EPIC-0012 Revision 2, R16: true when a letter blocks only on lines that a failed meaning check never
 * judged. Any hard-fail line makes this false, so the letter still blocks on it.
 */
export function letterBlocksOnlyOnUnjudged(
  letter: CoverLetterContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string>,
  posting: PostingGuard | null = null,
  wording: FactWording = null
): boolean {
  const allowance = directionAllowance()
  let blocking = 0
  let unjudged = 0
  for (const paragraph of letter.paragraphs) {
    const trial: DirectionAllowance = { used: allowance.used }
    const failure = checkLine(paragraph, facts, target, contact, meaningChecked, "letter_paragraph", posting, trial, wording)
    if (failure === null) {
      allowance.used = trial.used
      continue
    }
    blocking += 1
    if (needsMeaningCheck(paragraph, facts, target, contact, "letter_paragraph", posting, wording) && !isMeaningChecked(meaningChecked, paragraph)) unjudged += 1
  }
  return blocking > 0 && blocking === unjudged
}

/**
 * The line's sentences that pass the claim check alone or hold a judged verdict, joined, or null when none
 * does or nothing was cut. `checked` gains the joined line's carved verdict once it passes.
 */
function supportedSentences(
  line: DocumentLine,
  facts: ReadonlyMap<string, string>,
  contact: ContactHeader | null,
  target: LetterTarget | null = null,
  kind: LineKind = "experience_bullet",
  posting: PostingGuard | null = null,
  allowance: DirectionAllowance | null = null,
  wording: FactWording = null,
  meaningChecked: ReadonlySet<string> = new Set()
): DocumentLine | null {
  const sentences = sentencesOf(line.text)
  if (sentences.length < 2) return null
  // `working` lets only the first direction sentence pass on its own; `allowance` is committed only once
  // the joined line passes, because the joined line carries that same sentence and must strip it again.
  const working: DirectionAllowance = { used: allowance?.used ?? false }
  const passing = sentences.filter((sentence) => {
    const trial: DirectionAllowance = { used: working.used }
    const checked = checkLine({ text: sentence, factIds: line.factIds }, facts, target, contact, meaningChecked, kind, posting, allowance === null ? null : trial, wording)
    if (checked !== null) return false
    working.used = trial.used
    return true
  })
  if (passing.length === 0 || passing.length === sentences.length) return null
  const joined: DocumentLine = { text: passing.join(" "), factIds: line.factIds }
  const committed: DirectionAllowance = { used: allowance?.used ?? false }
  // Every kept sentence was judged (or passes without one), so the joined text is judged too. Hard fails
  // still decide: the carve only answers the claim-wording question the judge answered for the parts.
  const carve = new Set(meaningChecked)
  carve.add(meaningKey(joined.text, joined.factIds))
  if (checkLine(joined, facts, target, contact, carve, kind, posting, allowance === null ? null : committed, wording) !== null) return null
  if (allowance !== null) allowance.used = committed.used
  return joined
}

function checkLine(
  line: DocumentLine,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string> = new Set(),
  kind: LineKind = "experience_bullet",
  posting: PostingGuard | null = null,
  allowance: DirectionAllowance | null = null,
  wording: FactWording = null,
  extraOpeners: ReadonlySet<string> | null = null
): DocumentValidation | null {
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

function supportText(line: DocumentLine, facts: ReadonlyMap<string, string>): string {
  return line.factIds.map((id) => facts.get(id) ?? "").join(". ")
}

/**
 * EPIC-0012 Revision 3, R19: what a document line may quote. Only the posting's verified direction quotes
 * (`posting.direction`, already empty with the direction flag off) and the validation text of the facts the
 * line cites. The posting text itself is not a source, so with the flag off nothing may be quoted from it.
 */
function quotationSources(line: DocumentLine, facts: ReadonlyMap<string, string>, posting: PostingGuard | null): string[] {
  return [...(posting?.direction ?? []), ...line.factIds.map((id) => facts.get(id) ?? "")]
}

function unsupportedClaim(line: DocumentLine, unsupported: string[], hardFail?: HardFailCode): DocumentValidation {
  return hardFail === undefined
    ? { ok: false, reason: "unsupported_claim", claim: line.text, unsupported }
    : { ok: false, reason: "unsupported_claim", claim: line.text, unsupported, hardFail }
}

/**
 * EPIC-0012 Revision 2, 2.3: how many draft lines (letter: sentences) fail for each hard-fail reason, run on
 * the model's draft before the meaning check. Counts only: no line text, no fact, no posting word.
 */
export function hardFailCounts(
  resume: ResumeContent,
  letter: CoverLetterContent,
  facts: ReadonlyMap<string, string>,
  target: LetterTarget | null,
  contact: ContactHeader | null,
  posting: PostingGuard | null,
  wording: FactWording
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  const count = (failure: DocumentValidation | null) => {
    if (failure !== null && !failure.ok && failure.hardFail !== undefined) counts[failure.hardFail] = (counts[failure.hardFail] ?? 0) + 1
  }
  for (const { line, kind } of kindedLines(resume)) count(checkLine(line, facts, null, contact, new Set(), kind, posting, null, wording))
  // One allowance for the letter, as a validation pass has, so a second direction sentence is not stripped.
  // A letter line is a paragraph: the direction sentence is stripped from the paragraph, and a completion
  // word in another of its sentences is then visible (R11).
  const allowance = directionAllowance()
  for (const paragraph of letter.paragraphs) {
    count(checkLine(paragraph, facts, target, contact, new Set(), "letter_paragraph", posting, allowance, wording))
  }
  return counts
}

/** An ATS keyword the posting asks for, the profile does not state, and the line's cited facts don't state. */
function gapKeywordIn(text: string, support: string, gaps: readonly string[]): string | undefined {
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
function borrowedNameIn(text: string, support: string, names: readonly string[]): string | undefined {
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

/**
 * EPIC-0012 Revision 2, R10: the words the raw posting writes as names. A word counts when the posting
 * writes it at least once with a capital first letter or in all caps and never writes it in lower case,
 * wherever it stands: a line start, after ":", or in a list. Position no longer matters, so a posting
 * that lists "Tableau experience is a plus." or "Tools: Snowflake, …" lends neither word. Stop words,
 * `OPENING_WORDS`, generic section labels and month and day names are not names. A domain word a posting
 * only writes capitalised ("Sustainability consulting firm.") cannot be lent, which fails safe.
 */
function borrowedNames(postingText: string): string[] {
  // Dotted acronyms are one word ("E.S.G." is "ESG"), as in `matchedWords`.
  const text = postingText.replace(/\b(?:\p{L}\.){2,}\p{L}\b/gu, (dotted) => dotted.replaceAll(".", ""))
  const matches = [...text.matchAll(/[\p{L}\p{N}]+/gu)]
  const writtenLowerCase = new Set(matches.filter((match) => match[0] === match[0].toLowerCase()).map((match) => match[0]))
  const names = new Set<string>()
  for (const match of matches) {
    const word = match[0]
    if (word.length < 2 || !/\p{Lu}/u.test(word)) continue
    const lower = word.toLowerCase()
    if (writtenLowerCase.has(lower) || isOrdinaryWord(lower)) continue
    names.add(lower)
  }
  return [...names]
}

/** Words a posting may capitalise without lending a name (Revision 2, R10). */
function isOrdinaryWord(word: string): boolean {
  return (
    POSTING_STOPWORDS.has(word) ||
    OPENING_WORDS.has(word) ||
    GENERIC_SECTION_WORDS.has(word) ||
    MONTH_AND_DAY_NAMES.has(word)
  )
}

/** A role noun in the line that its cited facts do not state, matched whole and across a plural. */
function roleNounIn(text: string, support: string, nouns: readonly string[]): string | undefined {
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

/** Every claim-bearing line of a document with the section it sits in, for the bridge allowance and its hard fails. */
function kindedLines(content: DocumentContent): Array<Readonly<{ line: DocumentLine; kind: LineKind }>> {
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

/** True when the sentence is a direction sentence: it quotes a stored span inside the frame words (R3, R4). */
function isDirectionSentence(sentence: string, posting: PostingGuard): boolean {
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
  facts: ReadonlyMap<string, string>,
  target: LetterTarget,
  contact: ContactHeader | null,
  meaningChecked: ReadonlySet<string>,
  posting: PostingGuard | null,
  wording: FactWording
): Readonly<{ letter: CoverLetterContent; checked: ReadonlySet<string>; paragraphsDropped: number; restored: number }> {
  // A carved verdict: the remaining sentences are a subset of the judged ones, so a hard fail still decides.
  const checked = new Set(meaningChecked)
  for (const { from, to } of capped.trimmed) {
    if (isMeaningChecked(meaningChecked, from)) checked.add(meaningKey(to.text, to.factIds))
  }
  const byParagraph = new Map(capped.trimmed.map((trimmed) => [trimmed.to, trimmed] as const))
  // First pass: which capped paragraphs pass on their capped text, with the direction allowance as
  // validateDocument reads the letter, and one M1 check for a paragraph left holding only quoted directions.
  const allowance = directionAllowance()
  const passes: boolean[] = []
  for (const paragraph of capped.letter.paragraphs) {
    const trial: DirectionAllowance = { used: allowance.used }
    const failure = checkLine(paragraph, facts, target, contact, checked, "letter_paragraph", posting, trial, wording)
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
