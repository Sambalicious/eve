import { Link } from "react-router-dom"

import { submissionCopy, type SubmissionStatus } from "@/entities/application"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"
import { Progress } from "@/shared/ui/progress"

const c = submissionCopy.cap

/**
 * Today's cap card (F6 step 1): large count, "of 5 automatic submissions
 * today", progress bar (max stays 5), help C-CAP-5; at 5 C-CAP-6 plus C-CAP-8
 * when postings are queued for tomorrow; above 5 C-CAP-2.
 */
export function TodaysCapCard({ status }: { status: SubmissionStatus }) {
  const { todayCount: n, cap, queuedForTomorrow: q } = status
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-sm font-medium text-muted-foreground">{c.title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">{n}</span>
          <span className="text-sm text-muted-foreground">{c.of(cap)}</span>
        </p>
        <Progress value={Math.min(n, cap)} max={cap} aria-label={`${n} ${c.of(cap)}`} />
        {n > cap ? <p className="text-sm">{c.over(n)}</p> : n === cap && <p className="text-sm">{c.reached}</p>}
        {n >= cap && q > 0 && (
          <p className="text-sm">
            {c.queued(q)}{" "}
            <Link to="/postings?tab=good" className="underline underline-offset-4">
              {c.seeThem}
            </Link>
          </p>
        )}
        <p className="text-xs text-muted-foreground">{c.help}</p>
      </CardContent>
    </Card>
  )
}
