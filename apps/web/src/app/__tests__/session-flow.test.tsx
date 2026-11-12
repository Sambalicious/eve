import { DEFAULT_RETURN_PATH } from "@eve/contracts"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { sessionQueryKey } from "@/entities/session"
import { apiRequest } from "@/shared/api"
import {
  apiErrorResponse,
  expiredSession,
  noSession,
  server,
  signedInSession,
  TEST_CSRF_TOKEN,
} from "@/shared/testing"
import { renderApp } from "./test-app"

const SESSION_ENDED =
  "Your session ended. Sign in with Google again to continue where you left off."

function signInPath(next: string, reason?: "expired") {
  const params = new URLSearchParams({ next })
  if (reason) params.set("reason", reason)
  return `/sign-in?${params.toString()}`
}

describe("route guard", () => {
  it("sends an unauthenticated visit to sign-in with the requested page as next", async () => {
    const { currentPath } = renderApp("/dashboard")

    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeVisible()
    expect(currentPath()).toBe(signInPath("/dashboard"))
  })

  it("keeps the query and hash of an email link in next", async () => {
    const emailLink = "/applications/R-1042?tab=documents#resume"
    const { currentPath } = renderApp(emailLink)

    await screen.findByRole("button", { name: "Sign in with Google" })
    expect(currentPath()).toBe(signInPath(emailLink))
  })

  it("shows no dashboard content before the session is confirmed", async () => {
    renderApp("/dashboard")

    await screen.findByRole("button", { name: "Sign in with Google" })
    expect(screen.queryByRole("heading", { name: "Home" })).not.toBeInTheDocument()
  })

  it("renders the requested page for a signed-in Candidate", async () => {
    server.use(signedInSession)
    const { currentPath } = renderApp("/dashboard")

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible()
    expect(currentPath()).toBe("/dashboard")
  })

  it("sends an expired session to sign-in with the session-ended message", async () => {
    server.use(expiredSession)
    const { currentPath } = renderApp("/blocked")

    expect(await screen.findByRole("status")).toHaveTextContent(SESSION_ENDED)
    expect(currentPath()).toBe(signInPath("/blocked", "expired"))
  })

  it("offers a retry when the session check fails for another reason", async () => {
    let calls = 0
    server.use(
      http.get("/v1/session", () => {
        calls += 1
        return calls === 1
          ? apiErrorResponse("service_unavailable")
          : HttpResponse.json({ csrfToken: TEST_CSRF_TOKEN })
      })
    )
    const user = userEvent.setup({ delay: null })
    renderApp("/dashboard")

    await user.click(await screen.findByRole("button", { name: "Try again" }))

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible()
  })
})

describe("sign-in page for a signed-in Candidate", () => {
  it("goes to Home", async () => {
    server.use(signedInSession)
    const { currentPath } = renderApp("/sign-in?next=%2Fblocked")

    await screen.findByRole("heading", { name: "Home" })
    expect(currentPath()).toBe(DEFAULT_RETURN_PATH)
  })
})

describe("401 from an API call", () => {
  // Slice 1 has no domain endpoint yet. Later slices' queries reach the API
  // through apiRequest and this QueryClient, which this probe stands in for.
  const PROBE_PATH = "/v1/probe"
  const probeQuery = { queryKey: ["probe"], queryFn: () => apiRequest(PROBE_PATH) }

  async function signedInAt(path: string) {
    server.use(signedInSession)
    const view = renderApp(path)
    await screen.findByRole("heading", { name: "Home" })
    return view
  }

  it("session_expired sends the Candidate to sign-in with session-ended copy and the current page as next", async () => {
    const { app, currentPath } = await signedInAt("/dashboard?view=week#today")
    server.use(
      http.get(PROBE_PATH, () => apiErrorResponse("session_expired")),
      expiredSession
    )

    await app.queryClient.prefetchQuery(probeQuery)

    expect(await screen.findByRole("status")).toHaveTextContent(SESSION_ENDED)
    expect(currentPath()).toBe(signInPath("/dashboard?view=week#today", "expired"))
  })

  it("unauthenticated sends the Candidate to sign-in with the current page as next and no message", async () => {
    const { app, currentPath } = await signedInAt("/dashboard")
    server.use(http.get(PROBE_PATH, () => apiErrorResponse("unauthenticated")), noSession)

    await app.queryClient.prefetchQuery(probeQuery)

    await screen.findByRole("button", { name: "Sign in with Google" })
    expect(currentPath()).toBe(signInPath("/dashboard"))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("a recheck of an expired session leaves the dashboard", async () => {
    const { app, currentPath } = await signedInAt("/dashboard")
    server.use(expiredSession)

    await app.queryClient.invalidateQueries({ queryKey: sessionQueryKey })

    await waitFor(() => expect(currentPath()).toBe(signInPath("/dashboard", "expired")))
    expect(screen.queryByRole("heading", { name: "Home" })).not.toBeInTheDocument()
  })

  it("a non-401 error leaves the Candidate where they are", async () => {
    const { app, currentPath } = await signedInAt("/dashboard")
    server.use(http.get(PROBE_PATH, () => apiErrorResponse("csrf_invalid")))

    await app.queryClient.prefetchQuery(probeQuery)

    expect(currentPath()).toBe("/dashboard")
    expect(screen.getByRole("heading", { name: "Home" })).toBeVisible()
  })
})

describe("401 while the sign-in page is already showing (QA-FU1-01)", () => {
  it("a late 401 does not cancel the sign-in page's session check, so the page leaves its skeleton", async () => {
    let releaseSession: () => void = () => undefined
    const sessionHeld = new Promise<void>((release) => {
      releaseSession = release
    })
    server.use(
      http.get("/v1/session", async () => {
        await sessionHeld
        return apiErrorResponse("unauthenticated")
      }),
      http.get("/v1/probe", () => apiErrorResponse("unauthenticated"))
    )
    const { app, currentPath } = renderApp("/sign-in?next=%2Fdashboard&reason=expired")
    await waitFor(() =>
      expect(app.queryClient.getQueryState(sessionQueryKey)?.fetchStatus).toBe("fetching")
    )

    // A query that was still mounted on the page before reports its 401 now.
    await app.queryClient.prefetchQuery({ queryKey: ["probe"], queryFn: () => apiRequest("/v1/probe") })
    releaseSession()

    // Released, the check settles at once; 2 s keeps a hang an assertion failure.
    expect(
      await screen.findByRole("button", { name: "Sign in with Google" }, { timeout: 2000 })
    ).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent(SESSION_ENDED)
    expect(currentPath()).toBe(signInPath("/dashboard", "expired"))
  })
})
