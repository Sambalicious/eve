import {
  isOverridableDecision,
  overrideDecisionsEqual,
  sortViolatedRules,
  type ApiErrorCode,
  type ApplicationOverride,
  type ApplyAnyway,
  type CreateApplicationAcknowledgement,
  type JobPostingDetail,
  type OverrideDecision,
} from "@eve/contracts"

/**
 * The v1.24.0 apply-anyway rules the web fakes share (api-contract.md "Apply
 * anyway: bounds and consent", "MSW guidance", CR-AA-06). The create handler
 * and the posting-detail handler both decide from the stored posting through
 * these functions, with `isOverridableDecision` and `overrideDecisionsEqual`
 * from `@eve/contracts`, so the button and the create agree with the API.
 */

/** What the fake knows about the requisition's existing Application. */
export interface ExistingApplication {
  readonly id: string
  readonly submissionState: string | null
  readonly isSample: boolean
  readonly detailsDeleted: boolean
}

/** The posting's decision for the session Candidate: every `violated` rule, in server order. */
export function decisionOf(posting: Pick<JobPostingDetail, "status" | "skipReason" | "skipDetail" | "eligibility">): OverrideDecision {
  const violated = (posting.eligibility?.rules ?? []).filter((r) => r.result === "violated").map((r) => r.rule)
  return { status: posting.status, skipReason: posting.skipReason, skipDetail: posting.skipDetail, violatedRules: sortViolatedRules(violated) }
}

/** AA-6.1, AA-6.3: state none or queued, not a sample, details present. */
export function isMarkable(app: ExistingApplication): boolean {
  return (app.submissionState === null || app.submissionState === "queued") && !app.isSample && !app.detailsDeleted
}

/** v1.27.0 `JobPostingDetail.pastedPrepareOffered`: pasted, finished as ranked/skipped/excluded, no Application. */
export function pastedPrepareOfferedFor(posting: JobPostingDetail, existing: ExistingApplication | null): boolean {
  return posting.origin === "pasted_description" && ["ranked", "skipped", "excluded"].includes(posting.status) && existing === null
}

/** `JobPostingDetail.applyAnyway`: visible, overridable, and no Application or a markable one. */
export function applyAnywayFor(posting: JobPostingDetail, existing: ExistingApplication | null): ApplyAnyway | null {
  // v1.27.0: never offered for a pasted-description posting (`pastedPrepareOffered` instead).
  if (posting.origin === "pasted_description") return null
  if (posting.hiddenReason !== null) return null
  const decision = decisionOf(posting)
  if (!isOverridableDecision(decision)) return null
  if (existing && !isMarkable(existing)) return null
  return { offered: true, decision }
}

export type CreateDecision =
  | { readonly kind: "refuse"; readonly code: ApiErrorCode }
  | { readonly kind: "ranked" }
  | { readonly kind: "override"; readonly decision: OverrideDecision }

const UNCHECKED = new Set(["checking", "waiting_to_be_checked", "not_checked", "evaluation_failed"])

/** The contract's order of checks, steps 2 to 9. Steps 10 and 11 (mark or insert) are the caller's. */
export function decideCreate(
  posting: JobPostingDetail | undefined,
  acknowledgement: CreateApplicationAcknowledgement | null | undefined,
  existing: ExistingApplication | null
): CreateDecision {
  if (!posting) return { kind: "refuse", code: "not_found" }
  // v1.27.0 (PD-3.1): a pasted-description posting of any finished decision, never an override.
  if (posting.origin === "pasted_description") {
    if (UNCHECKED.has(posting.status)) return { kind: "refuse", code: "application_not_eligible" }
    if (acknowledgement) return { kind: "refuse", code: "override_not_allowed" }
    return { kind: "ranked" }
  }
  if (posting.hiddenReason !== null) return { kind: "refuse", code: "posting_hidden" }
  if (UNCHECKED.has(posting.status)) return { kind: "refuse", code: "application_not_eligible" }
  if (posting.status === "ranked") return { kind: "ranked" }
  const current = decisionOf(posting)
  if (!isOverridableDecision(current)) return { kind: "refuse", code: "override_not_allowed" }
  if (!acknowledgement) return { kind: "refuse", code: "override_acknowledgement_missing" }
  if (!overrideDecisionsEqual(acknowledgement.decision, current)) return { kind: "refuse", code: "override_decision_changed" }
  if (existing && !isMarkable(existing)) return { kind: "refuse", code: "override_application_state" }
  return { kind: "override", decision: current }
}

/** A recorded override that applies (a fresh create or mark). */
export function appliedOverride(decision: OverrideDecision, createdAt: string): ApplicationOverride {
  return {
    createdAt,
    status: decision.status === "excluded" ? "excluded" : "skipped",
    skipReason: decision.skipReason,
    skipDetail: decision.skipDetail,
    violatedRules: [...decision.violatedRules],
    applies: true,
    notAppliesReason: null,
  }
}

/** A stored override for fixtures: skipped for a weak core Match unless overridden. */
export function storedOverride(overrides: Partial<ApplicationOverride> = {}): ApplicationOverride {
  return {
    createdAt: "2026-10-29T09:00:00.000Z",
    status: "skipped",
    skipReason: "weak_core_match",
    skipDetail: null,
    violatedRules: [],
    applies: true,
    notAppliesReason: null,
    ...overrides,
  }
}

/**
 * Shares one store between the discovery and documents fakes: the create reads
 * the stored posting, and the posting detail reads the requisition's Application.
 */
export function linkFakes(
  discovery: { state: { postings: JobPostingDetail[]; existingApplication: (postingId: string) => ExistingApplication | null } },
  documents: { state: { postingOf: (id: string) => JobPostingDetail | undefined }; existingFor: (postingId: string) => ExistingApplication | null }
): void {
  documents.state.postingOf = (id) => discovery.state.postings.find((p) => p.id === id)
  discovery.state.existingApplication = (id) => documents.existingFor(id)
}
