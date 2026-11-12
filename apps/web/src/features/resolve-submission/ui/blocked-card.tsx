import { useId } from "react"
import { CircleAlert, CircleCheck } from "lucide-react"
import { Link } from "react-router-dom"

import {
  applicationName,
  blockedReasonLabel,
  documentDownloadUrl,
  missingAnswerTarget,
  type MissingAnswerTarget,
  subReasonFallback,
  submissionCopy,
  type SubmissionRow,
  OverrideBadge,
} from "@/entities/application"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/shared/ui/card"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { ReasonDialog } from "@/shared/ui/reason-dialog"
import { blockedActions } from "../model/blocked-actions"
import { useBlockedCard } from "../model/use-blocked-card"
import { ExternalButton } from "@/shared/ui/external-button"

const c = submissionCopy.blocked
const REASON_MAX = 500

interface BlockedCardProps {
  row: SubmissionRow
  /**
   * "Add Approved Answer" (F6, FE5-4): a Custom question opens the sheet
   * pre-filled and calls `onSaved` after a save; a sensitive or salary target
   * opens that section of `/answers`.
   */
  onAddAnswer: (target: MissingAnswerTarget, onSaved: () => void) => void
}

/**
 * One Blocked Application (design-spec.r4.md F6 step 2): reason badge, role,
 * company, requisition ID, blocked time, the backend's detail line, and the
 * actions for that reason.
 */
export function BlockedCard({ row, onAddAnswer }: BlockedCardProps) {
  const id = useId()
  const { application, submission } = row
  const card = useBlockedCard(row)
  const blocked = submission.blocked
  if (!blocked) return null
  const actions = blockedActions(blocked.reason)
  const answerTarget = missingAnswerTarget(blocked)
  const hasDocs = application.state === "documents_ready"
  const isSeventh = blocked.reason === "automation_incomplete"
  const name = applicationName(application)

  return (
    <Card role="article" aria-labelledby={`${id}-title`} size="sm">
      <CardHeader className="gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={blocked.reason === "same_company_review" ? "warning" : "destructive"}>
            <CircleAlert aria-hidden="true" />
            {blockedReasonLabel[blocked.reason]}
          </Badge>
          {application.override && <OverrideBadge />}
          {blocked.at && <span className="text-xs text-muted-foreground">{c.blockedAt(blocked.at)}</span>}
        </div>
        <h3 id={`${id}-title`} className="text-base font-semibold [overflow-wrap:anywhere]">
          <Link to={`/applications/${application.id}`} className="underline-offset-4 hover:underline">
            {name}
          </Link>
        </h3>
        {/* With no role or company the name already is the requisition ID; don't print it twice. */}
        {(application.roleTitle || application.company) && (
          <p className="font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{application.requisitionId}</p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-pretty">
        {isSeventh ? (
          <>
            {blocked.subReason && <p>{blocked.detail ?? subReasonFallback[blocked.subReason]}</p>}
            <p>{c.automationIncomplete}</p>
          </>
        ) : (
          blocked.detail && <p className="[overflow-wrap:anywhere]">{blocked.detail}</p>
        )}
        {blocked.reason === "ats_below_minimum" && (
          <p>
            Add the missing experience to your <Link to="/profile" className="underline underline-offset-2">Career Profile</Link> and generate the documents again, or lower your{" "}
            <Link to="/settings#ats" className="underline underline-offset-2">ATS minimum</Link>. It goes back to the queue on its own once its ATS match reaches your minimum.
          </p>
        )}
        {card.answerSaved && (
          <p role="status" className="flex items-start gap-1.5">
            <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-text" />
            {c.answerSaved}
          </p>
        )}
        {card.inline && (
          <p role="alert" className="flex items-start gap-1.5 text-destructive-text">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {card.inline}
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {actions.sameCompany && (
          <>
            <Button size="sm" onClick={() => card.setDialog("approve")}>{c.approveSubmission}</Button>
            <Button size="sm" variant="outline" onClick={() => card.setDialog("decline")}>{c.declinePosting}</Button>
          </>
        )}
        {actions.addAnswer && answerTarget && !card.answerSaved && (
          <Button size="sm" onClick={() => onAddAnswer(answerTarget, card.onAnswerSaved)}>{c.addAnswer}</Button>
        )}
        {actions.employerForm && application.applicationUrl && <ExternalButton href={application.applicationUrl} label={c.openEmployerForm} />}
        {actions.downloads && hasDocs && (
          <>
            <ExternalButton download href={documentDownloadUrl(application.id, "resume", "pdf")} label={c.downloadResume} />
            <ExternalButton download href={documentDownloadUrl(application.id, "cover_letter", "pdf")} label={c.downloadCoverLetter} />
          </>
        )}
        {actions.manual && (
          <Button size="sm" variant="outline" onClick={() => card.setDialog("manual")}>{c.markManual}</Button>
        )}
      </CardFooter>
      <ConfirmDialog
        open={card.dialog === "manual"}
        onOpenChange={(open) => !open && card.setDialog(null)}
        title={c.confirmManual.title}
        body={c.confirmManual.body}
        confirmLabel={c.confirmManual.confirm}
        pendingLabel={c.confirmManual.pending}
        isPending={card.manual.isPending}
        onConfirm={card.manual.run}
      />
      <ConfirmDialog
        open={card.dialog === "approve"}
        onOpenChange={(open) => !open && card.setDialog(null)}
        title={c.confirmSameCompany.title(card.company)}
        body={c.confirmSameCompany.body}
        confirmLabel={c.approveSubmission}
        pendingLabel={c.confirmSameCompany.pending}
        isPending={card.approve.isPending}
        onConfirm={card.approve.run}
      />
      <ReasonDialog
        open={card.dialog === "decline"}
        onOpenChange={(open) => !open && card.setDialog(null)}
        title={c.confirmDecline.title(card.role, card.company)}
        body={c.confirmDecline.body}
        fieldLabel={c.confirmDecline.field}
        help={c.confirmDecline.help}
        confirmLabel={c.declinePosting}
        pendingLabel={c.confirmDecline.pending}
        isPending={card.decline.isPending}
        destructive
        emptyMessage={submissionCopy.validation.declineReasonEmpty}
        tooLongMessage={submissionCopy.validation.reasonTooLong}
        maxLength={REASON_MAX}
        onConfirm={card.decline.run}
      />
    </Card>
  )
}

