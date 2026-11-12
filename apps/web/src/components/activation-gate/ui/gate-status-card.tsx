import { Circle, CircleCheck } from "lucide-react"
import { Link } from "react-router-dom"

import { submissionCopy, type SubmissionStatus } from "@/entities/application"
import { TurnOnAutomatic } from "@/features/enable-automatic-submission"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/shared/ui/card"
import { Progress } from "@/shared/ui/progress"

const g = submissionCopy.gate

/**
 * Gate status card (F2): "{n} of 5 samples approved", progress bar, help
 * C-GATE-5, three requirement rows with a check or an empty circle and a link
 * to fix each, C-GATE-2 once passed, and "Turn on automatic submission".
 */
export function GateStatusCard({ status }: { status: SubmissionStatus }) {
  const n = Math.min(status.countingSamples, status.requiredSamples)
  const rows = [
    { label: g.rows.careerProfile, done: status.careerProfileApproved, to: "/profile", existing: false },
    // C-GATE-6: the label is the link while incomplete, plain once complete (C-GATE-7 retired 2026-10-30).
    { label: g.rows.existingApplications, done: status.existingApplicationsCompletedAt !== null, to: "/existing-applications", existing: true },
    { label: g.rows.samples, done: status.countingSamples >= status.requiredSamples, to: null, existing: false },
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg font-semibold tabular-nums">{g.progress(n)}</h2>
        </CardTitle>
        <CardDescription>{status.gatePassedAt ? g.passed(status.gatePassedAt) : g.before}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Progress value={n} max={status.requiredSamples} aria-label={g.progress(n)} />
          <p className="text-sm text-muted-foreground">{g.help}</p>
        </div>
        <ul className="flex flex-col gap-2 text-sm">
          {rows.map((row) => (
            <li key={row.label} className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-0.5">
              {row.done ? (
                <CircleCheck aria-label="Done" className="size-4 shrink-0 text-success-text" />
              ) : (
                <Circle aria-label="Not done" className="size-4 shrink-0 text-muted-foreground" />
              )}
              {row.done || !row.to ? (
                <span>{row.label}</span>
              ) : (
                <Link to={row.to} className="underline underline-offset-4">
                  {row.label}
                </Link>
              )}
              {row.existing && !row.done && (
                <p className="col-start-2 text-muted-foreground">{g.existingHint}</p>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter>
        <TurnOnAutomatic status={status} />
      </CardFooter>
    </Card>
  )
}
