/** Approved Answers (CONTEXT.md: Approved Answer) and the salary answers. */

export type StandardTopic =
  | "notice_period"
  | "start_date"
  | "skill_years"
  | "profile_links"
  | "relocation_willingness"

export type SensitiveTopic = "demographic" | "disability" | "veteran_status"

export type ApprovedAnswer =
  | {
      readonly group: "standard"
      readonly id: string
      readonly topic: StandardTopic
      /** Only for `skill_years`. */
      readonly skill: string | null
      readonly value: string
      readonly updatedAt: string
    }
  | {
      readonly group: "sensitive"
      readonly id: string
      readonly topic: SensitiveTopic
      readonly value: string
      readonly updatedAt: string
    }
  | {
      readonly group: "custom"
      readonly id: string
      readonly question: string
      readonly value: string
      readonly updatedAt: string
    }

export type NewApprovedAnswer =
  | { readonly group: "standard"; readonly topic: StandardTopic; readonly skill?: string; readonly value: string }
  | { readonly group: "sensitive"; readonly topic: SensitiveTopic; readonly value: string }
  | { readonly group: "custom"; readonly question: string; readonly value: string }

export type GrossPeriod = "year" | "month"

/** A gross figure: the gross-salary policy or the current salary. */
export interface GrossSalary {
  readonly kind: "gross"
  readonly amount: number
  readonly currency: string
  readonly period: GrossPeriod
  readonly display: string
}

/**
 * The preferred net pay. A separate kind with its own period, so it can never
 * be passed where a gross figure is expected (AC 1.4).
 */
export interface PreferredNetPay {
  readonly kind: "net"
  readonly amount: number
  readonly currency: string
  readonly period: "month_net"
  readonly display: string
}

export interface SalaryAnswers {
  readonly grossSalaryPolicy: GrossSalary | null
  readonly currentSalary: GrossSalary | null
  readonly preferredNetPay: PreferredNetPay | null
}

export interface GrossSalaryInput {
  readonly amount: number
  readonly currency: string
  readonly period: GrossPeriod
}

export interface NetPayInput {
  readonly amount: number
  readonly currency: string
}
