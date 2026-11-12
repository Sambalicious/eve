import { useMutation, useQueryClient } from "@tanstack/react-query"
import { pasteFieldErrorSchema } from "@eve/contracts"

import {
  jobPostingsQueryKey,
  pasteJobLink,
  type JobPosting,
  type PasteRequest,
  type PasteResult,
  type WaitingReason,
} from "@/entities/job-posting"
import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode, type ApiError } from "@/shared/api"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"
import { fieldMessages, type PasteFieldMessages } from "./description"
import { LINK_EMPTY, LINK_INVALID } from "./job-link"
import { pasteCopy } from "./paste-copy"

/** C-LINK-1. */
export const LINK_ACCEPTED =
  "Checking the link. It goes through the same Eligibility, Match, duplicate and cap rules as discovered postings."

/** Design r1 B1 form-level alert: refusals no single field owns. */
export type PasteFormAlert =
  | { readonly kind: "employer_page_unreadable"; readonly missing: readonly ("title" | "company")[] }
  | { readonly kind: "posting_still_checking" }

export type PasteOutcome =
  | { kind: "created"; posting: JobPosting; waitingReason: WaitingReason | null }
  | { kind: "existing"; posting: JobPosting; waitingReason: WaitingReason | null }
  | { kind: "refused"; message: string }
  /** v1.27.0: a paste that carried a description, answered with a `descriptionOutcome`. */
  | { kind: "description"; result: PasteResult }
  /** v1.27.0: a description paste refused on one or more fields. */
  | { kind: "fields"; messages: PasteFieldMessages }
  | { kind: "alert"; alert: PasteFormAlert }

const FIELD_CODES = [
  "job_description_too_short",
  "job_description_too_long",
  "job_title_required",
  "job_title_too_long",
  "company_required",
  "company_too_long",
] as const

function pasteFieldErrorsOf(error: ApiError) {
  return error.fieldErrors.flatMap((entry) => {
    const parsed = pasteFieldErrorSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/** The outcome of a refused description paste, or null when it is not one the form shows inline. */
function descriptionRefusal(error: unknown): PasteOutcome | null {
  if (hasErrorCode(error, "job_link_invalid")) return { kind: "fields", messages: { link: LINK_INVALID } }
  if (hasErrorCode(error, "employer_page_unreadable")) {
    const missing = pasteFieldErrorsOf(error).flatMap((e) => (e.field === "title" || e.field === "company" ? [e.field] : []))
    return { kind: "alert", alert: { kind: "employer_page_unreadable", missing } }
  }
  if (hasErrorCode(error, "posting_still_checking")) return { kind: "alert", alert: { kind: "posting_still_checking" } }
  for (const code of FIELD_CODES) {
    if (!hasErrorCode(error, code)) continue
    const messages = fieldMessages(pasteFieldErrorsOf(error))
    return { kind: "fields", messages: Object.keys(messages).length > 0 ? messages : { description: error.message } }
  }
  return null
}

/**
 * Sends a paste. Link-only (`{ url }`) is today's behaviour: a new posting clears
 * the field and shows C-LINK-1; an already stored one shows C-LINK-2 inline; a
 * refusal shows its message inline. A paste with a description reports its
 * `descriptionOutcome` (the form shows the result line, no toast), field
 * refusals and the two form-level refusals. Network and server failures toast
 * C-ERR-2 ("check the link", or C-PD-26 "check the job" with a description) and
 * keep the form.
 */
export function usePasteJobLink({ onOutcome }: { onOutcome: (outcome: PasteOutcome) => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (request: PasteRequest) => pasteJobLink(request, await ensureCsrfToken(queryClient)),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: jobPostingsQueryKey })
      if (result.descriptionOutcome !== null) return onOutcome({ kind: "description", result })
      const { created, posting } = result
      // EPIC-0006 B7: a hidden result gets the inline line instead of the toast (one message, not two).
      if (created && posting.hiddenReason === null) toastSuccess(LINK_ACCEPTED)
      onOutcome({ kind: created ? "created" : "existing", posting, waitingReason: result.waitingReason })
    },
    onError: (error, request) => {
      if ("description" in request) {
        const refusal = descriptionRefusal(error)
        if (refusal) return onOutcome(refusal)
        return toastActionFailed(pasteCopy.failedVerb)
      }
      if (hasErrorCode(error, "job_link_empty")) return onOutcome({ kind: "refused", message: LINK_EMPTY })
      if (hasErrorCode(error, "job_link_invalid")) return onOutcome({ kind: "refused", message: LINK_INVALID })
      toastActionFailed("check the link")
    },
  })
  return { paste: mutation.mutate, isPasting: mutation.isPending }
}
