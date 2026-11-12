import { decisionCriteria } from "../job-criteria.js"
import { rankPostings } from "../ranking.js"
import { OWNER_POSTINGS, OWNER_TECHNOLOGY_POSTINGS } from "./owner-postings.js"
import { OWNER_CRITERIA, OWNER_EVALUATION, type OwnerVerdict, verdictsUnder } from "./owner-regression.js"

/**
 * EPIC-0002 r5 "Should A0 cover job criteria and Stack posts?": the second
 * fixed criteria set. 80 percent pins AC 5.1 step 4 at a non-default percent;
 * the lists turn step 5 on (`technology_mismatch`, pass, "not checked").
 */
export const CRITERIA_SET_2 = Object.freeze({ minCoreMatchPercent: 80, frameworks: Object.freeze(["React"]), technologies: Object.freeze(["TypeScript"]) })

export const OWNER_CRITERIA_SNAPSHOT_FILE = "owner-criteria-regression.snap.json"

/** The commit the snapshot was captured on: main before A1 (the builder copied there), then proved equal on the candidate. */
export const OWNER_CRITERIA_SNAPSHOT_BASE = "main 86637ae (pre-A1), proved on epic-0002/a0-gap"

/** "not_checked" (null), "none_found" ([]) or "listed": the three technology states AC 4.8 distinguishes. */
function technologyState(technologies: OwnerVerdict["verdict"]["technologies"]): "not_checked" | "none_found" | "listed" {
  if (technologies === null) return "not_checked"
  return technologies.length === 0 ? "none_found" : "listed"
}

function entry({ posting, verdict }: OwnerVerdict) {
  return {
    id: posting.id,
    title: posting.title,
    technologyState: technologyState(verdict.technologies),
    technologies: verdict.technologies,
    droppedTechnologyCount: verdict.droppedTechnologyCount,
    status: verdict.status,
    skipReason: verdict.skipReason,
    skipDetail: verdict.skipDetail,
    match: {
      verdict: verdict.matchVerdict.verdict,
      weakReason: verdict.matchVerdict.weakReason,
      coveredCount: verdict.match.coveredCount,
      totalCount: verdict.match.totalCount,
    },
    roleFamily: verdict.roleFamily,
  }
}

function ranking(verdicts: readonly OwnerVerdict[]): string[] {
  return rankPostings(
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
}

/**
 * Every fixture (the 61 owner postings and the technology postings) under
 * criteria set 2, with the `rankPostings` order of the ranked ones; and the
 * technology postings under the owner's own criteria (70 percent, empty
 * lists), where step 5 is off. Returned as the exact file text.
 */
export function buildOwnerCriteriaSnapshot(): string {
  const all = [...OWNER_POSTINGS, ...OWNER_TECHNOLOGY_POSTINGS]
  const underSet2 = verdictsUnder(all, decisionCriteria(CRITERIA_SET_2))
  const technologyUnderOwner = verdictsUnder(OWNER_TECHNOLOGY_POSTINGS, OWNER_CRITERIA)
  const snapshot = {
    note: "EPIC-0002 A0 owner Job criteria golden (r5). Regenerate only in its own commit with a reason.",
    capturedOn: OWNER_CRITERIA_SNAPSHOT_BASE,
    owner: OWNER_EVALUATION,
    criteriaSet2: CRITERIA_SET_2,
    underCriteriaSet2: { postings: underSet2.map(entry), ranking: ranking(underSet2) },
    technologyPostingsUnderOwnerCriteria: { postings: technologyUnderOwner.map(entry), ranking: ranking(technologyUnderOwner) },
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`
}
