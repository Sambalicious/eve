import { useMutation, useQueryClient } from "@tanstack/react-query"

import { jobCriteriaQueryKey, jobCriteriaQueryOptions, saveJobCriteria, type JobCriteria, type JobCriteriaInput } from "@/entities/candidate-settings"
import { jobPostingsQueryKey } from "@/entities/job-posting"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError, isUnauthorizedError } from "@/shared/api"
import { toastSuccess } from "@/shared/lib/action-failed"
import { type FieldError, fieldErrorSchema } from "@eve/contracts"
import { jobCriteriaCopy } from "./copy"

/** Why a save failed, in the terms the form shows (design-spec J2). */
export type SaveFailure =
  | { readonly kind: "fields"; readonly fieldErrors: readonly FieldError[]; readonly message: string }
  | { readonly kind: "message"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  /** 401: the app-wide handler sends the Candidate to sign-in; the form shows nothing. */
  | { readonly kind: "signed_out" }

/**
 * Routes a failed save by HTTP status class (design-spec.r1 J2 step 4, copy-deck r2):
 * - 401: the app-wide handler redirects; nothing shows here.
 * - 409: the conflict alert (its message, else C-JC-CONFLICT).
 * - 400 with field errors: mapped to fields by the form.
 * - other 4xx with a message: the API message verbatim (C-JC-SAVE-ERR-API).
 * - any 5xx (whatever its message), a network failure, an unparseable body,
 *   or a 4xx without a message: C-JC-SAVE-ERR-NET.
 */
export function toSaveFailure(error: unknown): SaveFailure {
  if (isUnauthorizedError(error)) return { kind: "signed_out" }
  const retry: SaveFailure = { kind: "message", message: jobCriteriaCopy.saveFailed }
  if (!(error instanceof ApiError) || error.code === null) return retry
  if (error.status >= 500 || error.status < 400) return retry
  if (error.status === 409) return { kind: "conflict", message: error.message || jobCriteriaCopy.conflict }
  const fieldErrors = error.fieldErrors.filter((item): item is FieldError => fieldErrorSchema.safeParse(item).success)
  if (error.code === "bad_request" && fieldErrors.length > 0) {
    return { kind: "fields", fieldErrors, message: error.message || jobCriteriaCopy.saveFailed }
  }
  return error.message.trim() === "" ? retry : { kind: "message", message: error.message }
}

/**
 * PUT the whole Job criteria section. On success: replace the cached criteria,
 * invalidate every postings query (the save re-decided them, AC 5.3) and toast
 * "Saved.". Failures go to the caller, which keeps the input on screen.
 */
export function useSaveJobCriteria() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (input: JobCriteriaInput) => saveJobCriteria(input, await ensureCsrfToken(queryClient)),
    onSuccess: (saved) => {
      queryClient.setQueryData(jobCriteriaQueryKey, saved)
      void queryClient.invalidateQueries({ queryKey: jobPostingsQueryKey })
      toastSuccess(jobCriteriaCopy.saved)
    },
  })
  const save = (
    input: JobCriteriaInput,
    handlers: { onSaved: (saved: JobCriteria) => void; onFailed: (failure: SaveFailure) => void }
  ) => mutation.mutate(input, { onSuccess: handlers.onSaved, onError: (error) => handlers.onFailed(toSaveFailure(error)) })
  /** Refetches the stored criteria for the defensive 409 "Reload job criteria" action. */
  const reload = () => queryClient.fetchQuery({ ...jobCriteriaQueryOptions(), staleTime: 0 })
  return { save, isSaving: mutation.isPending, reload }
}
