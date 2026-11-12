import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  approvedAnswerCopy,
  clearSalaryCard,
  salaryQueryKey,
  setCurrentSalary,
  setGrossSalaryPolicy,
  setPreferredNetPay,
  type GrossSalaryInput,
  type NetPayInput,
  type SalaryAnswers,
  type SalaryCard,
} from "@/entities/approved-answer"
import { ensureCsrfToken } from "@/entities/session"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"

type GrossCard = Exclude<SalaryCard, "preferredNetPay">

const SAVE_GROSS: Record<GrossCard, (input: GrossSalaryInput, csrf: string) => Promise<SalaryAnswers>> = {
  grossSalaryPolicy: setGrossSalaryPolicy,
  currentSalary: setCurrentSalary,
}

function useSalaryMutation<T>(
  save: (input: T, csrf: string) => Promise<SalaryAnswers>,
  onDone: () => void,
  failedAction = "save the salary answer"
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: T) => save(input, await ensureCsrfToken(queryClient)),
    onSuccess: (salary) => {
      queryClient.setQueryData(salaryQueryKey, salary)
      toastSuccess(approvedAnswerCopy.saved)
      onDone()
    },
    onError: () => toastActionFailed(failedAction),
  })
}

/** Saves one gross figure: the gross-salary policy or the current salary. */
export function useSaveGrossSalary(card: GrossCard, onDone: () => void) {
  const mutation = useSalaryMutation(SAVE_GROSS[card], onDone)
  return { save: mutation.mutate, isSaving: mutation.isPending }
}

/** Saves the preferred net pay. A separate call with no period: it can't land in a gross field. */
export function useSaveNetPay(onDone: () => void) {
  const mutation = useSalaryMutation<NetPayInput>(setPreferredNetPay, onDone)
  return { save: mutation.mutate, isSaving: mutation.isPending }
}

export function useClearSalaryCard(card: SalaryCard, onDone: () => void) {
  const mutation = useSalaryMutation<void>((_input, csrf) => clearSalaryCard(card, csrf), onDone, "delete the salary answer")
  return { clear: () => mutation.mutate(), isClearing: mutation.isPending }
}
