import type { QueryClient } from "@tanstack/react-query"

import { sessionQueryOptions } from "./session-query"

/** The session's CSRF token for a state-changing request, from the cached session check when it is fresh. */
export async function ensureCsrfToken(queryClient: QueryClient): Promise<string> {
  const session = await queryClient.ensureQueryData(sessionQueryOptions())
  return session.csrfToken
}
