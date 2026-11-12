import { ME_PREFERENCES_PATH, preferencesRecordResponseSchema, preferencesResponseSchema } from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { JobPreferences, SavedJobPreferences, SavePreferencesInput } from "../model/preferences"

/** `GET /v1/me/preferences`: a record, or version null with the server's step 3 defaults. */
export async function fetchPreferences(): Promise<JobPreferences> {
  const response = await apiRequest(ME_PREFERENCES_PATH)
  const body = preferencesResponseSchema.parse(await response.json())
  return body.version === null
    ? { version: null, savedAt: null, timeZoneLockedUntil: null, matchedRegions: [], values: body.values }
    : toSaved(body)
}

/**
 * `PUT /v1/me/preferences` with `baseVersion` and every value. Refusals reach the
 * caller as `ApiError` (field errors, 409 stale or time zone, 429).
 */
export async function savePreferences(input: SavePreferencesInput, csrfToken: string): Promise<SavedJobPreferences> {
  const response = await apiRequest(ME_PREFERENCES_PATH, {
    method: "PUT",
    csrfToken,
    json: { baseVersion: input.baseVersion, values: input.values },
  })
  return toSaved(preferencesRecordResponseSchema.parse(await response.json()))
}

function toSaved(body: ReturnType<typeof preferencesRecordResponseSchema.parse>): SavedJobPreferences {
  return {
    version: body.version,
    savedAt: body.savedAt,
    timeZoneLockedUntil: body.timeZoneLockedUntil,
    matchedRegions: [...body.matchedRegions],
    values: body.values,
  }
}
