import {
  type ApplicationOverride,
  type OverrideDecision,
  type OverrideNotAppliesReason,
  type QueuedPostingDroppedDetail,
  isOverridableDecision,
  overrideDecisionsEqual,
  skipReasonSchema,
  sortViolatedRules,
} from "@eve/contracts"

import type { JobPostingStatus, StoredRule } from "../db/schema.js"
import { ruleInlineLabel } from "../notification/rule-labels.js"

/**
 * api-contract.md v1.24.0 "Apply anyway: bounds and consent", Terms. Pure rules
 * the create, the reads, the three submission checks and the emails share. The
 * overridability and equality rules themselves come from `@eve/contracts`
 * (`isOverridableDecision`, `overrideDecisionsEqual`) so the web mocks agree.
 */

/** The `application` columns an override is read from. */
export type OverrideColumns = Readonly<{
  candidate_override_at: Date | null
  override_created_at: Date | null
  override_status: "skipped" | "excluded" | null
  override_skip_reason: string | null
  override_skip_detail: string | null
  override_violated_rules: string[] | null
  details_deleted_at: Date | null
}>

/** The posting's current decision and visibility for the session Candidate. */
export type PostingDecisionState = Readonly<{
  decision: OverrideDecision
  hidden: boolean
  evaluationFailure: string | null
  /** v1.27.0 (EPIC-0010): the posting is a Candidate-private pasted description (never hidden, never overridden). */
  pastedDescription?: boolean
}>

/** A posting's decision from its `candidate_posting` row and Eligibility rules (`violated` only, server order). */
export function decisionOf(
  posting: Readonly<{ status: JobPostingStatus; skip_reason: string | null; skip_detail: string | null }>,
  rules: readonly StoredRule[] | null
): OverrideDecision {
  const skipReason = skipReasonSchema.safeParse(posting.skip_reason)
  const violated = [...new Set((rules ?? []).filter((rule) => rule.result === "violated").map((rule) => rule.rule))]
  return {
    status: posting.status,
    skipReason: skipReason.success ? skipReason.data : null,
    skipDetail: posting.skip_detail === null || posting.skip_detail === "" ? null : posting.skip_detail.slice(0, 500),
    violatedRules: sortViolatedRules(violated),
  }
}

/** True when an override is recorded (stored or legacy) and the details still exist. */
export function overrideRecorded(columns: OverrideColumns): boolean {
  return columns.details_deleted_at === null && (columns.override_created_at !== null || columns.candidate_override_at !== null)
}

/** The stored decision, or null for a legacy override or none. */
export function storedDecision(columns: OverrideColumns): OverrideDecision | null {
  if (columns.override_status === null || columns.override_violated_rules === null) return null
  const skipReason = skipReasonSchema.safeParse(columns.override_skip_reason)
  return {
    status: columns.override_status,
    skipReason: skipReason.success ? skipReason.data : null,
    skipDetail: columns.override_skip_detail,
    violatedRules: columns.override_violated_rules,
  }
}

/** "Applies" (AA-2.3, AA-4.3 r1, N1); null when it applies, else the first reason that holds. */
function notAppliesReason(stored: OverrideDecision | null, posting: PostingDecisionState | null): OverrideNotAppliesReason | null {
  if (posting?.hidden) return "hidden"
  if (posting?.decision.status === "ranked") return null
  if (stored === null) return "legacy_no_decision"
  // TM-F-03: a stored decision that is not overridable never applies (the database check refuses one too).
  if (posting === null || !isOverridableDecision(stored) || !overrideDecisionsEqual(stored, posting.decision)) return "decision_changed"
  return null
}

/** `ApplicationSummary.override` / `Submission.override`; null when none is recorded or the details are deleted. */
export function applicationOverride(columns: OverrideColumns, posting: PostingDecisionState | null): ApplicationOverride | null {
  if (!overrideRecorded(columns)) return null
  const stored = storedDecision(columns)
  const reason = notAppliesReason(stored, posting)
  return {
    createdAt: (columns.override_created_at ?? columns.candidate_override_at)!.toISOString(),
    status: stored?.status === "skipped" || stored?.status === "excluded" ? stored.status : null,
    skipReason: stored?.skipReason ?? null,
    skipDetail: stored?.skipDetail ?? null,
    violatedRules: stored?.violatedRules ?? null,
    applies: reason === null,
    notAppliesReason: reason,
  }
}

/**
 * The submittable test of the three checks (AA-2.3, AA-2.4): null when the
 * posting may be submitted, else the `queued_posting_dropped` detail, the first
 * that holds (contract drop table). `override` is the Application's columns when
 * an override is recorded, else null. `posting` null: the Candidate no longer holds it.
 */
export function dropDetail(override: OverrideColumns | null, posting: PostingDecisionState | null): QueuedPostingDroppedDetail | null {
  if (posting !== null && posting.decision.status === "evaluation_failed" && posting.evaluationFailure === "posting_unavailable") return "closed"
  if (posting?.hidden) return "hidden"
  if (posting?.decision.status === "ranked") return null
  const recorded = override !== null && overrideRecorded(override)
  if (!recorded) return "not_ranked"
  return applicationOverride(override, posting)?.applies ? null : "override_mismatch"
}

/** Copy deck reason mapping, short form (C-AA-32 `{reason}`): reuses the C-SKIP-* daily-summary short forms. */
export function overrideReasonShort(decision: OverrideDecision): string | null {
  if (decision.status === "excluded") {
    const rule = decision.violatedRules[0] ?? decision.skipDetail
    return rule ? `the posting not fitting your ${ruleInlineLabel(rule)} rule` : "the posting not fitting one of your rules"
  }
  switch (decision.skipReason) {
    case "weak_core_match":
      return "your profile backing too few of the core responsibilities"
    case "no_core_responsibilities":
      return "no core responsibilities found"
    case "uncovered_mandatory_prerequisite":
      return decision.skipDetail === null ? "your profile not showing a required prerequisite" : `your profile not showing a required prerequisite "${decision.skipDetail}"`
    default:
      return null
  }
}

/** AA-6.1, AA-6.3: an existing Application is markable when not past the queue, not a sample and its details exist. The documents state does not matter. */
export function isMarkable(row: Readonly<{ submission_state: string | null; sample_state: string | null; details_deleted_at: Date | null }>): boolean {
  return (row.submission_state === null || row.submission_state === "queued") && row.sample_state === null && row.details_deleted_at === null
}
