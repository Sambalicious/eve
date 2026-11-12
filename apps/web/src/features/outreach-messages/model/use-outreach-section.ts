import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"

import { hasErrorCode } from "@/shared/api"
import type { OutreachItem, OutreachKind, OutreachResponse } from "@eve/contracts"
import { activePause, type PauseKind } from "./outreach-state"
import { outreachPauseQueryOptions, outreachQueryOptions } from "./outreach-query"
import { useOutreachActions, type SaveNameResult, type WriteResult } from "./use-outreach-actions"

export type OutreachSectionState =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "unavailable" }
  | { status: "ready"; response: OutreachResponse; pause: PauseKind | null }

/**
 * One polite announcement per event. The region keeps its last message and the
 * rendered span is keyed by sequence, so two identical messages in a row are
 * both announced (design spec section 12).
 */
export function useLiveAnnouncer() {
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 })
  const announce = useCallback((text: string) => setAnnouncement((current) => ({ text, seq: current.seq + 1 })), [])
  return { message: announcement.text, seq: announcement.seq, announce }
}

/**
 * The section's data: the three items, the pause state from `GET /v1/controls`
 * (G5) and the two mutations. A 404 on any outreach route means the details are
 * gone, so the page swaps to its minimal record view (api-contract.md 2, 6.1).
 */
export function useOutreachSection(
  applicationId: string,
  onUnavailable: () => void
): OutreachSectionState & {
  message: string
  seq: number
  announce: (message: string) => void
  pending: ReturnType<typeof useOutreachActions>["pending"]
  write: (kind: OutreachKind, item: OutreachItem, draft: string) => Promise<WriteResult>
  saveName: (kind: OutreachKind, draft: string) => Promise<SaveNameResult>
  refetch: () => void
} {
  const query = useQuery(outreachQueryOptions(applicationId))
  const automation = useQuery(outreachPauseQueryOptions())
  const actions = useOutreachActions(applicationId)
  const { message, seq, announce } = useLiveAnnouncer()

  const unavailable = hasErrorCode(query.error, "not_found")
  useEffect(() => {
    if (unavailable) onUnavailable()
  }, [unavailable, onUnavailable])

  const state: OutreachSectionState = unavailable
    ? { status: "unavailable" }
    : query.data !== undefined
      ? {
          status: "ready",
          response: query.data,
          pause: activePause(automation.data?.globalPaused === true, automation.data?.costPause != null),
        }
      : query.isError
        ? { status: "error", retry: () => void query.refetch() }
        : { status: "loading" }

  return {
    ...state,
    message,
    seq,
    announce,
    pending: actions.pending,
    write: actions.write,
    saveName: actions.saveName,
    refetch: () => void query.refetch(),
  }
}
