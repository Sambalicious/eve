import { SESSION_PATH, sessionResponseSchema } from "@eve/contracts"

import { apiRequest, isUnauthorizedError } from "@/shared/api"
import { clearSessionHint, markSignedIn } from "../lib/session-hint"
import type { Session } from "../model/session"

/**
 * Confirms the session and reads its CSRF token, and keeps the landing page's
 * session hint in step: set on success, cleared on a 401. Rejects with a 401 `ApiError`
 * (`unauthenticated` or `session_expired`) when there is no valid session.
 */
export async function fetchSession(): Promise<Session> {
  try {
    const response = await apiRequest(SESSION_PATH)
    const body = sessionResponseSchema.parse(await response.json())
    markSignedIn()
    return { csrfToken: body.csrfToken }
  } catch (error) {
    if (isUnauthorizedError(error)) clearSessionHint()
    throw error
  }
}
