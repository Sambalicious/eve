/**
 * Rule 1 (EPIC-0012): the resume headline. The owner's rule is that the title may change but the evidence
 * may not, so the backend prints the posting's role title under the Candidate's name only when one single
 * approved experience title already holds every meaningful word of it. Never a model line and never a fact.
 *
 * No subset and no combine: a word the profile does not support prints nothing at all, and two titles never
 * join to make a third ("Sustainability Analyst" plus "Head of Finance" never yields "Head of
 * Sustainability"). Seniority words are ordinary words with no ladder: Lead is not Senior.
 *
 * Revision 2, R12: the posting title's tokens must appear as one contiguous run, in the same order, inside
 * one single profile title. Stop words count as tokens ("head of" must appear as written), and a posting
 * title with more than one segment prints nothing before matching is tried.
 *
 * Revision 3, R18: an experience title in the profile is split at the R5 separators plus brackets and stripped
 * of a trailing period ("from 2023", "II", "present"). A segment then supports the posting title only as
 * optional step-down words followed by the posting title's tokens and nothing after them, so "Senior
 * Consultant" still prints "Consultant" but "Deputy Head of Finance" prints nothing.
 *
 * Revision 4, R21: the relation cut is gone and a multi-title entry no longer splits. An entry supports the
 * posting title only through one segment, once its period segments (a date, a level, a status) are dropped and
 * a trailing period is trimmed, and then only when that segment is the posting title whole behind a step-down
 * word. Any qualifier, in a bracket or after a separator, leaves no candidate: "Head of Finance (Intern)" prints
 * nothing. "junior" is no longer a step-down word, because it names a level below the bare title.
 *
 * Pure and deterministic. `headlineFor` answers what to print; `headlineDecision` also carries the count of
 * words the profile does not support, for the one log line the caller writes.
 */
import { normaliseForAts } from "../ats/ats-score.js"
import { MONTH_AND_DAY_NAMES } from "../career-profile/claim-check.js"
import { letterName } from "../career-profile/posting-name.js"
import { containsContactDetail } from "./contact-detail.js"

/** A printed title longer than this is not a role title. */
export const HEADLINE_MAX_WORDS = 8

/**
 * Review fix (post-R26): a profile title with more tokens than this is not a title, so it never supports one. It is a
 * backstop on the profile side, as `HEADLINE_MAX_WORDS` is on the posting side: the matcher itself is linear,
 * so this only keeps an impossible title out of it.
 */
const PROFILE_TITLE_MAX_TOKENS = 12

/** Words that carry no meaning about the role, so the profile need not state them. */
const STOP_WORDS = new Set(["a", "an", "and", "the", "of", "at", "in", "for", "to", "with", "on", "or"])

/**
 * Separators between two titles held in one entry (design Revision 1, R5, Revision 3 R18). A slash, pipe,
 * semicolon, comma, arrow or bracket splits with or without spaces; an ampersand, plus, dash or the word
 * and splits only when written with spaces around them. Words never combine across segments. "to" is no
 * longer a separator: a relation phrase such as "Assistant to the Head of Finance" is one segment, which is
 * neither title whole, so it prints nothing (Revision 4, R21).
 */
const TITLE_SEGMENT_BREAK = /\s*(?:\/|\||;|,|→|->|\(|\)|\[|\])\s*|\s+(?:&|\+|–|—|-|and)\s+/gi

/**
 * Revision 3, R18: title levels and status words a trailing period may end with ("Engineer II", "Head of
 * Finance from 2023", "Head of Finance, current").
 */
const TITLE_PERIOD_WORDS: ReadonlySet<string> = new Set(["i", "ii", "iii", "iv", "v", "present", "current", "now", "date"])

/** Words that may lead a trailing period ("from 2023", "since March", "until 2024"). */
const TITLE_PERIOD_LEAD_WORDS: ReadonlySet<string> = new Set(["from", "since", "until", "till", "in"])

/** Connectors a whole period segment may hold beside its period tokens ("(2021 to present)", "from 2023"). */
const TITLE_PERIOD_SEGMENT_WORDS: ReadonlySet<string> = new Set(["from", "since", "until", "till", "in", "to"])

/**
 * Revision 3, R18: words that may stand in front of the posting title as a step down. "Senior Consultant"
 * prints "Consultant"; nothing else may precede the run. Revision 4, R21: "junior" left the list, because it
 * names a level below the bare title (the class of Associate or Trainee), so printing it would be a step up.
 */
const HEADLINE_STEP_DOWN_WORDS: ReadonlySet<string> = new Set(["senior", "lead", "principal", "staff"])


export type HeadlineDecision = Readonly<{
  /** The posting title to print, or null when no single profile title supports it. */
  headline: string | null
  /** Meaningful posting-title words no single profile title states. For the log line only. */
  missing: number
}>

/** The posting title to print under the Candidate's name, or null. D1: only the approved profile supports it. */
export function headlineFor(
  roleTitle: string | null | undefined,
  profileTitles: readonly string[],
  approvedTitles: readonly string[] = []
): string | null {
  return headlineDecision(roleTitle, profileTitles, approvedTitles).headline
}

/**
 * `headlineFor` plus the missing-word count. `approvedTitles` are extra single title candidates (an
 * owner-approved alternate on the Career Profile in a later epic); they never combine with each other.
 */
export function headlineDecision(
  roleTitle: string | null | undefined,
  profileTitles: readonly string[],
  approvedTitles: readonly string[] = []
): HeadlineDecision {
  const printed = printableTitle(roleTitle)
  if (printed === null) return { headline: null, missing: 0 }
  const wanted = tokensOf(printed)
  // No meaningful word means no claim to support (and a title such as "The" that says nothing). Stop words
  // are kept in `wanted` because they must match, but they never make a title meaningful (R12).
  const wantedMeaningful = wanted.filter((word) => !STOP_WORDS.has(word))
  if (wantedMeaningful.length === 0) return { headline: null, missing: 0 }
  // Revision 4, R21: a profile entry supports the posting title only through one segment, after its period
  // segments (a bare date, level or status) are dropped and a trailing period is trimmed. Zero segments left
  // or two or more means a multi-title entry or a qualifier after a separator, and neither prints. An approved
  // alternate is one extra single title as the owner wrote it, so it is not split or trimmed.
  const approved = approvedTitles.map(tokensOf).filter((title) => title.length > 0)
  const candidates: Array<readonly string[]> = []
  let missing = wantedMeaningful.length
  for (const title of profileTitles) {
    const kept = candidateSegments(title)
    for (const segment of kept) missing = Math.min(missing, uncovered(trimTrailingPeriod(segment), wantedMeaningful))
    // Review fix (post-R26): one segment, and one a title could actually be. Neither the posting nor the profile
    // side of a real title runs to more tokens than that.
    if (kept.length !== 1) continue
    const only = trimTrailingPeriod(kept[0]!)
    if (only.length > PROFILE_TITLE_MAX_TOKENS) continue
    candidates.push(only)
  }
  for (const title of approved) missing = Math.min(missing, uncovered(title, wantedMeaningful))
  candidates.push(...approved)
  // An owner-approved alternate is one exact title the owner wrote, so it still supports a posting title
  // that R5 splits into two segments ("Head of Research & Development", 3h).
  if (approved.some((title) => supported(title, wanted))) return { headline: printed, missing: 0 }
  // More than one segment in the posting title is two roles, or a role plus a location, never one title.
  // Revision 2, M1: this runs before matching, so a supported multi-segment title never prints.
  if (titleSegments(printed).length > 1) return { headline: null, missing }
  for (const title of candidates) if (supported(title, wanted)) return { headline: printed, missing: 0 }
  return { headline: null, missing }
}

/** The non-empty title segments of one experience title or posting title (Revision 1, R5). */
function titleSegments(text: string): string[] {
  return text
    .split(TITLE_SEGMENT_BREAK)
    .map((segment) => segment.replace(/\s+/gu, " ").trim())
    .filter((segment) => segment !== "")
}

/**
 * Revision 4, R21: the segments of one profile title that could carry a title, in order. A segment whose
 * every token is a period token or a period connector, and that holds at least one period token, is a bare
 * date, level or status ("(2021–present)", ", present", "(from 2023)") and holds no word that could qualify a
 * title, so it is dropped. Empty segments go too.
 */
function candidateSegments(title: string): string[][] {
  return titleSegments(title)
    .map(tokensOf)
    .filter((segment) => segment.length > 0 && !isPeriodSegment(segment))
}

/** True when a segment is only a period: period tokens and their connectors, and at least one period token. */
function isPeriodSegment(tokens: readonly string[]): boolean {
  let periods = 0
  for (const token of tokens) {
    if (isPeriodToken(token)) {
      periods += 1
      continue
    }
    if (!TITLE_PERIOD_SEGMENT_WORDS.has(token)) return false
  }
  return periods > 0
}

/**
 * Revision 3, R18: from the end of the title, remove the period tokens (numbers, levels, months, "present"),
 * and the one word that may lead them ("from 2023"). "Head of Finance from 2023" reads "head of finance".
 */
function trimTrailingPeriod(tokens: readonly string[]): string[] {
  const out = [...tokens]
  let removed = false
  while (out.length > 0 && isPeriodToken(out[out.length - 1]!)) {
    out.pop()
    removed = true
  }
  const lead = out.at(-1)
  if (removed && lead !== undefined && TITLE_PERIOD_LEAD_WORDS.has(lead)) out.pop()
  return out
}

function isPeriodToken(token: string): boolean {
  return /^\p{N}+$/u.test(token) || TITLE_PERIOD_WORDS.has(token) || MONTH_AND_DAY_NAMES.has(token)
}

/**
 * The title as printed: parenthesised parts removed ("(m/f/d)"), trimmed, then refused when it holds a
 * digit or contact detail, runs past `HEADLINE_MAX_WORDS`, or fails `letterName` (SEC-410).
 *
 * Review fix (post-R26): the printed limit counts space-separated words, but the matcher reads
 * `normaliseForAts` tokens, and that splits on `* ~ • ^` as well. A 300-character title can therefore reach
 * the matcher as hundreds of tokens, so the same limit is enforced on the token count too.
 */
function printableTitle(roleTitle: string | null | undefined): string | null {
  if (roleTitle == null) return null
  const printed = roleTitle.replace(/\([^)]*\)/g, " ").replace(/\s+/gu, " ").trim()
  if (printed === "" || /\p{N}/u.test(printed)) return null
  if (printed.split(" ").length > HEADLINE_MAX_WORDS) return null
  if (tokensOf(printed).length > HEADLINE_MAX_WORDS) return null
  if (containsContactDetail(printed, null)) return null
  return letterName(printed)
}

/**
 * A title's tokens, compared the way the posting and the profile spell them: `normaliseForAts`, sr to
 * senior and jr to junior, plurals singularised, acronyms as written. Stop words are tokens here (Revision
 * 2, R12); `uncovered` takes only the meaningful ones.
 */
function tokensOf(text: string): string[] {
  return normaliseForAts(text)
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => (word === "sr" ? "senior" : word === "jr" ? "junior" : word))
    .map(singular)
}

/** "Strategies" to "strategy", "Engineers" to "engineer"; a word ending "ss" is left alone. */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

/**
 * True when one profile segment supports the posting title (Revision 3, R18): the segment is a run of
 * step-down words followed by the posting title's tokens exactly, with nothing after them.
 *
 * Review fix (post-R26): the join rule is still applied on both sides ("frontend" is one run of "front end" and the
 * reverse), but it is no longer enumerated. Joining words only concatenates them, so one side's joined form is
 * a string, and each side can always be joined whole: a match exists exactly when some token boundary of the
 * segment starts a suffix whose words concatenate to the wanted words concatenated. One backward pass, so the
 * cost is linear in the title length. The old enumeration grew like Fibonacci (a 34-token title was tens of
 * millions of arrays and the api ran out of memory).
 */
function supported(title: readonly string[], wanted: readonly string[]): boolean {
  const target = wanted.join("")
  // An empty posting title matches a segment that is nothing but step-down words, as the enumeration did.
  if (target === "") return title.every((word) => HEADLINE_STEP_DOWN_WORDS.has(word))
  let suffix = ""
  for (let index = title.length - 1; index >= 0; index -= 1) {
    suffix = `${title[index] ?? ""}${suffix}`
    // The suffix only grows, so once it is longer than the wanted run it can never equal it.
    if (suffix.length > target.length) return false
    if (suffix === target) return title.slice(0, index).every((word) => HEADLINE_STEP_DOWN_WORDS.has(word))
  }
  return false
}

/**
 * How many meaningful words of the posting title one profile title does not state. Counted one by one,
 * without the join rule, because it only feeds the diagnostic log line.
 */
function uncovered(title: readonly string[], wanted: readonly string[]): number {
  const counts = new Map<string, number>()
  for (const word of title) counts.set(word, (counts.get(word) ?? 0) + 1)
  let missing = 0
  for (const word of wanted) {
    const left = counts.get(word) ?? 0
    if (left === 0) missing += 1
    else counts.set(word, left - 1)
  }
  return missing
}
