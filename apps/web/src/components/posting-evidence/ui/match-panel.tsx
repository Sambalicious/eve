import { useId } from "react"
import { Check, CircleCheck, CircleMinus, Minus, X } from "lucide-react"

import {
  jobPostingCopy,
  type Match,
  type MatchItem,
} from "@/entities/job-posting"
import { Badge } from "@/shared/ui/badge"
import { Section } from "@/shared/ui/section"
import { matchLines } from "../model/match-lines"

/**
 * Match panel: verdict badge, coverage and weak-reason lines (described by the
 * badge), the C-MATCH-1 rule in muted 12px text, then three groups. The UI
 * shows the backend's verdict and never computes it.
 */
export function MatchPanel({ match }: { match: Match }) {
  const id = useId()
  const lines = matchLines(match)
  const describedBy = [
    lines.coverage && `${id}-coverage`,
    lines.reason && `${id}-reason`,
  ]
    .filter(Boolean)
    .join(" ")
  return (
    <Section title="Match" headingProps={{ id: `${id}-heading` }}>
      <div className="mb-6 flex flex-col items-start gap-1.5">
        <Badge
          variant={match.verdict === "strong" ? "success" : "outline"}
          aria-describedby={describedBy || undefined}
        >
          {match.verdict === "strong" ? (
            <CircleCheck aria-hidden="true" />
          ) : (
            <CircleMinus aria-hidden="true" />
          )}
          {match.verdict === "strong"
            ? jobPostingCopy.strongMatch
            : jobPostingCopy.weakMatch}
        </Badge>
        {lines.coverage && (
          <p id={`${id}-coverage`} className="text-sm tabular-nums">
            {lines.coverage}
          </p>
        )}
        {match.atsFit !== null && match.atsFit !== undefined && (
          <p className="text-sm tabular-nums">
            ATS fit {match.atsFit}%: your Career Profile meets {match.atsFit}% of this posting's ATS requirements.
          </p>
        )}
        {lines.reason && (
          <p
            id={`${id}-reason`}
            className="max-w-[72ch] text-sm [overflow-wrap:anywhere]"
          >
            {lines.reason}
          </p>
        )}
        <p className="max-w-[72ch] text-xs text-muted-foreground">
          {lines.rule}
        </p>
      </div>
      <MatchGroup
        title={jobPostingCopy.matchGroups.core}
        items={match.coreResponsibilities}
        kind="core"
        emptyText={jobPostingCopy.noCoreFound}
      />
      <MatchGroup
        title={jobPostingCopy.matchGroups.mandatory}
        items={match.mandatoryPrerequisites}
        kind="mandatory"
      />
      <MatchGroup
        title={jobPostingCopy.matchGroups.niceToHave}
        items={match.niceToHave}
        kind="niceToHave"
      />
    </Section>
  )
}

type GroupKind = "core" | "mandatory" | "niceToHave"

function MatchGroup({
  title,
  items,
  kind,
  emptyText,
}: {
  title: string
  items: readonly MatchItem[]
  kind: GroupKind
  emptyText?: string
}) {
  const id = useId()
  if (items.length === 0 && !emptyText) return null
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 border-t pt-4 pb-5 last:pb-0"
    >
      <h3 id={id} className="text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {items.map((item, index) => (
            <li
              key={`${index}-${item.text}`}
              className="flex min-w-0 flex-col items-start gap-1"
            >
              <span className="text-sm font-medium [overflow-wrap:anywhere]">
                {item.text}
              </span>
              <Coverage item={item} kind={kind} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Coverage({ item, kind }: { item: MatchItem; kind: GroupKind }) {
  if (item.factId === null) {
    return kind === "mandatory" ? (
      <Badge variant="destructive">
        <X aria-hidden="true" />
        {jobPostingCopy.notCovered}
      </Badge>
    ) : (
      <Badge variant="outline">
        <Minus aria-hidden="true" />
        {jobPostingCopy.notCovered}
      </Badge>
    )
  }
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-sm text-muted-foreground">
      <Check
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-success-text"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {item.factText}{" "}
        <span className="font-mono text-[12.5px] whitespace-nowrap text-muted-foreground">
          {item.factId}
        </span>
      </span>
    </span>
  )
}
