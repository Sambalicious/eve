import { useId } from "react"

import { jobPostingCopy, RuleResultBadge, type Eligibility, type EligibilityRule, type EmploymentType } from "@/entities/job-posting"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Section } from "@/shared/ui/section"
import { ruleLine } from "../model/rule-line"

/**
 * Eligibility panel: one row per stored rule with its result badge and the posting
 * text that supports it. Results stored before B1 have five rules (location,
 * sponsorship, pay, hours, industry); later ones add seniority and employment type
 * (D44). Rows follow the stored list, so either shape renders and nothing names a
 * missing rule. Each row reads as "{Rule}: {result}. {supporting text}".
 */
export function EligibilityPanel({ eligibility, employmentType }: { eligibility: Eligibility; employmentType: EmploymentType | null }) {
  const headingId = useId()
  return (
    <Section title="Eligibility" headingProps={{ id: headingId }}>
      <ul className="@container flex flex-col divide-y">
        {eligibility.rules.map((rule) => (
          <RuleRow key={rule.rule} rule={rule} eligibility={eligibility} employmentType={employmentType} />
        ))}
      </ul>
    </Section>
  )
}

function RuleRow({ rule, eligibility, employmentType }: { rule: EligibilityRule; eligibility: Eligibility; employmentType: EmploymentType | null }) {
  const label = jobPostingCopy.ruleLabel[rule.rule]
  const line = ruleLine(rule, employmentType)
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-3.5 first:pt-0 last:pb-0 @lg:grid-cols-[9rem_minmax(0,1fr)_auto] @lg:items-start @lg:gap-x-5"
      aria-label={`${label}: ${jobPostingCopy.resultLabel[rule.result]}`}
    >
      <span className="col-start-1 row-start-1 text-sm font-medium">
        {label}
      </span>
      <span className="col-start-2 row-start-1 justify-self-end @lg:col-start-3">
        <RuleResultBadge result={rule.result} />
      </span>
      <div className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-col gap-1 @lg:col-span-1 @lg:col-start-2 @lg:row-start-1">
        {line.kind === "quote" ? (
          <blockquote className="max-w-[72ch] text-sm leading-snug whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
            {line.text}
          </blockquote>
        ) : (
          <p className="text-sm text-muted-foreground">{line.text}</p>
        )}
        {rule.rule === "pay" && eligibility.normalizedMonthlyMaxUsd && (
          <p className="text-sm tabular-nums">
            {jobPostingCopy.normalizedPay(eligibility.normalizedMonthlyMaxUsd)}
            {eligibility.fxRateDate && (
              // OPEN[designer] FE3-4: no copy for the rate date; shown so the conversion can be checked.
              <span className="text-muted-foreground"> (rate of {formatWatDate(eligibility.fxRateDate)})</span>
            )}
          </p>
        )}
      </div>
    </li>
  )
}
