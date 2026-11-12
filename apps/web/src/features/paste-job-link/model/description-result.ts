import type { JobPosting, PasteResult } from "@/entities/job-posting"
import { firstOfNextMonth } from "@/entities/automation-state"
import { hiringCopy as h } from "@/entities/stack-post"
import { formatWatDate, watToday } from "@/shared/lib/format-wat"
import { pasteCopy } from "./paste-copy"

/** The result line of a paste that carried a description (design r1 B1 table). */
export interface DescriptionResultLine {
  readonly text: string
  /** The status badge follows the text, except when the link goes to an Application. */
  readonly badgePosting: JobPosting | null
  readonly link: { readonly to: string; readonly label: string }
  /** `already_pasted` and `unchanged_has_application` keep the typed values; the rest clear and close. */
  readonly keepValues: boolean
}

/** C-PD-36's `{date}`: 1st of next month WAT, as C-LINK-10 computes it. */
function costPauseResumeDate(now: Date): string {
  return formatWatDate(firstOfNextMonth(`${watToday(now).slice(0, 7)}-01`))
}

export function descriptionResultLine(result: PasteResult, now: Date = new Date()): DescriptionResultLine | null {
  const { posting, waitingReason } = result
  const view = { to: `/postings/${posting.id}`, label: h.checkView }
  // A waiting line replaces C-PD-30/38/32 for the outcomes that saved the description.
  const waiting =
    waitingReason === "cost_pause"
      ? pasteCopy.result.waitingCost(costPauseResumeDate(now))
      : waitingReason === "checks_not_enabled"
        ? pasteCopy.result.waitingInvitee
        : null
  const saved = (text: string) => ({ text: waiting ?? text, badgePosting: posting, link: view, keepValues: false })
  switch (result.descriptionOutcome) {
    case "stored":
      return saved(pasteCopy.result.created)
    case "stored_lookup_failed":
      return saved(pasteCopy.result.lookupFailed)
    case "attached":
    case "replaced":
      return saved(pasteCopy.result.updated)
    case "already_pasted":
      return { text: pasteCopy.result.alreadyPasted, badgePosting: posting, link: view, keepValues: true }
    case "employer_page_used":
      return { text: pasteCopy.result.employerPage, badgePosting: posting, link: view, keepValues: false }
    case "unchanged_has_application":
      return {
        text: pasteCopy.result.hasApplication,
        badgePosting: null,
        link: { to: `/applications/${result.applicationId ?? ""}`, label: pasteCopy.result.viewApplication },
        keepValues: true,
      }
    case null:
      return null
  }
}
