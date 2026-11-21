import type { Selectable } from "kysely"

import type { ApplicationTable } from "../db/schema.js"

/** The `application` columns the queue preconditions read. */
export type QueuePreconditionRow = Pick<Selectable<ApplicationTable>, "state" | "submission_state" | "blocked_reason" | "sample_state">

/**
 * SEC-R04: the preconditions `queue()` applies before a documents-ready Application
 * may enter the automatic queue, in the one place the added-facts confirm route
 * reads them too (`added-facts.service.ts`), so the two routes cannot drift.
 *
 * `manualOnly` is read from the posting row, a query, so the caller passes it in.
 * The two checkpoints are separate because the routes apply them at the points
 * their contracts fix: confirm reads `manualOnly` before the Application Match and
 * the state/sample rules after the documents checks, while `queue()` reads them
 * together. `queue()`'s own replay (`submission_state === "queued"` is a no-op) and
 * confirm's replay (an already-confirmed queued row) stay with their routes.
 */
export type QueuePreconditions = Readonly<{
  /** A pasted-description or manual-apply Application is never queued (PD-4.1). */
  manualOnly: boolean
  /** The assistant could not complete the form, so it never retries this Application. */
  automationIncomplete: boolean
  /** The Application itself is not documents-ready. */
  notDocumentsReady: boolean
  /** Its queue position, blocked reason or sample state is not one a queue can start from. */
  notResumable: boolean
}>

export function queuePreconditions(row: QueuePreconditionRow, manualOnly: boolean): QueuePreconditions {
  const fromBlocked = row.submission_state === "blocked" && row.blocked_reason !== "same_company_review"
  return {
    manualOnly,
    automationIncomplete: row.submission_state === "blocked" && row.blocked_reason === "automation_incomplete",
    notDocumentsReady: row.state !== "documents_ready",
    notResumable: !(row.submission_state === null || fromBlocked) || row.sample_state !== null,
  }
}
