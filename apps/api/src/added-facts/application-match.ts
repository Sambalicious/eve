import { GENERIC_SECTION_WORDS } from "../career-profile/claim-check.js"
import { type DecisionCriteria, decideJobCriteria, matchVerdict } from "../discovery/rules/job-criteria.js"
import type { MatchVerdict } from "../discovery/rules/job-criteria.js"
import { requirementYears } from "../discovery/rules/tenure.js"
import type { ApplicationMatch } from "@eve/contracts"
import { stem } from "../career-profile/claim-check.js"
import { GAP_STOPWORDS, keywordNamed, matchedWords, singular } from "../documents/keyword-match.js"

/**
 * FEAT-0017 Application Match (OD-3, OD-12, OD-19), pure and with no AI call.
 *
 * Starts from the posting's stored Match items. An item the profile covers (its
 * fact is still in the approved version) stays covered; a mandatory
 * total-experience item is recomputed by tenure, exactly as `coveredByTenure`
 * does. Every remaining uncovered core or mandatory item is offered to the added
 * facts:
 *
 * - a **skill-only** fact covers it only when the requirement's own text names
 *   the skill (`keywordNamed`, OD-12): Figma never covers "own the design process";
 * - a **one-liner** counts in full: its gap term named by the item, or at least
 *   `min(2, n)` significant stems shared with it (OD-19). A one-liner that matches
 *   nothing changes nothing.
 *
 * `nice_to_have` items never count. The lift is the only case that changes
 * behaviour, and only from a Match-only skip whose technology criterion still
 * ranks the posting (OD-3, PRD 7.5, 7.12).
 */

export type MatchItemLike = Readonly<{ group: "core" | "mandatory" | "nice_to_have"; text: string; factId: string | null }>

/** An added fact as the Match sees it. `roleInProfile` false: the role is gone from the version in use, so it covers nothing. */
export type AddedFactForMatch = Readonly<{
  id: string
  kind: "skill_only" | "one_liner"
  text: string
  term: string | null
  roleInProfile: boolean
}>

export type ApplicationMatchInput = Readonly<{
  profileVersion: number
  addedFactsVersion: number
  criteriaVersion: number
  items: readonly MatchItemLike[]
  approvedFactIds: ReadonlySet<string>
  tenureMonths: number
  criteria: DecisionCriteria
  /** The posting's technology names; null means no technology data, so the criterion never skips. */
  technologyNames: readonly string[] | null
  postingStatus: string
  skipReason: string | null
  violatedRules: readonly string[]
  manualOnly: boolean
  addedFacts: readonly AddedFactForMatch[]
}>

export type ApplicationMatchResult = ApplicationMatch & Readonly<{ addedFactsVersion: number; criteriaVersion: number }>

type Cover = ApplicationMatch["covers"][number]

/** The stems a one-liner must share with a requirement, minus stop words, generic section labels and 2-letter words. */
function significantStems(text: string): string[] {
  return matchedWords(text)
    .filter((word) => word.length > 2 && !GAP_STOPWORDS.has(word) && !GENERIC_SECTION_WORDS.has(word))
    .map((word) => stem(singular(word)))
}

function oneLinerCovers(item: string, fact: AddedFactForMatch): boolean {
  if (fact.term !== null && keywordNamed(item, fact.term)) return true
  const wanted = new Set(significantStems(item))
  if (wanted.size === 0) return false
  const shared = new Set(significantStems(fact.text).filter((word) => wanted.has(word)))
  return shared.size >= Math.min(2, wanted.size)
}

function factCovers(item: MatchItemLike, fact: AddedFactForMatch): boolean {
  if (fact.kind === "skill_only") return keywordNamed(item.text, fact.text)
  return fact.roleInProfile && oneLinerCovers(item.text, fact)
}

function numbers(covered: number, total: number, unmetMandatory: number, minCoreMatchPercent: number): { covered: number; total: number; unmetMandatory: number; verdict: "strong" | "weak" } {
  const verdict: MatchVerdict = matchVerdict({ coveredCount: covered, totalCount: total, unmetMandatoryCount: unmetMandatory }, minCoreMatchPercent)
  return { covered, total, unmetMandatory, verdict: verdict.verdict }
}

export function applicationMatch(input: ApplicationMatchInput): ApplicationMatchResult {
  const approved = (item: MatchItemLike): string | null => (item.factId !== null && input.approvedFactIds.has(item.factId) ? item.factId : null)
  const byTenure = (item: MatchItemLike): boolean => {
    if (item.factId !== null) return false
    const years = requirementYears(item.text)
    return years !== null && input.tenureMonths >= years * 12
  }
  const core = input.items.filter((item) => item.group === "core")
  const mandatory = input.items.filter((item) => item.group === "mandatory")
  const postingCovered = core.filter((item) => approved(item) !== null).length
  const postingUnmet = mandatory.filter((item) => approved(item) === null && !byTenure(item)).length
  const covers: Cover[] = []
  let addedCovered = 0
  let addedUnmetMandatory = 0
  for (const item of input.items) {
    if (item.group === "nice_to_have") continue
    if (approved(item) !== null) continue
    if (item.group === "mandatory" && byTenure(item)) continue
    const fact = input.addedFacts.find((candidate) => factCovers(item, candidate))
    if (fact === undefined) {
      if (item.group === "mandatory") addedUnmetMandatory += 1
      continue
    }
    if (item.group === "core") addedCovered += 1
    covers.push({ group: item.group, requirement: item.text, factId: fact.id, kind: fact.kind })
  }
  const withAddedCovered = postingCovered + addedCovered
  const posting = numbers(postingCovered, core.length, postingUnmet, input.criteria.minCoreMatchPercent)
  const withAdded = numbers(withAddedCovered, core.length, addedUnmetMandatory, input.criteria.minCoreMatchPercent)
  const matchOnlySkip = input.postingStatus === "skipped" && (input.skipReason === "weak_core_match" || input.skipReason === "uncovered_mandatory_prerequisite") && input.violatedRules.length === 0
  const lifted =
    matchOnlySkip &&
    !input.manualOnly &&
    withAdded.verdict === "strong" &&
    decideJobCriteria({ coveredCount: withAddedCovered, totalCount: core.length, technologyNames: input.technologyNames }, input.criteria).status === "ranked"
  return {
    careerProfileVersion: input.profileVersion,
    thresholdPercent: input.criteria.minCoreMatchPercent,
    posting,
    withAdded,
    lifted,
    covers,
    addedFactsVersion: input.addedFactsVersion,
    criteriaVersion: input.criteriaVersion,
  }
}
