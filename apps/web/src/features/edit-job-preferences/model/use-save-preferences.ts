import { useMutation, useQueryClient } from "@tanstack/react-query"
import { preferencesFieldErrorSchema, type PreferencesFieldError } from "@eve/contracts"

import { preferencesQueryKey, preferencesQueryOptions, savePreferences, type JobPreferences, type SavedJobPreferences, type SavePreferencesInput } from "@/entities/job-preferences"
import { jobPostingsQueryKey } from "@/entities/job-posting"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError, isUnauthorizedError } from "@/shared/api"

/** Why a save failed, in the terms the form shows (design-spec.r6 B-PREF-3, feedback matrix). */
export type PreferencesSaveFailure =
  | { readonly kind: "fields"; readonly fieldErrors: readonly PreferencesFieldError[] }
  /** 409 `preferences_stale`: C-PREF-CONFLICT at the top, edits kept. */
  | { readonly kind: "conflict" }
  /** 429: `prefs.save.error.rateLimited`. */
  | { readonly kind: "rateLimited" }
  /** Other 4xx with a message: `prefs.save.error.api`, the message verbatim (including 409 `timezone_change_rate_limited`). */
  | { readonly kind: "message"; readonly message: string }
  /** 5xx or no response while online: `prefs.save.error.network` (Settings) or C-WIZ-ERR-1 (wizard). */
  | { readonly kind: "network" }
  /** No response while the browser is offline: C-WIZ-ERR-2 in the wizard. */
  | { readonly kind: "offline" }
  /** 401: the app-wide handler sends the Candidate to sign-in. */
  | { readonly kind: "signed_out" }

export function toPreferencesSaveFailure(error: unknown, online: boolean = navigator.onLine): PreferencesSaveFailure {
  if (isUnauthorizedError(error)) return { kind: "signed_out" }
  if (!(error instanceof ApiError)) return online ? { kind: "network" } : { kind: "offline" }
  if (error.status >= 500 || error.code === null) return { kind: "network" }
  if (error.code === "preferences_stale") return { kind: "conflict" }
  if (error.status === 429) return { kind: "rateLimited" }
  const fieldErrors = error.fieldErrors.filter((item): item is PreferencesFieldError => preferencesFieldErrorSchema.safeParse(item).success)
  if (error.code === "bad_request" && fieldErrors.length > 0) return { kind: "fields", fieldErrors }
  return error.message.trim() === "" ? { kind: "network" } : { kind: "message", message: error.message }
}

/**
 * `PUT /v1/me/preferences`. On success the cached record is replaced and every
 * postings query is invalidated, because the save re-decided keyword and family
 * skips (architecture.r6 "Save and re-decision"). Failures go to the caller.
 */
export function useSavePreferences() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (input: SavePreferencesInput) => savePreferences(input, await ensureCsrfToken(queryClient)),
    onSuccess: (saved) => {
      queryClient.setQueryData<JobPreferences>(preferencesQueryKey, saved)
      void queryClient.invalidateQueries({ queryKey: jobPostingsQueryKey })
    },
  })
  const save = (
    input: SavePreferencesInput,
    handlers: { onSaved: (saved: SavedJobPreferences) => void; onFailed: (failure: PreferencesSaveFailure) => void }
  ) => mutation.mutate(input, { onSuccess: handlers.onSaved, onError: (error) => handlers.onFailed(toPreferencesSaveFailure(error)) })
  /** "Reload preferences": the latest stored version; nothing is merged. */
  const reload = () => queryClient.fetchQuery({ ...preferencesQueryOptions(), staleTime: 0 })
  return { save, reload, isSaving: mutation.isPending }
}
