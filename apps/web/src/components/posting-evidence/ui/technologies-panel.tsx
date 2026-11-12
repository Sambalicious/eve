import { useId, useState } from "react"
import { Check } from "lucide-react"
import { Link } from "react-router-dom"

import { jobPostingCopy, TechnologiesNotCheckedBadge, type PostingTechnology } from "@/entities/job-posting"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Section, SectionNote } from "@/shared/ui/section"
import { orderTechnologies, TECHNOLOGIES_SHOWN } from "../model/technology-rows"

const copy = jobPostingCopy.criteria

/**
 * "Technologies mentioned" (design-spec B3): each verified technology with its
 * quote, matched ones first with "In your criteria". `technologies: null` with
 * `notChecked` shows the not-checked note; `null` without it renders nothing
 * (AC 3.6). `criterionOn` is null while the Candidate's criteria are unknown,
 * which hides only the summary line.
 */
export function TechnologiesPanel({
  technologies,
  notChecked,
  criterionOn,
}: {
  technologies: readonly PostingTechnology[] | null
  notChecked: boolean
  criterionOn: boolean | null
}) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  if (technologies === null && !notChecked) return null

  const editLink = (
    <Link
      to={copy.settingsHref}
      className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      {copy.change}
    </Link>
  )
  const showEdit = criterionOn === true || notChecked || (technologies?.length ?? 0) > 0

  return (
    <Section title={copy.technologiesTitle} headingProps={{ id: `${id}-heading` }} actions={showEdit ? editLink : undefined}>
      {technologies === null ? (
        <SectionNote className="flex flex-col items-start gap-2">
          <TechnologiesNotCheckedBadge />
          <p className="text-sm text-muted-foreground">{copy.notCheckedBody}</p>
        </SectionNote>
      ) : technologies.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.none}</p>
      ) : (
        <TechnologyList
          id={id}
          technologies={technologies}
          criterionOn={criterionOn === true}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      )}
    </Section>
  )
}

function TechnologyList({
  id,
  technologies,
  criterionOn,
  expanded,
  onToggle,
}: {
  id: string
  technologies: readonly PostingTechnology[]
  criterionOn: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const ordered = orderTechnologies(technologies)
  const matched = technologies.filter((t) => t.inCriteria).length
  const visible = expanded ? ordered : ordered.slice(0, TECHNOLOGIES_SHOWN)
  const listId = `${id}-list`
  return (
    <div className="flex flex-col gap-3">
      {criterionOn && (
        <p className="text-sm tabular-nums">
          {matched > 0 ? copy.matchCount(matched, technologies.length) : copy.noMatch}
        </p>
      )}
      <ul id={listId} className="@container flex flex-col divide-y">
        {visible.map((technology, index) => (
          <li
            key={`${index}-${technology.name}`}
            aria-label={technology.inCriteria ? copy.rowLabelInCriteria(technology.name) : undefined}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 py-3.5 first:pt-0 last:pb-0 @lg:grid-cols-[9rem_minmax(0,1fr)_auto] @lg:items-start @lg:gap-x-5"
          >
            <span className="col-start-1 row-start-1 text-sm font-medium [overflow-wrap:anywhere]">{technology.name}</span>
            {technology.inCriteria && (
              <span className="col-start-2 row-start-1 justify-self-end @lg:col-start-3">
                <Badge variant="success">
                  <Check aria-hidden="true" />
                  {copy.inCriteria}
                </Badge>
              </span>
            )}
            <div className="col-span-2 col-start-1 row-start-2 min-w-0 @lg:col-span-1 @lg:col-start-2 @lg:row-start-1">
              <span className="sr-only">{copy.quotePrefix} </span>
              <blockquote className="line-clamp-4 max-w-[72ch] text-sm leading-snug whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
                {technology.quote}
              </blockquote>
            </div>
          </li>
        ))}
      </ul>
      {ordered.length > TECHNOLOGIES_SHOWN && (
        <div>
          <Button type="button" variant="link" className="px-0" aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
            {expanded ? copy.showLess : copy.showAll(ordered.length)}
          </Button>
        </div>
      )}
    </div>
  )
}
