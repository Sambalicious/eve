import { Link } from "react-router-dom"

import type { AddedFactUsed } from "@eve/contracts"

import {
  blockedReasonLabel,
  CaptchaAfterSubmitBadge,
  evidenceLabel,
  subReasonFallback,
  submissionCopy,
  type Submission,
} from "@/entities/application"
import { addedFactsCopy, atsAddedCopy } from "@/features/added-facts"
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
 *
 * FEAT-0017: a sent Application also lists the added facts its documents cited
 * (`C-AF-89`, AC 5.10 and 9.5).
 */
export function SubmissionEvidence({
  submission,
  plain = false,
  addedFactsUsed = [],
}: {
  submission: Submission
  plain?: boolean
  addedFactsUsed?: readonly AddedFactUsed[]
}) {
  const body = evidenceBody(submission, plain ? plainWords : (text) => text)
  if (!body) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg font-semibold">{d.evidenceTitle}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-pretty">
        {body}
        {addedFactsUsed.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t pt-2">
            <h3 className="font-medium">{addedFactsCopy.evidence.heading}</h3>
            <ul className="flex flex-col gap-1">
              {addedFactsUsed.map((fact) => (
                <li key={fact.id} className="flex flex-wrap items-baseline gap-x-1.5 [overflow-wrap:anywhere]">
                  <bdi>{fact.text}</bdi>
                  <span className="text-[13px] text-muted-foreground">
                    {fact.kind === "skill_only" ? atsAddedCopy.kind.skillOnly : atsAddedCopy.kind.oneLiner}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
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
