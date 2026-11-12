import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query"

import {
  applicationsQueryKey,
  submissionListQueryKey,
  submissionQueryKey,
  submitAction,
  submitReasonAction,
  type Submission,
  type SubmissionAction,
  type SubmissionReasonAction,
} from "@/entities/application"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"
import { toastActionFailed } from "@/shared/lib/action-failed"

export type ActionRequest =
  | { readonly action: SubmissionAction; readonly id: string }
  | { readonly action: SubmissionReasonAction; readonly id: string; readonly reason: string }

interface Options {
  /** C-ERR-2 action phrase for a network or server failure, e.g. "mark this confirmed". */
  readonly failure: string
  readonly onDone: (submission: Submission) => void
  /**
   * A contract refusal (4xx with a code). Return true when handled; otherwise
   * C-ERR-2 shows. Return "inline" when the refusal is shown on the card
   * itself: the submission lists are then not refetched, because a refetch
   * could drop the row, and its message with it (C-BLOCK-12d). Counts and
   * Applications still refetch.
   */
  readonly onRefused?: (error: ApiError) => boolean | "inline"
}

/**
 * One of the Candidate's submission actions. On success every submission and
 * Application query refetches, so the lists, counts and status update; the
 * backend's state wins over the screen.
 */
export function useSubmissionAction({ failure, onDone, onRefused }: Options) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (request: ActionRequest) => {
      const csrfToken = await ensureCsrfToken(queryClient)
      return "reason" in request
        ? submitReasonAction(request.action, request.id, request.reason, csrfToken)
        : submitAction(request.action, request.id, csrfToken)
    },
    onSuccess: async (submission) => {
      onDone(submission)
      await refreshSubmissions(queryClient)
    },
    onError: (error) => {
      const handled = error instanceof ApiError && error.code && error.status < 500 ? (onRefused?.(error) ?? false) : false
      // The screen may be stale (another tab); the backend's state wins, except under an inline refusal.
      void refreshSubmissions(queryClient, { keepLists: handled === "inline" })
      if (!handled) toastActionFailed(failure)
    },
  })
  return { run: mutation.mutate, isPending: mutation.isPending }
}

export async function refreshSubmissions(queryClient: ReturnType<typeof useQueryClient>, { keepLists = false } = {}) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: submissionQueryKey, predicate: (query) => !keepLists || !isSubmissionList(query.queryKey) }),
    queryClient.invalidateQueries({ queryKey: applicationsQueryKey }),
  ])
}

/** CR-03: a Submission list query, by the exported key prefix. */
function isSubmissionList(queryKey: QueryKey): boolean {
  return submissionListQueryKey.every((part, index) => queryKey[index] === part)
}
