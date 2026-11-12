/**
 * EPIC-0012 rule 4 (design 2c to 2e, owner decision D2: posting text only). The employer's own
 * direction may be quoted in one cover-letter sentence, and that sentence says nothing about the
 * Candidate. Code enforces the shape; the meaning check reads the same sentence for claims (2f).
 *
 * A stored quote is a verified, verbatim forward statement of the posting (design 2a). The model may
 * copy three or more of its words between quotation marks, in a sentence that addresses the employer
 * ("you" or "your") and holds no first-person word. The copied span is removed before the claim and
 * number checks; every other word of the line is checked against the cited facts as before. An
 * unquoted or altered quote stays in, so "your 2030 agenda" still fails on "2030". The resume and the
 * summary never get the allowance (design 2c).
 */
import { z } from "zod"

import { stem } from "../career-profile/claim-check.js"

/**
 * One quoted direction sentence is allowed per cover letter (design 2d). One object carries that
 * allowance through one validation pass; `used` flips when a span is actually stripped, so a second
 * direction sentence is checked with its quote still in place and fails as an unsourced claim.
 */
export type DirectionAllowance = { used: boolean }

export function directionAllowance(): DirectionAllowance {
  return { used: false }
}

/**
 * What the posting row may hold in `forward_statements` (rule 4, design 2a and 2b): the extraction keeps up
 * to three verbatim quotes of 20 to 200 characters, so this is its shape. The column is jsonb, so a row can
 * hold anything else too (an older shape, a dry-run value, a hand edit), and nothing else may reach the
 * prompt, the guard or a letter.
 */
const STORED_FORWARD_STATEMENTS = z.array(z.string().max(200)).max(3)

/**
 * The stored forward statements a letter may quote, or none. A value that does not parse lends nothing,
 * rather than making the generation fail or letting non-quote data become a "source" for a quoted span.
 */
export function storedDirectionQuotes(value: unknown): string[] {
  const parsed = STORED_FORWARD_STATEMENTS.safeParse(value)
  return parsed.success ? parsed.data : []
}

/** First person words (design 2d): the direction sentence speaks about the employer, not the Candidate. */
const FIRST_PERSON: ReadonlySet<string> = new Set(["i", "me", "my", "mine", "myself", "we", "our", "us"])

/** A quotation-marked span: straight or typographic double quotes (design 2d). */
const QUOTED_SPAN = /["“]([^"“”]+)["”]/g

/** At least this many tokens must be copied from one stored quote (design 2d, Revision 1 R3). */
const MIN_SPAN_WORDS = 3

/** Punctuation stripped from each end of a token before the copy test (Revision 1, R3). */
const TOKEN_EDGE = /^[.,;:!?"“”]+|[.,;:!?"“”]+$/g

/**
 * EPIC-0012 Revision 2, R11: words that present the employer's goal as met, reached or delivered. In a
 * letter paragraph that used the direction allowance, one of these outside the quoted span is a hard fail
 * and the sentence holding it drops.
 */
export const COMPLETION_WORDS: ReadonlySet<string> = new Set([
  "met", "meet", "meets", "achieved", "achieve", "reached", "reach", "delivered", "deliver", "delivers",
  "hit", "done", "completed", "accomplished", "fulfilled", "realised", "realized", "exceeded", "surpassed",
])

/**
 * EPIC-0012 Revision 3, R20: the same claim in other grammatical forms. A closed word list cannot hold every
 * inflection, so a word matches when its `stem()` matches the stem of the list's words and of the extra base
 * forms here. Accepted cost: "meeting" or "complete" as a noun in that one paragraph drops its sentence.
 */
export const COMPLETION_STEMS: ReadonlySet<string> = new Set(
  [
    ...COMPLETION_WORDS,
    "fulfil", "fulfill", "surpass", "exceed", "accomplish", "complete", "achieve", "deliver", "reach", "meet",
    "realise", "realize",
  ].map((word) => stem(word))
)

/** Forms whose stem is not a hint of the word: stem("hitting") is "hitt" (R20). */
const COMPLETION_FORMS: ReadonlySet<string> = new Set(["hitting"])

/** The first completion word in `text`, lower-cased, or null (Revision 2, R11; by stem, Revision 3 R20). */
export function completionWordIn(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? []
  return words.find((word) => COMPLETION_WORDS.has(word) || COMPLETION_FORMS.has(word) || COMPLETION_STEMS.has(stem(word))) ?? null
}

/**
 * The closed list of words a direction sentence may keep once its quoted span is gone (Revision 1, R4).
 * No verb of completion and no fact word is here, so the sentence can only say the employer has the goal.
 */
const DIRECTION_FRAME_WORDS: ReadonlySet<string> = new Set([
  "your", "you", "plan", "plans", "aim", "aims", "goal", "goals", "target", "targets", "ambition",
  "ambitions", "commitment", "pledge", "mission", "stated", "public", "to", "of", "is", "are", "a",
  "the", "this", "clear",
])

/**
 * The frame words as a read-only set (EPIC-0012 Revision 2 addendum, D): the prompt spec checks that every
 * opening word named in A4 is one of these.
 */
export function directionFrameWords(): ReadonlySet<string> {
  return DIRECTION_FRAME_WORDS
}

/** Abbreviations a sentence does not end at ("e.g.", "U.S.", "Dr."), as the letter repair splits lines. */
const SENTENCE_BREAK =
  /(?<![A-Za-z]\.[A-Za-z]\.)(?<!\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|St|Inc|Ltd|Co|No|[A-Z]))(?<=[.!?])\s+(?=[A-Z])/

/** The sentences of a line, split the same way the letter repair splits them. */
export function sentencesOf(text: string): string[] {
  return text.split(SENTENCE_BREAK)
}

/**
 * The line with its first copied direction span removed, or null when it carries none. Only the first
 * sentence in the letter that meets design 2d is stripped: `allowance.used` is set when that happens.
 * Nothing else in the line changes, so every other word is still checked against the facts.
 */
export function withoutDirectionQuote(text: string, quotes: readonly string[], allowance: DirectionAllowance): string | null {
  if (allowance.used) return null
  const stored = quotes.filter((quote) => quote.trim() !== "")
  if (stored.length === 0) return null
  for (const sentence of sentencesOf(text)) {
    for (const span of sentence.matchAll(QUOTED_SPAN)) {
      if (!isCopied(span[1] ?? "", stored)) continue
      // With the span gone, the sentence must address the employer, say nothing about the Candidate, and
      // keep only frame words: any other word means the quote is not stripped (Revision 1, R4).
      const rest = sentence.replace(span[0], " ")
      if (!/\b(?:you|your)\b/i.test(rest) || hasFirstPerson(rest) || !isDirectionFrame(rest)) continue
      allowance.used = true
      // The replacement is a function, so `$&`, `` $` `` and `$'` in the remaining text stay literal instead of
      // being read as replacement patterns.
      return text.replace(sentence, () => rest)
    }
  }
  return null
}

/** True when every word left in the sentence is on the closed frame-word list (Revision 1, R4). */
function isDirectionFrame(text: string): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  return words.every((word) => DIRECTION_FRAME_WORDS.has(word))
}

/**
 * Three or more whole tokens copied from one stored quote (Revision 1, R3). Tokens are whitespace
 * separated and carry no edge punctuation (percent signs, currency signs and digits stay), so a span
 * cut inside a number ("by 4" from "by 40%") is not a copy. Case stays as written.
 */
function isCopied(quoted: string, stored: readonly string[]): boolean {
  const span = quoteTokens(quoted)
  if (span.length < MIN_SPAN_WORDS) return false
  return stored.some((quote) => {
    const tokens = quoteTokens(quote)
    for (let start = 0; start + span.length <= tokens.length; start++) {
      if (span.every((token, offset) => tokens[start + offset] === token)) return true
    }
    return false
  })
}

/** The comparable tokens of a span or quote: split on whitespace, then strip edge punctuation (R3). */
function quoteTokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(TOKEN_EDGE, ""))
    .filter((token) => token !== "")
}

/**
 * EPIC-0012 Revision 6, R24 step 1: the closed alphabet. Each code point gets exactly one class, decided by
 * its NFKC form, and everything off the allowlists is a mark whether or not Unicode has assigned it a name.
 * Default-deny is the point: an unseen glyph, an invisible format character, a combining mark or an emoji can
 * never be plain text that slips past the provenance check.
 */
const SPACE_CHARACTERS: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"])

/** Letters drawn as ticks that are still Latin letters but never word characters (U+A78B/C, the saltillo). */
const NOT_WORD_LETTERS: ReadonlySet<string> = new Set(["\uA78B", "\uA78C"])

/** Plain punctuation and symbols (R24 step 1): `( ) [ ] { } * | ~` stay plain in every width. */
const PLAIN_PUNCTUATION: ReadonlySet<string> = new Set([
  ".", ",", ";", ":", "!", "?", "-", "/", "&", "%", "$", "#", "+", "(", ")", "[", "]", "{", "}", "*", "|", "~",
  "‐", "‒", "–", "—", "―", "−", "·", "•", "°", "×", "±", "‰", "©", "®", "§", "⁄",
])

/**
 * EPIC-0012 Revision 7, R25 step 1: a character whose own Unicode category is a mark category is a mark
 * whatever its NFKC form is. Modifier letters (Lm, the superscript letters), modifier symbols (Sk), every
 * combining mark, format, private use, surrogate, unassigned, line and paragraph separator, and the
 * remaining controls are never word characters.
 */
const MARK_CATEGORY = /^[\p{Lm}\p{Sk}\p{M}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Cc}]$/u

const DIGIT_CODE_POINT = /^\p{Nd}$/u
const WORD_LETTER_CODE_POINT = /^[\p{Lu}\p{Ll}\p{Lt}]$/u
const THREE_SCRIPTS = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]$/u
const CURRENCY_CODE_POINT = /^\p{Sc}$/u

/** True for one NFKC code point that is a word character: a digit, or a letter of Latin, Greek or Cyrillic. */
function isWordCodePoint(char: string): boolean {
  if (DIGIT_CODE_POINT.test(char)) return true
  return WORD_LETTER_CODE_POINT.test(char) && !NOT_WORD_LETTERS.has(char) && THREE_SCRIPTS.test(char)
}

/** The class of one code point (R24 step 1, category first from R25 step 1): word, space, plain or mark. */
export function charClassOf(char: string): "word" | "space" | "plain" | "mark" {
  const folded = char.normalize("NFKC")
  if (SPACE_CHARACTERS.has(char) || folded === " ") return "space"
  // R25 step 1: the character's own category decides before its NFKC form, so a modifier letter whose
  // compatibility form is a Latin letter is still a mark.
  if (MARK_CATEGORY.test(char)) return "mark"
  const points = [...folded]
  if (points.length > 0 && points.every(isWordCodePoint)) return "word"
  if (points.every((point) => isWordCodePoint(point) || PLAIN_PUNCTUATION.has(point) || CURRENCY_CODE_POINT.test(point))) return "plain"
  return "mark"
}

/**
 * True when one code point can hold a quotation (EPIC-0012 Revision 6, R24 step 1; supersedes R23's category
 * list). It is exactly the mark class of `charClassOf`: every character that is not a word, a space or an
 * allowlisted plain character is a mark. Callers iterate with `[...text]`, so an astral character (🙶) is one
 * element there and two UTF-16 units in a `string`.
 */
export function isQuoteLike(char: string): boolean {
  return charClassOf(char) === "mark"
}

/**
 * EPIC-0012 Revision 6, R24; Revision 7, R25: the first part of `text` that reads as a quotation and no
 * source backs, or null. A quotation in a document line may only repeat words the document can point at: a
 * verified direction quote of the posting, or the validation text of a fact the line cites. R25 keeps R24's
 * per-sentence provenance question and adds two things: the whole unit passes when it is verbatim source
 * text, marks included (U0), and every active mark must take part in a balanced reading (B), which closes a
 * quotation that opens in one sentence and never closes. U0 also reads each sentence, so a sentence that is a
 * source's own words passes inside a longer unit (cost C13). The alphabet is closed by `charClassOf`; a lone
 * mark, a wordless envelope, and a mark attached to text outside the envelope (L1 to L4, read through
 * spacing only) fail closed. Provenance is a string question, so code answers it here and the judge's prompt
 * never changes.
 */
export function unsourcedQuotationIn(text: string, sources: readonly string[]): string | null {
  const sourceTokens = sources.map(quotationTokens)
  const sourceExactTokens = sources.map(exactTokens)
  const sourceSentenceTokens = sources.flatMap((source) => {
    const sentences = sentencesOf(source)
    // R26 residual (v): a source whose own quotation spans a sentence end is cut inside that quotation, so
    // two of its sentences read unbalanced. Its sentences are then not source sentences for the pass below,
    // so an invented sentence cannot sit inside that quotation. One unbalanced sentence is residual (iv).
    return sentences.filter((sentence) => !spacedBalanced(sentence)).length > 1 ? [] : sentences.map(exactTokens)
  })
  // U0 (R25 step 3): the whole unit is verbatim source text, marks and all, so it passes. This is what keeps
  // a fact's own wording and the fallback safe, including a fact carrying a mark the alphabet calls a quote.
  const unitTokens = exactTokens(text)
  if (unitTokens.length > 0 && sourceExactTokens.some((source) => containsTokenRun(source, unitTokens))) return null
  for (const sentence of sentencesOf(text)) {
    // R24 step 2: every rule reads classes on the NFC form of the sentence; a returned sentence stays raw.
    const chars = [...sentence.normalize("NFC")]
    const marks = quoteMarksOf(chars)
    const positions = activePositions(marks)
    // U0 on one sentence (R25 cost C13): a sentence that IS one of a source's own sentences passes inside a
    // longer unit too, so a fact's sentence never fails narrowed S0's balance and never drops its paragraph.
    // It is a whole source sentence, not any run: a run cut inside a source's own quotation stays checked.
    const exactSentenceTokens = exactTokens(sentence)
    if (exactSentenceTokens.length > 0 && sourceSentenceTokens.some((tokens) => sameTokens(tokens, exactSentenceTokens))) continue
    // S0, narrowed by R25: the sentence is a source's own words AND its spaced marks balance. A sentence that
    // only carries an opener or a closer of a quotation spanning sentences no longer skips the rest of the check.
    const sentenceTokens = quotationTokens(sentence)
    if (sentenceTokens.length > 0 && sourceTokens.some((source) => containsTokenRun(source, sentenceTokens)) && balanced(chars, marks, positions, true)) continue
    // S1: no active mark, so nothing can be read as quoted. S2: a lone mark fails closed.
    if (positions.length === 0) continue
    if (positions.length === 1) return sentence
    const first = positions[0] ?? 0
    const last = positions[positions.length - 1] ?? 0
    // S3: everything between the outermost marks that could be quoted is one run of one source, marks removed.
    const envelope = chars.slice(first + 1, last).join("")
    const envelopeTokens = quotationTokens(envelope)
    // S3′: a wordless envelope (“”, ” “, ”—“) fails closed. Orientation-blind, it cannot be told from a padded
    // French-style opener, so R24 refuses every one.
    if (envelopeTokens.length === 0) return sentence
    if (!sourceTokens.some((source) => containsTokenRun(source, envelopeTokens))) return envelope
    // L1 to L4: the outer marks attach only inward. Each reads the unbroken run of non-space characters on its
    // side, up to the nearest space, so punctuation or an invisible character cannot bridge to outside text.
    const nameMark = marks.find((mark) => mark.at === first)?.name === true
    if (wordInRun(chars, nameMark ? first - 2 : first - 1, -1)) return sentence
    if (!opensEnvelope(chars[first + 1])) return sentence
    if (!endsWord(chars, last - 1)) return sentence
    if (wordInRun(chars, last + 1, 1)) return sentence
    // B (R25 step 3): every active mark must attach and the sentence must balance. It runs last so the strings
    // L1 to L4 return for existing rows do not change.
    if (!balanced(chars, marks, positions, false)) return sentence
  }
  return null
}

/** Apostrophe marks (R23 step 2): one of these may be a correct apostrophe instead of a quotation mark. */
const APOSTROPHE_MARKS: ReadonlySet<string> = new Set(["'", "’", "ʼ", "ʻ"])

/**
 * Whole words whose apostrophe is always an apostrophe (R24 rule b′): o'clock, ma'am, y'all, Hawai'i, O'ahu.
 * The mark is glued into a fixed word, so it cannot bound a phrase.
 */
const APOSTROPHE_WORDS: ReadonlySet<string> = new Set(["o'clock", "ma'am", "y'all", "hawai'i", "o'ahu"])

/** The letters after an in-word mark that make it an apostrophe ("team's", "don't", "they're", "we'll"). */
const APOSTROPHE_TAILS: ReadonlySet<string> = new Set(["s", "m", "t", "d", "re", "ve", "ll"])

/** Words after an unpaired leading mark that make it an elision rather than a quotation ("'Twas", "'til"). */
const ELISIONS: ReadonlySet<string> = new Set(["tis", "twas", "twere", "twill", "em", "n", "cause", "til", "bout"])

/** One quote-like code point and what it can do in its sentence (R23 steps 2 and 3). */
type QuoteMark = Readonly<{
  at: number
  second: number | null
  opens: boolean
  closes: boolean
  name: boolean
  plain: boolean
}>

const LETTER_CHARACTER = /^\p{L}$/u
const UPPER_CHARACTER = /^\p{Lu}$/u

/** A word character (R24 step 1): a code point of class word, so digits count and CJK does not. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && charClassOf(char) === "word"
}

/** Punctuation that may close a word at an envelope's right edge (R24 L3). */
const ENDS_WORD_PUNCTUATION: ReadonlySet<string> = new Set([".", ",", "!", "?"])

/** True for the unbroken run from `at` in `step` when it holds a word character (R24 L1 and L4). */
function wordInRun(chars: readonly string[], at: number, step: 1 | -1): boolean {
  for (let index = at; index >= 0 && index < chars.length; index += step) {
    const char = chars[index]
    if (char === undefined || charClassOf(char) === "space") return false
    if (charClassOf(char) === "word") return true
  }
  return false
}

/** True when a code point can sit inside the envelope's left edge (R24 L2): a word or a currency sign. */
function opensEnvelope(char: string | undefined): boolean {
  return char !== undefined && (isWordChar(char) || CURRENCY_CODE_POINT.test(char))
}

/** True when the code point right before the last mark ends a word (R24 L3): word, `%`, or `. , ! ?` after one. */
function endsWord(chars: readonly string[], at: number): boolean {
  const char = chars[at]
  if (char === undefined) return false
  if (isWordChar(char) || char === "%") return true
  if (!ENDS_WORD_PUNCTUATION.has(char)) return false
  const before = chars[at - 1]
  return isWordChar(before) || before === "%"
}

/** The lower-cased letters immediately after `at`, up to the next non-letter (R23 step 2b, class word). */
function lettersAfter(chars: readonly string[], at: number): string {
  let tail = ""
  for (let index = at; index < chars.length; index += 1) {
    const char = chars[index]
    if (char === undefined || charClassOf(char) !== "word" || !LETTER_CHARACTER.test(char)) break
    tail += char
  }
  return tail.toLowerCase()
}

/** The word ending just before `at`, case kept (R23 step 2c: one letter before a mark means a name). */
function wordBefore(chars: readonly string[], at: number): string {
  let word = ""
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = chars[index]
    if (!isWordChar(char)) break
    word = char + word
  }
  return word
}

/** The lower-cased word starting at `at` (R23 step 2f: an elision or a two-digit decade). */
function wordAfter(chars: readonly string[], at: number): string {
  let word = ""
  for (let index = at; index < chars.length; index += 1) {
    const char = chars[index]
    if (!isWordChar(char)) break
    word += char
  }
  return word.toLowerCase()
}

/** True when the mark at `at` starts an elision ("'Twas", "'til", "'90s") rather than a quotation (R23 step 2f). */
function isElision(chars: readonly string[], at: number): boolean {
  const word = wordAfter(chars, at + 1)
  if (word === "") return false
  return ELISIONS.has(word) || /^\d{2}s?$/.test(word)
}

/**
 * What each quote-like code point can do (R24 step 3), taking the first rule that applies: an n-unit, a
 * standard contraction tail, a fixed apostrophe word, a name mark, an in-word mark, a possessive trailing
 * mark, a leading mark, and finally a plain mark. A plain mark is the only role always trusted to bound a
 * quotation.
 */
function quoteMarksOf(chars: readonly string[]): QuoteMark[] {
  const marks: QuoteMark[] = []
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (char === undefined || !isQuoteLike(char)) continue
    if (APOSTROPHE_MARKS.has(char)) {
      const next = chars[index + 1]
      const third = chars[index + 2]
      // Rule a: an apostrophe mark, n or N, and another apostrophe mark is one n-unit ("rock'n'roll").
      if ((next === "n" || next === "N") && third !== undefined && APOSTROPHE_MARKS.has(third)) {
        marks.push({ at: index, second: index + 2, opens: true, closes: true, name: false, plain: false })
        index += 2
        continue
      }
      const left = isWordChar(chars[index - 1])
      const right = isWordChar(next)
      if (left && right) {
        // Rule b: a standard contraction tail is not a mark at all ("I'm", "team's", "couldn't've").
        if (APOSTROPHE_TAILS.has(lettersAfter(chars, index + 1))) continue
        const word = wordBefore(chars, index)
        // Rule b′: five whole words keep their apostrophe ("o'clock", "ma'am", "y'all", "Hawai'i", "O'ahu").
        const whole = `${word.toLowerCase()}'${wordAfter(chars, index + 1)}`
        if (APOSTROPHE_WORDS.has(whole)) continue
        // Rule c: a one-letter word (o, d or l) before an upper-case letter names a person ("O'Brien").
        if (word.length === 1 && "odl".includes(word.toLowerCase()) && UPPER_CHARACTER.test(next ?? "")) {
          marks.push({ at: index, second: null, opens: true, closes: false, name: true, plain: false })
          continue
        }
        // Rule d: an in-word mark ("Hawai'i", "ma'am", "plan'double").
        marks.push({ at: index, second: null, opens: true, closes: true, name: false, plain: false })
        continue
      }
      // Rule e: a trailing mark is a possessive only after s, x, z, "in" or a number ("teams'", "Dunkin'", "5'").
      if (left) {
        const word = wordBefore(chars, index).toLowerCase()
        if (/(?:[sxz]|in)$/.test(word) || /^\p{Nd}+$/u.test(word)) {
          marks.push({ at: index, second: null, opens: false, closes: true, name: false, plain: false })
          continue
        }
      }
      // Rule f: a leading mark before an elision or a two-digit decade ("'90s", "'Twas", "'til").
      if (right && isElision(chars, index)) {
        marks.push({ at: index, second: null, opens: true, closes: false, name: false, plain: false })
        continue
      }
      // Rule g: plain.
      marks.push({ at: index, second: null, opens: true, closes: true, name: false, plain: true })
      continue
    }
    // Rule f also covers a left single mark before an elision; otherwise every other quote-like mark is plain.
    if (char === "‘" && !isWordChar(chars[index - 1]) && isWordChar(chars[index + 1]) && isElision(chars, index)) {
      marks.push({ at: index, second: null, opens: true, closes: false, name: false, plain: false })
      continue
    }
    marks.push({ at: index, second: null, opens: true, closes: true, name: false, plain: true })
  }
  return marks
}

/**
 * The code-point positions that could bound a quotation in some reading (R23 step 3). A plain mark is
 * always active. Any other mark is active when an opener comes before it (it can close) or a closer comes
 * after it (it can open), whether or not those marks are themselves active. An n-unit counts as two.
 */
function activePositions(marks: readonly QuoteMark[]): number[] {
  const positions: number[] = []
  marks.forEach((mark, index) => {
    const opensBefore = marks.slice(0, index).some((other) => other.opens)
    const closesAfter = marks.slice(index + 1).some((other) => other.closes)
    const active = mark.plain || (mark.closes && opensBefore) || (mark.opens && closesAfter)
    if (!active) return
    positions.push(mark.at)
    if (mark.second !== null) positions.push(mark.second)
  })
  return positions
}

/** Punctuation and symbols stripped from a token's edges (R24 step 2, step 6 of `quotationTokens`). */
const QUOTATION_TOKEN_EDGE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

/**
 * EPIC-0012 Revision 7, R25 step 2: the marks that separate tokens. Punctuation, symbols, separators and
 * controls read as spacing; every other mark-class character is kept inside the token it sits in and is
 * compared, so a letter outside the allowlisted scripts can never be dropped from the comparison.
 */
const SPACED_MARK = /^[\p{P}\p{S}\p{Z}\p{Cc}]$/u

/** True when a mark-class character splits tokens (R25 step 2): punctuation, symbols, separators, controls, apostrophes. */
function isSpacedMark(char: string): boolean {
  return APOSTROPHE_MARKS.has(char) || SPACED_MARK.test(char)
}

/**
 * A span's or source's comparable tokens (R24 step 2, keep rule from R25 step 2): NFC, a spaced mark becomes
 * a space, NFKC, every dash becomes `-`, split on whitespace, strip edge punctuation and symbols, lower-case,
 * drop empty tokens. Normalisation decides the class of each character; it never rewrites the sentence.
 */
function quotationTokens(text: string): string[] {
  const folded = [...text.normalize("NFC")]
    .map((char) => (charClassOf(char) === "mark" && isSpacedMark(char) ? " " : char))
    .join("")
    .normalize("NFKC")
  return folded
    .replace(/[\p{Pd}\u2212]/gu, "-")
    .split(/\s+/)
    .map((token) => token.replace(QUOTATION_TOKEN_EDGE, "").toLowerCase())
    .filter((token) => token !== "")
}

/** Punctuation stripped from each end of an exact token (R25 step 3, U0). */
const EXACT_TOKEN_EDGE = /^[.,;:!?]+|[.,;:!?]+$/g

/**
 * The tokens of a whole unit for U0 (R25 step 3): NFKC, dashes to `-`, split on whitespace, strip edge
 * sentence punctuation, lower-case, drop empty tokens. Marks are kept, so a unit matches a source only when
 * it carries the same marks in the same words; a unit that only adds marks does not match.
 */
function exactTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/[\p{Pd}\u2212]/gu, "-")
    .split(/\s+/)
    .map((token) => token.replace(EXACT_TOKEN_EDGE, "").toLowerCase())
    .filter((token) => token !== "")
}

/**
 * How one active position reads (R25 step 3): +1 when it opens (L1 and L2), -1 when it closes (L3 and L4), 0
 * when neither reading attaches it. A name mark reads the run before its single letter, as L1 does.
 */
function orientationAt(chars: readonly string[], at: number, name: boolean): 1 | -1 | 0 {
  if (!wordInRun(chars, name ? at - 2 : at - 1, -1) && opensEnvelope(chars[at + 1])) return 1
  if (endsWord(chars, at - 1) && !wordInRun(chars, at + 1, 1)) return -1
  return 0
}

/**
 * True when every active mark takes part in a balanced reading (R25 step 3). The marks are walked in order,
 * keeping the set of reachable nesting depths from {0}. A trusted mark (a name mark, or a non-plain
 * single-position mark with exactly one role) can be glued inside a word, so it is optional; every other
 * active mark must attach, and a depth below 0 is dropped. With `spacedOnly`, only spaced marks are read,
 * which is what narrows S0.
 */
function balanced(chars: readonly string[], marks: readonly QuoteMark[], positions: readonly number[], spacedOnly: boolean): boolean {
  let depths: Set<number> = new Set([0])
  for (const mark of marks) {
    for (const at of mark.second === null ? [mark.at] : [mark.at, mark.second]) {
      if (!positions.includes(at)) continue
      const char = chars[at]
      if (char === undefined || (spacedOnly && !isSpacedMark(char))) continue
      const side = orientationAt(chars, at, mark.name)
      const trusted = mark.name || (!mark.plain && mark.second === null && mark.opens !== mark.closes)
      const next = new Set<number>()
      if (trusted) {
        for (const depth of depths) {
          next.add(depth)
          if ((side === 1 && mark.opens) || (side === -1 && mark.closes)) {
            const moved = depth + side
            if (moved >= 0) next.add(moved)
          }
        }
      } else if (side === 0) {
        return false
      } else {
        for (const depth of depths) {
          const moved = depth + side
          if (moved >= 0) next.add(moved)
        }
      }
      depths = next
      if (depths.size === 0) return false
    }
  }
  return depths.has(0)
}

/**
 * EPIC-0012 Revision 8, R26 residual (v): the narrowed-S0 balance on one sentence, read through its spaced
 * marks only. A source's sentence that answers false carries a quotation this splitter cut through, so the
 * source's sentence list cannot be trusted for the per-sentence pass.
 */
function spacedBalanced(sentence: string): boolean {
  const chars = [...sentence.normalize("NFC")]
  const marks = quoteMarksOf(chars)
  return balanced(chars, marks, activePositions(marks), true)
}

/** True when `run` is a contiguous slice of `available`, in the same order (R19: one token is enough). */
function containsTokenRun(available: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0 || run.length > available.length) return false
  for (let start = 0; start + run.length <= available.length; start += 1) {
    if (run.every((token, offset) => available[start + offset] === token)) return true
  }
  return false
}

/** True when two token lists are the same list in the same order (U0 read on one sentence, R25 cost C13). */
function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index])
}

/** A first person word anywhere in the sentence ("I", "we've", "our") makes it a claim, not a direction. */
function hasFirstPerson(text: string): boolean {
  const words = text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z]+(?:'[a-z]+)*/g) ?? []
  return words.some((word) => FIRST_PERSON.has(word) || /^(?:i|we)'/.test(word))
}
