import type { ReactNode } from "react"
import { submissionCopy, type SubmissionStatus } from "@/entities/application"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card"

const g = submissionCopy.gate

/** The cost pause as the card shows it: C-COST-4's title and line. */
export interface CostPauseLine {
  readonly title: string
  readonly line: string
}

/**
 * Automation status card (Composite blocks): "Automatic submission is off" with
 * C-GATE-1, "Automatic submission is on" with C-GATE-4, "Paused", or "Paused
 * for cost" with C-COST-4. The global pause wins when both are on, as the
 * banners put it first.
 */
export function AutomationStatusCard({ status, costPause = null, children }: { status: SubmissionStatus; costPause?: CostPauseLine | null; children?: ReactNode }) {
  const paused = status.globalPaused ? { title: g.paused, line: null } : costPause
  const title = paused ? paused.title : status.automaticEnabled ? g.isOn : g.isOff
  const line = paused ? paused.line : status.automaticEnabled ? g.on : status.gatePassedAt ? g.passed(status.gatePassedAt) : g.before
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">{title}</h2>
        </CardTitle>
        {line && <CardDescription>{line}</CardDescription>}
      </CardHeader>
      {children && <CardContent className="flex flex-col gap-2 text-sm">{children}</CardContent>}
    </Card>
  )
}
