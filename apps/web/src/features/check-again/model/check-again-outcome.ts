import { plural, relevanceCopy, type CheckAgainResult } from "@/entities/job-posting"
import { ApiError, isUnauthorizedError } from "@/shared/api"

/** What a successful Check again shows (api-contract.r1, "Web"). */
export interface CheckAgainToast {
  readonly tone: "success" | "info"
  readonly text: string
  /** Mirrored in the page status region (`postings.announce.queued` / `.waiting`); null when the toast alone speaks. */
  readonly announce: string | null
}

/**
 * The three toast cases, exhaustive and checked in this order: nothing claimed
 * first, then where the claimed rows moved. Waiting is info, not success:
 * nothing was queued for a check.
 */
export function checkAgainToast({ queued, movedTo }: CheckAgainResult): CheckAgainToast {
  const { toast } = relevanceCopy.postings.checkAgain
  if (queued === 0) return { tone: "info", text: toast.nothingNew, announce: null }
  if (movedTo === "checking") {
    const text = plural(toast.queued, queued)
    return { tone: "success", text, announce: text }
  }
  const text = plural(toast.waiting, queued)
  return { tone: "info", text, announce: text }
}

/** How a failed request shows in the dialog: an inline alert, or nothing when sign-in takes over. */
export type CheckAgainFailure = { readonly kind: "alert"; readonly message: string } | { readonly kind: "signed_out" }

/**
 * 401: the app-wide handler redirects to sign-in. A 4xx with a message: the
 * message verbatim (`dialog.errorApi`). 5xx, a network failure, a 4xx without
 * a message, or a 200 the schema refuses: `dialog.errorNet`.
 */
export function checkAgainFailure(error: unknown): CheckAgainFailure {
  if (isUnauthorizedError(error)) return { kind: "signed_out" }
  const retry: CheckAgainFailure = { kind: "alert", message: relevanceCopy.postings.checkAgain.dialog.errorNet }
  if (!(error instanceof ApiError) || error.code === null) return retry
  if (error.status >= 500 || error.status < 400 || error.message.trim() === "") return retry
  return { kind: "alert", message: error.message }
}
