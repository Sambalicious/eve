import {
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleSlash,
  CircleX,
  EyeOff,
  Clock,
  ExternalLink,
  LoaderCircle,
  Minus,
  TriangleAlert,
  UserRound,
} from "lucide-react"

import { Badge } from "@/shared/ui/badge"
import { cn } from "cn"

import { jobPostingCopy } from "../model/copy"
import type { Attribution, JobPosting, PostedDate, RuleName, RuleResult } from "../model/job-posting"
import { ageLabel } from "../model/relevance-copy"
import { postingWord, postingWordCopy } from "../model/plain-status"

const resultIcon = {
  met: CircleCheck,
  unverified: CircleDashed,
  violated: CircleX,
  not_applicable: Minus,
} satisfies Record<RuleResult, unknown>

const resultVariant = {
  met: "success",
  unverified: "warning",
  violated: "destructive",
  not_applicable: "outline",
} as const satisfies Record<RuleResult, string>

/** Eligibility result badge: icon plus text (status vocabulary). */
export function RuleResultBadge({ result }: { result: RuleResult }) {
  const Icon = resultIcon[result]
  return (
    <Badge variant={resultVariant[result]}>
      <Icon aria-hidden="true" />
      {jobPostingCopy.resultLabel[result]}
    </Badge>
  )
}

/** "Unverified: {rule}" badges, or "All rules met" when there are none. */
export function UnverifiedLabels({ labels }: { labels: readonly RuleName[] }) {
  if (labels.length === 0) return <span className="text-sm text-muted-foreground">{jobPostingCopy.allRulesMet}</span>
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Unverified rules">
      {labels.map((rule) => (
        <li key={rule}>
          <Badge variant="warning">
            <CircleDashed aria-hidden="true" />
            {jobPostingCopy.unverified(rule)}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

/**
 * The posting's one status word as an icon plus text (R4, status map): Checking, Good match,
 * Not a match, Couldn't check, Hidden. The icon is decorative; the word carries the meaning.
 */
export function PostingStatusBadge({ posting }: { posting: Pick<JobPosting, "status"> & { hiddenReason?: JobPosting["hiddenReason"]; skipReason?: JobPosting["skipReason"] } }) {
  const word = postingWord({ status: posting.status, hiddenReason: posting.hiddenReason ?? null, skipReason: posting.skipReason })
  const label = postingWordCopy[word]
  switch (word) {
    case "checking":
      return (
        <Badge variant="outline">
          {posting.status === "waiting_to_be_checked" ? (
            <Clock aria-hidden="true" />
          ) : (
            <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          )}
          {label}
        </Badge>
      )
    case "goodMatch":
      return (
        <Badge variant="success">
          <CircleCheck aria-hidden="true" />
          {label}
        </Badge>
      )
    case "manualApply":
      return (
        <Badge variant="secondary">
          <UserRound aria-hidden="true" />
          {label}
        </Badge>
      )
    case "notMatch":
      return (
        <Badge variant="outline">
          <CircleSlash aria-hidden="true" />
          {label}
        </Badge>
      )
    case "couldntCheck":
      return (
        <Badge variant="destructive">
          <TriangleAlert aria-hidden="true" />
          {label}
        </Badge>
      )
    case "hidden":
      return (
        <Badge variant="outline">
          <EyeOff aria-hidden="true" />
          {label}
        </Badge>
      )
  }
}

export function ManualApplicationBadge() {
  return (
    <Badge variant="secondary">
      <UserRound aria-hidden="true" />
      {jobPostingCopy.manualApplication}
    </Badge>
  )
}

/**
 * Board credit, "via {name}", as a normal followed link (no rel="nofollow":
 * Remote OK's terms require a followed link back).
 */
export function AttributionLink({ attribution }: { attribution: Attribution }) {
  return (
    <a
      href={attribution.url}
      target="_blank"
      rel="noopener"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      {jobPostingCopy.via(attribution.name)}
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

/** "Open employer page", opening where Apply starts (Himalayas: its applicationLink). */
export function EmployerPageLink({ href, className }: { href: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "inline-flex items-center gap-1 text-sm underline underline-offset-4"}
    >
      {jobPostingCopy.openEmployerPage}
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

/**
 * "Technologies not checked" (C-JC-ROW-NOTCHECKED / C-JC-TECH-NOTCHECKED): a quiet outline fact, no action.
 * `CircleQuestionMark` (design-spec r2, D4), not `CircleDashed`, which the adjacent Unverified labels use.
 */
export function TechnologiesNotCheckedBadge() {
  return (
    <Badge variant="outline">
      <CircleQuestionMark aria-hidden="true" />
      {jobPostingCopy.criteria.notChecked}
    </Badge>
  )
}

/**
 * Age label (design-spec.r1 B2): "Posted {n} days ago" or "Updated {n} days ago"
 * from the server's WAT `ageDays`, only from 31 days. Muted text, never a colour signal.
 */
export function PostingAge({ postedDate, className }: { postedDate: PostedDate | null; className?: string }) {
  const label = ageLabel(postedDate)
  if (postedDate === null || label === null) return null
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums", className)}>
      <CalendarClock aria-hidden="true" className="size-3 shrink-0" />
      <time dateTime={postedDate.on}>{label}</time>
    </span>
  )
}
