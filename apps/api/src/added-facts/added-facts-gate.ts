import type { QueuedPostingDroppedDetail } from "@eve/contracts"

import type { ApplicationMatchResult } from "./application-match.js"

/**
 * FEAT-0017 queue gate, pure (architecture "Queue gate, confirmation and voiding").
 *
 * "Same set" is counter equality. One rule decides stale documents for every
 * caller (the submit-time check, `queue`, `sample`, `sample/approve`,
 * `requeueAtsHeld`, the view and `confirm`), so they cannot disagree:
 *
 * - flag on: any recorded counter that differs from the Application's is stale;
 * - flag off (A-11 r1, SEC-001): still stale when a counter differs AND the union
 *   of the resume's and cover letter's `cited` lists is non-empty. Regenerating
 *   with the flag off records counter 0 and an empty `cited`, so nothing sticks.
 */

export type RecordedAddedFacts = Readonly<{ version: number; cited: readonly string[] }>

export function documentsStale(input: Readonly<{ flagOn: boolean; applicationVersion: number; documents: readonly RecordedAddedFacts[] }>): boolean {
  if (input.documents.length === 0) return false
  const mismatch = input.documents.some((document) => document.version !== input.applicationVersion)
  if (!mismatch) return false
  if (input.flagOn) return true
  return input.documents.some((document) => document.cited.length > 0)
}

export type GateInput = Readonly<{
  flagOn: boolean
  applicationVersion: number
  confirmedVersion: number | null
  documents: readonly RecordedAddedFacts[]
  /** The posting's stored decision status. */
  postingStatus: string
  /** What the existing posting rule decided: null when the Application may be submitted. */
  baseDrop: QueuedPostingDroppedDetail | null
  /** The live Application Match, read under the same lock. */
  match: Pick<ApplicationMatchResult, "lifted"> | null
}>

/**
 * The locked submit-time drop detail, first match wins:
 *
 * 1. stale documents (every Application, both flag states);
 * 2. the posting is ranked: no further objection from this gate;
 * 3. the Application Match is not lifted: the existing result stands;
 * 4. lifted but not confirmed for the current counter: `added_facts_unconfirmed`;
 * 5. lifted, confirmed, and the existing result was `not_ranked` or
 *    `override_mismatch`: submittable on the lift basis (`dropOf`'s Eligibility
 *    re-check still runs, and the Override is never rewritten).
 */
export function addedFactsDropDetail(input: GateInput): QueuedPostingDroppedDetail | null {
  if (documentsStale({ flagOn: input.flagOn, applicationVersion: input.applicationVersion, documents: input.documents })) return "documents_stale"
  if (input.postingStatus === "ranked") return input.baseDrop
  if (!input.flagOn) return input.baseDrop
  if (input.match === null || !input.match.lifted) return input.baseDrop
  if (input.confirmedVersion !== input.applicationVersion) return "added_facts_unconfirmed"
  if (input.baseDrop === "not_ranked" || input.baseDrop === "override_mismatch") return null
  return input.baseDrop
}

/** `POST …/queue` refuses a lifted Application whose confirmation does not cover the current counter. */
export function confirmationRequired(input: Readonly<{ flagOn: boolean; applicationVersion: number; confirmedVersion: number | null; match: Pick<ApplicationMatchResult, "lifted"> | null }>): boolean {
  return input.flagOn && input.match !== null && input.match.lifted && input.confirmedVersion !== input.applicationVersion
}
