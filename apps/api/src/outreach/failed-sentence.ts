import { OUTREACH_FIRST_FAILED_SENTENCE_MAX, outreachLength } from "@eve/contracts"

/**
 * EPIC-0014 architecture r1 D13: the two pure rules the first failed sentence
 * needs. Both are called from inside `OutreachRepository`'s transactions (the
 * cap in `finishBlocked`, the name comparison in `finishBlocked` and in the name
 * save), and neither touches a database, a clock or the model.
 *
 * The sentence is model text that the guard refused, so it is stored verbatim
 * (trimmed only) and shown to the Candidate who owns it. These two functions are
 * the only code that may shorten it or refuse to store it.
 */

/** The ellipsis a cut sentence ends with: U+2026, one code point, never three full stops. */
const ELLIPSIS = "\u2026"

/**
 * The sentence as it may be stored (D13, "Length bound and what happens above
 * it"): null stays null, whitespace is trimmed, and a sentence of at most
 * `OUTREACH_FIRST_FAILED_SENTENCE_MAX` (400) code points is returned unchanged.
 * Above the cap it is cut at the last whole word, so the kept words plus one
 * `…` total at most the cap: never inside a character and never mid-word. The
 * cut adds no em dash, but it can leave one the sentence already had as the last
 * kept character before the `…`; that cannot happen today, because the write
 * schema's 400 UTF-16 unit limit refuses an over-long element first. A single
 * unbroken token longer than the cap has no whole word to cut at, so it returns
 * null and the sentence is withheld.
 *
 * In practice the write schema's 400 UTF-16 unit limit already refuses an
 * over-long element, so this is defence in depth for a later schema change.
 */
export function capFailedSentence(sentence: string | null): string | null {
  if (sentence === null) return null
  const trimmed = sentence.trim()
  if (trimmed === "") return null
  if (outreachLength(trimmed) <= OUTREACH_FIRST_FAILED_SENTENCE_MAX) return trimmed

  // Two code points are reserved for " …", so "kept words" plus the ellipsis fit the cap.
  const room = OUTREACH_FIRST_FAILED_SENTENCE_MAX - 2
  const characters = Array.from(trimmed)
  const head = characters.slice(0, room).join("")
  // The last whole word inside the head: cut at the final space and drop it too.
  const boundary = head.lastIndexOf(" ")
  if (boundary === -1) return null
  const kept = head.slice(0, boundary).trim()
  if (kept === "") return null
  return `${kept} ${ELLIPSIS}`
}

/**
 * Whether a sentence names the Reader (D13, "Privacy"). The comparison folds
 * case and accents the way the claim checks do (`namesTarget`'s fold: invisible
 * characters removed, NFKD, combining marks removed, lower case, every
 * non-letter/digit run as one space), so "Amara" matches "amara" and "Amára"
 * matches "Amara".
 *
 * A match is the whole name as words, or any word of the name with three or
 * more letters (the name is split on spaces, hyphens, apostrophes and full
 * stops by the fold), as whole words only: "Al" inside "Ali" or "van" inside
 * "Advance" is not a match. The rule is deliberately conservative, so a name
 * that is also a common word ("Will") withholds a quote. That is the safe
 * direction: the Candidate sees the cause line only.
 */
export function mentionsReaderName(sentence: string, readerName: string): boolean {
  const line = ` ${foldWords(sentence)} `
  const name = foldWords(readerName)
  if (name === "") return false
  if (line.includes(` ${name} `)) return true
  return name
    .split(" ")
    .filter((part) => Array.from(part).length >= 3)
    .some((part) => line.includes(` ${part} `))
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
