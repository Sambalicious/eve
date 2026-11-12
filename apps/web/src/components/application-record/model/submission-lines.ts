import { submissionCopy, type Application, type Submission } from "@/entities/application"

const d = submissionCopy.detail

/** "How it was sent" (F9): Approved sample, Automatic, Manual; null before submission. */
export function howSent(submission: Submission): string | null {
  if (submission.state === "manual") return submissionCopy.howSent.manual
  if (submission.kind === "sample" && submission.submittedAt) return submissionCopy.howSent.sample
  if (submission.kind === "automatic" && submission.submittedAt) return submissionCopy.howSent.automatic
  return null
}

/**
 * The status line under the header: C-QUEUE-1 (queued, first attempt),
 * C-UNC-6 (queued again), C-CAP-3 (queued for tomorrow), C-UNC-9 or C-UNC-10
 * (not submitted), C-BLOCK-13 (declined, with the reason shown separately).
 * Dates come from `markedNotSubmittedAt` and `declinedAt`; rows changed
 * before contract v1.7.0 have none, and then the line falls back to the
 * Application's last change.
 */
export function statusLine(app: Application, submission: Submission): string | null {
  const marked = submission.markedNotSubmittedAt ?? app.updatedAt
  switch (submission.state) {
    case "queued":
      if (submission.queuedForWatDay) return submissionCopy.cap.queuedForTomorrowLine
      return submission.attemptNumber >= 1 ? d.queuedAgain(marked) : d.queued
    case "not_submitted":
      return submission.kind === "sample" ? d.sampleNotSubmitted(marked) : d.notSubmittedFinal
    case "declined":
      return d.declined(submission.declinedAt ?? app.updatedAt)
    default:
      return null
  }
}
