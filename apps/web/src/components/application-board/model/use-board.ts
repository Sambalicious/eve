import { useEffect, useMemo, useState, type RefObject } from "react"

import {
  boardColumn,
  boardColumnCopy,
  visibleColumns,
  type Application,
  type BoardColumn,
  type BoardPlacement,
} from "@/entities/application"
import { moveOptions, useMoveApplication, type MoveOption } from "@/features/move-application"
import { useAnnouncer } from "@/shared/lib/use-announcer"

export interface BoardCard {
  readonly app: Application
  readonly placement: BoardPlacement
  readonly options: MoveOption[]
}

export interface BoardColumnModel {
  readonly column: BoardColumn
  readonly cards: BoardCard[]
}

export const COLUMN_PAGE = 20

/** Groups Applications into columns, in list order (newest first), with each card's move options. */
export function groupBoard(applications: readonly Application[], advanced: boolean): BoardColumnModel[] {
  const cards: BoardCard[] = applications.map((app) => {
    const placement = boardColumn(app, { advanced })
    return { app, placement, options: moveOptions(app, placement, { advanced }) }
  })
  const columns = visibleColumns(
    cards.map((card) => card.placement),
    advanced
  )
  return columns.map((column) => ({ column, cards: cards.filter((card) => card.placement.column === column) }))
}

/** View model of the board: columns, the move runner, the polite live region and focus after a move. */
export function useBoard(applications: readonly Application[], advanced: boolean, root: RefObject<HTMLElement | null>) {
  const { message, announce } = useAnnouncer()
  const mover = useMoveApplication({ advanced, announce })
  const columns = useMemo(() => groupBoard(applications, advanced), [applications, advanced])
  const [confirming, setConfirming] = useState<Application | null>(null)

  // After a move the same card is focused in its new column, or the column heading if it left the page.
  const { focusId, clearFocus } = mover
  useEffect(() => {
    if (!focusId || !root.current) return
    const link = root.current.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(focusId)}"] a`)
    if (link) link.focus()
    clearFocus()
  })

  const pick = (card: BoardCard, option: MoveOption) => {
    if (option.action.kind === "manualComplete") return setConfirming(card.app)
    void mover.move(card.app, option.target, option.action)
  }
  const confirmApplied = async () => {
    const app = confirming
    if (!app) return
    const card = columns.flatMap((c) => c.cards).find((c) => c.app.id === app.id)
    const option = card?.options.find((o) => o.action.kind === "manualComplete")
    if (option) await mover.move(app, option.target, option.action)
    setConfirming(null)
  }

  return {
    columns,
    announcement: message,
    pendingId: mover.pendingId,
    error: mover.error,
    clearError: mover.clearError,
    confirming,
    cancelConfirm: () => setConfirming(null),
    confirmApplied,
    pick,
    columnWord: (column: BoardColumn) => boardColumnCopy[column],
  }
}
