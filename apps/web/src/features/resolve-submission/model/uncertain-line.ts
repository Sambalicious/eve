import { submissionCopy, type SubmissionRow } from "@/entities/application"

const u = submissionCopy.uncertain

/** The explanation line: C-UNC-8 on the one more attempt, C-UNC-5 after a CAPTCHA, otherwise C-UNC-1. */
export function uncertainLine(row: SubmissionRow): string | null {
  const { submission } = row
  const at = submission.submittedAt
  if (!at) return null
  if (submission.kind !== "sample" && submission.attemptNumber >= 2) return u.freshAttempt(at)
  return submission.captchaAfterSubmit ? u.captcha(at) : u.noEvidence(at)
}

