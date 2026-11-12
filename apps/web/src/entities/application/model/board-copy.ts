import type { ApplicationState, DocumentFailure } from "./application"
import { failureCopy } from "./copy"

/** The seven board columns (copy deck status.app.*). Sending and Needs you show only with Advanced on or under the safety rule. */
export type BoardColumn = "needsYou" | "sending" | "draft" | "applied" | "interview" | "offer" | "closed"

export const boardColumnCopy = {
  needsYou: "Needs you",
  sending: "Sending",
  draft: "Draft",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  closed: "Closed",
} as const satisfies Record<BoardColumn, string>

/** Reason lines under the one word (copy deck status.app.reason.*, PROPOSAL). Never a second badge. */
export const boardReasonCopy = {
  writing: "Writing documents…",
  docFailed: (cause: string) => `Couldn't make documents: ${cause}`,
  docBlocked: "Couldn't make documents: a claim isn't backed by your profile.",
  queued: "Waiting to send. It goes out in Eve's next daily run.",
  /** Advanced off, still queued: shown under Draft. */
  queuedHidden: "Waiting to send automatically.",
  blocked: "Eve stopped and needs you. Open Blocked for the reason.",
  /** Advanced off (owner decision 2, COPY PROPOSAL): names no automation page. */
  blockedPlain: "Eve stopped and needs you.",
  uncertain: "Eve can't tell if this was sent. Check it.",
  sample: "Waiting for you to review this sample.",
  employerAsked: "Employer asked for something",
  doesntCount: "Doesn't count toward your daily cap.",
  sampleFlag: "This is a sample.",
  override: "You chose to prepare this anyway.",
} as const

/** The cause text for a failed document run, from today's failure copy. */
export function docFailedCause(failure: DocumentFailure | null): string {
  return failureCopy(failure).line.replace(/\.$/, "")
}

export function draftReason(state: ApplicationState, failure: DocumentFailure | null): string | null {
  switch (state) {
    case "generating":
      return boardReasonCopy.writing
    case "documents_failed":
      return boardReasonCopy.docFailed(docFailedCause(failure))
    case "documents_blocked":
      return boardReasonCopy.docBlocked
    case "prepared":
    case "documents_ready":
      return null
  }
}
