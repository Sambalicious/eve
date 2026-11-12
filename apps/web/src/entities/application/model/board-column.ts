import type { Application, BoardInfo } from "./application"
import { boardReasonCopy, draftReason, type BoardColumn } from "./board-copy"

export interface BoardPlacement {
  readonly column: BoardColumn
  /** The one line under the word. Null when the column says it all. */
  readonly reason: string | null
  /** The card's actions are on its own page, not on the board (Sending, Needs you). */
  readonly automatic: boolean
  /** Why this card sits where it does: set by an Outcome (movable by editing it) or by submission state alone. */
  readonly placedBy: "outcome" | "submission" | "none"
  /** "Employer asked for something" line, in whatever column the card is in. */
  readonly employerAsked: boolean
}

function assertNever(value: never): never {
  throw new Error(`Unhandled board value: ${String(value)}`)
}

const EMPTY_BOARD: BoardInfo = {
  submissionState: null,
  submissionKind: null,
  sampleState: null,
  latestOutcome: null,
  requestForAction: false,
}

function columnForOutcome(type: NonNullable<BoardInfo["latestOutcome"]>["type"]): BoardColumn {
  switch (type) {
    case "offer":
      return "offer"
    case "interview_invitation":
      return "interview"
    case "rejection":
      return "closed"
    case "confirmation":
      return "applied"
    default:
      return assertNever(type)
  }
}

/**
 * The one column an Application sits in (D6, contract "Placement and Move-to mapping"). First match wins:
 * the safety override, the newest Outcome, the submission state, then Draft. Total over the enums, so a new
 * backend value fails the type check. `advanced` only decides whether Sending exists; Needs you never depends on it.
 */
export function boardColumn(app: Pick<Application, "state" | "failure" | "board">, options: { advanced: boolean }): BoardPlacement {
  const board = app.board ?? EMPTY_BOARD
  const employerAsked = board.requestForAction
  const sub = board.submissionState

  if (sub === "blocked" || sub === "uncertain" || board.sampleState === "awaiting_review") {
    const reason = sub === "uncertain" ? boardReasonCopy.uncertain : sub === "blocked" ? (options.advanced ? boardReasonCopy.blocked : boardReasonCopy.blockedPlain) : boardReasonCopy.sample
    return { column: "needsYou", reason, automatic: true, placedBy: "none", employerAsked }
  }
  if (board.latestOutcome) {
    return { column: columnForOutcome(board.latestOutcome.type), reason: null, automatic: false, placedBy: "outcome", employerAsked }
  }
  switch (sub) {
    case "manual":
    case "confirmed":
      return { column: "applied", reason: null, automatic: false, placedBy: "submission", employerAsked }
    case "declined":
    case "not_submitted":
      return { column: "closed", reason: null, automatic: false, placedBy: "submission", employerAsked }
    case "queued":
    case "submit_claimed":
    case "submitting":
      return options.advanced
        ? { column: "sending", reason: boardReasonCopy.queued, automatic: true, placedBy: "none", employerAsked }
        : { column: "draft", reason: boardReasonCopy.queuedHidden, automatic: false, placedBy: "none", employerAsked }
    case null:
      return { column: "draft", reason: draftReason(app.state, app.failure), automatic: false, placedBy: "none", employerAsked }
    default:
      return assertNever(sub)
  }
}

/** The columns the board shows, in order: Sending and Needs you only when they hold a card and are allowed. */
export function visibleColumns(placements: readonly BoardPlacement[], advanced: boolean): BoardColumn[] {
  const holds = (column: BoardColumn) => placements.some((p) => p.column === column)
  const out: BoardColumn[] = []
  if (holds("needsYou")) out.push("needsYou")
  if (advanced && holds("sending")) out.push("sending")
  out.push("draft", "applied", "interview", "offer", "closed")
  return out
}
