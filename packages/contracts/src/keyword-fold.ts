/**
 * The one keyword fold (slice 8, 8F.4; slice 8d, 8d.13, D8d-5). It lives here
 * so the API (stored `job_posting.title_folded`, the request keyword, the
 * classifier and the pre-filter) and the web (postings URL parsing) fold text
 * exactly the same way.
 *
 * Lower-cased, accents folded, whitespace collapsed, dotted initialisms
 * undotted ("U.S." to "us"), Unicode dashes as "-", and every
 * `\p{Default_Ignorable_Code_Point}` and combining mark (`\p{M}`) removed.
 *
 * BACKFILL RULE (8d.19): any change to this function ships a migration that
 * recomputes `job_posting.title_folded` for every titled row. The Job Postings
 * list compares the stored fold with a keyword folded at request time, so a
 * changed fold without that migration makes old titles stop matching. Migration
 * 0011 carries its own frozen copy and is not affected by changes here.
 * The same change must also re-fold every saved title keyword (CR8-03; EPIC-0002
 * D15 compares a saved keyword folded with this function), and it changes the
 * EPIC-0002 A0 owner snapshot, which records `foldForKeywords(title)`.
 */
export function foldForKeywords(text: string): string {
  return text
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (abbreviation) => abbreviation.replace(/\./g, ""))
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

/**
 * v1.13.1 (8d.13): true when `keyword` is empty or only whitespace after
 * `foldForKeywords`, for example zero-width spaces, a soft hyphen, word joiners,
 * bidi controls, a byte order mark, variation selectors or a combining mark on
 * its own. Such a keyword can match nothing the fold keeps, so it is no keyword.
 * The API query schema and the web's postings URL parser both use this rule.
 */
export function keywordFoldsToEmpty(keyword: string): boolean {
  return foldForKeywords(keyword).trim() === ""
}
