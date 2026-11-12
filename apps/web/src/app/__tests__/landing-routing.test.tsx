import { act, screen, waitFor } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"

import { SESSION_HINT_KEY } from "@/entities/session"
import { apiErrorResponse, expiredSession, notificationStatusHandler, server, signedInSession } from "@/shared/testing"
import { renderApp } from "./test-app"

const HEADLINE = "Applies for you. Asks instead of guessing."
const headline = () => screen.queryByRole("heading", { level: 1, name: HEADLINE })

/** Records every path the router shows, so a test can prove one never appeared. */
function trackPaths(app: ReturnType<typeof renderApp>["app"]) {
  const seen = [app.router.state.location.pathname]
  app.router.subscribe((state) => seen.push(state.location.pathname))
  return seen
}

describe("landing routing (routing.feature)", () => {
  it("a signed-out visitor sees the landing page at the root and never visits sign-in", async () => {
    const { app, currentPath } = renderApp("/")
    const seen = trackPaths(app)

    expect(await screen.findByRole("heading", { level: 1, name: HEADLINE })).toBeVisible()
    await waitFor(() => expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull())
    expect(currentPath()).toBe("/")
    expect(seen).not.toContain("/sign-in")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it.each([
    ["an expired session", expiredSession],
    ["a server error", http.get("/v1/session", () => apiErrorResponse("internal_error"))],
    ["a malformed body", http.get("/v1/session", () => HttpResponse.json({ nope: true }))],
  ])("%s at the root shows the landing page with no error", async (_label, handler) => {
    server.use(handler)
    const { currentPath } = renderApp("/")

    expect(await screen.findByRole("heading", { level: 1, name: HEADLINE })).toBeVisible()
    expect(currentPath()).toBe("/")
    expect(screen.queryByText(/something went wrong|try again/i)).not.toBeInTheDocument()
  })

  it("a signed-in Candidate opening the root lands on the dashboard by replace", async () => {
    server.use(signedInSession)
    const { app, currentPath } = renderApp("/")

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible()
    expect(currentPath()).toBe("/dashboard")
    expect(app.router.state.historyAction).toBe("REPLACE")
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe("1")
  })

  it("with the session hint, the hero never enters the page before the redirect", async () => {
    localStorage.setItem(SESSION_HINT_KEY, "1")
    server.use(signedInSession)
    const appeared: boolean[] = []
    const observer = new MutationObserver(() => appeared.push(headline() !== null))
    observer.observe(document.body, { childList: true, subtree: true })
    const { currentPath } = renderApp("/")

    await screen.findByRole("heading", { name: "Home" })
    observer.disconnect()
    expect(currentPath()).toBe("/dashboard")
    expect(appeared).not.toContain(true)
  })

  it("with the hint and a hanging session check, the page shows after 2 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.setItem(SESSION_HINT_KEY, "1")
    server.use(http.get("/v1/session", () => new Promise(() => {})))
    renderApp("/")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(headline()).not.toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(await screen.findByRole("heading", { level: 1, name: HEADLINE })).toBeInTheDocument()
  })

  it("a 401 clears a stale hint", async () => {
    localStorage.setItem(SESSION_HINT_KEY, "1")
    renderApp("/")

    expect(await screen.findByRole("heading", { level: 1, name: HEADLINE })).toBeVisible()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull()
  })

  it("/about shows the page to a signed-in Candidate with three Open dashboard links", async () => {
    server.use(signedInSession)
    const { currentPath } = renderApp("/about")

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Open dashboard" })).toHaveLength(3))
    for (const link of screen.getAllByRole("link", { name: "Open dashboard" })) expect(link).toHaveAttribute("href", "/dashboard")
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument()
    expect(currentPath()).toBe("/about")
  })

  it("/about shows three Sign in links to a signed-out visitor and never redirects", async () => {
    const { app, currentPath } = renderApp("/about")
    const seen = trackPaths(app)

    await screen.findByRole("heading", { level: 1, name: HEADLINE })
    const links = screen.getAllByRole("link", { name: "Sign in" })
    expect(links).toHaveLength(3)
    for (const link of links) expect(link).toHaveAttribute("href", "/sign-in")
    expect(currentPath()).toBe("/about")
    expect(seen).not.toContain("/sign-in")
  })

  it.each(["/dashboard", "/applications", "/settings"])("%s still sends a signed-out visitor to sign-in with next", async (route) => {
    const { currentPath } = renderApp(route)

    await screen.findByRole("button", { name: "Sign in with Google" })
    expect(currentPath()).toBe(`/sign-in?next=${encodeURIComponent(route)}`)
  })

  it("the sign-in wordmark links back to the root", async () => {
    renderApp("/sign-in")

    expect(await screen.findByRole("link", { name: "Eve, home" })).toHaveAttribute("href", "/")
  })

  it("a root URL with the access hash keeps the hash", async () => {
    const { currentPath } = renderApp("/#access")

    await screen.findByRole("heading", { level: 1, name: HEADLINE })
    expect(currentPath()).toBe("/#access")
  })
})

describe("the access-request alert never shows on public pages", () => {
  it.each(["/", "/about"])("%s shows no waiting-requests alert even with requests waiting", async (path) => {
    server.use(notificationStatusHandler({ senderConfigured: false, accessRequests: { waiting: 2, failed: 0 } }))
    renderApp(path)
    await screen.findByRole("heading", { level: 1, name: HEADLINE })
    expect(screen.queryByText("Access requests are waiting")).not.toBeInTheDocument()
    expect(screen.queryByText(/access requests? (is|are) waiting/)).not.toBeInTheDocument()
  })
})
