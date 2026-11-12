import { Circle, CircleCheck } from "lucide-react"

import { Badge } from "@/shared/ui/badge"
import { ButtonLink } from "@/shared/ui/button-link"
import { Section } from "@/shared/ui/section"
import type { SetupItem } from "../model/setup-items"

/** Labels from design-spec.r2 F1 step 1 and its failure paths. */
const STATE_LABELS = {
  start: "Start",
  continue: "Continue",
  "needs-anthropic": "Needs Anthropic approved first", // C-SETUP-2
} as const
const REQUIRED_TAG = "Required for automatic submission"
/** C-SETUP-1: {total} is the number of items the card shows. */
const TITLE = "Set up Eve"
const progress = (done: number, total: number) => `${done} of ${total} done`

/**
 * The first-run checklist (F1). Slice 2 shows the three items it can derive;
 * the other four arrive with their slices. The card hides once all are done.
 */
export function SetupChecklist({ items }: { items: readonly SetupItem[] }) {
  const doneCount = items.filter((item) => item.state === "done").length
  if (doneCount === items.length) return null
  return (
    <Section
      title={TITLE}
      headingProps={{ id: "setup-checklist-heading" }}
      description={
        <span className="tabular-nums">
          {progress(doneCount, items.length)}
        </span>
      }
      actions={<ProgressMeter done={doneCount} total={items.length} />}
    >
      <ol className="flex flex-col divide-y">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3.5 first:pt-1 last:pb-0"
          >
            {item.state === "done" ? (
              <CircleCheck
                aria-hidden="true"
                className="size-[1.125rem] shrink-0 self-start text-success-text sm:self-center"
              />
            ) : (
              <Circle
                aria-hidden="true"
                className="size-[1.125rem] shrink-0 self-start text-muted-foreground/50 sm:self-center"
              />
            )}
            <div className="flex min-w-48 flex-1 flex-col items-start gap-1.5">
              <span
                className={
                  item.state === "done"
                    ? "text-sm text-muted-foreground"
                    : "text-sm font-medium"
                }
              >
                {item.label}
              </span>
              {item.requiredForAutomaticSubmission && (
                <Badge variant="outline" className="text-muted-foreground">
                  {REQUIRED_TAG}
                </Badge>
              )}
            </div>
            <SetupItemAction item={item} />
          </li>
        ))}
      </ol>
    </Section>
  )
}

/** Decorative: the "{done} of {total} done" text carries the same information. */
function ProgressMeter({ done, total }: { done: number; total: number }) {
  return (
    <div aria-hidden="true" className="mt-1.5 flex w-28 gap-1">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={
            i < done
              ? "h-1 flex-1 rounded-full bg-primary"
              : "h-1 flex-1 rounded-full bg-foreground/10"
          }
        />
      ))}
    </div>
  )
}

function SetupItemAction({ item }: { item: SetupItem }) {
  switch (item.state) {
    case "done":
      return <span className="text-sm text-success-text">Done</span>
    case "needs-anthropic":
      return (
        <span className="text-sm text-muted-foreground">
          {STATE_LABELS["needs-anthropic"]}
        </span>
      )
    case "start":
    case "continue":
      return (
        <ButtonLink
          variant="outline"
          size="sm"
          aria-label={`${STATE_LABELS[item.state]}: ${item.label}`}
          to={item.href}
        >
          {STATE_LABELS[item.state]}
        </ButtonLink>
      )
    default: {
      const exhaustive: never = item.state
      return exhaustive
    }
  }
}
