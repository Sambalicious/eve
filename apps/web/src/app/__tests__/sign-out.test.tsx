import { CSRF_HEADER } from "@eve/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { renderApp } from "./test-app"
import {
  apiErrorResponse,
  noSession,
  server,
  signedInSession,
  TEST_CSRF_TOKEN,
} from "@/shared/testing"

async function openAccountMenu() {
  server.use(signedInSession)
  const user = userEvent.setup({ delay: null })
  const view = renderApp("/dashboard")
  await screen.findByRole("heading", { name: "Home" })
  const trigger = await screen.findByRole("button", { name: /Ada Okafor/ })
  await user.click(trigger)
  const signOut = await screen.findByRole("menuitem", { name: "Sign out" })
  return { ...view, user, signOut, trigger }
}

/** Opens the menu, picks "Sign out" and returns the confirmation dialog. */
async function openSignOutDialog() {
  const view = await openAccountMenu()
  await view.user.click(view.signOut)
  const dialog = await screen.findByRole("alertdialog", { name: "Sign out?" })
  return { ...view, dialog }
}

describe("sign out", () => {
  it("asks for confirmation first, with Cancel focused, and sends nothing yet", async () => {
    const logoutCalls: string[] = []
    server.use(
      http.post("/v1/auth/logout", () => {
        logoutCalls.push("called")
        return new HttpResponse(null, { status: 204 })
      })
    )
    const { dialog, currentPath } = await openSignOutDialog()

    expect(
      within(dialog).getByText("You'll need to sign in with Google again to open your dashboard.")
    ).toBeVisible()
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus())
    expect(logoutCalls).toEqual([])
    expect(currentPath()).toBe("/dashboard")
  })

  it("Cancel closes the dialog, keeps the Candidate signed in and returns focus to the account button", async () => {
    const logoutCalls: string[] = []
    server.use(
      http.post("/v1/auth/logout", () => {
        logoutCalls.push("called")
        return new HttpResponse(null, { status: 204 })
      })
    )
    const { user, dialog, trigger, currentPath } = await openSignOutDialog()

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(logoutCalls).toEqual([])
    expect(currentPath()).toBe("/dashboard")
  })

  it("Escape counts as Cancel", async () => {
    const { user, currentPath } = await openSignOutDialog()

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(currentPath()).toBe("/dashboard")
  })

  it("ends the session with the CSRF token and lands on sign-in once confirmed", async () => {
    const csrfHeaders: (string | null)[] = []
    server.use(
      http.post("/v1/auth/logout", ({ request }) => {
        csrfHeaders.push(request.headers.get(CSRF_HEADER))
        server.use(noSession)
        return new HttpResponse(null, { status: 204 })
      })
    )
    const { user, dialog, currentPath } = await openSignOutDialog()

    await user.click(within(dialog).getByRole("button", { name: "Sign out" }))

    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeVisible()
    expect(csrfHeaders).toEqual([TEST_CSRF_TOKEN])
    expect(currentPath()).toBe("/sign-in")
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("lands on sign-in when the session had already ended", async () => {
    server.use(http.post("/v1/auth/logout", () => apiErrorResponse("session_expired")))
    const { user, dialog, currentPath } = await openSignOutDialog()
    server.use(noSession)

    await user.click(within(dialog).getByRole("button", { name: "Sign out" }))

    await waitFor(() => expect(currentPath()).toBe("/sign-in"))
  })

  it("stays signed in, closes the dialog and says so when sign-out fails", async () => {
    server.use(http.post("/v1/auth/logout", () => apiErrorResponse("internal_error")))
    const { user, dialog, trigger, currentPath } = await openSignOutDialog()

    await user.click(within(dialog).getByRole("button", { name: "Sign out" }))

    const [message] = await screen.findAllByText(
      "Couldn't sign out. Nothing changed. Try again."
    )
    expect(message.closest("[data-sonner-toast]")).toBeVisible()
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(currentPath()).toBe("/dashboard")
  })
})
