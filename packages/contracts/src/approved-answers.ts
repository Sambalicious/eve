import { z } from "zod"

export const APPROVED_ANSWERS_PATH = "/v1/approved-answers"
export const approvedAnswerPath = (id: string) => `/v1/approved-answers/${id}`
export const SALARY_PATH = "/v1/salary"
export const GROSS_SALARY_POLICY_PATH = "/v1/salary/gross-salary-policy"
export const CURRENT_SALARY_PATH = "/v1/salary/current-salary"
export const PREFERRED_NET_PAY_PATH = "/v1/salary/preferred-net-pay"
export const CANDIDATE_SETTINGS_PATH = "/v1/candidate-settings"
export const WORK_AUTHORIZATION_PATH = "/v1/candidate-settings/work-authorization"

/** AC 1.5: recorded as this unless the Candidate changes it. */
export const DEFAULT_WORK_AUTHORIZATION = "none outside Nigeria"

export const APPROVED_ANSWER_VALUE_MAX = 2000
export const CUSTOM_QUESTION_MAX = 500

export const standardAnswerTopicSchema = z.enum([
  "notice_period",
  "start_date",
  "skill_years",
  "profile_links",
  "relocation_willingness",
])
export const sensitiveAnswerTopicSchema = z.enum(["demographic", "disability", "veteran_status"])

/**
 * One Approved Answer. `skill` is set only for `skill_years`; `question` only for
 * the custom group. Values are stored exactly as entered (trimmed).
 */
export const approvedAnswerSchema = z.discriminatedUnion("group", [
  z
    .object({
      id: z.uuid(),
      group: z.literal("standard"),
      topic: standardAnswerTopicSchema,
      skill: z.string().nullable(),
      value: z.string(),
      updatedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      group: z.literal("sensitive"),
      topic: sensitiveAnswerTopicSchema,
      value: z.string(),
      updatedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      group: z.literal("custom"),
      question: z.string(),
      value: z.string(),
      updatedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
])
export type ApprovedAnswer = z.infer<typeof approvedAnswerSchema>

export const approvedAnswersResponseSchema = z.object({ answers: z.array(approvedAnswerSchema) }).strict()
export type ApprovedAnswersResponse = z.infer<typeof approvedAnswersResponseSchema>

/** Raw value; emptiness is checked by the backend so it can answer `approved_answer_value_empty`. */
const answerValue = z.string().max(APPROVED_ANSWER_VALUE_MAX)

export const createApprovedAnswerRequestSchema = z.discriminatedUnion("group", [
  z
    .object({
      group: z.literal("standard"),
      topic: standardAnswerTopicSchema,
      skill: z.string().trim().min(1).max(100).optional(),
      value: answerValue,
    })
    .strict(),
  z.object({ group: z.literal("sensitive"), topic: sensitiveAnswerTopicSchema, value: answerValue }).strict(),
  z
    .object({ group: z.literal("custom"), question: z.string().max(CUSTOM_QUESTION_MAX), value: answerValue })
    .strict(),
])
export type CreateApprovedAnswerRequest = z.infer<typeof createApprovedAnswerRequestSchema>

export const updateApprovedAnswerRequestSchema = z.object({ value: answerValue }).strict()
export type UpdateApprovedAnswerRequest = z.infer<typeof updateApprovedAnswerRequestSchema>

const currency = z.string().regex(/^[A-Z]{3}$/)
/** Highest salary amount on any card (design-spec.r3.md C-VAL-SAL-4). */
export const SALARY_AMOUNT_MAX = 100_000_000

/**
 * Greater than 0, at most 2 decimals, at most 100,000,000 (CR2-03, decision
 * 2026-10-18). The decimal check is exact: it reads the number's shortest
 * round-trip decimal form (what `String(n)` prints, which is also what JSON
 * carries), not `n * 100`, which binary floats get wrong for 13% of cent values
 * (0.07 * 100 = 7.000000000000001).
 */
export function isValidSalaryAmount(value: number): boolean {
  if (!Number.isFinite(value) || value <= 0 || value > SALARY_AMOUNT_MAX) return false
  return /^\d+(\.\d{1,2})?$/.test(String(value))
}

const amount = z.number().refine(isValidSalaryAmount, "Greater than 0, at most 2 decimals, at most 100,000,000")

/** A gross figure: the gross-salary policy or the current salary. */
export const grossSalarySchema = z
  .object({ amount, currency, period: z.enum(["year", "month"]), display: z.string() })
  .strict()
export type GrossSalary = z.infer<typeof grossSalarySchema>

/** The preferred net pay. Its own shape so it can never be read as a gross figure. */
export const preferredNetPaySchema = z
  .object({ amount, currency, period: z.literal("month_net"), display: z.string() })
  .strict()
export type PreferredNetPay = z.infer<typeof preferredNetPaySchema>

export const salaryResponseSchema = z
  .object({
    grossSalaryPolicy: grossSalarySchema.nullable(),
    currentSalary: grossSalarySchema.nullable(),
    preferredNetPay: preferredNetPaySchema.nullable(),
  })
  .strict()
export type SalaryResponse = z.infer<typeof salaryResponseSchema>

export const setGrossSalaryRequestSchema = z
  .object({ amount, currency: currency.default("USD"), period: z.enum(["year", "month"]) })
  .strict()
export type SetGrossSalaryRequest = z.input<typeof setGrossSalaryRequestSchema>

export const setPreferredNetPayRequestSchema = z.object({ amount, currency: currency.default("USD") }).strict()
export type SetPreferredNetPayRequest = z.input<typeof setPreferredNetPayRequestSchema>

export const candidateSettingsResponseSchema = z.object({ workAuthorization: z.string() }).strict()
export type CandidateSettingsResponse = z.infer<typeof candidateSettingsResponseSchema>

export const setWorkAuthorizationRequestSchema = z
  .object({ workAuthorization: z.string().trim().min(1).max(200) })
  .strict()
export type SetWorkAuthorizationRequest = z.infer<typeof setWorkAuthorizationRequestSchema>
