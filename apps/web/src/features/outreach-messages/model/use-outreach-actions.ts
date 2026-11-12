import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import {
  validateReaderName,
  type OutreachItem,
  type OutreachKind,
  type OutreachResponse,
} from "@eve/contracts"

import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"

import { saveOutreachReaderName, startOutreachRun } from "../api/outreach-repository"
import { outreachQueryKey } from "./outreach-query"

/** v1.31.0: the code the api sends when a Reader name fails validation (section 7.1, 422). */
const READER_NAME_INVALID_CODE = "outreach_reader_name_invalid"

export function isReaderNameInvalid(error: unknown): boolean {
  return error instanceof ApiError && error.code === READER_NAME_INVALID_CODE
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

export type SaveNameResult = { ok: true; item: OutreachItem } | { ok: false; reason: "refused" | "saveFailed" | "unavailable" }

export type WriteResult = { ok: true; item: OutreachItem } | { ok: false; reason: "nameRefused" | "nameSaveFailed" | "startFailed" | "unavailable" }

/**
 * The two mutations the section makes, without `useMutation`: a Write with an
 * unsaved name is two requests in order (decision G4), and a POST is never
 * retried automatically (api-contract.md 4.2).
 */
export function useOutreachActions(applicationId: string) {
  const queryClient = useQueryClient()
  const queryKey = [...outreachQueryKey, applicationId]
  const [pending, setPending] = useState<Partial<Record<OutreachKind, "name" | "write">>>({})

  const setPendingFor = (kind: OutreachKind, action: "name" | "write" | null) =>
    setPending((current) => {
      const next = { ...current }
      if (action === null) delete next[kind]
      else next[kind] = action
      return next
    })

  /** A response item replaces its own kind in the cached read; nothing else moves. */
  const applyItem = (item: OutreachItem) =>
    queryClient.setQueryData<OutreachResponse>(queryKey, (current) =>
      current === undefined
        ? current
        : { ...current, items: current.items.map((existing) => (existing.kind === item.kind ? item : existing)) }
    )

  const saveName = async (kind: OutreachKind, draft: string): Promise<SaveNameResult> => {
    const validated = validateReaderName(draft)
    if (!validated.ok) return { ok: false, reason: "refused" }
    setPendingFor(kind, "name")
    try {
      const item = await saveOutreachReaderName(applicationId, kind, validated.value, await ensureCsrfToken(queryClient))
      applyItem(item)
      return { ok: true, item }
    } catch (error) {
      if (isNotFound(error)) return { ok: false, reason: "unavailable" }
      if (isReaderNameInvalid(error)) return { ok: false, reason: "refused" }
      return { ok: false, reason: "saveFailed" }
    } finally {
      setPendingFor(kind, null)
    }
  }

  /**
   * Write or Write again. A typed, valid, unsaved name is saved first, and the
   * Run starts only after that `200` (G4). A refusal or a failed save sends no
   * `POST`.
   */
  const write = async (kind: OutreachKind, item: OutreachItem, draft: string): Promise<WriteResult> => {
    const saved = item.readerName ?? ""
    if (draft !== saved) {
      const named = await saveName(kind, draft)
      if (!named.ok) {
        if (named.reason === "unavailable") return { ok: false, reason: "unavailable" }
        return { ok: false, reason: named.reason === "refused" ? "nameRefused" : "nameSaveFailed" }
      }
    }
    setPendingFor(kind, "write")
    try {
      const started = await startOutreachRun(applicationId, kind, await ensureCsrfToken(queryClient))
      applyItem(started)
      return { ok: true, item: started }
    } catch (error) {
      if (isNotFound(error)) return { ok: false, reason: "unavailable" }
      return { ok: false, reason: "startFailed" }
    } finally {
      setPendingFor(kind, null)
    }
  }

  return { pending, write, saveName }
}
