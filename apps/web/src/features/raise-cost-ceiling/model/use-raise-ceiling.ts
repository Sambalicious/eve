import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  automationCopy,
  automationStateQueryKey,
  ceilingProblem,
  normalizeUsd,
  raiseCeiling,
  type MonthlySpend,
} from "@/entities/automation-state"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

type Step = "closed" | "form" | "confirm"

/**
 * Raise this month's ceiling (F10, raise steps 1 to 5): the form checks the
 * C-VAL-COST rules for speed, then C-CONFIRM-18 confirms. A backend refusal is
 * the source of truth: its message goes back under the field with the value
 * kept. A failed request is C-ERR-2 and the value is kept too.
 */
export function useRaiseCeiling(spend: MonthlySpend) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>("closed")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: async (ceiling: string) => raiseCeiling(spend.month, ceiling, await ensureCsrfToken(queryClient)),
    onSuccess: (result) => {
      if (result.kind === "refused") {
        setError(result.message)
        return setStep("form")
      }
      queryClient.setQueryData(automationStateQueryKey, result.state)
      // Saved links and the submission status react to the pause clearing.
      void queryClient.invalidateQueries()
      setStep("closed")
      toastSuccess(automationCopy.cost.raisedToast(result.state.spend.ceiling))
    },
    onError: () => {
      setStep("form")
      toastActionFailed("raise this month's ceiling")
    },
  })
  return {
    step,
    value,
    error,
    isPending: mutation.isPending,
    open: () => {
      setValue("")
      setError(null)
      setStep("form")
    },
    close: () => setStep("closed"),
    change: (next: string) => setValue(next),
    /** "Continue": the first matching rule shows under the field; otherwise C-CONFIRM-18. */
    submit: () => {
      const problem = ceilingProblem(value, spend)
      setError(problem)
      if (!problem) setStep("confirm")
    },
    /** Normalised amount for C-CONFIRM-18; only meaningful once `submit` passed. */
    next: step === "confirm" ? normalizeUsd(value) : null,
    confirm: () => mutation.mutate(value.trim()),
  }
}
