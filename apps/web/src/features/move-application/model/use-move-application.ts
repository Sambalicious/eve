import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import {
  applicationsQueryKey,
  applicationsQueryOptions,
  boardColumn,
  boardColumnCopy,
  boardUiCopy,
  submissionQueryKey,
  submitAction,
  type Application,
  type BoardColumn,
} from "@/entities/application"
import { editOutcome, recordOutcome } from "@/entities/outcome"
import { ensureCsrfToken } from "@/entities/session"
import { toast } from "@/shared/ui/toast"
import { moveAction, outcomeForColumn, type MoveAction } from "./move-action"

type MoveStatus = { kind: "idle" } | { kind: "error"; message: string }

function sameAction(a: MoveAction, b: MoveAction): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "createOutcome" && b.kind === "createOutcome") return a.outcome === b.outcome
  if (a.kind === "editOutcome" && b.kind === "editOutcome") return a.outcomeId === b.outcomeId && a.outcome === b.outcome
  return a.kind !== "refused"
}

/**
 * Runs one board move (R6). It always refetches the board first (one read per move, so a card changed on another device is caught), recomputes the move from the fresh card, and refuses
 * with the conflict line when the card changed elsewhere; a 409 or 404 from the write does the same. Draft to
 * Applied is permanent (a confirm dialog sits in front of it); the others toast with Undo, which edits the
 * Outcome back, because no Outcome is deleted. `announce` feeds a polite live region.
 */
export function useMoveApplication({ advanced, announce }: { advanced: boolean; announce: (text: string) => void }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<MoveStatus>({ kind: "idle" })
  const [pendingId, setPendingId] = useState<string | null>(null)
  /** The card to put focus on once the board re-renders after a move. */
  const [focusId, setFocusId] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: applicationsQueryKey })
  const fail = (message: string) => {
    setStatus({ kind: "error", message })
    void refresh()
  }

  const move = async (app: Application, target: BoardColumn, requested: MoveAction): Promise<boolean> => {
    if (requested.kind === "refused" || pendingId !== null) return false
    setStatus({ kind: "idle" })
    setPendingId(app.id)
    try {
      const list = await queryClient.fetchQuery({ ...applicationsQueryOptions(), staleTime: 0 })
      const fresh = list.find((a) => a.id === app.id)
      if (!fresh || !sameAction(moveAction(fresh, target, { advanced }), requested)) {
        fail(boardUiCopy.move.conflict)
        return false
      }
      const csrf = await ensureCsrfToken(queryClient)
      const from = boardColumn(fresh, { advanced }).column
      const targetWord = boardColumnCopy[target]
      let undo: (() => Promise<unknown>) | null = null
      if (requested.kind === "manualComplete") {
        await submitAction("manual_complete", app.id, csrf)
        void queryClient.invalidateQueries({ queryKey: submissionQueryKey })
      } else if (requested.kind === "createOutcome") {
        const created = await recordOutcome(app.id, requested.outcome, csrf)
        const back = outcomeForColumn(from)
        if (back) undo = () => editOutcome(created.id, back, csrf)
      } else {
        const back = fresh.board?.latestOutcome?.type
        await editOutcome(requested.outcomeId, requested.outcome, csrf)
        if (back) undo = () => editOutcome(requested.outcomeId, back, csrf)
      }
      await refresh()
      setFocusId(app.id)
      announce(boardUiCopy.movedAnnounce(targetWord))
      if (requested.kind === "manualComplete") toast.success(boardUiCopy.toastApplied)
      else
        toast.success(boardUiCopy.toastMoved(targetWord), {
          action: undo
            ? {
                label: boardUiCopy.undo,
                onClick: () => {
                  void undo!().then(refresh, () => fail(boardUiCopy.move.error))
                },
              }
            : undefined,
        })
      return true
    } catch (error) {
      const code = (error as { status?: number } | null)?.status
      fail(code === 409 || code === 404 ? boardUiCopy.move.conflict : boardUiCopy.move.error)
      return false
    } finally {
      setPendingId(null)
    }
  }

  return {
    move,
    pendingId,
    error: status.kind === "error" ? status.message : null,
    clearError: () => setStatus({ kind: "idle" }),
    focusId,
    clearFocus: () => setFocusId(null),
  }
}
