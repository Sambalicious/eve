import type { JobPosting } from "@/entities/job-posting"

/**
 * A posting's role and company as one line; a link the backend couldn't read shows its URL.
 * v1.27.0: a description-only posting has no URL but always a typed title.
 */
export function postingName(posting: Pick<JobPosting, "title" | "company" | "applicationUrl">): string {
  if (!posting.title) return posting.applicationUrl ?? posting.company ?? ""
  return posting.company ? `${posting.title} at ${posting.company}` : posting.title
}
