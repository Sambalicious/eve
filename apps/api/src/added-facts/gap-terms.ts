import type { ContactHeader } from "../documents/document-model.js"
import { containsAddedFactContactDetail } from "./added-fact-contact-detail.js"
import { codePoints, hasInvalidCharacters } from "./added-facts-rules.js"

/**
 * FEAT-0017 live gap-term filter (SEC-R01, threat-model control 5).
 *
 * A stored `ats.gaps` entry is the posting author's own wording, so it can be
 * anything: a 400-character group label, a zero-width or bidi payload, or a
 * `www.` link. A skill-only fact stores its term verbatim, and migration 0042
 * bounds `term` at 200 code points, so an unfiltered term turns a tick into a
 * 23514 write failure. The filter drops a term the write path could never store:
 *
 * 1. longer than 200 code points after trim (migration 0042's term CHECK);
 * 2. holding a code point the `invalid_characters` one-liner rule refuses;
 * 3. holding one of the Candidate's contact details, or a link.
 *
 * A dropped term is absent from `postingGaps.terms` and from the tick match, so
 * ticking it is `term_not_a_gap`.
 */
export const GAP_TERM_MAX_CODE_POINTS = 200

export function gapTermAllowed(term: string, contact: ContactHeader | null): boolean {
  const trimmed = term.trim()
  if (trimmed === "") return false
  if (codePoints(trimmed) > GAP_TERM_MAX_CODE_POINTS) return false
  if (hasInvalidCharacters(trimmed)) return false
  return !containsAddedFactContactDetail(trimmed, contact)
}
