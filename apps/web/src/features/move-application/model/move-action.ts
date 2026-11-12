import {
  boardColumn,
  boardUiCopy,
  type Application,
  type BoardColumn,
  type BoardOutcomeType,
  type BoardPlacement,
} from "@/entities/application"

/** What one chosen target turns into: exactly one existing write, or a refusal with its one-line reason (D8). */
export type MoveAction =
  | { readonly kind: "manualComplete" }
  | { readonly kind: "createOutcome"; readonly outcome: BoardOutcomeType }
  | { readonly kind: "editOutcome"; readonly outcomeId: string; readonly outcome: BoardOutcomeType }
  | { readonly kind: "refused"; readonly reason: string }

export interface MoveOption {
  readonly target: BoardColumn
  readonly label: string
  readonly action: MoveAction
}

const c = boardUiCopy.move

/** The Outcome that places a card in a column. */
const OUTCOME_FOR: Readonly<Partial<Record<BoardColumn, BoardOutcomeType>>> = {
  applied: "confirmation",
  interview: "interview_invitation",
  offer: "offer",
  closed: "rejection",
}

/** Column order for the stages a user moves along. Closed is terminal. */
const STAGES = ["applied", "interview", "offer"] as const satisfies readonly BoardColumn[]

export function outcomeForColumn(column: BoardColumn): BoardOutcomeType | null {
  return OUTCOME_FOR[column] ?? null
}

type Movable = Pick<Application, "state" | "failure" | "board" | "detailsDeletedAt">

function labelFor(from: BoardColumn, target: BoardColumn): string {
  if (target === "applied") return c.backToApplied
  if (target === "interview") return from === "offer" ? c.backToInterview : c.interview
  if (target === "offer") return c.offer
  return c.closed
}

/**
 * The move menu for a card. Draft offers only "I applied", and only when the server would take it. A card
 * placed by an Outcome moves forward or into Closed by recording one, and backward or out of Closed by editing
 * the placing Outcome (no Outcome is ever deleted). Applied can't go back to Draft; a Closed card that no
 * Outcome placed can't be reopened. Automatic cards (Sending, Needs you) have no menu: their actions stay on the
 * Blocked, Unsure sends and Check first sends pages (AC-6.7). Pure, so every column is a table test.
 */
export function moveOptions(card: Movable, placement: BoardPlacement, options: { advanced: boolean }): MoveOption[] {
  const from = placement.column
  if (placement.automatic) return []
  if (from === "draft") {
    const board = card.board
    const eligible = board?.submissionState == null && board?.sampleState == null && card.detailsDeletedAt === null
    return eligible ? [{ target: "applied", label: c.applied, action: { kind: "manualComplete" } }] : []
  }
  const placing = card.board?.latestOutcome ?? null
  const editable = placement.placedBy === "outcome" && placing !== null
  const out: MoveOption[] = []
  const fromIndex = STAGES.indexOf(from as (typeof STAGES)[number])
  for (const target of STAGES) {
    if (target === from) continue
    const outcome = OUTCOME_FOR[target]!
    const later = fromIndex !== -1 && STAGES.indexOf(target) > fromIndex
    if (later) {
      out.push({ target, label: labelFor(from, target), action: { kind: "createOutcome", outcome } })
    } else if (editable) {
      out.push({ target, label: labelFor(from, target), action: { kind: "editOutcome", outcomeId: placing.id, outcome } })
    } else if (from === "closed") {
      out.push({ target, label: labelFor(from, target), action: { kind: "refused", reason: c.noReopen } })
    }
  }
  if (from !== "closed") out.push({ target: "closed", label: c.closed, action: { kind: "createOutcome", outcome: "rejection" } })
  if (from === "applied") out.push({ target: "draft", label: c.draft, action: { kind: "refused", reason: c.noDraft } })
  if (options.advanced) {
    out.push({ target: "sending", label: c.sending, action: { kind: "refused", reason: c.noTargetSending } })
    out.push({ target: "needsYou", label: c.needsYou, action: { kind: "refused", reason: c.noTargetNeedsYou } })
  }
  return out
}

/** The action for one target of a card, or a refusal when the card can't go there (D8). */
export function moveAction(card: Movable, target: BoardColumn, options: { advanced: boolean }): MoveAction {
  const placement = boardColumn(card, options)
  const found = moveOptions(card, placement, options).find((option) => option.target === target)
  if (found) return found.action
  const reason =
    target === "sending" ? c.noTargetSending : target === "needsYou" ? c.noTargetNeedsYou : placement.automatic ? c.automaticNeedsYou : c.noReopen
  return { kind: "refused", reason }
}
