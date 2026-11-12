import type { BlockedReason, Submission } from "@/entities/application"

/** Which actions a Blocked Application card offers (design-spec.r4.md F6 step 2). */
export interface BlockedActions {
  readonly addAnswer: boolean
  readonly employerForm: boolean
  readonly downloads: boolean
  readonly sameCompany: boolean
  readonly manual: boolean
}

const MANUAL_PATH: BlockedActions = { addAnswer: false, employerForm: true, downloads: true, sameCompany: false, manual: true }

export function blockedActions(reason: BlockedReason): BlockedActions {
  switch (reason) {
    case "missing_approved_answer":
      // F6 (FE5-4): every Missing Approved Answer card also offers the Manual Application path.
      return { ...MANUAL_PATH, addAnswer: true }
    case "same_company_review":
      return { addAnswer: false, employerForm: false, downloads: false, sameCompany: true, manual: true }
    default:
      return MANUAL_PATH
  }
}

/** Groups Blocked rows by reason, in the AC 7.2 order, keeping each group's server order. */
export function groupByReason<T extends { submission: Submission }>(rows: readonly T[]): { reason: BlockedReason; rows: T[] }[] {
  const order: BlockedReason[] = [
    "missing_approved_answer",
    "login",
    "email_verification",
    "captcha",
    "assessment",
    "same_company_review",
    "declaration",
    "personal_data_request",
    "automation_incomplete",
    "ats_below_minimum",
  ]
  return order
    .map((reason) => ({ reason, rows: rows.filter((r) => r.submission.blocked?.reason === reason) }))
    .filter((group) => group.rows.length > 0)
}
