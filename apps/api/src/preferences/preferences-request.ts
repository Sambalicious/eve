import type { PreferencesValues } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { parseSaveBody } from "./preferences-rules.js"

/** A `PUT /v1/me/preferences` body that passed every bound and field rule. */
export type PreferencesSave = Readonly<{ baseVersion: number | null; values: PreferencesValues }>

/**
 * Bounds and shape first (a plain 400), then the field rules (a 400 naming each bad field), as `parseSaveBody` decides;
 * this turns its verdict into the response or the value the handler saves.
 */
export function preferencesSaveOrRefuse(body: unknown): PreferencesSave {
  const parsed = parseSaveBody(body)
  if (parsed.kind === "bad_request") throw new ApiException("bad_request")
  if (parsed.kind === "field_errors") throw ApiException.badRequestWithFieldErrors(parsed.fieldErrors)
  return { baseVersion: parsed.baseVersion, values: parsed.values }
}
