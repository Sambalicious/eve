import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

import type { AddAddedFactsItem, AddAddedFactsResponse, AddedFactFieldError, AddedFactsView, Submission } from "@eve/contracts"

import { applicationsQueryKey, submissionQueryKey } from "@/entities/application"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"
import { useAnnouncer } from "@/shared/lib/use-announcer"

import { addAddedFacts, confirmAddedFacts, editAddedFact, removeAddedFact } from "../api/added-facts-repository"
import { addedFactsQueryKey } from "./added-facts-query"

/** The failure kinds the feature maps to copy (C-AF-51 to C-AF-59, C-AF-67, C-AF-68). */
export type AddedFactsFailure =
  | Readonly<{ kind: "fields"; fieldErrors: readonly AddedFactFieldError[] }>
  | Readonly<{ kind: "conflict" | "frozen" | "busy" | "gone" | "stale" | "not_lifted" | "network" }>

export type AddedFactsResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: AddedFactsFailure }>

/** The `added_facts` members of the envelope's `fieldErrors` union (the `source` literal tells them apart). */
export function addedFactFieldErrors(error: ApiError): readonly AddedFactFieldError[] {
  return error.fieldErrors.filter((field): field is AddedFactFieldError => "source" in field && field.source === "added_facts")
}

function failureOf(error: unknown): AddedFactsFailure {
  if (!(error instanceof ApiError)) return { kind: "network" }
  switch (error.code) {
    case "added_facts_invalid":
    case "added_facts_limit": {
      const fieldErrors = addedFactFieldErrors(error)
      return fieldErrors.length > 0 ? { kind: "fields", fieldErrors } : { kind: "network" }
    }
    case "added_facts_conflict":
      return { kind: "conflict" }
    /**
     * CR-2: confirm refuses with this when the Application's state makes the queue refusal (or no
     * documents) true. The list and the Application are what changed, so it is the same recovery as
     * `added_facts_conflict`: reload and show C-AF-57, never C-AF-58's pointless "Try again".
     */
    case "application_state_conflict":
      return { kind: "conflict" }
    case "added_facts_frozen":
      return { kind: "frozen" }
    case "added_facts_busy":
      return { kind: "busy" }
    case "added_facts_not_lifted":
      return { kind: "not_lifted" }
    case "documents_stale":
      return { kind: "stale" }
    case "not_found":
      return { kind: "gone" }
    default:
      return { kind: "network" }
  }
}

/** A refusal that may mean another tab changed the record: reload both the view and the Application. */
function needsReload(failure: AddedFactsFailure): boolean {
  return failure.kind === "conflict" || failure.kind === "frozen" || failure.kind === "busy" || failure.kind === "gone" || failure.kind === "stale" || failure.kind === "not_lifted"
}

/**
 * The five routes as the page uses them: each action resolves with an outcome rather than throwing, so
 * the inline form can keep its text, show field errors and offer recovery (`C-AF-57`, `C-AF-58`).
 * A successful write replaces the cached view with the response's `view` and refetches the Application
 * (documents, Match, submission). The one live region's text comes from `useAnnouncer`.
 */
export function useAddedFactsActions(applicationId: string) {
  const queryClient = useQueryClient()
  const { message: announcement, announce } = useAnnouncer()

  const setView = useCallback(
    (view: AddedFactsView) => queryClient.setQueryData(addedFactsQueryKey(applicationId), view),
    [applicationId, queryClient]
  )
  const reload = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: addedFactsQueryKey(applicationId) }),
      queryClient.invalidateQueries({ queryKey: applicationsQueryKey }),
      queryClient.invalidateQueries({ queryKey: submissionQueryKey }),
    ])
  }, [applicationId, queryClient])

  const settle = useCallback(
    async <T,>(run: () => Promise<T>, onValue: (value: T) => void): Promise<AddedFactsResult<T>> => {
      try {
        const value = await run()
        onValue(value)
        return { ok: true, value }
      } catch (error) {
        const failure = failureOf(error)
        if (needsReload(failure)) void reload()
        return { ok: false, failure }
      }
    },
    [reload]
  )

  const addMutation = useMutation({
    mutationFn: async (input: { expectedVersion: number; items: readonly AddAddedFactsItem[] }) =>
      addAddedFacts(applicationId, await ensureCsrfToken(queryClient), input.expectedVersion, input.items),
  })
  const editMutation = useMutation({
    mutationFn: async (input: { factId: string; expectedVersion: number; text: string; roleSectionId: string | null }) =>
      editAddedFact(applicationId, input.factId, await ensureCsrfToken(queryClient), input),
  })
  const removeMutation = useMutation({
    mutationFn: async (input: { factId: string; expectedVersion: number }) =>
      removeAddedFact(applicationId, input.factId, await ensureCsrfToken(queryClient), input.expectedVersion),
  })
  const confirmMutation = useMutation({
    mutationFn: async (expectedVersion: number) => confirmAddedFacts(applicationId, await ensureCsrfToken(queryClient), expectedVersion),
  })

  const addFacts = useCallback(
    (input: { expectedVersion: number; items: readonly AddAddedFactsItem[] }) =>
      settle<AddAddedFactsResponse>(
        () => addMutation.mutateAsync(input),
        (value) => {
          setView(value.view)
          void reload()
        }
      ),
    [addMutation, reload, setView, settle]
  )

  const editFact = useCallback(
    (input: { factId: string; expectedVersion: number; text: string; roleSectionId: string | null }) =>
      settle<AddedFactsView>(
        () => editMutation.mutateAsync(input),
        (view) => {
          setView(view)
          void reload()
        }
      ),
    [editMutation, reload, setView, settle]
  )

  const removeFact = useCallback(
    (input: { factId: string; expectedVersion: number }) =>
      settle<AddedFactsView>(
        () => removeMutation.mutateAsync(input),
        (view) => {
          setView(view)
          void reload()
        }
      ),
    [removeMutation, reload, setView, settle]
  )

  const confirm = useCallback(
    (expectedVersion: number) =>
      settle<Submission>(
        () => confirmMutation.mutateAsync(expectedVersion),
        () => void reload()
      ),
    [confirmMutation, reload, settle]
  )

  return {
    announcement,
    announce,
    addFacts,
    editFact,
    removeFact,
    confirm,
    isAdding: addMutation.isPending,
    isEditing: editMutation.isPending,
    isRemoving: removeMutation.isPending,
    isConfirming: confirmMutation.isPending,
  }
}
