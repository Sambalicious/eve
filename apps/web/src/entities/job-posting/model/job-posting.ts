/** Job Posting as the dashboard uses it (CONTEXT.md: Job Posting, Eligibility, Match). */

export type PostingStatus =
  | "checking"
  | "waiting_to_be_checked"
  /** Contract v1.18.0: stored while hidden, never evaluated for this Candidate ("Not checked yet"). */
  | "not_checked"
  | "ranked"
  | "excluded"
  | "skipped"
  | "evaluation_failed"

export type SkipReason =
  | "unsupported_application_system"
  | "not_software_role"
  | "violated_rule"
  | "uncovered_mandatory_prerequisite"
  | "weak_core_match"
  | "no_core_responsibilities"
  /** Contract v1.13.0 (EPIC-0004). */
  | "technology_mismatch"
  /** Contract v1.25.0 (EPIC-0002 B1). Copy and tabs are Frontend's B1 work. */
  | "excluded_role_family"
  | "keyword_mismatch"

export type EvaluationFailure =
  | "not_approved"
  | "not_configured"
  | "provider_error"
  | "invalid_output"
  | "timed_out"
  | "no_career_profile"
  | "posting_unavailable"

/** v1.23.0 D44 adds seniority and employment_type; results stored before B1 hold only the first five. */
export type RuleName = "location" | "sponsorship" | "pay" | "hours" | "industry" | "seniority" | "employment_type"
export type RuleResult = "met" | "unverified" | "violated" | "not_applicable"

export type RoleFamily =
  | "senior_frontend"
  | "technical_lead"
  | "fullstack"
  | "product_engineering"
  | "software_engineering"
  | "backend"
  | "mobile"
  | "platform_engineering"
  | "devops_platform"
  | "people_management"
  | "data_ml"
  | "solutions_customer"
  | "other"

/** Contract v1.18.0: the first reason a posting is hidden for the session Candidate (AC-3.4 order). */
export type HiddenReason = "off_target" | "below_seniority_floor" | "undated" | "older_than_60_days"

/** Contract v1.18.0: which source field gave the posted date. "updated" reads "Updated {n} days ago". */
export type PostedDateKind = "published" | "updated"

/** Contract v1.18.0: why the Candidate's visible waiting postings wait (chooses the waiting notice text). */
export type WaitingReason = "cost_pause" | "checks_not_enabled"

/**
 * The posted date as the server computed it in WAT (AC-6.1). The client never
 * computes an age from `postedAt` itself, so the label agrees with what is hidden.
 */
export interface PostedDate {
  /** WAT calendar date, "YYYY-MM-DD", for `<time dateTime>` and `formatWatDate`. */
  readonly on: string
  readonly kind: PostedDateKind
  /** Whole WAT days since `on`. */
  readonly ageDays: number
}

/** Hidden postings per first reason, over all of the Candidate's postings (AC-3.4). */
export interface HiddenCounts {
  readonly offTarget: number
  readonly belowSeniorityFloor: number
  readonly undated: number
  readonly olderThan60Days: number
  readonly total: number
}

export type EmploymentType = "direct" | "employer_of_record" | "contract"

/** v1.23.0 (EPIC-0002 B1): four tabs. */
export type PostingsTab = "ranked" | "manual" | "skipped" | "excluded_family" | "all"

/** A remote board's credit, shown as "via {name}" with a followed link. */
export interface Attribution {
  readonly name: string
  readonly url: string
}

export interface JobPosting {
  readonly id: string
  readonly title: string | null
  readonly company: string | null
  /** v1.27.0: null for a description-only pasted posting (no link): render no outbound link. */
  readonly applicationUrl: string | null
  /** v1.27.0: synthetic `pasted:<id>` for a pasted-description posting; never shown then. */
  readonly requisitionId: string
  /** v1.27.0: `"none"` for a description-only posting; hidden when `applyUrl` is null. */
  readonly applicationSystem: string
  /** Where Apply starts. Himalayas: its applicationLink, never an ATS link. v1.27.0: null exactly when `applicationUrl` is. */
  readonly applyUrl: string | null
  readonly isManual: boolean
  /** v1.27.0 (PD-2.1): origin `pasted_description`, the Candidate pasted its text (C-PD-40). */
  readonly pastedDescription: boolean
  readonly attribution: Attribution | null
  readonly status: PostingStatus
  readonly skipReason: SkipReason | null
  readonly skipDetail: string | null
  readonly evaluationFailure: EvaluationFailure | null
  readonly roleFamily: RoleFamily | null
  readonly rank: number | null
  readonly unverifiedLabels: readonly RuleName[]
  /** `thresholdPercent` is the minimum core Match the stored decision used (contract v1.13.0). */
  readonly coverage: { readonly covered: number; readonly total: number; readonly thresholdPercent: number; readonly atsFit?: number | null } | null
  /** True only when the technology criterion is on now and the posting has no technology data (AC 4.5, 3.6). */
  readonly technologiesNotChecked: boolean
  readonly discoveredAt: string
  /** Null when undated (always hidden then). */
  readonly postedDate: PostedDate | null
  /** Null when visible. Always null on list rows. */
  readonly hiddenReason: HiddenReason | null
}

/** One page of `GET /v1/job-postings` (v1.12.0). */
export interface JobPostingPage {
  readonly postings: readonly JobPosting[]
  readonly waitingToBeCheckedCount: number
  /** Opaque; null on the last page. Never parsed, never put in the URL. */
  readonly nextCursor: string | null
  /** Postings matching the tab and the Posting filter when this page was served. */
  readonly totalCount: number
  /** AC 6.3: the Ranked tab is empty because of the Job criteria. Same value on every tab. */
  readonly criteriaEmptyState: boolean
  /** v1.18.0: same on every tab, page and filter. */
  readonly hiddenCounts: HiddenCounts
  /** v1.18.0: visible `evaluation_failed` plus visible `not_checked`; the Check again count. */
  readonly recheckableCount: number
  /** v1.18.0: the Candidate's target families in catalog order; the Posting filter panel lists only these. */
  readonly targetRoleFamilies: readonly RoleFamily[]
  /** v1.18.0: null exactly when nothing waits. */
  readonly waitingReason: WaitingReason | null
}

/**
 * Outcome of Check again (v1.18.0). `movedTo` "checking": checks were queued (the
 * Operator). "waiting_to_be_checked": no check scheduled (every other Candidate
 * until EPIC-0002 slice D).
 */
export interface CheckAgainResult {
  readonly queued: number
  readonly movedTo: "checking" | "waiting_to_be_checked"
}

/** The 13 role families in catalog order (EPIC-0006 AC-1.2). */
export const ROLE_FAMILIES = [
  "senior_frontend",
  "technical_lead",
  "fullstack",
  "product_engineering",
  "software_engineering",
  "backend",
  "mobile",
  "platform_engineering",
  "devops_platform",
  "people_management",
  "data_ml",
  "solutions_customer",
  "other",
] as const satisfies readonly RoleFamily[]

/** The age label shows only from 31 days (AC-6.3). */
export const AGE_LABEL_MIN_DAYS = 31

export function showsAgeLabel(postedDate: PostedDate | null): postedDate is PostedDate {
  return postedDate !== null && postedDate.ageDays >= AGE_LABEL_MIN_DAYS
}

/** The on-screen Posting filter. Families in ROLE_FAMILIES order; keyword trimmed, null when blank. */
export interface PostingFilter {
  readonly families: readonly RoleFamily[]
  readonly keyword: string | null
}

export function isPostingFilterActive(filter: PostingFilter): boolean {
  return filter.families.length > 0 || filter.keyword !== null
}

/**
 * Rows of every loaded page, in order, each id once (8W.9). A repeat on a
 * later page keeps its first position.
 */
export function loadedPostings(pages: readonly JobPostingPage[]): JobPosting[] {
  const seen = new Set<string>()
  const rows: JobPosting[] = []
  for (const page of pages) {
    for (const posting of page.postings) {
      if (seen.has(posting.id)) continue
      seen.add(posting.id)
      rows.push(posting)
    }
  }
  return rows
}

/** One verified technology the posting mentions (AC 4.4). */
export interface PostingTechnology {
  readonly name: string
  /** Verbatim posting text. Render as text, never HTML. */
  readonly quote: string
  /** Matches an entry in the Candidate's lists. Always false while both lists are empty. */
  readonly inCriteria: boolean
}

export interface EligibilityRule {
  readonly rule: RuleName
  readonly result: RuleResult
  /** Verbatim posting text; null means the posting doesn't say. */
  readonly quote: string | null
}

export interface Eligibility {
  readonly arrangement: "remote" | "relocation" | "onsite"
  readonly relocationCountry: string | null
  readonly rules: readonly EligibilityRule[]
  /** "2000.27": monthly gross maximum in USD, or null. */
  readonly normalizedMonthlyMaxUsd: string | null
  readonly fxRateDate: string | null
  readonly evaluatedAt: string
}

export interface MatchItem {
  readonly text: string
  /** Approved Career Profile fact ID, or null for "Not covered". */
  readonly factId: string | null
  readonly factText: string | null
}

export type WeakReason = "unmet_mandatory" | "coverage_below_threshold" | "no_core_responsibilities"

export interface Match {
  readonly verdict: "strong" | "weak"
  readonly weakReason: WeakReason | null
  readonly covered: number
  readonly total: number
  readonly thresholdPercent: number
  /** ATS fit 0 to 100: share of the posting's ATS requirements the Career Profile meets; null before ATS scoring. */
  readonly atsFit?: number | null
  readonly careerProfileVersion: number
  readonly coreResponsibilities: readonly MatchItem[]
  readonly mandatoryPrerequisites: readonly MatchItem[]
  readonly niceToHave: readonly MatchItem[]
}

export interface JobPostingDetail extends JobPosting {
  /** Untrusted posting text. Render as text, never HTML. */
  readonly postingText: string
  readonly employmentType: EmploymentType | null
  readonly eligibility: Eligibility | null
  readonly match: Match | null
  /** `null` = no technology data ("not checked"); `[]` = checked, none found. */
  readonly technologies: readonly PostingTechnology[] | null
  /**
   * v1.24.0 (AA-1.1, AA-1.4): the server-computed offer of "Prepare documents
   * anyway" with the decision the dialog renders and echoes. The client never
   * decides overridability itself; null means not offered.
   */
  readonly applyAnyway: { readonly decision: OverrideDecision } | null
  /** v1.24.0 (AA-6.4): the Candidate's Application for this requisition, if any. */
  readonly applicationId: string | null
  /**
   * v1.27.0 (PD-3.1): the server offers "Prepare documents" with no dialog and no
   * acknowledgement for a finished pasted-description posting without an Application.
   */
  readonly pastedPrepareOffered: boolean
}

/** A posting's decision as the API states it (status, skip reason, skip detail, violated rules). */
export interface OverrideDecision {
  readonly status: PostingStatus
  readonly skipReason: SkipReason | null
  readonly skipDetail: string | null
  readonly violatedRules: readonly string[]
}

/**
 * v1.27.0: what a paste sends. Link-only is exactly `{ url }`; a description is
 * never sent blank (I-1). `title` and `company` go only with a description.
 */
export type PasteRequest =
  | { readonly url: string }
  | { readonly url?: string; readonly description: string; readonly title?: string; readonly company?: string }

/** v1.27.0: what a paste that carried a description did (contract `descriptionOutcome`). */
export type PasteDescriptionOutcome =
  | "stored"
  | "stored_lookup_failed"
  | "attached"
  | "replaced"
  | "already_pasted"
  | "employer_page_used"
  | "unchanged_has_application"

export interface PasteResult {
  readonly created: boolean
  /** The posting now held; its id changes on `attached`. */
  readonly posting: JobPosting
  /** Null exactly for a link-only paste. */
  readonly descriptionOutcome: PasteDescriptionOutcome | null
  /** Set exactly with `unchanged_has_application`. */
  readonly applicationId: string | null
  /** Set exactly when the posting waits to be checked. */
  readonly waitingReason: WaitingReason | null
}

/** C-MATCH-2: coverage rounded down, so 69.9% never reads as a pass. */
export function coveragePercent(covered: number, total: number): number {
  return total === 0 ? 0 : Math.floor((covered * 100) / total)
}
