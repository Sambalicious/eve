import { QUALIFICATION_WORDS, claimWords, statesNumber } from "./claim-check.js"

/** Longest role title or employer name the backend writes into a letter sentence (SEC-410). */
export const LETTER_NAME_MAX_LENGTH = 80
/** Longest role title or employer name stored at ingestion (SEC-410). */
export const STORED_NAME_MAX_LENGTH = 200

// Control, format and line/paragraph separator characters, and every default-ignorable code point.
const NON_PRINTING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\p{Default_Ignorable_Code_Point}/gu

/**
 * SEC-410, at ingestion: one line, no control or invisible characters, single
 * spaces, at most STORED_NAME_MAX_LENGTH characters. Empty becomes null.
 */
export function cleanPostingName(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const line = raw.replace(NON_PRINTING, " ").replace(/\s+/gu, " ").trim().slice(0, STORED_NAME_MAX_LENGTH).trim()
  return line === "" ? null : line
}

// Sentence punctuation that could end the backend's sentence and start another.
// SEC-411: tested after NFKC, plus every Unicode sentence terminator and
// terminal punctuation mark. The ASCII comma is the one terminal mark allowed
// ("Staff Software Engineer, Payments").
const SENTENCE_PUNCTUATION = /[.!?;:\u2026\u3002\uff01\uff1f\uff1b\uff1a]|\p{Sentence_Terminal}|(?!,)\p{Terminal_Punctuation}/u
// First-person and biography words: a name never states something about the Candidate.
const BIOGRAPHY_WORDS = new Set([
  "i", "me", "my", "mine", "myself", "i'm", "i've", "im", "ive",
  "former", "formerly", "previously", "ex", "hold", "holds", "held", "led", "years", "experience", "hired", "worked",
])
// Cyrillic and Greek letters that look like Latin ones (SEC-411), folded before the word lists.
const CONFUSABLES: Readonly<Record<string, string>> = {
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", Ѕ: "S", І: "I", Ј: "J", Ү: "Y",
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", ѕ: "s", і: "i", ј: "j", һ: "h", ԁ: "d", ԛ: "q", ԝ: "w",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  ο: "o", ν: "v", ρ: "p", ι: "i", κ: "k", υ: "u", τ: "t",
}
const CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu")
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u] as const

/** SEC-411: a word that mixes Latin, Cyrillic and Greek letters ("Рhd", "fοrmer") is a spoof, not a name. */
function mixesScripts(name: string): boolean {
  return (name.match(/[\p{L}\p{M}]+/gu) ?? []).some((word) => SCRIPTS.filter((script) => script.test(word)).length > 1)
}

/**
 * SEC-410: the posting's role or company as the backend may write it into the
 * greeting, opening and closing, or null for the generic sentence. Rejected:
 * empty, a newline or other non-printing character in the raw value, more than
 * LETTER_NAME_MAX_LENGTH characters, sentence punctuation, any number or date,
 * a qualification word, or a first-person or biography word. Title and skill
 * words ("Senior", "React") stay allowed: in "I am applying for the … role"
 * they name the posting, not the Candidate (deviation from the finding's
 * "claim words" rule, which would drop every normal role title).
 *
 * SEC-411: the name is NFKC-normalised first (fullwidth, math-styled and
 * compatibility forms become plain letters and digits) and returned in that
 * form. Unicode terminators reject it, a word mixing Latin with Cyrillic or
 * Greek rejects it, and Cyrillic/Greek look-alikes are folded to Latin before
 * the word lists ("МВА" is "MBA"). A name wholly in another script ("Яндекс")
 * is kept.
 */
export function letterName(raw: string | null | undefined): string | null {
  if (raw == null) return null
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw.replace(/[\t ]/g, "")) || /\p{Default_Ignorable_Code_Point}/u.test(raw)) return null
  const name = raw.normalize("NFKC").replace(/\s+/gu, " ").trim()
  if (name === "" || name.length > LETTER_NAME_MAX_LENGTH) return null
  if (SENTENCE_PUNCTUATION.test(name) || mixesScripts(name)) return null
  const folded = name.replace(CONFUSABLE, (letter) => CONFUSABLES[letter] ?? letter)
  if (statesNumber(folded)) return null
  const words = claimWords(folded)
  if (words.some((word) => QUALIFICATION_WORDS.has(word) || BIOGRAPHY_WORDS.has(word))) return null
  return name
}
