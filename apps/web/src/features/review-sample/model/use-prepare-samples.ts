import { useMutation, useQueryClient } from "@tanstack/react-query"

import { prepareSamples, submissionCopy, submissionQueryKey, type PrepareSamplesResult } from "@/entities/application"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastError, toastSuccess } from "@/shared/lib/action-failed"

const p = submissionCopy.gate.prepare

/** The toast for a preparation result: how many were added, or why none were. */
export function prepareResultMessage(result: PrepareSamplesResult): { text: string; ok: boolean } {
  if (result.created > 0) return { text: p.created(result.created), ok: true }
  switch (result.stoppedBy) {
    case "paused":
      return { text: p.paused, ok: false }
    case "career_profile_not_approved":
      return { text: p.careerProfile, ok: false }
    case "no_candidates":
      return { text: p.noCandidates, ok: false }
    case "gate_passed":
    case null:
      return { text: p.nothingNeeded, ok: true }
  }
}

/** `POST /v1/samples/prepare`: makes the samples the five still need; the backend picks them. */
export function usePrepareSamples() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async () => prepareSamples(await ensureCsrfToken(queryClient)),
    onSuccess: async (result) => {
      const message = prepareResultMessage(result)
      if (message.ok) toastSuccess(message.text)
      else toastError(message.text)
      await queryClient.invalidateQueries({ queryKey: submissionQueryKey })
    },
    onError: () => toastActionFailed("prepare samples"),
  })
  return { run: () => mutation.mutate(), isPending: mutation.isPending }
}
