import { useId } from "react"
import { Link } from "react-router-dom"

import {
  applicationName,
  CaptchaAfterSubmitBadge,
  OverrideBadge,
  SubmissionStatusBadge,
  submissionCopy,
  type SubmissionRow,
  type SubmissionStatus,
} from "@/entities/application"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/shared/ui/card"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { uncertainLine } from "../model/uncertain-line"
import { useUncertainCard } from "../model/use-uncertain-card"
import { ExternalButton } from "@/shared/ui/external-button"

const u = submissionCopy.uncertain

/**
 * One Uncertain Submission (design-spec.r4.md F6 steps 4, 4a, 5): role and
 * company, "Sample" for an Activation Gate sample, requisition ID, submitted
 * time, the explanation, "Open employer page", "Mark confirmed", "Mark not
 * submitted".
 */
export function UncertainCard({ row, status }: { row: SubmissionRow; status: SubmissionStatus | undefined }) {
  const id = useId()
  const { application, submission } = row
  const card = useUncertainCard(row, status)
  return (
    <Card role="article" aria-labelledby={`${id}-title`} size="sm">
      <CardHeader className="gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <SubmissionStatusBadge submission={submission} />
          {submission.captchaAfterSubmit && <CaptchaAfterSubmitBadge />}
          {application.override && <OverrideBadge />}
          {submission.submittedAt && <span className="text-xs text-muted-foreground">{u.submittedAt(submission.submittedAt)}</span>}
        </div>
        <h3 id={`${id}-title`} className="text-base font-semibold [overflow-wrap:anywhere]">
          <Link to={`/applications/${application.id}`} className="underline-offset-4 hover:underline">
            {applicationName(application)}
          </Link>
          {card.isSample && <span className="ml-2 text-sm font-normal text-muted-foreground">{submissionCopy.status.sample}</span>}
        </h3>
        {/* With no role or company the name already is the requisition ID; don't print it twice. */}
        {(application.roleTitle || application.company) && (
          <p className="font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{application.requisitionId}</p>
        )}
      </CardHeader>
      <CardContent className="text-sm text-pretty">
        <p>{uncertainLine(row)}</p>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {application.applicationUrl && <ExternalButton href={application.applicationUrl} label={u.openEmployerPage} />}
        <Button size="sm" onClick={() => card.setDialog("confirmed")}>{u.markConfirmed}</Button>
        <Button size="sm" variant="outline" onClick={() => card.setDialog("not_submitted")}>{u.markNotSubmitted}</Button>
      </CardFooter>
      <ConfirmDialog
        open={card.dialog === "confirmed"}
        onOpenChange={(open) => !open && card.setDialog(null)}
        title={u.confirmConfirmed.title}
        body={u.confirmConfirmed.body(submission.submittedWatDay ?? submission.submittedAt ?? "")}
        confirmLabel={u.markConfirmed}
        pendingLabel={u.confirmConfirmed.pending}
        isPending={card.confirm.isPending}
        onConfirm={card.confirm.run}
      />
      <ConfirmDialog
        open={card.dialog === "not_submitted"}
        onOpenChange={(open) => !open && card.setDialog(null)}
        title={card.notSubmittedDialog.title}
        body={card.notSubmittedDialog.body}
        confirmLabel={u.markNotSubmitted}
        pendingLabel={u.confirmNotSubmitted.pending}
        isPending={card.notSubmitted.isPending}
        onConfirm={card.notSubmitted.run}
      />
    </Card>
  )
}
