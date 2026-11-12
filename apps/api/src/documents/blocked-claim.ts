import { BLOCKED_CLAIM_TERMS_CAUSES, BLOCKED_CLAIM_TERMS_LIMIT, BLOCKED_CLAIM_TERM_MAX, type BlockedClaimCause } from "@eve/contracts"

import { writtenClaims } from "../career-profile/claim-check.js"
import type { DocumentValidation } from "./document-claims.js"

/**
 * EPIC-0009 D2: why a document was blocked, ready to store. `terms` and `moreTerms` are null for
 * every cause that shows no list (OD-1), never an empty array, so the contract's "present exactly
 * with a terms cause" rule holds at the write.
 */
export type BlockedClaim = Readonly<{
  /** Null for a validator result outside the path table: no kind is stored and the web shows the fallback (A-2, AC 10.10). */
  cause: BlockedClaimCause | null
  terms: readonly string[] | null
  moreTerms: number | null
}>

const TERMS_CAUSES: ReadonlySet<string> = new Set(BLOCKED_CLAIM_TERMS_CAUSES)

/**
 * EPIC-0009 OD-1, architecture D2: `reason` decides first, then `hardFail` inside `unsupported_claim`,
 * and a failure with no hard fail is `not_confirmed`. A code this build does not know stores no kind at
 * all (A-2, AC 10.10), so the alert shows the fallback instead of a wrong remedy.
 */
export function causeOf(validation: Extract<DocumentValidation, { ok: false }>): BlockedClaimCause | null {
  switch (validation.reason) {
    case "contact_detail":
      return "contact_detail"
    case "unknown_fact":
      return "unknown_fact"
    case "names_target":
      return "names_target"
    case "no_fact":
      return "no_fact"
    case "unsupported_claim":
      if (validation.hardFail === undefined) return "not_confirmed"
      switch (validation.hardFail) {
        case "number":
          return "number_order"
        case "claim_word":
        case "gap":
        case "role_noun":
        case "borrowed_name":
        case "posting_term":
        case "support_inflation":
        case "completion_word":
        case "unsourced_quote":
          return "unsupported_terms"
        // R2-6: unreachable from today's validator, but the mapper must still be total.
        case "names_target":
          return "names_target"
        default:
          return null
      }
    default:
      return null
  }
}

/**
 * The blocked paragraph's cause and the flagged terms as they are written in it (PRD 1.2 to 1.6,
 * OD-4). Never throws: a locator failure must not turn a block into a provider error (contract A-2).
 */
export function describeBlock(validation: Extract<DocumentValidation, { ok: false }>): BlockedClaim {
  const cause = causeOf(validation)
  if (cause === null || !TERMS_CAUSES.has(cause)) return { cause, terms: null, moreTerms: null }
  try {
    const { terms, moreTerms } = collectTerms(validation.claim, validation.unsupported)
    return { cause, terms, moreTerms }
  } catch {
    return { cause, terms: [], moreTerms: 0 }
  }
}

/**
 * The terms a Candidate sees: each value the validator returned, as written in the paragraph, in
 * paragraph order, de-duplicated case-insensitively. Values the paragraph no longer holds are left
 * out (PRD 1.4). Terms past the stored limit, and terms longer than the contract allows, are counted
 * in `moreTerms` instead of being dropped silently (PRD 1.6, OD-4).
 */
export function collectTerms(claim: string, values: readonly string[]): { terms: string[]; moreTerms: number } {
  const located = locate(claim, values)
  const terms: string[] = []
  const seen = new Set<string>()
  let moreTerms = 0
  for (const term of located) {
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (term.length > BLOCKED_CLAIM_TERM_MAX || terms.length >= BLOCKED_CLAIM_TERMS_LIMIT) {
      moreTerms += 1
      continue
    }
    terms.push(term)
  }
  return { terms, moreTerms }
}

/**
 * Each value's first appearance in the paragraph, as written, in paragraph order (contract D1 step 1):
 * a token span from `writtenClaims` first, otherwise a whole-word, case-insensitive literal match. The
 * literal pass is what finds a quotation or any other multi-word span; a value the paragraph does not
 * hold is left out and not counted (AC 1.4).
 */
function locate(claim: string, values: readonly string[]): string[] {
  const wanted = new Set(values)
  if (wanted.size === 0) return []
  const found: { text: string; start: number }[] = []
  for (const written of writtenClaims(claim)) {
    if (!wanted.has(written.value)) continue
    wanted.delete(written.value)
    found.push({ text: written.text, start: written.start })
  }
  for (const value of [...wanted]) {
    if (value.trim() === "") continue
    const start = indexOfWholeWord(claim, value)
    if (start === -1) continue
    wanted.delete(value)
    found.push({ text: claim.slice(start, start + value.length), start })
  }
  return found.sort((a, b) => a.start - b.start).map((entry) => entry.text)
}

/** Case-insensitive literal match that cannot start or end inside a letter or digit. */
function indexOfWholeWord(claim: string, value: string): number {
  const haystack = claim.toLowerCase()
  const needle = value.toLowerCase()
  // Lower-casing can change the length (a few letters expand); offsets would then not map back to the
  // paragraph, so such a line is treated as not locatable rather than slicing the wrong text.
  if (haystack.length !== claim.length || needle.length !== value.length) return -1
  // The boundary rule applies to the edge that is itself a letter or digit: a value that starts or ends
  // with punctuation has nothing to be "inside" on that side.
  const needsBefore = isWordChar(needle[0] ?? "")
  const needsAfter = isWordChar(needle[needle.length - 1] ?? "")
  let from = 0
  while (from + needle.length <= haystack.length) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return -1
    const before = haystack[at - 1] ?? ""
    const after = haystack[at + needle.length] ?? ""
    if (!(needsBefore && isWordChar(before)) && !(needsAfter && isWordChar(after))) return at
    from = at + 1
  }
  return -1
}

function isWordChar(char: string): boolean {
  return char !== "" && /[\p{L}\p{N}]/u.test(char)
}

/**
 * What `summaryOf` may send: a stored term that no longer parses (emptied, over-long) is dropped and
 * counted in `moreTerms` instead, so one bad row cannot make the contract reject a whole list
 * (threat TM-0009-04). A cause this build does not know is sent as-is and the web shows the fallback.
 */
export function storedTerms(cause: string | null, terms: readonly string[] | null, moreTerms: number | null): { terms: string[] | null; moreTerms: number | null } {
  if (cause === null || !TERMS_CAUSES.has(cause)) return { terms: null, moreTerms: null }
  const kept: string[] = []
  let dropped = 0
  for (const term of terms ?? []) {
    if (term.length === 0 || term.length > BLOCKED_CLAIM_TERM_MAX || kept.length >= BLOCKED_CLAIM_TERMS_LIMIT) dropped += 1
    else kept.push(term)
  }
  return { terms: kept, moreTerms: (moreTerms ?? 0) + dropped }
}
