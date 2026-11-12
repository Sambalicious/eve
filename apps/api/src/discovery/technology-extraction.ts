import { KNOWN_TECHNOLOGY_FORMS, TECHNOLOGY_ALIASES, normaliseTechnologyName, stripTechnologyName } from "@eve/contracts"

import { normaliseForQuote } from "../career-profile/source-quote.js"
import { POSTING_TEXT_LIMIT } from "./posting-extraction.js"

/** AC 4.1, 4.9: the first 40 items that pass are kept; the rest are discarded. */
export const TECHNOLOGY_ITEM_LIMIT = 40
/** AC 4.1, 4.9: a trimmed name over 60 characters is dropped alone. */
export const TECHNOLOGY_NAME_MAX_LENGTH = 60
/** SEC-004: the same cap as every other extracted quote (`posting-extraction.ts`); a longer quote drops its item alone. */
export const TECHNOLOGY_QUOTE_MAX_LENGTH = 600
/**
 * SEC-005 (AC 4.10): Unicode bidirectional controls (U+202A to U+202E, U+2066
 * to U+2069, U+200E, U+200F, U+061C). They can visually reorder a quote on the
 * detail page, and `normaliseForQuote` removes them only for comparison, so a
 * quote carrying one is dropped alone, before verification.
 */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u
/** Longest token run compared; a 60-character name has at most this many words. */
const MAX_NGRAM = 12
/** Longest known multi-word name ("Google Cloud Platform") in words. */
const MAX_KNOWN_SPAN = 4
/**
 * Cost bounds (AC 4.9; the quotes are untrusted model output). Without them a
 * 40-item answer of one-character quotes cost tens of seconds of worker CPU,
 * because every occurrence re-tokenised the whole posting.
 *
 * - CONTEXT_WINDOW_CHARS: characters read either side of a match for the
 *   masking context. The longest known multi-word form is 19 characters, so
 *   512 always holds the 3 neighbouring tokens unless one is very long.
 * - MAX_TOKEN_CHARS: how far a match is widened to whole tokens. A token
 *   longer than the quote cap cannot be checked and the occurrence is skipped.
 * - MAX_OCCURRENCES: raw occurrences (every `indexOf` hit, boundary-rejected
 *   ones included) examined per item (AC 4.11, SEC-009). The first one that
 *   verifies keeps the item.
 *
 * Verification also reads only the first POSTING_TEXT_LIMIT characters: the
 * text the model saw, so a quote from later in the posting cannot verify.
 */
const CONTEXT_WINDOW_CHARS = 512
const MAX_TOKEN_CHARS = 600
const MAX_OCCURRENCES = 64
/**
 * SEC-009 part 2 (AC 4.9, AC 4.12 proposal): name comparisons allowed per
 * `verifyTechnologies` call, across all items. One comparison is one
 * canonical-form check of a token run: an n-gram or "/" part against the name,
 * or a 2 to 4 token run against the known multi-word forms. A run longer than
 * COMPARISON_CHARS costs one comparison per started COMPARISON_CHARS, because
 * the check normalises the whole run (dot runs: few runs, each ~600
 * characters, cost ~300 ms unweighted). Spaced repetitive
 * quotes ("a a a …") otherwise cost 64 occurrences x ~300 tokens x 12 run
 * sizes per item, about 3 to 6 s for 40 items. A realistic item verifies at
 * its first occurrence for a few hundred comparisons, so 40 real items use a
 * small part of it. Once spent, the item being checked and every later item
 * are dropped under AC 4.9; the evaluation still succeeds.
 */
export const TECHNOLOGY_COMPARISON_BUDGET = 50_000
const COMPARISON_CHARS = 64
/** Stands in for a context token the window may have cut; equals no name or known form. */
const CUT_TOKEN = "\u0000"

export type VerifiedTechnology = Readonly<{ name: string; quote: string }>

export type TechnologyVerification = Readonly<{
  /** null = no technology data ("not checked", AC 4.8); [] = checked, none verified. */
  technologies: VerifiedTechnology[] | null
  /** Items dropped by AC 4.9 checks (feeds the Open question 3 review). Excludes items past the 40th. */
  droppedCount: number
  /**
   * SEC-009 part 2: how many of `droppedCount` were dropped because the
   * per-call comparison budget ran out. Present only when it did.
   */
  budgetDroppedCount?: number
}>

/** Comparisons left in this call; shared by every item. */
class ComparisonBudget {
  private remaining = TECHNOLOGY_COMPARISON_BUDGET

  /** Spends `count` comparisons; false (and nothing left) when they are not available. */
  spend(count: number): boolean {
    if (count > this.remaining) {
      this.remaining = 0
      return false
    }
    this.remaining -= count
    return true
  }

  get spent(): boolean {
    return this.remaining === 0
  }
}

/** Raised inside one item's check when the budget runs out; never escapes `verifyTechnologies`. */
class BudgetSpent extends Error {}

/** Multi-word names the table knows ("react native", "google cloud platform"), as stripped forms. */
const MULTI_WORD_FORMS: ReadonlySet<string> = new Set([...KNOWN_TECHNOLOGY_FORMS].filter((form) => form.length > 0))
const MAX_MULTI_WORD_FORM_LENGTH = Math.max(0, ...[...MULTI_WORD_FORMS].map((form) => form.length))
/** Longest alias key; a run whose stripped form is longer can only be its own canonical form. */
const MAX_ALIAS_KEY_LENGTH = Math.max(0, ...Object.keys(TECHNOLOGY_ALIASES).map((key) => key.length))

/**
 * AC 4.2, 4.8, 4.9. `raw` is what the tolerant schema parsed: `undefined` when
 * the field was missing or not an array (no technology data), otherwise an
 * array whose malformed items are `null`. Items are checked in model order and
 * dropped individually; the first 40 that pass are kept.
 */
export function verifyTechnologies(raw: readonly unknown[] | undefined, postingText: string): TechnologyVerification {
  if (raw === undefined) return { technologies: null, droppedCount: 0 }
  const haystack = normaliseForQuote(postingText.slice(0, POSTING_TEXT_LIMIT))
  const budget = new ComparisonBudget()
  const kept: VerifiedTechnology[] = []
  let dropped = 0
  let budgetDropped = 0
  for (const item of raw) {
    if (kept.length >= TECHNOLOGY_ITEM_LIMIT) break
    const verified = budget.spent ? "spent" : verifyWithinBudget(item, haystack, budget)
    if (verified === "spent") {
      dropped += 1
      budgetDropped += 1
    } else if (verified) kept.push(verified)
    else dropped += 1
  }
  return budgetDropped === 0 ? { technologies: kept, droppedCount: dropped } : { technologies: kept, droppedCount: dropped, budgetDroppedCount: budgetDropped }
}

function verifyWithinBudget(item: unknown, haystack: string, budget: ComparisonBudget): VerifiedTechnology | null | "spent" {
  try {
    return verifyItem(item, haystack, budget)
  } catch (error) {
    if (error instanceof BudgetSpent) return "spent"
    throw error
  }
}

function verifyItem(item: unknown, haystack: string, budget: ComparisonBudget): VerifiedTechnology | null {
  if (typeof item !== "object" || item === null) return null
  const { name, quote } = item as Record<string, unknown>
  if (typeof name !== "string" || typeof quote !== "string") return null
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > TECHNOLOGY_NAME_MAX_LENGTH) return null
  if (quote.length > TECHNOLOGY_QUOTE_MAX_LENGTH) return null
  if (BIDI_CONTROL.test(quote)) return null
  const needle = normaliseForQuote(quote)
  if (needle.length === 0) return null
  for (const span of anchoredSpans(needle, haystack)) {
    if (nameInTokens(trimmed, span, budget)) return { name: trimmed, quote }
  }
  return null
}

const TOKEN_SPLIT = /[\s,;:()[\]{}!?"'|]+/u
const SEPARATOR = /[\s,;:()[\]{}!?"'|]/u
const WORD_CHAR = /[\p{L}\p{N}]/u

/** Where a quote sits in the posting: its whole tokens, plus up to 3 posting tokens either side for masking. */
type AnchoredSpan = Readonly<{ left: string[]; core: string[]; right: string[] }>

/**
 * SEC-001 (AC 4.2). Each place, among the first MAX_OCCURRENCES raw hits,
 * where the normalised quote occurs in the normalised posting on word
 * boundaries: letters and digits are word characters, so an edge is valid
 * unless a word character of the quote touches a word character of the posting ("java" never anchors inside "javascript", "go" never inside
 * "good"). Symbols keep names like C#, C++, .NET and Node.js anchorable.
 *
 * Each match is widened to whole posting tokens (out to the nearest
 * separator, at most MAX_TOKEN_CHARS), so the name is checked against what the posting says there, not
 * the model's cut: a quote "c" taken from "C#" widens to "c#" and never yields
 * C. Neighbouring tokens are kept only so a longer known name around the match
 * ("React Native") masks a shorter one ("React", AC 3.5).
 */
function* anchoredSpans(needle: string, haystack: string): Generator<AnchoredSpan> {
  const first = needle[0] ?? ""
  const last = needle[needle.length - 1] ?? ""
  let examined = 0
  for (let at = haystack.indexOf(needle); at !== -1 && examined < MAX_OCCURRENCES; at = haystack.indexOf(needle, at + 1)) {
    examined += 1
    const end = at + needle.length
    const before = haystack[at - 1]
    const after = haystack[end]
    if (before !== undefined && WORD_CHAR.test(first) && WORD_CHAR.test(before)) continue
    if (after !== undefined && WORD_CHAR.test(last) && WORD_CHAR.test(after)) continue
    const start = tokenStart(haystack, at)
    const stop = tokenStop(haystack, end)
    if (start === null || stop === null) continue
    yield { left: leftContext(haystack, start), core: tokenise(haystack.slice(start, stop)), right: rightContext(haystack, stop) }
  }
}

/** Start of the posting token containing `at`, or null when it lies more than MAX_TOKEN_CHARS back. */
function tokenStart(haystack: string, at: number): number | null {
  const limit = Math.max(0, at - MAX_TOKEN_CHARS)
  let start = at
  while (start > limit && !SEPARATOR.test(haystack[start - 1] ?? " ")) start -= 1
  return start > 0 && start === limit && !SEPARATOR.test(haystack[start - 1] ?? " ") ? null : start
}

/** End of the posting token containing `end - 1`, or null when it runs more than MAX_TOKEN_CHARS on. */
function tokenStop(haystack: string, end: number): number | null {
  const limit = Math.min(haystack.length, end + MAX_TOKEN_CHARS)
  let stop = end
  while (stop < limit && !SEPARATOR.test(haystack[stop] ?? " ")) stop += 1
  return stop < haystack.length && stop === limit && !SEPARATOR.test(haystack[stop] ?? " ") ? null : stop
}

/** Up to 3 whole tokens before `start` (a token boundary), read from a bounded window. */
function leftContext(haystack: string, start: number): string[] {
  const from = Math.max(0, start - CONTEXT_WINDOW_CHARS)
  const tokens = tokenise(haystack.slice(from, start))
  // Every token after the first has a separator before it inside the window, so it is whole.
  if (from > 0 && tokens.length > 0 && tokens.length < MAX_KNOWN_SPAN) tokens[0] = CUT_TOKEN
  return tokens.slice(-(MAX_KNOWN_SPAN - 1))
}

/** Up to 3 whole tokens after `stop` (a token boundary), read from a bounded window. */
function rightContext(haystack: string, stop: number): string[] {
  const to = Math.min(haystack.length, stop + CONTEXT_WINDOW_CHARS)
  const tokens = tokenise(haystack.slice(stop, to))
  if (to < haystack.length && tokens.length > 0 && tokens.length < MAX_KNOWN_SPAN) tokens[tokens.length - 1] = CUT_TOKEN
  return tokens.slice(0, MAX_KNOWN_SPAN - 1)
}

function tokenise(normalised: string): string[] {
  return normalised
    .split(TOKEN_SPLIT)
    .map(trimEdgePunctuation)
    .filter((token) => token.length > 0)
}

const EDGE_PUNCTUATION = new Set([".", "-", "_"])

/**
 * Removes leading and trailing ".", "-" and "_". Same result as
 * `replace(/^[.\-_]+|[.\-_]+$/gu, "")`, in linear time: that regex retries
 * `[.\-_]+$` from every position of an inner run, so a 300-character dot run
 * cost quadratic time per token (SEC-009 part 2, "dot runs").
 */
function trimEdgePunctuation(token: string): string {
  let start = 0
  let end = token.length
  while (start < end && EDGE_PUNCTUATION.has(token[start] ?? "")) start += 1
  while (end > start && EDGE_PUNCTUATION.has(token[end - 1] ?? "")) end -= 1
  return start === 0 && end === token.length ? token : token.slice(start, end)
}

/**
 * AC 4.2: the name must be one the quote uses, or its alias, as a whole run
 * of tokens. `verifyItem` passes the matched posting span, widened to whole
 * tokens, not the raw quote. The text is tokenised; "/"-joined tokens also offer their parts ("React/Redux" gives
 * React). Runs of 1 to 12 tokens are compared in canonical form. A run that
 * lies inside a longer known multi-word name ("React Native") is skipped, so
 * "React Native" never yields "React". Substrings never count: "Preact" is
 * not "React".
 */
export function nameAppearsInQuote(name: string, quote: string): boolean {
  return nameInTokens(name, { left: [], core: tokenise(normaliseForQuote(quote)), right: [] }, UNLIMITED)
}

/** `nameAppearsInQuote` checks one quote the caller chose, so it is not budgeted. */
const UNLIMITED: Pick<ComparisonBudget, "spend"> = { spend: () => true }

/**
 * Names indexed by canonical form, in the order given; the first name wins for
 * a repeated form and a name with an empty form is left out. Build it once per
 * run and reuse it for every text (CR-E5-02).
 */
export type TechnologyIndex = Readonly<{ entries: ReadonlyArray<Readonly<{ name: string; canonical: string }>>; canonicals: ReadonlySet<string> }>

export function buildTechnologyIndex(names: readonly string[]): TechnologyIndex {
  const entries: { name: string; canonical: string }[] = []
  const canonicals = new Set<string>()
  for (const name of names) {
    const canonical = normaliseTechnologyName(name)
    if (canonical === "" || canonicals.has(canonical)) continue
    canonicals.add(canonical)
    entries.push({ name, canonical })
  }
  return { entries, canonicals }
}

/**
 * The indexed names that appear in the text made of `parts` (joined by a
 * space), in index order. Same rule as calling `nameAppearsInQuote` once per
 * name on the joined text, but the text is tokenised and its known spans
 * computed once, and each token run is looked up in the index (CR-E5-02: the
 * per-name loop cost names x text with a large constant).
 * Like `nameAppearsInQuote` it is not charged to the SEC-009 comparison
 * budget (that bounds `verifyTechnologies` over model quotes); the caller caps
 * each part (Stack post title and snippet, AC 5.5), and `fieldTokens` bounds
 * each part's normalised form by its raw length (CR-E5F-07), so the cost is
 * linear in the capped raw text.
 */
export function namesAppearingInText(index: TechnologyIndex, ...parts: readonly string[]): string[] {
  if (index.entries.length === 0) return []
  // Kept tokens are searched; lookahead tokens (after a cut) only feed the known-name masking.
  const tokens: string[] = []
  const searchable: boolean[] = []
  for (const part of parts) {
    const field = fieldTokens(part)
    for (const token of field.kept) {
      tokens.push(token)
      searchable.push(true)
    }
    if (field.lookahead === null) continue
    // A cut field ends with its lookahead and a cut marker, so it never joins the next field.
    for (const token of [...field.lookahead, CUT_TOKEN]) {
      tokens.push(token)
      searchable.push(false)
    }
  }
  const found = new Set<string>()
  for (const [position, token] of tokens.entries()) {
    if (!searchable[position] || !token.includes("/")) continue
    for (const part of token.split("/")) {
      const canonical = normaliseTechnologyName(part)
      if (index.canonicals.has(canonical)) found.add(canonical)
    }
  }
  // Stripping a run removes only whitespace, "." "-" "_" after NFKC and lower-casing, which
  // never cross a space, so a run's stripped form is its tokens' stripped forms joined. Its
  // length only grows with the run, so a run longer than every indexed form (or alias key)
  // and every later one cannot match and is not built (the bulk of the cost of a long field).
  const stripped = tokens.map(stripTechnologyName)
  const maxLength = Math.max(MAX_ALIAS_KEY_LENGTH, ...[...index.canonicals].map((canonical) => canonical.length))
  const known = knownSpans(tokens, stripped)
  for (let start = 0; start < tokens.length; start += 1) {
    let length = 0
    for (let size = 1; size <= MAX_NGRAM && start + size <= tokens.length; size += 1) {
      if (!searchable[start + size - 1]) break
      length += stripped[start + size - 1]!.length
      if (length > maxLength) break
      const joined = stripped.slice(start, start + size).join("")
      const canonical = TECHNOLOGY_ALIASES[joined] ?? joined
      if (found.has(canonical) || !index.canonicals.has(canonical)) continue
      const insideLongerName = known.some((outer) => outer.start <= start && start + size <= outer.end && outer.end - outer.start > size && outer.canonical !== canonical)
      if (!insideLongerName) found.add(canonical)
    }
  }
  return index.entries.filter((entry) => found.has(entry.canonical)).map((entry) => entry.name)
}

/**
 * Bounds on one field's normalised form in `namesAppearingInText`
 * (CR-E5F-07). NFKC can expand one character up to 18 times (U+FDFA gives
 * 18 characters and 4 words), so a capped title or snippet could otherwise
 * cost many times the matching work of its cap, which is linear in tokens.
 *
 * - Characters: at most 4 times the field's length. Ordinary text grows by a
 *   few characters ("ﬁ" gives "fi"); even a field of nothing but "…" (which
 *   gives "...") is 3 times its length.
 * - Tokens: at most half the field's length, rounded up. Each token needs a
 *   character and a separator after it, so only text whose characters expand
 *   into several words ("⑴" gives "(1)", U+FDFA gives 4 words) can have more.
 *
 * Text under both bounds (all ordinary text) is matched exactly as
 * `nameAppearsInQuote` would. Over a bound, the field is cut at a token
 * boundary. A cut only removes matches: names after it, and names that cross
 * it, are not found. A known multi-word name that crosses the cut still masks
 * the shorter names inside it (SEC-E5F-05, CR-E5F2-01): `lookahead` holds up
 * to `MAX_KNOWN_SPAN - 1` tokens after the cut, read from at most
 * `LOOKAHEAD_CHARS` normalised characters, which feed `knownSpans` only. A cut
 * never joins the end of the title to the start of the snippet.
 */
const NORMALISED_GROWTH_LIMIT = 4
/** 4 times the 40-character criteria entry limit: more than any known multi-word form. */
const LOOKAHEAD_CHARS = 160

type FieldTokens = Readonly<{ kept: readonly string[]; lookahead: readonly string[] | null }>

function fieldTokens(text: string): FieldTokens {
  const normalised = normaliseForQuote(text)
  const limit = text.length * NORMALISED_GROWTH_LIMIT
  let kept = normalised
  let rest = ""
  if (normalised.length > limit) {
    const boundary = normalised[limit] === " " ? limit : normalised.lastIndexOf(" ", limit)
    kept = boundary > 0 ? normalised.slice(0, boundary) : ""
    rest = normalised.slice(Math.max(boundary, 0))
  }
  const tokens = tokenise(kept)
  const maxTokens = Math.ceil(text.length / 2)
  if (tokens.length <= maxTokens && rest === "") return { kept: tokens, lookahead: null }
  return { kept: tokens.slice(0, maxTokens), lookahead: lookaheadTokens(tokens.slice(maxTokens), rest) }
}

/**
 * Up to `MAX_KNOWN_SPAN - 1` whole tokens after a cut: the tokens the token
 * cap dropped, then those of the text the character cap dropped, together at
 * most `LOOKAHEAD_CHARS` characters. A token the window splits is replaced by
 * the cut marker, as in `rightContext`.
 */
function lookaheadTokens(dropped: readonly string[], rest: string): string[] {
  const out: string[] = []
  let chars = 0
  for (const token of dropped) {
    if (out.length === MAX_KNOWN_SPAN - 1) return out
    chars += token.length + 1
    if (chars > LOOKAHEAD_CHARS) return [...out, CUT_TOKEN]
    out.push(token)
  }
  if (out.length === MAX_KNOWN_SPAN - 1 || rest === "") return out
  const window = rest.slice(0, Math.max(0, LOOKAHEAD_CHARS - chars))
  const more = tokenise(window)
  if (window.length < rest.length && more.length > 0 && !SEPARATOR.test(rest[window.length] ?? " ")) more[more.length - 1] = CUT_TOKEN
  return [...out, ...more].slice(0, MAX_KNOWN_SPAN - 1)
}

/** The name must be a whole run of `core` tokens; `left` and `right` only feed the known-name masking. */
function nameInTokens(name: string, span: AnchoredSpan, budget: Pick<ComparisonBudget, "spend">): boolean {
  const target = normaliseTechnologyName(name)
  if (target === "") return false
  const { core } = span
  const charge = (count: number) => {
    if (!budget.spend(count)) throw new BudgetSpent()
  }
  for (const token of core) {
    if (!token.includes("/")) continue
    const parts = token.split("/")
    charge(parts.reduce((sum, part) => sum + comparisonCost(part.length), 0))
    if (parts.some((part) => normaliseTechnologyName(part) === target)) return true
  }
  const tokens = [...span.left, ...core, ...span.right]
  const offset = span.left.length
  const ends = runEnds(tokens)
  const runLength = (start: number, size: number) => (ends[start + size] ?? 0) - (ends[start] ?? 0) + size - 1
  charge(knownSpanCost(tokens.length, runLength))
  const known = knownSpans(tokens)
  for (let size = 1; size <= Math.min(MAX_NGRAM, core.length); size += 1) {
    for (let start = offset; start + size <= offset + core.length; start += 1) {
      charge(comparisonCost(runLength(start, size)))
      if (normaliseTechnologyName(tokens.slice(start, start + size).join(" ")) !== target) continue
      const insideLongerName = known.some((outer) => outer.start <= start && start + size <= outer.end && outer.end - outer.start > size && outer.canonical !== target)
      if (!insideLongerName) return true
    }
  }
  return false
}

type KnownSpan = Readonly<{ start: number; end: number; canonical: string }>

/** Budget units for one canonical-form check of a run of `chars` characters (at least 1). */
function comparisonCost(chars: number): number {
  return Math.max(1, Math.ceil(chars / COMPARISON_CHARS))
}

/** Prefix sums of token lengths: `ends[i]` is the length of tokens 0 to i-1. */
function runEnds(tokens: readonly string[]): number[] {
  const ends = [0]
  for (const token of tokens) ends.push((ends[ends.length - 1] ?? 0) + token.length)
  return ends
}

/** Budget units for every run `knownSpans` checks; `runLength` gives a run's joined length. */
function knownSpanCost(length: number, runLength: (start: number, size: number) => number): number {
  let cost = 0
  for (let size = 2; size <= MAX_KNOWN_SPAN; size += 1) {
    for (let start = 0; start + size <= length; start += 1) cost += comparisonCost(runLength(start, size))
  }
  return cost
}

/** Runs of 2 to 4 tokens that form a name the alias table knows. */
function knownSpans(tokens: readonly string[], strippedTokens: readonly string[] = tokens.map(stripTechnologyName)): KnownSpan[] {
  const spans: KnownSpan[] = []
  for (let size = 2; size <= MAX_KNOWN_SPAN; size += 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      let length = 0
      for (let i = start; i < start + size && length <= MAX_MULTI_WORD_FORM_LENGTH; i += 1) length += strippedTokens[i]!.length
      if (length > MAX_MULTI_WORD_FORM_LENGTH) continue
      const stripped = strippedTokens.slice(start, start + size).join("")
      if (MULTI_WORD_FORMS.has(stripped)) spans.push({ start, end: start + size, canonical: normaliseTechnologyName(stripped) })
    }
  }
  return spans
}
