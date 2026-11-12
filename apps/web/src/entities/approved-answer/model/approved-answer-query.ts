import { queryOptions } from "@tanstack/react-query"

import { fetchApprovedAnswers, fetchSalaryAnswers } from "../api/approved-answer-repository"

export const approvedAnswersQueryKey = ["approved-answers"] as const
export const salaryQueryKey = ["salary"] as const

export function approvedAnswersQueryOptions() {
  return queryOptions({ queryKey: approvedAnswersQueryKey, queryFn: fetchApprovedAnswers })
}

export function salaryQueryOptions() {
  return queryOptions({ queryKey: salaryQueryKey, queryFn: fetchSalaryAnswers })
}
