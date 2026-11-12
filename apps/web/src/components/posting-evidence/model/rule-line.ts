import { employmentTypeLabel, jobPostingCopy, type EligibilityRule, type EmploymentType } from "@/entities/job-posting"

export type RuleLine = { readonly kind: "quote" | "text"; readonly text: string }

/**
 * The one line under a rule's badge in the Eligibility panel: the stored quote, or the
 * explicit line for a rule whose quote is null for a reason other than silence
 * (C-ELIG-1; D44 copy-b1 keys 125-128), else "The posting doesn't say.".
 */
export function ruleLine(rule: EligibilityRule, employmentType: EmploymentType | null): RuleLine {
  const c = jobPostingCopy
  const text = (value: string): RuleLine => ({ kind: "text", text: value })
  if (rule.rule === "sponsorship" && rule.result === "not_applicable") return text(c.sponsorshipNotApplicable)
  if (rule.rule === "seniority" && rule.result === "not_applicable") return text(c.seniorityNotApplicable)
  if (rule.rule === "employment_type" && rule.result === "not_applicable") return text(c.employmentTypeNotApplicable)
  if (rule.quote) return { kind: "quote", text: rule.quote }
  if (rule.rule === "seniority" && rule.result === "unverified") return text(c.seniorityNoLevel)
  if (rule.rule === "employment_type" && (rule.result === "met" || rule.result === "violated") && employmentType)
    return text(c.employmentTypeStated(employmentTypeLabel[employmentType]))
  return text(c.postingDoesntSay)
}
