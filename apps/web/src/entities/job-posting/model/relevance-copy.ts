import { formatCopy } from "./postings-copy"
import type { HiddenCounts, HiddenReason, PostedDate, WaitingReason } from "./job-posting"

/**
 * EPIC-0006 copy deck (`copy-deck.r1.md`), keyed by its slot IDs:
 * `relevanceCopy.postings.hidden.total` is the deck's `postings.hidden.total`.
 * Placeholders keep the deck's names; fill them with `formatCopy` (en-US grouping).
 * `relevance-copy.test.ts` checks the fixed strings against the deck.
 */
export const relevanceCopy = {
  posting: {
    age: {
      posted: "Posted {n} days ago",
      updated: "Updated {n} days ago",
    },
    status: {
      notCheckedYet: "Not checked yet",
      failed: "Not checked",
    },
    notCheckedYet: { line: "Not checked while it was hidden. Use Check again on Jobs." },
  },
  postingDetail: {
    posted: { label: "Posted" },
    updated: { label: "Updated" },
    hidden: {
      reason: {
        off_target: "Hidden from your board: off-target role, not one of your role families.",
        below_seniority_floor: "Hidden from your board: entry-level role, below your seniority setting.",
        undated: "Hidden from your board: no posted date.",
        older_than_60_days: "Hidden from your board: posted more than 60 days ago.",
      } satisfies Record<HiddenReason, string>,
      body: "Eve keeps this posting, and any Application for it still links here. No new Application can start from it.",
      link: "Change job criteria",
    },
  },
  postings: {
    hidden: {
      total: { one: "1 posting hidden", other: "{n} postings hidden" },
      reason: {
        offTarget: { one: "1 off-target role", other: "{n} off-target roles" },
        belowFloor: "{n} entry-level",
        undated: "{n} with no posted date",
        stale: "{n} older than 60 days",
      },
      link: "Change job criteria",
    },
    allHidden: {
      title: "Every posting Eve found is hidden",
      body: "Your role families, seniority setting and the 60-day age limit decide what shows. The line above gives each reason.",
      bodyUndated: "Posted dates fill in the next time Eve reads each job board. Your job criteria decide the rest.",
      action: "Change job criteria",
    },
    checkAgain: {
      panel: {
        text: { one: "1 posting on your board hasn't been checked.", other: "{n} postings on your board haven't been checked." },
        action: "Check again",
      },
      dialog: {
        title: { one: "Check 1 posting again?", other: "Check {n} postings again?" },
        body: "Each check uses AI spend and counts toward this month's cost ceiling. If the ceiling is reached, the rest wait until the cost pause ends.",
        cancel: "Cancel",
        confirm: { one: "Check 1 posting", other: "Check {n} postings" },
        pending: "Queuing…",
        errorNet: "Couldn't queue the checks. Nothing changed. Try again.",
      },
      toast: {
        queued: { one: "1 posting queued for a check.", other: "{k} postings queued for a check." },
        nothingNew: "Nothing new to check. Those postings are already queued.",
        waiting: {
          one: "1 posting moved to waiting. It isn't checked until the person who runs your Eve turns on checks for you.",
          other: "{k} postings moved to waiting. They aren't checked until the person who runs your Eve turns on checks for you.",
        },
      },
    },
    waitingNotice: {
      text: {
        one: "1 posting is waiting to be checked. Eve checks it when the cost pause ends, then ranks it with the rest.",
        other: "{q} postings are waiting to be checked. Eve checks them when the cost pause ends, then ranks them with the rest.",
      },
      textInvitee: {
        one: "1 posting is waiting to be checked. It isn't checked until the person who runs your Eve turns on checks for you.",
        other: "{q} postings are waiting to be checked. They aren't checked until the person who runs your Eve turns on checks for you.",
      },
      link: "See them",
    },
  },
  addJobLink: {
    hidden: {
      created: "Saved, but hidden: {reason}.",
      existing: "You already have this Job Posting. It's hidden: {reason}.",
      view: "View it",
      reason: {
        off_target: "off-target role",
        below_seniority_floor: "entry-level role",
        undated: "no posted date",
        older_than_60_days: "posted more than 60 days ago",
      } satisfies Record<HiddenReason, string>,
    },
  },
  api: {
    error: {
      posting_hidden:
        "This Job Posting is hidden from your board. Eve won't start a new Application or sample from it. Reload the page to see why.",
    },
  },
} as const

type Plural = { readonly one: string; readonly other: string }

/** The singular form for 1, else the plural with every placeholder set to `count`. */
export function plural(forms: Plural, count: number): string {
  return count === 1 ? forms.one : formatCopy(forms.other, { n: count, k: count, q: count })
}

/** `posting.age.posted` / `.updated`, or null below 31 days (AC-6.3). */
export function ageLabel(postedDate: PostedDate | null): string | null {
  if (postedDate === null || postedDate.ageDays < 31) return null
  const template = postedDate.kind === "updated" ? relevanceCopy.posting.age.updated : relevanceCopy.posting.age.posted
  return formatCopy(template, { n: postedDate.ageDays })
}

/**
 * `postings.hidden.total` + ": " + the non-zero reasons in AC-3.4 order, joined
 * per `postings.hidden.join` (no serial comma), with a closing full stop. Null at zero.
 */
export function hiddenCountsLine(counts: HiddenCounts): string | null {
  if (counts.total <= 0) return null
  const { reason } = relevanceCopy.postings.hidden
  const phrases = [
    counts.offTarget > 0 ? plural(reason.offTarget, counts.offTarget) : null,
    counts.belowSeniorityFloor > 0 ? formatCopy(reason.belowFloor, { n: counts.belowSeniorityFloor }) : null,
    counts.undated > 0 ? formatCopy(reason.undated, { n: counts.undated }) : null,
    counts.olderThan60Days > 0 ? formatCopy(reason.stale, { n: counts.olderThan60Days }) : null,
  ].filter((phrase): phrase is string => phrase !== null)
  const total = plural(relevanceCopy.postings.hidden.total, counts.total)
  return phrases.length === 0 ? `${total}.` : `${total}: ${joinPhrases(phrases)}.`
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases.join("")
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`
}

/** `postings.waitingNotice.text` for the cost pause, `.textInvitee` for checks not enabled. */
export function waitingNoticeText(reason: WaitingReason, count: number): string {
  const { waitingNotice } = relevanceCopy.postings
  return plural(reason === "checks_not_enabled" ? waitingNotice.textInvitee : waitingNotice.text, count)
}

/** The hidden notice links to Job criteria only for setting-driven reasons (P15). */
export function hiddenReasonHasSettingsLink(reason: HiddenReason): boolean {
  return reason === "off_target" || reason === "below_seniority_floor"
}

/** `addJobLink.hidden.created` / `.existing` with the reason phrase. */
export function pastedHiddenLine(created: boolean, reason: HiddenReason): string {
  const { hidden } = relevanceCopy.addJobLink
  return formatCopy(created ? hidden.created : hidden.existing, { reason: hidden.reason[reason] })
}
