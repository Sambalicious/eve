import { SIGN_IN_PAGE_PATH } from "@eve/contracts"
import { createBrowserRouter, type RouteObject } from "react-router-dom"

import { clearSessionHint, createSessionEnding, sessionQueryKey } from "@/entities/session"
import type { ApiError } from "@/shared/api"
import { createAppQueryClient } from "./providers/query-client"
import { HydrateFallback, RootLayout } from "./router/root-layout"
import { RouteError } from "./router/route-error"
import { routes } from "./router/routes"

type AppRouter = ReturnType<typeof createBrowserRouter>
type RouterFactory = (routes: RouteObject[]) => AppRouter

/**
 * Builds the router and QueryClient together, because a 401 from any API call
 * has to send the Candidate to sign-in with the page they were on as `next`.
 * `sessionEnding` is the one decision on that redirect's reason, shared with
 * the route guard, so a later redirect cannot drop `reason=expired` (FU-1).
 * Tests pass a memory router factory.
 */
export function createApp(createRouter: RouterFactory = createBrowserRouter) {
  const sessionEnding = createSessionEnding()
  const sendToSignIn = (error: ApiError) => {
    const from = router.state.location
    clearSessionHint()
    // The sign-in page runs its own session check; removing it mid-flight
    // would cancel it and leave the page on its skeleton (QA-FU1-01).
    if (from.pathname === SIGN_IN_PAGE_PATH) return
    queryClient.removeQueries({ queryKey: sessionQueryKey })
    void router.navigate(sessionEnding.signInPath(error, from), { replace: true })
  }
  const queryClient = createAppQueryClient({ onUnauthorized: sendToSignIn, sessionEnding })
  const router = createRouter([
    { element: <RootLayout />, HydrateFallback, errorElement: <RouteError />, children: routes },
  ])
  return { queryClient, router, sessionEnding }
}
