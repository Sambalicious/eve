import { CONTROLS_PATH, SESSION_PATH } from "@eve/contracts"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { delay, http, HttpResponse } from "msw"
import { createMemoryRouter, type RouteObject } from "react-router-dom"
import { beforeAll, describe, expect, it } from "vitest"

import { sessionQueryOptions } from "@/entities/session"
import { apiRequest } from "@/shared/api"
import { apiErrorResponse, noSession, server, TEST_CSRF_TOKEN } from "@/shared/testing"
import { App } from "../app"
import { createApp } from "../create-app"
import { preloadPages } from "../router/routes"
import { loadShellFallback } from "../router/shell-fallback-loader"

/**
 * FU-1 (QA-A-01): one session ending is one sign-in redirect. Once any 401 in it
 * was `session_expired`, the Candidate lands on sign-in with `reason=expired`
 * and C-AUTH-2, whichever redirect comes last (dashboard.feature:129-135,
 * design-spec.r4.md:46, api-contract.md:845).
 *
 * The race needs a sign-in navigation that is still pending, as it is in the
 * browser while the code-split `/sign-in` chunk loads, so the sign-in route's
 * `lazy` waits SIGN_IN_LOAD_MS here.
 */
// Everything but the sign-in delay is loaded up front, so each test sees the same timing.
await Promise.all([preloadPages(), loadShellFallback()])

const SIGN_IN_LOAD_MS = 100
const SESSION_ENDED =
  "Your session ended. Sign in with Google again to continue where you left off."

function signInPath(next: string, reason?: "expired") {
  const params = new URLSearchParams({ next })
  if (reason) params.set("reason", reason)
  return `/sign-in?${params.toString()}`
}

function withSlowSignIn(routes: RouteObject[]): RouteObject[] {
  return routes.map((route) => {
    const copy = { ...route }
    const { lazy } = route
    if (route.path === "/sign-in" && typeof lazy === "function") {
      copy.lazy = async () => {
        await new Promise((done) => setTimeout(done, SIGN_IN_LOAD_MS))
        return lazy()
      }
    }
    if (copy.children) copy.children = withSlowSignIn(copy.children)
    return copy
  })
}

function renderSlowSignInApp(initialPath: string) {
  const app = createApp((routes) =>
    createMemoryRouter(withSlowSignIn(routes), { initialEntries: [initialPath] })
  )
  render(<App app={app} />)
  const currentPath = () => {
    const { pathname, search, hash } = app.router.state.location
    return `${pathname}${search}${hash}`
  }
  return { app, currentPath }
}

/**
 * The real api: a request sent while the browser still held the dead cookie
 * gets `session_expired` (session.service.ts:46-49), and the first 401
 * response clears the cookie (api-exception.filter.ts:43-45), so requests sent
 * after it get `unauthenticated` (auth.guard.ts:48).
 */
function expiredCookieApi({ sessionMs, controlsMs }: { sessionMs: number; controlsMs: number }) {
  let hasCookie = true
  const answer = (ms: number) => async () => {
    const sentWithCookie = hasCookie
    await delay(ms)
    hasCookie = false
    return apiErrorResponse(sentWithCookie ? "session_expired" : "unauthenticated")
  }
  server.use(http.get(SESSION_PATH, answer(sessionMs)), http.get(CONTROLS_PATH, answer(controlsMs)))
}

/** Waits until the sign-in page is up and no later redirect is still on its way. */
async function settledOnSignIn(app: ReturnType<typeof createApp>) {
  await screen.findByRole("button", { name: "Sign in with Google" })
  await new Promise((done) => setTimeout(done, SIGN_IN_LOAD_MS * 3))
  await waitFor(() => expect(app.router.state.navigation.state).toBe("idle"))
}

describe("FU-1 an expired session keeps reason=expired under concurrent 401s", () => {
  // The first app render in a file is slower (first React and module work),
  // which shifts the request timings. Render the signed-in shell once so every
  // case below starts from the same warm state.
  beforeAll(async () => {
    server.use(http.get(SESSION_PATH, () => HttpResponse.json({ csrfToken: TEST_CSRF_TOKEN })))
    renderSlowSignInApp("/dashboard")
    await screen.findByRole("heading", { name: "Home" })
    cleanup()
    server.resetHandlers()
  })

  it("REG-001/REG-005 controls answers session_expired first: reason=expired, C-AUTH-2, next exact", async () => {
    expiredCookieApi({ sessionMs: 20, controlsMs: 0 })
    const { app, currentPath } = renderSlowSignInApp("/stack-posts?view=hiring")

    await settledOnSignIn(app)

    expect(currentPath()).toBe("/sign-in?next=%2Fstack-posts%3Fview%3Dhiring&reason=expired")
    expect(screen.getByRole("status")).toHaveTextContent(SESSION_ENDED)
  })

  it("REG-005 next keeps the path, query and hash exactly", async () => {
    expiredCookieApi({ sessionMs: 20, controlsMs: 0 })
    const requested = "/stack-posts?view=hiring&x=1#top"
    const { app, currentPath } = renderSlowSignInApp(requested)

    await settledOnSignIn(app)

    expect(currentPath()).toBe(signInPath(requested, "expired"))
  })

  const orderings: { sessionMs: number; controlsMs: number }[] = [
    { sessionMs: 0, controlsMs: 0 },
    { sessionMs: 20, controlsMs: 0 },
    { sessionMs: 5, controlsMs: 30 },
    { sessionMs: 0, controlsMs: 20 },
    { sessionMs: 0, controlsMs: 60 },
    { sessionMs: 30, controlsMs: 60 },
    { sessionMs: 10, controlsMs: 10 },
    { sessionMs: 40, controlsMs: 0 },
  ]
  it.each(orderings)(
    "REG-002 session $sessionMs ms, controls $controlsMs ms: reason=expired and C-AUTH-2",
    async (ordering) => {
      expiredCookieApi(ordering)
      const { app, currentPath } = renderSlowSignInApp("/stack-posts?view=hiring")

      await settledOnSignIn(app)

      expect(currentPath()).toBe(signInPath("/stack-posts?view=hiring", "expired"))
      expect(screen.getByRole("status")).toHaveTextContent(SESSION_ENDED)
    }
  )

  it("REG-003 no session cookie at all: next and no reason, no C-AUTH-2", async () => {
    server.use(
      noSession,
      http.get(CONTROLS_PATH, async () => {
        await delay(20)
        return apiErrorResponse("unauthenticated")
      })
    )
    const { app, currentPath } = renderSlowSignInApp("/stack-posts?view=hiring")

    await settledOnSignIn(app)

    expect(currentPath()).toBe(signInPath("/stack-posts?view=hiring"))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("REG-004 a session confirmed after an expired ending: a later unauthenticated 401 has no reason", async () => {
    expiredCookieApi({ sessionMs: 20, controlsMs: 0 })
    const { app, currentPath } = renderSlowSignInApp("/stack-posts?view=hiring")
    await settledOnSignIn(app)
    expect(currentPath()).toContain("reason=expired")

    // The Candidate signs in again: the session check now succeeds.
    server.use(http.get(SESSION_PATH, () => HttpResponse.json({ csrfToken: TEST_CSRF_TOKEN })))
    await app.queryClient.fetchQuery({ ...sessionQueryOptions(), staleTime: 0 })
    await app.router.navigate("/dashboard")
    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible()

    // Later the session is gone without expiring (no cookie).
    server.use(noSession, http.get("/v1/probe", () => apiErrorResponse("unauthenticated")))
    await app.queryClient.prefetchQuery({ queryKey: ["probe"], queryFn: () => apiRequest("/v1/probe") })

    await settledOnSignIn(app)
    expect(currentPath()).toBe(signInPath("/dashboard"))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
})
