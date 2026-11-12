import type { DeletedBy } from "../db/schema.js"
import type { CandidateTx } from "../db/tenant-database.js"

export type { DeletedBy } from "../db/schema.js"

/**
 * EPIC-0014 (architecture r1 D3, D10): a `running` Outreach row this old or
 * older is stale. The claim may take it over, it no longer makes the Application
 * busy, and the GET reports it as `idle` with `interrupted`. One value for all
 * three, well above the 90 s write call plus the 60 s judge, so a live Run is
 * never freed.
 */
export const OUTREACH_STALE_RUN_MS = 10 * 60 * 1_000

/** Submission states during which a browser attempt may be running; details can't be deleted under it. */
export const IN_FLIGHT = ["submit_claimed", "submitting"] as const
/** SEC-701: a document generation is running; its files and rows would land after the delete. */
export const GENERATING = "generating"
/**
 * E3.6 (D-E9): states that wait on a Candidate decision. Automatic expiry skips
 * them until they are resolved. Manual deletion does not: the Candidate
 * deleting by hand is the decision.
 */
export const PENDING_DECISION = ["uncertain", "blocked", "queued"] as const
/** E3.6 (D-E9): a sample awaiting the Candidate's review. */
export const PENDING_SAMPLE = "awaiting_review"

export type LockedRow = Readonly<{ id: string; state: string; submission_state: string | null; details_deleted_at: Date | null }>

/** E3.5: the set manual deletion refuses with 409 and automatic expiry skips. */
export function isBusy(row: Pick<LockedRow, "state" | "submission_state">): boolean {
  return row.state === GENERATING || (row.submission_state !== null && (IN_FLIGHT as readonly string[]).includes(row.submission_state))
}

/**
 * EPIC-0014 D3: the Applications with an Outreach Run in flight. A Run makes its
 * Application busy without touching the Application row (AC 9.4), so the signal
 * is the `outreach_message` row: `running`, and started under ten minutes ago.
 * An older row is stale (its Run is gone or superseded), so it neither blocks a
 * deletion nor makes the Application busy, and its late finisher writes nothing.
 */
export async function outreachRunningIds(trx: CandidateTx, candidateId: string, applicationIds: readonly string[], now: Date): Promise<Set<string>> {
  if (applicationIds.length === 0) return new Set()
  const rows = await trx
    .selectFrom("outreach_message")
    .select("application_id")
    .where("candidate_id", "=", candidateId)
    .where("application_id", "in", [...applicationIds])
    .where("run_status", "=", "running")
    .where("run_started_at", ">", new Date(now.getTime() - OUTREACH_STALE_RUN_MS))
    .execute()
  return new Set(rows.map((row) => row.application_id))
}

/** Whether any of these Applications has an Outreach Run in flight (the manual 409, and the expiry skip). */
export async function outreachRunning(trx: CandidateTx, candidateId: string, applicationIds: readonly string[], now: Date): Promise<boolean> {
  return (await outreachRunningIds(trx, candidateId, applicationIds, now)).size > 0
}

/**
 * EPIC-0014 D3 (CR-9): the row gained an Outreach Run in flight between the
 * batch that selected it and the lock this deletion takes. The caller's
 * transaction rolls back and nothing is deleted, so the row is not a failure:
 * expiry counts it as skipped in flight, through the same read it already uses
 * to explain every other skip.
 */
export class OutreachRunInFlightError extends Error {
  constructor() {
    super("deleteDetailsLocked: an Outreach Run is in flight")
    this.name = "OutreachRunInFlightError"
  }
}

/**
 * The one deletion of detailed records (AC 10.3, PRD E2.1 to E2.3), shared by
 * the manual endpoint and automatic expiry so the two cannot drift.
 *
 * The caller MUST already hold every row FOR UPDATE in `trx`, and pass only
 * rows whose details still exist and that are not busy; a violation throws and
 * the caller's transaction rolls back. It deletes the Tailored Documents, the
 * stored form read, Outcomes (with any excerpt), notification rows, submission
 * events and (EPIC-0014) Outreach messages, clears the detailed columns, sets
 * `final_status` (latest
 * Outcome type, else submission state, else state), `details_deleted_at` and
 * `details_deleted_by`. Files are not touched here: the storage names are
 * returned for the caller to unlink (api) or count as released (worker).
 *
 * EPIC-0002 A1 (merge 11): `trx` is `candidateId`'s `CandidateTx` and every
 * statement names that Candidate, so RLS and the query both keep it to their rows.
 */
export async function deleteDetailsLocked(trx: CandidateTx, candidateId: string, rows: readonly LockedRow[], now: Date, by: DeletedBy): Promise<{ deletedIds: string[]; fileNames: string[] }> {
  if (rows.some((row) => row.details_deleted_at !== null || isBusy(row))) throw new Error("deleteDetailsLocked: a row is already deleted or busy")
  const targets = rows.map((row) => row.id)
  if (targets.length === 0) return { deletedIds: [], fileNames: [] }
  // EPIC-0014 D3: the check is repeated here, so a caller that forgets cannot delete under an Outreach Run.
  if (await outreachRunning(trx, candidateId, targets, now)) throw new OutreachRunInFlightError()
  const latest = await trx
    .selectFrom("outcome")
    .select(["application_id", "type"])
    .distinctOn("application_id")
    .where("candidate_id", "=", candidateId)
    .where("application_id", "in", targets)
    .orderBy("application_id")
    .orderBy("created_at", "desc")
    .execute()
  const documents = await trx.selectFrom("tailored_document").select(["pdf_storage_name", "docx_storage_name"]).where("candidate_id", "=", candidateId).where("application_id", "in", targets).execute()
  // EPIC-0014 D3: `outreach_message` holds the Outreach texts, names, causes and the first failed sentence.
  for (const table of ["tailored_document", "application_form_read", "outcome", "notification_outbox", "submission_event", "outreach_message"] as const) {
    await trx.deleteFrom(table).where("candidate_id", "=", candidateId).where("application_id", "in", targets).execute()
  }
  for (const row of rows) {
    const outcome = latest.find((item) => item.application_id === row.id)?.type
    await trx
      .updateTable("application")
      .set({
        final_status: outcome ?? row.submission_state ?? row.state,
        details_deleted_at: now,
        details_deleted_by: by,
        role_title: null,
        blocked_claim: null,
        // EPIC-0009 D3: the block's cause and terms go with the paragraph.
        blocked_claim_cause: null,
        blocked_claim_terms: null,
        blocked_claim_more_terms: null,
        blocked_detail: null,
        blocked_question: null,
        evidence_text: null,
        sample_reject_reason: null,
        declined_reason: null,
        failure: null,
        // v1.24.0 (AA-7.1, SEC-AA-05): the minimal record keeps no override.
        candidate_override_at: null,
        override_created_at: null,
        override_status: null,
        override_skip_reason: null,
        override_skip_detail: null,
        override_violated_rules: null,
        updated_at: now,
      })
      .where("candidate_id", "=", candidateId)
      .where("id", "=", row.id)
      .execute()
  }
  return { deletedIds: targets, fileNames: documents.flatMap((document) => [document.pdf_storage_name, document.docx_storage_name]) }
}
