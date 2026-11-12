import { Circle, CircleCheck } from "lucide-react"
import { Link } from "react-router-dom"

import { homeCopy } from "@/entities/job-posting"
import { Button } from "@/shared/ui/button"
import { Section } from "@/shared/ui/section"
import { Skeleton } from "@/shared/ui/skeleton"
import { useDismissImprove } from "../model/use-dismiss-improve"
import { useImproveItems } from "../model/use-improve-items"

const c = homeCopy.improve

/**
 * "Improve your results" (R2): five optional rows with Done or Not done, each linking to the screen
 * that already exists. Nothing here blocks anything. Dismissing needs no confirm; the toast has Undo.
 */
export function ImproveResults() {
  const items = useImproveItems()
  const { hidden, dismiss } = useDismissImprove()
  if (hidden) return null
  return (
    <Section
      title={c.heading}
      description={c.description}
      actions={
        <Button variant="ghost" size="sm" aria-label={c.dismiss} onClick={dismiss}>
          {c.dismiss}
        </Button>
      }
    >
      <ul className="flex flex-col divide-y">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
            {item.done === null ? (
              <Skeleton className="size-[1.125rem] shrink-0 rounded-full" />
            ) : item.done ? (
              <CircleCheck aria-hidden="true" className="size-[1.125rem] shrink-0 text-success-text" />
            ) : (
              <Circle aria-hidden="true" className="size-[1.125rem] shrink-0 text-muted-foreground/50" />
            )}
            <div className={item.done ? "flex min-w-48 flex-1 flex-col text-muted-foreground" : "flex min-w-48 flex-1 flex-col"}>
              <span className="text-sm font-medium">
                {item.title}
                <span className="sr-only">: {item.done ? c.done : c.notDone}</span>
              </span>
              <span className="text-[0.8125rem] text-muted-foreground">{item.helper}</span>
            </div>
            <span aria-hidden="true" className="text-[0.8125rem] text-muted-foreground">
              {item.done === null ? "" : item.done ? c.done : c.notDone}
            </span>
            <Link to={item.href} aria-label={`${c.open} ${item.title}`} className="text-sm underline underline-offset-4">
              {c.open}
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  )
}
