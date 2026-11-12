import {
  APPROVED_ANSWERS_PATH,
  approvedAnswerPath,
  approvedAnswerSchema,
  approvedAnswersResponseSchema,
  CURRENT_SALARY_PATH,
  GROSS_SALARY_POLICY_PATH,
  PREFERRED_NET_PAY_PATH,
  SALARY_PATH,
  salaryResponseSchema,
  type ApprovedAnswer as ApprovedAnswerDto,
  type SalaryResponse,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type {
  ApprovedAnswer,
  GrossSalaryInput,
  NetPayInput,
  NewApprovedAnswer,
  SalaryAnswers,
} from "../model/approved-answer"

export async function fetchApprovedAnswers(): Promise<ApprovedAnswer[]> {
  const response = await apiRequest(APPROVED_ANSWERS_PATH)
  return approvedAnswersResponseSchema.parse(await response.json()).answers.map(toApprovedAnswer)
}

export async function createApprovedAnswer(answer: NewApprovedAnswer, csrfToken: string): Promise<ApprovedAnswer> {
  const response = await apiRequest(APPROVED_ANSWERS_PATH, { method: "POST", csrfToken, json: answer })
  return toApprovedAnswer(approvedAnswerSchema.parse(await response.json()))
}

export async function updateApprovedAnswer(id: string, value: string, csrfToken: string): Promise<ApprovedAnswer> {
  const response = await apiRequest(approvedAnswerPath(id), { method: "PATCH", csrfToken, json: { value } })
  return toApprovedAnswer(approvedAnswerSchema.parse(await response.json()))
}

export async function deleteApprovedAnswer(id: string, csrfToken: string): Promise<void> {
  await apiRequest(approvedAnswerPath(id), { method: "DELETE", csrfToken })
}

export async function fetchSalaryAnswers(): Promise<SalaryAnswers> {
  const response = await apiRequest(SALARY_PATH)
  return toSalaryAnswers(salaryResponseSchema.parse(await response.json()))
}

export function setGrossSalaryPolicy(input: GrossSalaryInput, csrfToken: string) {
  return putSalary(GROSS_SALARY_POLICY_PATH, input, csrfToken)
}

export function setCurrentSalary(input: GrossSalaryInput, csrfToken: string) {
  return putSalary(CURRENT_SALARY_PATH, input, csrfToken)
}

/** The net preference has no period field: the API always stores it as `month_net`. */
export function setPreferredNetPay(input: NetPayInput, csrfToken: string) {
  return putSalary(PREFERRED_NET_PAY_PATH, { amount: input.amount, currency: input.currency }, csrfToken)
}

export type SalaryCard = "grossSalaryPolicy" | "currentSalary" | "preferredNetPay"

const SALARY_CARD_PATHS: Record<SalaryCard, string> = {
  grossSalaryPolicy: GROSS_SALARY_POLICY_PATH,
  currentSalary: CURRENT_SALARY_PATH,
  preferredNetPay: PREFERRED_NET_PAY_PATH,
}

export async function clearSalaryCard(card: SalaryCard, csrfToken: string): Promise<SalaryAnswers> {
  const response = await apiRequest(SALARY_CARD_PATHS[card], { method: "DELETE", csrfToken })
  return toSalaryAnswers(salaryResponseSchema.parse(await response.json()))
}

async function putSalary(path: string, body: object, csrfToken: string): Promise<SalaryAnswers> {
  const response = await apiRequest(path, { method: "PUT", csrfToken, json: body })
  return toSalaryAnswers(salaryResponseSchema.parse(await response.json()))
}

function toApprovedAnswer(dto: ApprovedAnswerDto): ApprovedAnswer {
  switch (dto.group) {
    case "standard":
      return { group: "standard", id: dto.id, topic: dto.topic, skill: dto.skill, value: dto.value, updatedAt: dto.updatedAt }
    case "sensitive":
      return { group: "sensitive", id: dto.id, topic: dto.topic, value: dto.value, updatedAt: dto.updatedAt }
    case "custom":
      return { group: "custom", id: dto.id, question: dto.question, value: dto.value, updatedAt: dto.updatedAt }
    default: {
      const exhaustive: never = dto
      return exhaustive
    }
  }
}

function toSalaryAnswers(body: SalaryResponse): SalaryAnswers {
  const gross = (figure: SalaryResponse["grossSalaryPolicy"]) =>
    figure && { kind: "gross" as const, ...figure }
  return {
    grossSalaryPolicy: gross(body.grossSalaryPolicy),
    currentSalary: gross(body.currentSalary),
    preferredNetPay: body.preferredNetPay && { kind: "net", ...body.preferredNetPay },
  }
}
