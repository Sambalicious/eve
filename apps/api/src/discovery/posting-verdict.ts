import type { FxTable } from "./fx-rates.js"
import type { PostingExtraction } from "./posting-extraction.js"
import { verifyExtraction } from "./posting-extraction.js"
import {
  type EligibilityDecision,
  type EligibilityOutcome,
  type EligibilityPreferences,
  type StructuredFields,
  decideEligibility,
  evaluateEligibility,
} from "./rules/eligibility.js"
import { type CriteriaDecision, type DecisionCriteria, type MatchVerdict, decideJobCriteria, matchVerdict } from "./rules/job-criteria.js"
import { type MatchOutcome, evaluateMatch } from "./rules/match.js"
import { type RoleFamily, classifyRoleFamily } from "./rules/ranking.js"
import { type VerifiedTechnology, verifyTechnologies } from "./technology-extraction.js"

export type AssessmentInput = Readonly<{
  title: string | null
  postingText: string
  structured: StructuredFields
  extraction: PostingExtraction
  approvedFactIds: ReadonlySet<string>
  /** EPIC-0002 B1: the evaluated Candidate's Job Preferences the Eligibility rules read. */
  preferences: EligibilityPreferences
  rates: FxTable
  evaluatedOn: Date
  /** Distinct calendar months of professional experience in the approved profile (`rules/tenure.ts`); 0 when unknown. */
  tenureMonths?: number
}>

/** AC 5.1 steps 1 to 3 outcome. `criteria` means steps 4 and 5 decide, with the criteria read under lock. */
export type BaseDecision =
  | Readonly<{ kind: "excluded"; skipReason: "violated_rule"; skipDetail: string | null }>
  | Readonly<{ kind: "skipped"; skipReason: "uncovered_mandatory_prerequisite"; skipDetail: string | null }>
  | Readonly<{ kind: "skipped"; skipReason: "no_core_responsibilities"; skipDetail: null }>
  | Readonly<{ kind: "criteria" }>

/** Everything decided from the posting alone. Reads no Job criteria (AC 4.3, 5.6). */
export type PostingAssessment = Readonly<{
  eligibility: EligibilityOutcome
  decision: EligibilityDecision
  match: MatchOutcome
  roleFamily: RoleFamily
  technologies: VerifiedTechnology[] | null
  /** ATS key skills, verified like technologies. Null: none in the model's answer. */
  keySkills: VerifiedTechnology[] | null
  /** EPIC-0012 rule 4: verified forward-looking quotes, at most 3; [] when none. */
  forwardStatements: string[]
  droppedQuoteCount: number
  droppedTechnologyCount: number
  /** SEC-009 part 2: how many of `droppedTechnologyCount` the per-call comparison budget dropped. */
  budgetDroppedTechnologyCount: number
  base: BaseDecision
}>

export type SkipReasonValue =
  | "violated_rule"
  | "uncovered_mandatory_prerequisite"
  | "weak_core_match"
  | "no_core_responsibilities"
  | "technology_mismatch"

export type PostingVerdict = Readonly<{
  status: "ranked" | "excluded" | "skipped"
  skipReason: SkipReasonValue | null
  skipDetail: string | null
  matchVerdict: MatchVerdict
}>

/**
 * Verifies the model output and decides steps 1 to 3 of AC 5.1 in code (a
 * violated rule excludes; an uncovered mandatory prerequisite or no core
 * responsibilities skips). Steps 4 and 5 need the Candidate's criteria, read
 * inside the verdict transaction (`finishVerdict`).
 */
export function assessPosting(input: AssessmentInput): PostingAssessment {
  const verified = verifyExtraction(input.extraction, input.postingText)
  const technologies = verifyTechnologies(input.extraction.technologies, input.postingText)
  const keySkills = verifyTechnologies(input.extraction.keySkills, input.postingText)
  const eligibility = evaluateEligibility({
    title: input.title,
    postingText: input.postingText,
    facts: verified.facts,
    structured: input.structured,
    preferences: input.preferences,
    rates: input.rates,
    evaluatedOn: input.evaluatedOn,
  })
  const decision = decideEligibility(eligibility)
  const match = evaluateMatch(verified.match, input.approvedFactIds, input.tenureMonths ?? 0)
  const roleFamily = classifyRoleFamily(input.title ?? "", match.core.map((item) => item.text))
  return {
    eligibility,
    decision,
    match,
    roleFamily,
    technologies: technologies.technologies,
    keySkills: keySkills.technologies,
    forwardStatements: verified.forwardStatements,
    droppedQuoteCount: verified.droppedQuoteCount,
    droppedTechnologyCount: technologies.droppedCount,
    budgetDroppedTechnologyCount: technologies.budgetDroppedCount ?? 0,
    base: baseDecision(decision, match),
  }
}

function baseDecision(decision: EligibilityDecision, match: MatchOutcome): BaseDecision {
  if (!decision.eligible) return { kind: "excluded", skipReason: "violated_rule", skipDetail: decision.violatedRules[0] ?? null }
  if (match.unmetMandatory.length > 0) return { kind: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: match.unmetMandatory[0] ?? null }
  if (match.totalCount === 0) return { kind: "skipped", skipReason: "no_core_responsibilities", skipDetail: null }
  return { kind: "criteria" }
}

/** Steps 4 and 5 (when steps 1 to 3 passed), plus the stored Match verdict under the criteria in force. */
export function finishVerdict(assessment: PostingAssessment, criteria: DecisionCriteria): PostingVerdict {
  const { base, match } = assessment
  if (base.kind !== "criteria") {
    const verdict = matchVerdict(
      { coveredCount: match.coveredCount, totalCount: match.totalCount, unmetMandatoryCount: match.unmetMandatory.length },
      criteria.minCoreMatchPercent
    )
    return { status: base.kind, skipReason: base.skipReason, skipDetail: base.skipDetail, matchVerdict: verdict }
  }
  const decided: CriteriaDecision = decideJobCriteria(
    {
      coveredCount: match.coveredCount,
      totalCount: match.totalCount,
      technologyNames: assessment.technologies?.map((technology) => technology.name) ?? null,
    },
    criteria
  )
  return { status: decided.status, skipReason: decided.skipReason, skipDetail: null, matchVerdict: decided.match }
}
