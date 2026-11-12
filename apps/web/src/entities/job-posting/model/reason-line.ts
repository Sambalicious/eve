import { evaluationFailureLine, skipLine } from "./copy"
import type { JobPosting } from "./job-posting"
import { relevanceCopy } from "./relevance-copy"

/**
 * The reason line a row, card or detail page shows under the status: a failure
 * line, the "Not checked yet" line, or the skip line. Null when none applies.
 * A hidden posting shows neither a failure line nor the "Not checked yet" line:
 * both name Check again, which never sends a hidden posting, and AC-7.7 says a
 * line never names an action that can't retry it. Its hidden notice is the only
 * reason shown (design-preview DP-4, design-spec r2). Skip lines stay: they name no action.
 */
export function reasonLine(
  posting: Pick<JobPosting, "status" | "evaluationFailure" | "hiddenReason" | "skipReason" | "skipDetail" | "applicationSystem" | "coverage">
): string | null {
  const hidden = posting.hiddenReason !== null
  if (posting.status === "evaluation_failed") return !hidden && posting.evaluationFailure ? evaluationFailureLine[posting.evaluationFailure] : null
  if (posting.status === "not_checked") return hidden ? null : relevanceCopy.posting.notCheckedYet.line
  return skipLine(posting)
}
