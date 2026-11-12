import { http, HttpResponse, type JsonBodyType } from "msw"

import {
  HIRING_SEARCH_INPUTS_PATH,
  hiringHintTerms,
  hiringSearchInputsResponseSchema,
  type HiringHintPreferences,
} from "@/shared/lib/hiring-contracts"
import { apiErrorResponse } from "./contract-handlers"

export interface HiringSearchInputsApiState {
  /** The session Candidate's Job Preferences booleans; null = no row (AC 2.5). */
  preferences: HiringHintPreferences | null
  /** The next reads fail with 500 `internal_error` (contract: database failure). */
  failing: boolean
}

/** The Operator's 0018 values: all three hint terms (HSL "The Operator's current Job Preferences…"). */
export const OPERATOR_PREFERENCES: HiringHintPreferences = {
  remoteAccepted: true,
  relocationAccepted: true,
  sponsorshipNeededForRelocation: true,
}

/**
 * `GET /v1/stack-posts/hiring-search-inputs` from EPIC-0007 api-contract.md
 * (Phase 1): `200 { hintTerms }` parsed with the contract schema, `cache-control:
 * no-store`, or `500 internal_error`. Records every request with its full URL
 * so tests can assert the Role family is never sent.
 */
export function createHiringSearchInputsApi(initial: Partial<HiringSearchInputsApiState> = {}) {
  const state: HiringSearchInputsApiState = { preferences: null, failing: false, ...initial }
  const requests: { method: string; url: string }[] = []
  const handlers = [
    http.get(HIRING_SEARCH_INPUTS_PATH, ({ request }) => {
      requests.push({ method: request.method, url: request.url })
      if (state.failing) return apiErrorResponse("internal_error")
      const body = hiringSearchInputsResponseSchema.parse({ hintTerms: hiringHintTerms(state.preferences) })
      return HttpResponse.json(body as JsonBodyType, { headers: { "cache-control": "no-store" } })
    }),
  ]
  return { state, handlers, requests }
}

export type HiringSearchInputsApi = ReturnType<typeof createHiringSearchInputsApi>
