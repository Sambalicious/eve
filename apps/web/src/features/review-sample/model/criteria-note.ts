import { skipLine, type JobPosting, type SkipReason } from "@/entities/job-posting"

/** The skip reasons a Job criteria save can produce (AC 5.4). Only these get the note. */
const CRITERIA_SKIP_REASONS: readonly SkipReason[] = ["weak_core_match", "technology_mismatch"]

export type CriteriaNotePosting = Pick<JobPosting, "status" | "skipReason" | "skipDetail" | "applicationSystem" | "coverage">

/**
 * The reason line for the g9 criteria note, or null when the posting does not
 * get one: it must be skipped by the job criteria (`weak_core_match` or
 * `technology_mismatch`). The line is the Postings page's `skipLine()`
 * (C-JC-SKIP-WEAK, C-SKIP-4 fallback, C-JC-SKIP-TECH).
 */
export function criteriaNoteReason(posting: CriteriaNotePosting | undefined): string | null {
  if (!posting || posting.status !== "skipped" || !posting.skipReason || !CRITERIA_SKIP_REASONS.includes(posting.skipReason)) return null
  return skipLine(posting)
}
