/** An employer response recorded by hand (CONTEXT.md: Outcome). The MVP reads no mail, so every Outcome is the Candidate's. */

export type OutcomeType = "confirmation" | "rejection" | "interview_invitation" | "request_for_action" | "offer"

export const OUTCOME_TYPES: readonly OutcomeType[] = ["confirmation", "rejection", "interview_invitation", "request_for_action", "offer"]

export interface Outcome {
  readonly id: string
  readonly applicationId: string
  readonly type: OutcomeType
  readonly createdAt: string
  readonly updatedAt: string
}
