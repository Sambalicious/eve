import { Link } from "react-router-dom"

import {
  blockedReasonLabel,
  CaptchaAfterSubmitBadge,
  evidenceLabel,
  subReasonFallback,
  submissionCopy,
  type Submission,
} from "@/entities/application"
import { plainWords } from "@/shared/lib/plain-words"
import { formatWatDateTime } from "@/shared/lib/format-wat"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card"

const d = submissionCopy.detail
const u = submissionCopy.uncertain

/**
 * Evidence card (Composite blocks): for a Confirmed Submission the evidence
 * type, quoted text or ID, and observed time; for an Uncertain Submission
 * C-UNC-1, C-UNC-5 (with the badge) or C-UNC-8; for a Blocked Application the
 * reason and its detail line, with a link to the list that resolves it.
 * Nothing before submission.
 */
export function SubmissionEvidence({ submission, plain = false }: { submission: Submission; plain?: boolean }) {
  const body = evidenceBody(submission, plain ? plainWords : (text) => text)
  if (!body) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg font-semibold">{d.evidenceTitle}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-pretty">{body}</CardContent>
    </Card>
  )
}

function evidenceBody(s: Submission, w: (text: string) => string) {
  if (s.state === "confirmed" && s.evidence) {
    return (
      <>
        <p className="font-medium">{evidenceLabel[s.evidence.kind]}</p>
        {s.evidence.text && <blockquote className="border-l-2 pl-3 [overflow-wrap:anywhere]">{s.evidence.text}</blockquote>}
        <p className="text-muted-foreground">{d.observed(s.evidence.observedAt)}</p>
      </>
    )
  }
  if (s.state === "uncertain" && s.submittedAt) {
    const line = s.kind !== "sample" && s.attemptNumber >= 2 ? u.freshAttempt(s.submittedAt) : s.captchaAfterSubmit ? u.captcha(s.submittedAt) : u.noEvidence(s.submittedAt)
    return (
      <>
        {s.captchaAfterSubmit && <CaptchaAfterSubmitBadge />}
        <p>{w(line)}</p>
        <Link to="/uncertain" className="w-fit underline underline-offset-4">{w(d.openUncertain)}</Link>
      </>
    )
  }
  if (s.state === "blocked" && s.blocked) {
    const isSeventh = s.blocked.reason === "automation_incomplete"
    const detail = isSeventh ? (s.blocked.detail ?? (s.blocked.subReason ? subReasonFallback[s.blocked.subReason] : null)) : s.blocked.detail
    return (
      <>
        <p className="font-medium">{blockedReasonLabel[s.blocked.reason]}</p>
        {detail && <p className="[overflow-wrap:anywhere]">{detail}</p>}
        {isSeventh && <p>{submissionCopy.blocked.automationIncomplete}</p>}
        {s.blocked.at && <p className="text-muted-foreground">{submissionCopy.blocked.blockedAt(s.blocked.at)}</p>}
        <Link to="/blocked" className="w-fit underline underline-offset-4">{w(d.openBlocked)}</Link>
      </>
    )
  }
  if (s.state === "manual" && s.manualCompletedAt) return <p>{`${submissionCopy.status.manual}, ${formatWatDateTime(s.manualCompletedAt)}`}</p>
  return null
}
