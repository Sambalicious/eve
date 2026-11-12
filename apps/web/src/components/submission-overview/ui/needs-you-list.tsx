import { ChevronRight } from "lucide-react"
import { Link } from "react-router-dom"

import { submissionCopy } from "@/entities/application"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"

const c = submissionCopy.needsYou

interface NeedsYouListProps {
  /** Null once the gate passed: the samples row is shown only before (F6 step 1). */
  readonly samples: number | null
  readonly blocked: number
  readonly uncertain: number
}

/** Needs you list: each row is a link with a count, or "None" in muted text so the layout doesn't jump. */
export function NeedsYouList({ samples, blocked, uncertain }: NeedsYouListProps) {
  const rows: [string, string, number][] = [
    ...(samples === null ? [] : ([[c.samples, "/activation", samples]] as [string, string, number][])),
    [c.blocked, "/blocked", blocked],
    [c.uncertain, "/uncertain", uncertain],
  ]
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">{c.title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ul className="flex flex-col">
          {rows.map(([label, to, n]) => (
            <li key={to}>
              <Link to={to} aria-label={`${label}, ${n > 0 ? n : c.none}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-muted focus-visible:bg-muted">
                <span>{label}</span>
                <span className="flex items-center gap-1">
                  {n > 0 ? <span className="font-medium tabular-nums">{n}</span> : <span className="text-muted-foreground">{c.none}</span>}
                  <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
