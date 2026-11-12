import type { JobPosting } from "./job-posting"

/** The five posting words (copy deck status.*, AC-4.1). Backend enums are unchanged (AC-4.4). */
export type PostingWord = "checking" | "goodMatch" | "manualApply" | "notMatch" | "couldntCheck" | "hidden"

export const postingWordCopy = {
  checking: "Checking",
  goodMatch: "Good match",
  manualApply: "Manual apply",
  notMatch: "Not a match",
  couldntCheck: "Couldn't check",
  hidden: "Hidden",
} as const satisfies Record<PostingWord, string>

/** Reason lines for the waiting states (copy deck status.reason.*, PROPOSAL). */
export const postingReasonCopy = {
  waitingQueued: "Waiting its turn. Eve checks jobs one at a time.",
  waitingCostPause: "Waiting. Eve paused checks to stay within this month's ceiling.",
  waitingNotEnabled: "Saved. It waits until checks are turned on for your account.",
  inProgress: "Eve is checking this job now.",
  failed: "Eve couldn't finish the check. Try again.",
} as const

function assertNever(value: never): never {
  throw new Error(`Unhandled posting status: ${String(value)}`)
}

/**
 * The one word a posting shows (D6). Total over `PostingStatus`: a new backend value fails the
 * type check. Hidden wins over everything (precedence from the architecture). `applyMode manual`
 * is never a word; it is only the detail line.
 */
export function postingWord(posting: Pick<JobPosting, "status" | "hiddenReason"> & { skipReason?: JobPosting["skipReason"] }): PostingWord {
  if (posting.hiddenReason !== null) return "hidden"
  switch (posting.status) {
    case "checking":
    case "waiting_to_be_checked":
      return "checking"
    case "ranked":
      return "goodMatch"
    case "skipped":
      // v1.28.0: a job Eve cannot submit to is a manual lead, not a rejection.
      return posting.skipReason === "unsupported_application_system" ? "manualApply" : "notMatch"
    case "excluded":
      return "notMatch"
    case "evaluation_failed":
    case "not_checked":
      return "couldntCheck"
    default:
      return assertNever(posting.status)
  }
}

/** Why a Checking posting waits. `waitingReason` is the page-level reason from the list response. */
export function waitingReasonLine(
  status: JobPosting["status"],
  waitingReason: "cost_pause" | "checks_not_enabled" | null
): string | null {
  if (status === "checking") return postingReasonCopy.inProgress
  if (status !== "waiting_to_be_checked") return null
  if (waitingReason === "cost_pause") return postingReasonCopy.waitingCostPause
  if (waitingReason === "checks_not_enabled") return postingReasonCopy.waitingNotEnabled
  return postingReasonCopy.waitingQueued
}
