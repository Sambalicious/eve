import type { JobPostingDetail, RuleName } from "./job-posting"
import { reasonLine } from "./reason-line"

/**
 * PD-4.3 (design B2, B3): why Eve wouldn't apply to a skipped or excluded
 * pasted-description posting. Excluded names only the `violated` rules, never
 * `unverified` ones (MO:153); with none violated it falls back to the reason
 * line. Skipped uses the existing reason line. Null for any other posting.
 */
export type PastedWarning =
  | { readonly tone: "excluded"; readonly rules: readonly RuleName[] }
  | { readonly tone: "excluded" | "skipped"; readonly reason: string | null }

export function pastedWarning(
  posting: Pick<
    JobPostingDetail,
    "pastedDescription" | "status" | "eligibility" | "evaluationFailure" | "hiddenReason" | "skipReason" | "skipDetail" | "applicationSystem" | "coverage"
  >
): PastedWarning | null {
  if (!posting.pastedDescription) return null
  if (posting.status === "excluded") {
    const rules = (posting.eligibility?.rules ?? []).filter((r) => r.result === "violated").map((r) => r.rule)
    return rules.length > 0 ? { tone: "excluded", rules } : { tone: "excluded", reason: reasonLine(posting) }
  }
  if (posting.status === "skipped") return { tone: "skipped", reason: reasonLine(posting) }
  return null
}
