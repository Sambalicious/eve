/** Shorter quotes match too easily by chance to prove a fact came from the resume. */
const MIN_QUOTE_LENGTH = 8

const TYPOGRAPHIC: Readonly<Record<string, string>> = {
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201C": '"', "\u201D": '"', "\u201E": '"',
  "\u00A0": " ", "\u2022": " ", "\u00B7": " ",
}

/** Code points that render as nothing; dropped so they can't split a word (SEC-219). */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu

/**
 * The form both the resume text and a quote are compared in: invisible code
 * points removed, Unicode NFKC,
 * typographic dashes and quotes as ASCII, all whitespace collapsed, lower case.
 * Extraction breaks lines and spaces differently per format, so only those are
 * forgiven; every word and number must still match.
 */
export function normaliseForQuote(text: string): string {
  return text
    .replace(DEFAULT_IGNORABLE, "")
    .normalize("NFKC")
    .replace(/[\u2010-\u2014\u2212\u2018\u2019\u201A\u201C-\u201E\u00A0\u2022\u00B7]/g, (c) => TYPOGRAPHIC[c] ?? c)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/** True when the quote, normalised, is a substring of the normalised resume text. */
export function quoteAppearsIn(quote: string, normalisedResume: string): boolean {
  const needle = normaliseForQuote(quote)
  return needle.length >= MIN_QUOTE_LENGTH && normalisedResume.includes(needle)
}
