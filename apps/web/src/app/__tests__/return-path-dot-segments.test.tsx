import { DEFAULT_RETURN_PATH, SIGN_IN_START_PATH } from "@eve/contracts"
import { screen } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiRequest } from "@/shared/api"
import { apiErrorResponse, expiredSession, server, signedInSession } from "@/shared/testing"
import { renderApp } from "./test-app"

/**
 * QA-F1: inputs that URL parsing collapses to "//evil.com". Wherever the web
 * app builds or follows `next`, the result must stay on the dashboard origin.
 */
const DOT_SEGMENT_INPUTS = [
  "/.//evil.com",
  "/..//evil.com",
  "/a/..//evil.com",
  "/%2e//evil.com",
  "/%2e%2e//evil.com",
  "/v1/../..//evil.com",
  "/dashboard/../..//evil.com",
]

const ORIGIN = window.location.origin

/** Fails unless `url` resolves on the dashboard origin. Returns the resolved URL. */
function expectSameOrigin(url: string): URL {
  const resolved = new URL(url, ORIGIN)
  expect(resolved.origin, `${url} resolves off-origin`).toBe(ORIGIN)
  return resolved
}

/** The `next` a path carries, checked to resolve on the dashboard origin. */
function expectNextStaysHome(path: string) {
  const next = expectSameOrigin(path).searchParams.get("next")
  expect(next).not.toBeNull()
  expectSameOrigin(next ?? "")
  expect(next).toBe(DEFAULT_RETURN_PATH)
}

/** The URL the browser loads when the sign-in form is submitted. */
function signInSubmissionUrl(): string {
  const button = screen.getByRole("button", { name: "Sign in with Google" })
  const form = button.closest("form")
  if (!form) throw new Error("The sign-in button is not in a form")
  const query = new URLSearchParams()
  for (const [name, value] of new FormData(form)) query.append(name, String(value))
  return `${form.getAttribute("action")}?${query.toString()}`
}

describe.each(DOT_SEGMENT_INPUTS)("QA-F1 dot-segment next %s", (input) => {
  it("the sign-in page starts Google sign-in with next replaced by Home", async () => {
    renderApp(`/sign-in?next=${encodeURIComponent(input)}`)
    await screen.findByRole("button", { name: "Sign in with Google" })

    const submission = signInSubmissionUrl()

    expect(expectSameOrigin(submission).pathname).toBe(SIGN_IN_START_PATH)
    expectNextStaysHome(submission)
  })

  it("the route guard sends an unauthenticated visit to sign-in with next replaced by Home", async () => {
    const { currentPath } = renderApp(input)
    await screen.findByRole("button", { name: "Sign in with Google" })

    expect(expectSameOrigin(currentPath()).pathname).toBe("/sign-in")
    expectNextStaysHome(currentPath())
    expectNextStaysHome(signInSubmissionUrl())
  })

  it("a 401 from an API call sends the Candidate to sign-in with next replaced by Home", async () => {
    server.use(signedInSession)
    const { app, currentPath } = renderApp(input)
    await screen.findByRole("heading", { name: "404" })
    server.use(
      http.get("/v1/probe", () => apiErrorResponse("session_expired")),
      expiredSession
    )

    await app.queryClient.prefetchQuery({
      queryKey: ["probe"],
      queryFn: () => apiRequest("/v1/probe"),
    })

    await screen.findByRole("button", { name: "Sign in with Google" })
    expect(expectSameOrigin(currentPath()).pathname).toBe("/sign-in")
    expectNextStaysHome(currentPath())
    expectNextStaysHome(signInSubmissionUrl())
  })
})
