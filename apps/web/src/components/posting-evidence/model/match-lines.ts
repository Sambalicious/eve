import { coveragePercent, jobPostingCopy, type Match } from "@/entities/job-posting"

/** The lines under the verdict badge: coverage (C-MATCH-2), weak reason (C-MATCH-3/4/5), rule (C-MATCH-1). */
export interface MatchLines {
  readonly coverage: string | null
  readonly reason: string | null
  readonly rule: string
}

/**
 * The backend decides the verdict and the reason; this only picks the copy.
 * C-MATCH-4 is shown without C-MATCH-2 and C-MATCH-5 with neither, as F4 lists.
 */
export function matchLines(match: Match): MatchLines {
  const percent = coveragePercent(match.covered, match.total)
  const coverage = jobPostingCopy.matchCoverage(match.covered, match.total, percent)
  const rule = jobPostingCopy.matchRule(match.thresholdPercent)
  switch (match.weakReason) {
    case "unmet_mandatory": {
      const unmet = match.mandatoryPrerequisites.filter((item) => item.factId === null)
      const first = unmet[0]?.text ?? ""
      return { coverage, reason: jobPostingCopy.weakUnmet(first, unmet.length), rule }
    }
    case "coverage_below_threshold":
      return { coverage: null, reason: jobPostingCopy.weakCoverage(percent, match.thresholdPercent), rule }
    case "no_core_responsibilities":
      return { coverage: null, reason: jobPostingCopy.weakNoCore, rule }
    case null:
      return { coverage, reason: null, rule }
  }
}
