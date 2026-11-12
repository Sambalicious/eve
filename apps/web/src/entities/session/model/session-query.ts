import { queryOptions } from "@tanstack/react-query"

import { fetchSession } from "../api/session-repository"

export const sessionQueryKey = ["session"] as const

/**
 * The CSRF token is fixed for the session's life, so route changes reuse a
 * recent check instead of asking the API every time. An expired session still
 * shows up as soon as any API call returns 401. The route guard decides where
 * a 401 from this query leads, so the app-wide 401 handler skips it. The
 * sign-in page reuses the guard's failed check instead of repeating it.
 */
const SESSION_RECHECK_MS = 5 * 60 * 1000

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: sessionQueryKey,
    queryFn: fetchSession,
    staleTime: SESSION_RECHECK_MS,
    retry: false,
    retryOnMount: false,
    meta: { handlesUnauthorized: true },
  })
}
