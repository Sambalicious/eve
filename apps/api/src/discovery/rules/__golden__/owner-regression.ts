import { preferencesValuesSchema } from "@eve/contracts"

import { ownerValues } from "../../../db/migrations/0018-owner-preferences.js"
import { rewriteOwnerValues } from "../../../db/migrations/0027-preferences-version.js"
import { FX_RATES } from "../../fx-rates.js"
import { eligibilityPreferencesOf } from "../eligibility.js"
import { preFilter } from "../../pre-filters.js"
import { type AssessmentInput, assessPosting, finishVerdict, type PostingAssessment, type PostingVerdict } from "../../posting-verdict.js"
import type { DecisionCriteria } from "../job-criteria.js"
import { decisionCriteria } from "../job-criteria.js"
import { rankPostings } from "../ranking.js"
import { foldForKeywords } from "../rule-result.js"
import { type GoldenPosting, OWNER_FACT_IDS, OWNER_POSTINGS } from "./owner-postings.js"

/**
 * The owner's values as they are on main before EPIC-0002 (evaluation_setting
 * defaults). EPIC-0004 moved the Match line to `job_criteria`, seeded from
 * the old 0.7 setting as 70 percent with empty lists (migration 0012), so
 * the threshold stays 0.7 here and `OWNER_CRITERIA` carries it as criteria.
 */
export const OWNER_EVALUATION = Object.freeze({
  matchThreshold: 0.7,
  hours: Object.freeze({ hoursCutoff: "23:00", hoursTimeZone: "Africa/Lagos" }),
  evaluatedOn: "2026-10-20T09:00:00.000Z",
})

/**
 * EPIC-0002 B1: the Eligibility rules read the Operator's Job Preferences. The
 * snapshot runs on the value migrations 0018 and 0027 actually store for the
 * Operator, from these same hours (23:00 Africa/Lagos), so it proves the
 * migrated record reproduces the built rules byte for byte.
 */
export const OWNER_PREFERENCES = eligibilityPreferencesOf(
  preferencesValuesSchema.parse(
    rewriteOwnerValues(ownerValues(OWNER_EVALUATION.hours.hoursTimeZone, OWNER_EVALUATION.hours.hoursCutoff, { amount: "5000.00", currency: "USD" }) as unknown as Record<string, unknown>)
  )
)

/** The owner's migrated Job criteria (EPIC-0004 0012): 70 percent, no frameworks or technologies, so step 5 is off. */
export const OWNER_CRITERIA = decisionCriteria({ minCoreMatchPercent: Math.round(OWNER_EVALUATION.matchThreshold * 100), frameworks: [], technologies: [] })

/** The whole AC 5.1 order in one call (main moved its own copy into posting-verdict.spec.ts, CR-06). */
function decidePosting(input: AssessmentInput, criteria: DecisionCriteria): PostingAssessment & PostingVerdict {
  const assessment = assessPosting(input)
  return { ...assessment, ...finishVerdict(assessment, criteria) }
}

export const OWNER_SNAPSHOT_FILE = "owner-regression.snap.json"

/** The base commit the snapshot was captured on (A0 item 2, golden-capture.feature :150): main before A1. */
export const OWNER_SNAPSHOT_BASE = "main b17e786 (pre-A1), proved on epic-0002/slice-a0-a1"

/**
 * EPIC-0002 A0: every fixture posting through today's rules with the owner's
 * values. Records the pre-filter result, the folded title, verdicts, every
 * rule result and quote, Unverified labels, Match, role family and the
 * `rankPostings` order of the ranked postings.
 * Returned as the exact file text, so the spec compares bytes.
 */
export function buildOwnerSnapshot(): string {
  const verdicts = ownerVerdicts()
  return snapshotText(verdicts)
}

/** Every fixture with its verdict under the owner's values. The Job Postings page seed (test/__golden__) stores these. */
export function ownerVerdicts(): OwnerVerdict[] {
  return verdictsUnder(OWNER_POSTINGS, OWNER_CRITERIA)
}

export type OwnerVerdict = { posting: GoldenPosting; verdict: PostingAssessment & PostingVerdict }

/** Every posting with its verdict under the owner's evaluation values and the given Job criteria. */
export function verdictsUnder(postings: readonly GoldenPosting[], criteria: DecisionCriteria): OwnerVerdict[] {
  const facts = new Set(OWNER_FACT_IDS)
  const evaluatedOn = new Date(OWNER_EVALUATION.evaluatedOn)
  return postings.map((posting) => {
    const verdict = decidePosting({
      title: posting.title,
      postingText: posting.postingText,
      structured: posting.structured,
      extraction: posting.extraction,
      approvedFactIds: facts,
      preferences: OWNER_PREFERENCES,
      rates: FX_RATES,
      evaluatedOn,
    }, criteria)
    return { posting, verdict }
  })
}

function snapshotText(verdicts: ReturnType<typeof ownerVerdicts>): string {
  const ranking = rankPostings(
    verdicts
      .filter(({ verdict }) => verdict.status === "ranked")
      .map(({ posting, verdict }) => ({
        id: posting.id,
        family: verdict.roleFamily,
        coverage: verdict.match.totalCount === 0 ? 0 : verdict.match.coveredCount / verdict.match.totalCount,
        discoveredAt: new Date(posting.discoveredAt),
        fromEmployerBoard: posting.fromEmployerBoard,
      }))
  )
  const snapshot = {
    note: "EPIC-0002 A0 owner Eligibility golden. Regenerate only in its own commit with a reason.",
    capturedOn: OWNER_SNAPSHOT_BASE,
    owner: OWNER_EVALUATION,
    fxRateDate: FX_RATES.date,
    postings: verdicts.map(({ posting, verdict }) => ({
      id: posting.id,
      title: posting.title,
      preFilter: prefilterResult(posting.title),
      titleFolded: foldForKeywords(posting.title),
      status: verdict.status,
      skipReason: verdict.skipReason,
      skipDetail: verdict.skipDetail,
      eligible: verdict.decision.eligible,
      violatedRules: verdict.decision.violatedRules,
      unverifiedLabels: verdict.decision.unverifiedLabels,
      arrangement: verdict.eligibility.arrangement,
      relocationCountry: verdict.eligibility.relocationCountry,
      employmentType: verdict.eligibility.employmentType,
      rules: verdict.eligibility.rules,
      match: {
        verdict: verdict.matchVerdict.verdict,
        weakReason: verdict.matchVerdict.weakReason,
        coveredCount: verdict.match.coveredCount,
        totalCount: verdict.match.totalCount,
        unmetMandatory: verdict.match.unmetMandatory,
      },
      roleFamily: verdict.roleFamily,
    })),
    ranking,
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

function prefilterResult(title: string): "pass" | "not_software_role" {
  const result = preFilter({ title })
  return result.pass ? "pass" : result.reason
}
