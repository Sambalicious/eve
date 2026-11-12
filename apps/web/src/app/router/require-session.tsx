import { useQuery } from "@tanstack/react-query"
import { Navigate, Outlet, useLocation } from "react-router-dom"

import { sessionQueryOptions, useSessionEnding } from "@/entities/session"
import { viewerQueryOptions } from "@/entities/viewer"
import { isUnauthorizedError } from "@/shared/api"
import { PageLoadError } from "./page-load-error"
import { RootFallback } from "./root-layout"

/**
 * Renders the dashboard routes only for a signed-in Candidate whose view flags have been read (a failed read means the safe view). Without a
 * session it goes to sign-in with the requested path, query, and hash as
 * `next`, and with `reason=expired` when the session ended. The reason comes
 * from the app-wide session ending, not this query alone (FU-1).
 */
export function RequireSession() {
  const location = useLocation()
  const session = useQuery(sessionQueryOptions())
  // Started together with the session, so the shell never waits twice (D2). No flash: the shell draws only once /v1/me has answered.
  const viewer = useQuery(viewerQueryOptions())
  const sessionEnding = useSessionEnding()

  if (isUnauthorizedError(session.error)) {
    return <Navigate to={sessionEnding.signInPath(session.error, location)} replace />
  }
  if (session.data && !viewer.isPending) return <Outlet />
  if (session.isError) return <PageLoadError onRetry={() => void session.refetch()} />
  return <RootFallback />
}
