import { hashKey, MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"

import { sessionQueryKey, type SessionEnding } from "@/entities/session"
import { ApiError, isUnauthorizedError, type ApiRequestMeta } from "@/shared/api"

const MAX_RETRIES = 2
const SESSION_QUERY_HASH = hashKey(sessionQueryKey)

interface AppQueryClientOptions {
  /** Runs for a 401, unless its query or mutation handles 401 itself. */
  onUnauthorized: (error: ApiError) => void
  /** Hears every 401 and every confirmed session, as they land. */
  sessionEnding: Pick<SessionEnding, "record" | "reset">
}

/**
 * One QueryClient for the app. Every 401 is recorded in `sessionEnding` before
 * anything renders or redirects, including 401s from callers that handle them
 * themselves, so all sign-in redirects agree on the reason. A successful
 * session check resets it. Client errors (4xx) are not retried: repeating them
 * cannot succeed.
 */
export function createAppQueryClient({ onUnauthorized, sessionEnding }: AppQueryClientOptions) {
  const reportUnauthorized = (error: unknown, meta: ApiRequestMeta | undefined) => {
    if (!isUnauthorizedError(error)) return
    sessionEnding.record(error)
    if (!meta?.handlesUnauthorized) onUnauthorized(error)
  }

  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => reportUnauthorized(error, query.meta),
      onSuccess: (_data, query) => {
        if (query.queryHash === SESSION_QUERY_HASH) sessionEnding.reset()
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) =>
        reportUnauthorized(error, mutation.meta),
    }),
    defaultOptions: {
      queries: { retry: shouldRetry },
    },
  })
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  const isClientError = error instanceof ApiError && error.status < 500
  return !isClientError && failureCount < MAX_RETRIES
}
