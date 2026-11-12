import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  approvedAnswerCopy,
  approvedAnswersQueryKey,
  createApprovedAnswer,
  deleteApprovedAnswer,
  updateApprovedAnswer,
  type NewApprovedAnswer,
} from "@/entities/approved-answer"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"
import type { AnswerFormErrors } from "./answer-form"

type SaveRequest = { kind: "create"; answer: NewApprovedAnswer } | { kind: "edit"; id: string; value: string }

/**
 * Creates or edits an Approved Answer. The backend's rule refusals come back
 * as field errors; network and server failures are a C-ERR-2 toast and the
 * sheet stays open with its values.
 */
export function useSaveApprovedAnswer({
  onSaved,
  onFieldErrors,
}: {
  onSaved: () => void
  onFieldErrors: (errors: AnswerFormErrors) => void
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (request: SaveRequest) => {
      const csrfToken = await ensureCsrfToken(queryClient)
      return request.kind === "create"
        ? createApprovedAnswer(request.answer, csrfToken)
        : updateApprovedAnswer(request.id, request.value, csrfToken)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: approvedAnswersQueryKey })
      toastSuccess(approvedAnswerCopy.saved)
      onSaved()
    },
    onError: (error) => {
      const fieldErrors = toFieldErrors(error)
      if (fieldErrors) return onFieldErrors(fieldErrors)
      toastActionFailed("save the answer")
    },
  })
  return { save: mutation.mutate, isSaving: mutation.isPending }
}

export function useDeleteApprovedAnswer({ onDeleted }: { onDeleted: () => void }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (id: string) => deleteApprovedAnswer(id, await ensureCsrfToken(queryClient)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: approvedAnswersQueryKey })
      onDeleted()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "not_found") {
        void queryClient.invalidateQueries({ queryKey: approvedAnswersQueryKey })
        return onDeleted()
      }
      toastActionFailed("delete the answer")
    },
  })
  return { remove: mutation.mutate, isDeleting: mutation.isPending }
}

function toFieldErrors(error: unknown): AnswerFormErrors | null {
  if (!(error instanceof ApiError)) return null
  switch (error.code) {
    case "approved_answer_value_empty":
      return { value: approvedAnswerCopy.emptyValue }
    case "approved_answer_question_empty":
      return { question: approvedAnswerCopy.emptyQuestion }
    case "approved_answer_exists":
      return { topic: approvedAnswerCopy.answerExists } // C-ANS-6
    default:
      return null
  }
}
