import { z } from "zod"

import { jobPostingStatusSchema, type OverrideDecision, overrideDecisionSchema, skipReasonSchema, violatedRuleNameSchema } from "./discovery.js"

/**
 * v1.24.0 apply anyway, bounds and consent (`prd-apply-anyway.md` AA-1 to AA-4,
 * owner decisions D1 to D8, api-contract.md "Apply anyway: bounds and consent").
 *
 * A posting's decision is its status, skip reason, skip detail and the set of
 * violated Eligibility rules for the session Candidate. The backend decides
 * overridability with `isOverridableDecision`; the web never does (AA-1.4). The
 * MSW handlers use the same helpers so the mock and the API agree (AA-7.4).
 */

/**
 * AA-1.1, D1, D7: the weak-Match skip reasons. `technology_mismatch` and
 * `not_software_role` are not overridable.
 *
 * v1.28.0 (owner decision 2026-11-10, "all-in-one" manual lane): an
 * `unsupported_application_system` posting is overridable too. Nothing about the
 * Match is being overridden there — Eve simply cannot submit through that
 * employer's system, so the documents are prepared and the Candidate applies by
 * hand. The posting's `applyMode` stays `manual`, so the submission layer still
 * refuses to queue or send it.
 */
export const OVERRIDABLE_SKIP_REASONS = ["weak_core_match", "uncovered_mandatory_prerequisite", "no_core_responsibilities", "unsupported_application_system"] as const

/**
 * AA-1.1 and AA-1.2: overridable only when skipped for a weak Match with no
 * violated rule, or excluded for `violated_rule` with violated rules exactly
 * {industry} (D2). Every other decision, rule (known or not) and status is not.
 * Visibility and an existing Application are checked separately.
 */
export function isOverridableDecision(decision: OverrideDecision): boolean {
  if (decision.status === "skipped") {
    return decision.skipReason !== null && (OVERRIDABLE_SKIP_REASONS as readonly string[]).includes(decision.skipReason) && decision.violatedRules.length === 0
  }
  if (decision.status === "excluded") {
    return decision.skipReason === "violated_rule" && decision.violatedRules.length === 1 && decision.violatedRules[0] === "industry"
  }
  return false
}

/**
 * AA-2.1, AA-2.3: equal when status, skip reason and skip detail are equal
 * (exact strings; null equals only null) and the violated rules are equal as
 * sets, whatever their order.
 */
export function overrideDecisionsEqual(a: OverrideDecision, b: OverrideDecision): boolean {
  if (a.status !== b.status || a.skipReason !== b.skipReason || a.skipDetail !== b.skipDetail) return false
  const left = new Set(a.violatedRules)
  const right = new Set(b.violatedRules)
  return left.size === right.size && [...left].every((rule) => right.has(rule))
}

/** The order the server sends `violatedRules` in: the known rules, then any other name alphabetically. */
export const VIOLATED_RULE_ORDER = ["location", "sponsorship", "pay", "hours", "industry", "seniority", "employment_type"] as const

export function sortViolatedRules(rules: readonly string[]): string[] {
  const rank = (rule: string) => {
    const index = (VIOLATED_RULE_ORDER as readonly string[]).indexOf(rule)
    return index === -1 ? VIOLATED_RULE_ORDER.length : index
  }
  return [...rules].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

/** `POST /v1/applications` `acknowledgement`: the decision the dialog showed (design B2 snapshot). */
export const createApplicationAcknowledgementSchema = z
  .object({
    confirmed: z.literal(true),
    decision: overrideDecisionSchema,
  })
  .strict()
export type CreateApplicationAcknowledgement = z.infer<typeof createApplicationAcknowledgementSchema>

/** AA-4.3 r1: why `applies` is false, first that holds. */
export const overrideNotAppliesReasonSchema = z.enum(["hidden", "legacy_no_decision", "decision_changed"])
export type OverrideNotAppliesReason = z.infer<typeof overrideNotAppliesReasonSchema>

/** `ApplicationSummary.override` and `Submission.override`. Stored fields are all null for a legacy override (AA-2.7). */
export const applicationOverrideSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    status: z.enum(["skipped", "excluded"]).nullable(),
    skipReason: skipReasonSchema.nullable(),
    skipDetail: z.string().nullable(),
    violatedRules: z.array(violatedRuleNameSchema).nullable(),
    applies: z.boolean(),
    notAppliesReason: overrideNotAppliesReasonSchema.nullable(),
  })
  .strict()
  .refine((o) => (o.applies ? o.notAppliesReason === null : o.notAppliesReason !== null), { message: "notAppliesReason is null exactly when applies is true" })
export type ApplicationOverride = z.infer<typeof applicationOverrideSchema>

/** `submission_event.detail` for `queued_posting_dropped` (v1.24.0). Events before v1.24.0 have null. */
export const queuedPostingDroppedDetailSchema = z.enum(["closed", "hidden", "override_mismatch", "not_ranked"])
export type QueuedPostingDroppedDetail = z.infer<typeof queuedPostingDroppedDetailSchema>

/** `ApplicationDetail.latestDrop.reason`: `closed` picks C-AA-40, everything else C-AA-41. */
export const latestDropReasonSchema = z.enum(["closed", "not_submittable"])
export type LatestDropReason = z.infer<typeof latestDropReasonSchema>

export const latestDropSchema = z.object({ at: z.iso.datetime({ offset: true }), reason: latestDropReasonSchema }).strict()
export type LatestDrop = z.infer<typeof latestDropSchema>

/** Maps a stored drop event detail to the detail page reason (null for events written before v1.24.0). */
export function latestDropReasonOf(detail: QueuedPostingDroppedDetail | null): LatestDropReason {
  return detail === "closed" ? "closed" : "not_submittable"
}

/** `ApplicationDetail.posting`: the posting's current status and visibility for the session Candidate (AA-4.5). */
export const applicationPostingStateSchema = z.object({ status: jobPostingStatusSchema, hidden: z.boolean() }).strict()
export type ApplicationPostingState = z.infer<typeof applicationPostingStateSchema>
