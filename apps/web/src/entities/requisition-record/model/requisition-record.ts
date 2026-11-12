import { plainWords } from "@/shared/lib/plain-words"
/** What stays after detailed records are deleted (AC 10.4): enough to block a second Application for the requisition. */
export interface RequisitionRecord {
  readonly applicationId: string
  readonly company: string | null
  readonly applicationUrl: string | null
  readonly requisitionId: string
  readonly createdAt: string
  readonly detailsDeletedAt: string
  /** Raw final status from the backend: an Outcome type, a submission state or a documents state. */
  readonly finalStatus: string
  /** v1.17.0 (E5.3): who deleted the detailed records; undefined from an older api is unknown (show nothing). */
  readonly deletedBy: "candidate" | "expiry" | undefined
}

/**
 * Final status labels, from the status vocabulary. The contract sends a free
 * string, so an unknown value is shown as sent rather than hidden.
 * OPEN[designer]: no label list for the minimal record's final status; these reuse the badge labels.
 */
const FINAL_STATUS_LABEL: Record<string, string> = {
  confirmation: "Confirmation",
  rejection: "Rejection",
  interview_invitation: "Interview invitation",
  request_for_action: "Request for action",
  confirmed: "Confirmed Submission",
  uncertain: "Uncertain Submission",
  blocked: "Blocked Application",
  manual: "Manual Application",
  not_submitted: "Not submitted",
  declined: "Declined",
  queued: "Queued",
  prepared: "Prepared for you",
  documents_ready: "Prepared for you",
  documents_blocked: "Document blocked",
  documents_failed: "Not generated",
}

export function finalStatusLabel(status: string, plain = false): string {
  const label = FINAL_STATUS_LABEL[status] ?? status
  return plain ? plainWords(label) : label
}
