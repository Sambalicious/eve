import { OUTREACH_BUDGETS, type OutreachKind, outreachLength, usableTarget } from "@eve/contracts"

import type { StoredOutreachSentence } from "../db/schema.js"
import { sentencesOf } from "../documents/company-direction.js"
import { type FactWording, type postingGuard, checkSentence, needsMeaningCheck } from "../documents/document-claims.js"
import { withoutEmDashes } from "../documents/document-generation.js"
import type { ContactHeader, DocumentLine } from "../documents/document-model.js"
import { meaningKey, sameLine } from "../documents/line-text.js"
import type { MeaningCheckItem } from "../documents/meaning-check.js"
import { capFailedSentence } from "./failed-sentence.js"

/**
 * EPIC-0014 architecture r1 D5, D6 and D13: everything about one Outreach Run
 * that is decided by code alone, with no database, clock or model. The service
 * owns the two gateway calls and the run lifecycle; this file owns the rules,
 * the per-sentence checks, the structure and budget rules, and which sentence a
 * blocked Run keeps.
 *
 * Quote rules that live elsewhere and are re-exported here so the pipeline has
 * one import surface: the 400 code point cap and the Reader-name comparison
 * (`failed-sentence.ts`, run by the repository under the row lock) and the
 * unfilled-token test (`@eve/contracts`, which the web applies so a template
 * with a hole in it is never shown as the sentence that failed).
 */
export { capFailedSentence, mentionsReaderName } from "./failed-sentence.js"
export { hasUnfilledPlaceholder } from "@eve/contracts"

/**
 * D5, step 5: the openers of the Copywriter's example asks that `OPENING_WORDS`
 * does not hold. Passed only for an Ask, as `extraOpeners`, so no documents
 * decision changes. Each is a function or modal word; every later capitalised
 * word of an Ask is still a claim.
 */
export const OUTREACH_OPENING_WORDS: ReadonlySet<string> = new Set([
  "would", "could", "can", "may", "might", "should", "will", "shall", "is", "are", "do", "does", "did",
  "any", "who", "whom", "how", "whether", "if", "open", "happy", "glad", "interested", "perhaps", "maybe",
  "let", "feel", "just", "no", "i'd", "i'll",
])

/** The outreach-only rule that dropped a sentence: a closed set, safe to count in a log line (D7). */
export type OutreachRule =
  | "bracket"
  | "emoji"
  | "markdown"
  | "link"
  | "caps_run"
  | "pay"
  | "eligibility"
  | "relationship"
  | "reader_praise"
  | "application_status"
  | "sign_off"
  | "greeting"
  | "mentions_eve"
  | "other_offers"
  | "ask_shape"

/** Where a part left the pipeline. Counts only, never text (D7). */
export type DroppedStage = "outreach_rules" | "claim" | "judge" | "structure" | "budget" | "duplicate"

/** A sentence the write call returned, after splitting, with what the checks and the quote need (D5, D13). */
export type Part = {
  /** Its order in the reply after splitting, starting at 0. */
  position: number
  /** The model's text for this part, trimmed only: what a blocked Run may quote. */
  original: string
  kind: "statement" | "ask"
  factIds: string[]
  /** Normalised for output: em dashes converted, whitespace collapsed. Tokens still unfilled. */
  text: string
  /** The form the code checks read: for an Ask, the tokens become "the role" and "the company" and nothing else changes (D5 step 4). */
  checkText: string
  /** The form the judge reads and the Run would store: tokens filled with the real names, for an Ask and a Statement alike (r7). */
  judgeText: string
  /** Null while the part is still a candidate for the text. */
  removed: DroppedStage | null
  /** Whether the shared check found a failure that code alone cannot release. */
  needsJudge: boolean
}

/** The role title and company as shown on the Application. */
export type TargetNames = Readonly<{ company: string | null; roleTitle: string | null }>

/** The Run's result: the writers receive no dropped sentence (D11, D13). */
export type PipelineResult =
  | Readonly<{ outcome: "ready"; ready: ReadyBody; parts: readonly Part[]; bodyChars: number; namesFallback: boolean }>
  | Readonly<{ outcome: "blocked"; quote: string | null; parts: readonly Part[] }>
  | Readonly<{ outcome: "over_budget"; parts: readonly Part[] }>

/** The body, the kept sentences and the version: what `finishReady` writes. No field for a dropped sentence. */
export type ReadyBody = Readonly<{ body: string; sentences: readonly StoredOutreachSentence[]; profileVersion: number }>

/**
 * D5 step 2: split before normalising, so each part keeps its raw text. An
 * element holding two sentences becomes two parts with the element's kind and
 * fact ids; every part gets its position in the reply, and an exact duplicate
 * is dropped without being a failure.
 */
export function splitParts(
  sentences: readonly Readonly<{ kind: "statement" | "ask"; text: string; factIds: readonly string[] }>[],
  realId: (alias: string) => string,
  target: TargetNames
): Part[] {
  const parts: Part[] = []
  for (const sentence of sentences) {
    const pieces = sentencesOf(sentence.text)
    for (const piece of pieces.length === 0 ? [sentence.text] : pieces) {
      const original = piece.trim()
      if (original === "") continue
      const text = withoutEmDashes(original).replace(/\s+/g, " ").trim()
      parts.push({
        position: parts.length,
        original,
        kind: sentence.kind,
        factIds: sentence.kind === "ask" ? [] : sentence.factIds.map(realId),
        text,
        checkText: checkForm(text, target, sentence.kind),
        judgeText: fillTokens(text, target),
        removed: null,
        needsJudge: false,
      })
    }
  }
  const seen: string[] = []
  for (const part of parts) {
    if (seen.some((text) => sameLine(text, part.text))) part.removed = "duplicate"
    else seen.push(part.text)
  }
  return parts
}

/**
 * `{role_phrase}` and `{company_phrase}` filled by code (D5, "Role and company
 * fill-in"). `fallback` forces "the role" and "the company": the budget retry
 * uses it once (D6), and `checkForm` uses it for an Ask's tokens.
 */
export function fillTokens(text: string, target: TargetNames, fallback = false): string {
  const role = !fallback && usableTarget(target.roleTitle) ? `the ${target.roleTitle} role` : "the role"
  const company = !fallback && usableTarget(target.company) ? target.company : "the company"
  // Function replacers: a name is data, so `$&`, `$'`, `` $` `` and `$$` in it stay literal.
  return text.replaceAll(ROLE_TOKEN, () => role).replaceAll(COMPANY_TOKEN, () => company)
}

/**
 * The form of a sentence the code checks read (D5 step 4).
 *
 * The exemption is the tokens only (r7). An Ask keeps the neutral form for the
 * literal `{role_phrase}` and `{company_phrase}` tokens, which the prompt tells
 * the model to use there ("the role", "the company": PRD AC 2.6). Everything
 * else is left as written, so an Ask that writes the target's real company or
 * role title is checked exactly like a Statement: the name stays in the text and
 * fails as an unsupported capitalised word, because an Ask cites no fact that
 * could state it. No list of phrasings is involved, so there is no phrasing to
 * enumerate around (NEW-1, the eleven shapes in the Security re-check).
 *
 * A Statement is never neutralised (CR-1). Its tokens are filled with the real
 * names, as the stored text will be, and its literal names stay as written.
 *
 * The stored text is never this form, and the judge never reads it: it reads
 * `fillTokens(text, target)`, the real names (`Part.judgeText`).
 */
export function checkForm(text: string, target: TargetNames, kind: "statement" | "ask"): string {
  return kind === "ask" ? fillTokens(text, target, true) : fillTokens(text, target)
}

/**
 * A request without a question mark: "Happy to chat if you're open to it". A
 * shape test only, so it decides no claim. Its opener must still be exempt from
 * the claim check as a sentence-initial capitalised word, which means it is in
 * `OPENING_WORDS` or `OUTREACH_OPENING_WORDS`; "Keen" is left out for exactly
 * that reason, since exempting it would widen claim detection.
 */
const REQUEST_OPENERS = /^(?:would|could|can|may|might|do|does|are|is|will|should|please|happy|open to|let me know|i'd love|i would love|i'd like|i would like|i'd welcome|i would welcome|i'd appreciate|i would appreciate|i'd be grateful|i would be grateful|i'm reaching out|i am reaching out|i'm writing|i am writing)\b/u

/**
 * A formatting gate and nothing more: an Ask is a question or a request, so a
 * Statement cannot pass as an Ask by its `kind` alone. It does not detect a
 * claim; a sentence can be a question and still assert something, and the
 * claim rules and the judge handle that.
 */
export function isAskShaped(text: string): boolean {
  const folded = text.replace(/[\u2018\u2019]/g, "'").trim().toLowerCase()
  return folded.includes("?") || REQUEST_OPENERS.test(folded)
}

const ROLE_TOKEN = "{role_phrase}"
const COMPANY_TOKEN = "{company_phrase}"

/** A currency symbol and its figure, so a fact's own "$40k" can be told from a pay figure. */
const CURRENCY_AMOUNT = /[$€£¥₦]\s?\d[\d,.]*(?:\s?(?:k|m|bn|million|billion)\b)?/giu
/** A run of two or more all-capital words. */
const CAPS_RUN = /\b\p{Lu}{2,}(?:\s+\p{Lu}{2,})+\b/gu
/** A dotted token such as `ada.dev` or `Next.js`; the last label decides whether it is a domain. */
const DOTTED_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)+/gu
/** The only domain-shaped suffixes a fact-backed technology name may carry (D5). */
const CODE_SUFFIXES: ReadonlySet<string> = new Set(["js", "ts", "net"])

const RELATIONSHIP_PHRASES = [
  "as discussed",
  "as we discussed",
  "we spoke",
  "we talked",
  "we met",
  "our conversation",
  "our call",
  "following up",
  "circling back",
  "touching base",
  "hope you're well",
  "hope you are well",
  "hope this finds you",
  "mutual connection",
  "mutual contact",
  "mutual friend",
  "your colleague",
  "referred me",
  "recommended me",
  "referred by",
  "thanks for referring me",
  "thank you for referring me",
  "as promised",
  "good to meet",
  "nice to meet",
  "great to meet",
  "when we last",
  "reaching out again",
  "meeting you",
  "meet you",
  "we last talked",
  "we last spoke",
  "we last met",
  "referred to you",
  "i was referred",
] as const

/**
 * The outreach-only deterministic rules (D5, the "Code" column of the AC 3
 * table). Returns the first rule the sentence breaks, or null. A match drops
 * the sentence and makes it a failed sentence, so it may become a blocked Run's
 * quote. `citedFacts` is the text of the facts the sentence cites: a technology
 * name such as `Next.js`, an all-capital acronym pair such as `REST API` and a
 * currency figure pass only when a cited fact states the same token, so a
 * posting can never create one.
 *
 * Not here, because the shared check already refuses them: contact details
 * (`containsContactDetail`), unsourced quotations, and every claim. An em dash
 * is converted by `splitParts`, not dropped.
 */
export function outreachRuleIn(text: string, citedFacts: readonly string[] = []): OutreachRule | null {
  const plain = text.replaceAll(ROLE_TOKEN, " ").replaceAll(COMPANY_TOKEN, " ")
  const folded = plain.replace(/[\u2018\u2019]/g, "'")
  const lower = folded.toLowerCase()
  const cited = citedFacts.join(" . ")

  if (/[[\]{}<>]/u.test(plain)) return "bracket"
  if (/\p{Extended_Pictographic}/u.test(plain)) return "emoji"
  if (/^(?:greetings|hi|hello|hey|dear)\b|^good (?:morning|afternoon|evening)\b|^to whom it may concern\b/iu.test(folded.trim())) return "greeting"
  if (linkIn(plain, cited)) return "link"
  if (/[*_`~]|^\s*(?:[-\u2022\u00B7\u25AA\u25E6]|\d+[.)])\s|^\s*(?:#{1,6}|>)\s/mu.test(plain)) return "markdown"
  if (capsRunIn(plain, cited)) return "caps_run"
  if (payIn(folded, lower, cited)) return "pay"
  // "visa" is the lower-case word only, so an employer named Visa is left to the claim check.
  if (/\b(?:relocat\w*|sponsor\w*|work authori[sz]ation|authori[sz]ed to work|right to work|work permit|time ?zones?|based in|located in|(?:live|living|reside|residing) in|citizen(?:ship)?)\b/u.test(lower) || /\bvisas?\b/u.test(folded)) {
    return "eligibility"
  }
  if (RELATIONSHIP_PHRASES.some((phrase) => lower.includes(phrase))) return "relationship"
  if (/\b(?:admire\w*|congratulat\w*|impressed (?:by|with)|big fan|i noticed|i saw that|i read that|i love (?:what|how|your|the way)|love what you|i(?: have|'ve) (?:been )?follow(?:ing|ed))\b/u.test(lower)) {
    return "reader_praise"
  }
  if (/\b(?:i(?:'ve| have)? (?:already |just |recently )?(?:applied|submitted)|(?:have|had) (?:already |just )?(?:applied|submitted)|my (?:application|submission)|applied (?:for|to|via|through)|submitted (?:my|an|the) (?:application|resume|cv))\b/u.test(lower)) {
    return "application_status"
  }
  if (isSignOff(lower)) return "sign_off"
  // A fact-backed skill such as "AI features" is allowed; only a mention of Eve or of an AI writing the text is not.
  if (/\bEve\b/u.test(plain) || /\b(?:chatgpt|openai|anthropic|claude|language model|llm|chatbot)\b|\bai (?:assistant|tool|model|writer)\b|\bai[- ](?:generated|written|assisted|powered)\b|\b(?:written|generated) (?:by|with|using) (?:an? )?(?:ai|bot)\b|\bauto-?generated\b/u.test(lower)) {
    return "mentions_eve"
  }
  if (/\b(?:other (?:offers?|opportunities|employers|companies|interviews?)|competing offers?|(?:have|got|received|holding) (?:an? |two |three |several )?offers? from|interviewing (?:with|at|elsewhere))\b/u.test(lower)) {
    return "other_offers"
  }
  return null
}

/** A URL scheme, `www.`, a handle, a hashtag, a path, or a domain-shaped token no fact states as `js`, `ts` or `net`. */
function linkIn(text: string, cited: string): boolean {
  if (/:\/\/|\bmailto:|\btel:|\bwww\./iu.test(text)) return true
  if (/(?:^|\s)@[\p{L}\p{N}_]{2,}|(?:^|\s)#[\p{L}\p{N}_]+/u.test(text)) return true
  if (/(?:^|\s)\/[\p{L}\p{N}_.-]+|\S\/\S*\.[a-z]{2,4}\b/iu.test(text)) return true
  for (const match of text.matchAll(DOTTED_TOKEN)) {
    const labels = match[0].split(".")
    const suffix = (labels.at(-1) ?? "").toLowerCase()
    if (!/^\p{L}{2,}$/u.test(suffix) || !labels.slice(0, -1).some((label) => /\p{L}/u.test(label))) continue
    if (!CODE_SUFFIXES.has(suffix) || !cited.toLowerCase().includes(match[0].toLowerCase())) return true
  }
  return false
}

/** Two or more all-capital words in a row, unless a cited fact holds the same run ("REST API"). */
function capsRunIn(text: string, cited: string): boolean {
  for (const match of text.matchAll(CAPS_RUN)) if (!cited.includes(match[0])) return true
  return false
}

/** Pay, rates, notice and availability. A currency figure passes only when a cited fact states it. */
function payIn(folded: string, lower: string, cited: string): boolean {
  if (/\b(?:salary|salaries|compensation|remuneration|stipend|wages?|pay|notice period|start date|immediately)\b/u.test(lower)) return true
  if (/\b(?:hourly|daily|day|monthly|annual|my|expected|desired|asking)\s+rates?\b|\brates?\s+(?:of|at|per)\s+[$€£\d]|\bper\s+(?:hour|annum|year|month)\b/u.test(lower)) return true
  if (/\b(?:usd|eur|gbp|ngn|cad|aud|dollars?|euros?|naira)\b|\b(?:can|could|able to|will) start\b/u.test(lower)) return true
  // "High availability" is a systems term, not a start date.
  if (/\bavailab(?:le|ility)\b/u.test(lower.replace(/\bhigh[- ]availability\b/gu, ""))) return true
  for (const amount of folded.matchAll(CURRENCY_AMOUNT)) if (!cited.includes(amount[0].trim().replace(/[.,]+$/, ""))) return true
  return false
}

/** A sentence that is only a closing formula, optionally followed by a short name ("Best, Sam"). */
function isSignOff(lower: string): boolean {
  const line = lower.trim()
  if (/^sent from\b/u.test(line)) return true
  if (/^(?:thanks|thank you|many thanks|with thanks|thanks again|thank you again)[\s,.!:-]*$/u.test(line)) return true
  return /^(?:best(?: regards| wishes)?|(?:kind|warm|best|many) regards|regards|sincerely|cheers|yours (?:sincerely|faithfully|truly))[\s,.!:-]*(?:\p{L}+(?:[ '-]\p{L}+){0,2})?[\s.!]*$/u.test(line)
}

/** What the per-sentence checks read. The same maps the documents Run builds (`factsOf`, aliases, posting guard). */
export type CheckContext = Readonly<{
  facts: ReadonlyMap<string, string>
  wording: FactWording
  contact: ContactHeader
  guard: ReturnType<typeof postingGuard>
}>

/**
 * D5 steps 3 and 5: the outreach-only rules, then the shared claim check, one
 * sentence at a time. A sentence that fails either is removed and recorded as
 * failed at its position. Returns counts by reason code, never text (D7).
 *
 * A Statement is checked as a letter paragraph with the posting guard. An Ask is
 * checked as `outreach_ask` with no cited facts and `OUTREACH_OPENING_WORDS`: a
 * number, date, capitalised name, listed skill, title or qualification in it
 * fails in code (AC 2.5). Its lower-case wording is the judge's decision, so the
 * check assumes the Ask's own verdict and a sentence that survives is marked for
 * the judge. An Ask is never released by code alone.
 *
 * An Ask is checked with no cited facts whatever the model sent (`splitParts`
 * empties its `factIds`), so it cannot borrow a number or a name from a fact (CR-2).
 *
 * An Ask must also be a question or a request (`isAskShaped`), a formatting gate
 * that is not a claim detector.
 *
 * Neither passes a `LetterTarget`: only an Ask's `{role_phrase}` and
 * `{company_phrase}` tokens are neutral in the check form (`checkForm`, AC 2.6, r7).
 * A literal company or role title, in an Ask or a Statement, stays and fails
 * there as an unsupported capitalised word unless a cited fact states it.
 * `names_target` would only misfire on a Candidate's own title that equals the
 * posting's.
 */
export function checkParts(parts: readonly Part[], context: CheckContext): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  const fail = (part: Part, stage: "outreach_rules" | "claim", reason: string) => {
    part.removed = stage
    counts[reason] = (counts[reason] ?? 0) + 1
  }
  for (const part of parts) {
    if (part.removed !== null) continue
    const rule = outreachRuleIn(
      part.text,
      part.factIds.map((id) => context.facts.get(id) ?? "")
    )
    if (rule !== null) fail(part, "outreach_rules", rule)
  }
  for (const part of parts) {
    if (part.removed !== null) continue
    const line: DocumentLine = { text: part.checkText, factIds: part.factIds }
    if (part.kind === "ask") {
      if (!isAskShaped(part.text)) {
        fail(part, "outreach_rules", "ask_shape")
        continue
      }
      const verdict = new Set([meaningKey(line.text, line.factIds)])
      const code = checkSentence(line, context.facts, null, context.contact, verdict, "outreach_ask", null, context.wording, OUTREACH_OPENING_WORDS)
      if (code.ok) part.needsJudge = true
      else fail(part, "claim", code.hardFail ?? code.reason)
      continue
    }
    const code = checkSentence(line, context.facts, null, context.contact, new Set(), "letter_paragraph", context.guard, context.wording)
    if (code.ok) continue
    const judgeable =
      code.reason === "unsupported_claim" && needsMeaningCheck(line, context.facts, null, context.contact, "letter_paragraph", context.guard, context.wording)
    if (judgeable) part.needsJudge = true
    else fail(part, "claim", code.hardFail ?? code.reason)
  }
  return counts
}

/**
 * D5 step 6: the one judge call's items, in position order: every Ask and every
 * Statement that fails only on lower-case wording. The judge always reads the
 * stored form, the real company and role filled in, never a blanked sentence
 * (r7): a token-form Ask that reads as a claim ("since I'm at {company_phrase}")
 * is judged as "since I'm at Northwind Labs".
 */
export function judgeItems(parts: readonly Part[], facts: ReadonlyMap<string, string>): MeaningCheckItem[] {
  return parts
    .filter((part) => part.removed === null && part.needsJudge)
    .map((part) => ({
      line: { text: part.judgeText, factIds: part.factIds },
      facts: part.factIds.map((factId) => facts.get(factId) ?? ""),
      postingTerms: [],
    }))
}

/**
 * D5 step 7: the final check with the judge's verdicts. A Statement must return
 * no failure with its verdict; an Ask must have been explicitly judged
 * `supported: true`. A sentence the judge refuses is recorded as failed at its
 * position.
 */
export function applyVerdicts(parts: readonly Part[], context: CheckContext, supported: ReadonlySet<string>): void {
  for (const part of parts) {
    if (part.removed !== null || !part.needsJudge) continue
    const line: DocumentLine = { text: part.checkText, factIds: part.factIds }
    if (part.kind === "ask") {
      if (!supported.has(meaningKey(part.judgeText, line.factIds))) part.removed = "judge"
      continue
    }
    const final = checkSentence(line, context.facts, null, context.contact, supported, "letter_paragraph", context.guard, context.wording)
    if (!final.ok) part.removed = "judge"
  }
}

const isRemoved = (part: Part): boolean => part.removed !== null

/** The kept parts in reply order. */
const keptParts = (parts: readonly Part[]): Part[] => parts.filter((part) => !isRemoved(part)).sort((a, b) => a.position - b.position)

/** The body: the kept sentences in reply order, tokens filled, joined by single spaces (D6). */
function composeBody(parts: readonly Part[], target: TargetNames, fallback: boolean): string {
  return keptParts(parts)
    .map((part) => fillTokens(part.text, target, fallback))
    .join(" ")
}

/**
 * D5 step 8 and D6. An Application note keeps no Ask and needs one Statement; a
 * Referral request and an Introduction keep the first Ask that survived and need
 * one Statement and that Ask, or the Run is `blocked`. A sentence removed for
 * structure is not a failure. Then the body budget: whole Statements go from the
 * end, never the first Statement and never the Ask, then the fill-in retries once
 * with "the role" and "the company"; still over ends `over_budget`. Nothing is
 * cut, abbreviated or reordered, and a sentence removed for length is never a
 * failure.
 */
export function finishPipeline(parts: readonly Part[], kind: OutreachKind, target: TargetNames, profileVersion: number): PipelineResult {
  // A brace left after filling means a token could not be filled: the sentence fails, it is never stored with the brace.
  for (const part of parts) if (part.removed === null && /[{}]/u.test(fillTokens(part.text, target))) part.removed = "outreach_rules"

  const asks = keptParts(parts).filter((part) => part.kind === "ask")
  for (const ask of kind === "application_note" ? asks : asks.slice(1)) ask.removed = "structure"

  const kept = keptParts(parts)
  const statements = kept.filter((part) => part.kind === "statement")
  const hasAsk = kept.some((part) => part.kind === "ask")
  if (statements.length === 0 || (kind !== "application_note" && !hasAsk)) return { outcome: "blocked", quote: firstFailedQuote(parts), parts }

  const budget = OUTREACH_BUDGETS[kind].body
  let body = composeBody(parts, target, false)
  const droppable = statements.slice(1)
  while (outreachLength(body) > budget) {
    const last = droppable.pop()
    if (last === undefined) break
    last.removed = "budget"
    body = composeBody(parts, target, false)
  }
  let namesFallback = false
  if (outreachLength(body) > budget) {
    namesFallback = true
    body = composeBody(parts, target, true)
  }
  if (outreachLength(body) > budget) return { outcome: "over_budget", parts }

  const finalParts = keptParts(parts)
  const sentences: StoredOutreachSentence[] = finalParts.map((part) => ({ kind: part.kind, text: fillTokens(part.text, target, namesFallback), factIds: part.factIds }))
  return { outcome: "ready", ready: { body, sentences, profileVersion }, parts: finalParts, bodyChars: outreachLength(body), namesFallback }
}

/**
 * The first failed sentence (D13): the failed part with the lowest reply
 * position, whatever stage failed it, as the model wrote it (trimmed only). Only
 * a part removed by the outreach rules, the shared claim check or the judge is
 * failed; one removed for a duplicate, the structure or the budget was never
 * failed and is never elected. Null when nothing failed. The result is capped at
 * 400 code points at a whole word, or withheld when no whole word fits.
 */
export function firstFailedQuote(parts: readonly Part[]): string | null {
  const first = parts
    .filter((part) => part.removed === "outreach_rules" || part.removed === "claim" || part.removed === "judge")
    .sort((a, b) => a.position - b.position)[0]
  return first === undefined ? null : capFailedSentence(first.original)
}

/** Counts of removed parts by stage, for the count-only log line. A duplicate is not a failure and is not counted. */
export function droppedCounts(parts: readonly Part[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const part of parts) {
    if (part.removed === null || part.removed === "duplicate") continue
    counts[part.removed] = (counts[part.removed] ?? 0) + 1
  }
  return counts
}
