import {
  OUTREACH_BUDGETS,
  outreachLength,
  outreachMailtoHref,
  quotableFailedSentence,
  type OutreachItem,
  type OutreachKind,
} from "@eve/contracts"
import { formatWatDate } from "@/shared/lib/format-wat"
import { kindLower, outreachCopy } from "./outreach-copy"

/** How long the Copy button keeps its Copied state (design spec section 9). */
export const COPIED_MS = 2_000

/** A link inside a notice or the pause note. `mailto:` is never built here. */
export interface NoticeLink {
  to: string
  label: string
}

/**
 * The cause notice for one item (`api-contract.md` 6.1, design spec section 3).
 * `null` when the last Run succeeded or no Run has ended. A sentence in the
 * response is shown only for `blocked`, through `quotableFailedSentence`.
 */
export interface CauseNotice {
  /** `C-OM-20` to `C-OM-29`. */
  line: string
  link?: NoticeLink
  /** `C-OM-53`, the quote's label, present only with a stored sentence. */
  quoteLabel?: string
  /** The first failed sentence, exactly as stored. Plain text, never a slot. */
  quote?: string
  /** `C-OM-30`, appended when an earlier Ready text exists. */
  earlierKept?: string
}

export function causeNotice(item: OutreachItem): CauseNotice | null {
  const cause = item.lastFailure
  if (cause === null) return null
  const kind = kindLower(item.kind)
  const earlierKept = item.text === null ? undefined : outreachCopy.cause.earlierKept(kind)
  const withEarlier = (line: string, link?: NoticeLink): CauseNotice => ({ line, link, earlierKept })

  switch (cause) {
    case "not_approved":
      return withEarlier(outreachCopy.cause.notApproved(kind), { to: "/privacy#ai-provider", label: outreachCopy.links.approve })
    case "not_configured":
      return withEarlier(outreachCopy.cause.notConfigured(kind))
    case "provider_error":
      return withEarlier(outreachCopy.cause.providerError(kind))
    case "timed_out":
      return withEarlier(outreachCopy.cause.timedOut(kind))
    case "invalid_output":
      return withEarlier(outreachCopy.cause.invalidOutput(kind))
    case "no_career_profile":
      return withEarlier(outreachCopy.cause.noProfile(kind), { to: "/profile", label: outreachCopy.links.careerProfile })
    case "blocked": {
      const quote = quotableFailedSentence(item)
      return {
        line: outreachCopy.cause.blocked(kind),
        quoteLabel: quote === null ? undefined : outreachCopy.cause.blockedQuoteLabel,
        quote: quote ?? undefined,
        earlierKept,
      }
    }
    case "over_budget":
      return withEarlier(outreachCopy.cause.overBudget(kind, OUTREACH_BUDGETS[item.kind].total))
    case "interrupted":
      return withEarlier(outreachCopy.cause.interrupted(kind))
    default:
      // `unexpected`, a future cause, or a cause this build does not know (AC 11.3).
      return withEarlier(outreachCopy.cause.other(kind))
  }
}

/** The section live region speaks the cause line, then `C-OM-30`; never the label or the quote. */
export function noticeAnnouncement(notice: CauseNotice): string {
  return notice.earlierKept === undefined ? notice.line : `${notice.line} ${notice.earlierKept}`
}

/** `api-contract.md` 5.3: computed on the client, both versions named (`C-OM-33`). */
export function isStale(item: OutreachItem, approvedProfileVersion: number | null): boolean {
  return (
    item.profileVersion !== null &&
    approvedProfileVersion !== null &&
    approvedProfileVersion > item.profileVersion
  )
}

export function staleLine(item: OutreachItem, approvedProfileVersion: number | null): string | null {
  if (!isStale(item, approvedProfileVersion) || item.profileVersion === null || approvedProfileVersion === null) return null
  return outreachCopy.stale(item.profileVersion, approvedProfileVersion)
}

/** `C-OM-39`: `{n}` counts code points, `{max}` is the kind's total budget. */
export function countLine(item: OutreachItem): string | null {
  if (item.text === null) return null
  return outreachCopy.meta.count(outreachLength(item.text), OUTREACH_BUDGETS[item.kind].total)
}

/** `C-OM-40` in WAT; omitted when the date is missing, never an invalid date. */
export function writtenLine(item: OutreachItem): string | null {
  if (item.writtenAt === null) return null
  return outreachCopy.meta.written(formatWatDate(item.writtenAt))
}

/**
 * `api-contract.md` 7.5: the link for Open in email, or `null` when the whole
 * encoded href is over 2,000 characters. A blocked item's quote never reaches it.
 */
export function mailtoHref(item: OutreachItem, roleTitle: string | null, company: string | null): string | null {
  if (item.text === null) return null
  return outreachMailtoHref({ kind: item.kind, text: item.text, roleTitle, company })
}

export type PauseKind = "global" | "cost"

/** The pause note (`C-OM-31` or `C-OM-32`). Not stored, never a failure. */
export function pauseNotice(pause: PauseKind, kind: OutreachKind): { line: string; link?: NoticeLink } {
  return pause === "cost"
    ? { line: outreachCopy.pause.cost(kindLower(kind)), link: { to: "/pause-and-cost#cost", label: outreachCopy.pause.costLink } }
    : { line: outreachCopy.pause.global(kindLower(kind)) }
}

/** Which pause the page sees, global first (decision pause-order). */
export function activePause(globalPaused: boolean, costPaused: boolean): PauseKind | null {
  if (globalPaused) return "global"
  if (costPaused) return "cost"
  return null
}
