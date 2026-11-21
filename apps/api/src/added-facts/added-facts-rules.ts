import type { AddedFactField, AddedFactProblem } from "@eve/contracts"
import { ADDED_FACT_LIMITS } from "@eve/contracts"

import { aspirationPhraseIn } from "../documents/added-fact-claims.js"
import { containsAddedFactContactDetail } from "./added-fact-contact-detail.js"
import type { ContactHeader } from "../documents/document-model.js"

/**
 * FEAT-0017 add-time rules, pure: whether an Application's added facts may change,
 * and the field rules every write runs in the contract's order. The api never
 * renders these; the web maps `problem` to its copy slot.
 */

export const ADDED_FACTS_LIMITS = ADDED_FACT_LIMITS

/** Control characters, bidi controls and default-ignorables: refused, because a pasted invisible payload is not text. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\p{Default_Ignorable_Code_Point}/u

export type FrozenReason = "submitted" | "uncertain" | "manual" | "sample_approved" | "declined" | "details_deleted"
export type BusyReason = "generating" | "submitting"

/** The `application` columns `addedFactsEditable` reads. */
export type EditableColumns = Readonly<{
  state: string
  submission_state: string | null
  sample_state: string | null
  submit_clicked_at: Date | null
  manual_completed_at: Date | null
  details_deleted_at: Date | null
}>

/**
 * The contract's table (api-contract v1.32.0 "Editable, Frozen, busy"), first match
 * wins. `markNotSubmitted` (uncertain to `queued` or `not_submitted`) re-opens
 * editing with no extra code; nothing re-opens `confirmed` or `manual`.
 */
export function addedFactsState(row: EditableColumns): Readonly<{ frozenReason: FrozenReason | null; busyReason: BusyReason | null }> {
  if (row.details_deleted_at !== null) return { frozenReason: "details_deleted", busyReason: null }
  if (row.manual_completed_at !== null || row.submission_state === "manual") return { frozenReason: "manual", busyReason: null }
  if (row.submission_state === "confirmed") return { frozenReason: "submitted", busyReason: null }
  if (row.submission_state === "uncertain") return { frozenReason: "uncertain", busyReason: null }
  if (row.submission_state === "blocked" && row.submit_clicked_at !== null) return { frozenReason: "submitted", busyReason: null }
  if (row.submission_state === "declined") return { frozenReason: "declined", busyReason: null }
  if (row.sample_state === "approved") return { frozenReason: "sample_approved", busyReason: null }
  if (row.submission_state === "submit_claimed" || row.submission_state === "submitting") return { frozenReason: null, busyReason: "submitting" }
  if (row.state === "generating") return { frozenReason: null, busyReason: "generating" }
  return { frozenReason: null, busyReason: null }
}

export function isEditable(row: EditableColumns): boolean {
  const state = addedFactsState(row)
  return state.frozenReason === null && state.busyReason === null
}

/** The trimmed text's length in code points (what the contract counts). */
export function codePoints(text: string): number {
  return [...text].length
}

/** True when the text holds a refused code point: the `invalid_characters` rule alone, for callers that are not text fields. */
export function hasInvalidCharacters(text: string): boolean {
  return FORBIDDEN.test(text)
}

/**
 * The one text problem, in the contract's order: `empty`, `too_long`,
 * `invalid_characters`, `contact_detail`, `aspiration_text`. Null: accepted.
 */
export function textProblem(text: string, contact: ContactHeader | null): Extract<AddedFactProblem, "empty" | "too_long" | "invalid_characters" | "contact_detail" | "aspiration_text"> | null {
  const trimmed = text.trim()
  if (trimmed === "") return "empty"
  if (codePoints(trimmed) > ADDED_FACTS_LIMITS.textMax) return "too_long"
  if (hasInvalidCharacters(trimmed)) return "invalid_characters"
  if (containsAddedFactContactDetail(trimmed, contact)) return "contact_detail"
  if (aspirationPhraseIn(trimmed) !== null) return "aspiration_text"
  return null
}

/** The live gap's own wording for a ticked term (case-insensitive after trim), or null when it is not a live gap. */
export function liveGapTerm(term: string, gaps: readonly string[]): string | null {
  const wanted = term.trim().toLowerCase()
  return gaps.find((gap) => gap.trim().toLowerCase() === wanted) ?? null
}

/** The limit the request would pass, if any: one-liners first when both. */
export function limitProblem(counts: Readonly<{ oneLiner: number; skillOnly: number }>, adding: Readonly<{ oneLiner: number; skillOnly: number }>): "one_liner_limit" | "skill_only_limit" | null {
  if (counts.oneLiner + adding.oneLiner > ADDED_FACTS_LIMITS.oneLiner) return "one_liner_limit"
  if (counts.skillOnly + adding.skillOnly > ADDED_FACTS_LIMITS.skillOnly) return "skill_only_limit"
  return null
}

/** One field error, as the contract's `addedFactFieldErrorSchema` sends it. */
export type AddedFactFieldIssue = Readonly<{ source: "added_facts"; field: AddedFactField; position: number | null; problem: AddedFactProblem }>

export function issue(field: AddedFactField, position: number | null, problem: AddedFactProblem): AddedFactFieldIssue {
  return { source: "added_facts", field, position, problem }
}

/** At most one problem per (position, field): the first one a rule finds is kept. */
export function withoutDuplicateFields(issues: readonly AddedFactFieldIssue[]): AddedFactFieldIssue[] {
  const seen = new Set<string>()
  return issues.filter((entry) => {
    const key = `${entry.field}:${entry.position ?? "null"}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
