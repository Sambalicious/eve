import { Ban, CalendarClock, CircleCheck, CircleQuestionMark, CircleSlash, Hand, ListOrdered, LoaderCircle, RotateCcw, ShieldAlert, UserRound } from "lucide-react"

import { plainWords } from "@/shared/lib/plain-words"
import { Badge } from "@/shared/ui/badge"
import { submissionCopy } from "../model/submission-copy"
import { isSampleSubmitting, type Submission } from "../model/submission"

const spin = "animate-spin motion-reduce:animate-none"

/**
 * Status badge for an Application in submission (design-spec.r4.md, status
 * vocabulary): icon plus text. An approved sample the worker hasn't claimed
 * yet already reads "Submitting" (v1.8.0). Otherwise null when the
 * Application hasn't entered submission, so the document badge shows instead.
 */
export function SubmissionStatusBadge({ submission, plain = false }: { submission: Submission; /** Advanced is off: plain words. */ plain?: boolean }) {
  const raw = submissionCopy.status
  const s = plain ? (Object.fromEntries(Object.entries(raw).map(([key, text]) => [key, plainWords(text)])) as typeof raw) : raw
  const submitting = <Badge variant="info"><LoaderCircle aria-hidden="true" className={spin} />{s.submitting}</Badge>
  switch (submission.state) {
    case null:
      return isSampleSubmitting(submission) ? submitting : null
    case "confirmed":
      return <Badge variant="success"><CircleCheck aria-hidden="true" />{s.confirmed}</Badge>
    case "uncertain":
      return <Badge variant="warning"><CircleQuestionMark aria-hidden="true" />{s.uncertain}</Badge>
    case "blocked":
      return submission.blocked?.reason === "same_company_review" ? (
        <Badge variant="warning"><Hand aria-hidden="true" />{s.held}</Badge>
      ) : (
        <Badge variant="destructive"><Hand aria-hidden="true" />{s.blocked}</Badge>
      )
    case "manual":
      return <Badge variant="secondary"><UserRound aria-hidden="true" />{s.manual}</Badge>
    case "not_submitted":
      return <Badge variant="outline"><CircleSlash aria-hidden="true" />{s.notSubmitted}</Badge>
    case "declined":
      return <Badge variant="outline"><Ban aria-hidden="true" />{s.declined}</Badge>
    case "submit_claimed":
    case "submitting":
      return submitting
    case "queued":
      if (submission.queuedForWatDay) return <Badge variant="info"><CalendarClock aria-hidden="true" />{s.queuedForTomorrow}</Badge>
      if (submission.attemptNumber >= 1) return <Badge variant="info"><RotateCcw aria-hidden="true" />{s.queuedAgain}</Badge>
      return <Badge variant="info"><ListOrdered aria-hidden="true" />{s.queued}</Badge>
  }
}

/** "CAPTCHA after submit" (warning, ShieldAlert) next to an Uncertain Submission's status. */
export function CaptchaAfterSubmitBadge() {
  return <Badge variant="warning"><ShieldAlert aria-hidden="true" />{submissionCopy.status.captchaAfterSubmit}</Badge>
}
