import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { renderApp } from "./test-app"

const C_AUTH_0 = "Use the Google account you set up Eve with."
const C_AUTH_1 = "Sign-in didn't finish. Try again."
const C_AUTH_2 =
  "Your session ended. Sign in with Google again to continue where you left off."
const C_AUTH_3_TITLE = "This Google account can't open Eve"
const C_AUTH_NOTE = "Only one Google account can open this dashboard."

async function openSignIn(query = "") {
  const view = renderApp(`/sign-in${query}`)
  const button = await screen.findByRole("button", { name: "Sign in with Google" })
  return { ...view, button }
}

/** The URL the browser would load when the sign-in form is submitted. */
function submissionUrl(button: HTMLElement): string {
  const form = button.closest("form")
  if (!form) throw new Error("The sign-in button is not in a form")
  const query = new URLSearchParams()
  for (const [name, value] of new FormData(form)) query.append(name, String(value))
  return `${form.getAttribute("action")}?${query.toString()}`
}

describe("sign-in page", () => {
  it("offers only Google sign-in", async () => {
    await openSignIn()

    expect(screen.getByRole("heading", { level: 1, name: "Sign in to Eve" })).toBeVisible()
    expect(screen.getByText(C_AUTH_0)).toBeVisible()
    expect(screen.getByText(C_AUTH_NOTE)).toBeVisible()
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(document.querySelector('input[type="password"], input[type="email"]')).toBeNull()
  })

  it("shows no message on a first visit", async () => {
    await openSignIn("?next=%2Fdashboard")

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it.each([
    ["cancelled", "?error=cancelled"],
    ["failed", "?error=failed&next=%2Fblocked"],
  ])("shows C-AUTH-1 when Google sign-in was %s", async (_case, query) => {
    await openSignIn(query)

    expect(screen.getByRole("alert")).toHaveTextContent(C_AUTH_1)
  })

  it("shows C-AUTH-3 with the refused account's email", async () => {
    await openSignIn("?error=account_refused&email=someone.else%40gmail.com&next=%2Fdashboard")

    const alert = screen.getByRole("alert")
    expect(within(alert).getByRole("heading", { name: C_AUTH_3_TITLE })).toBeVisible()
    expect(alert).toHaveTextContent(
      "You signed in as someone.else@gmail.com. This dashboard opens only for the Google account it was set up with. Choose that account and try again."
    )
  })

  it("shows the C-AUTH-3 variant without an address when no email is returned", async () => {
    await openSignIn("?error=account_refused")

    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(
      "This dashboard opens only for the Google account it was set up with. Choose that account and try again."
    )
    expect(alert).not.toHaveTextContent("You signed in as")
  })

  it("moves focus to the C-AUTH-3 heading and keeps the button available", async () => {
    const { button } = await openSignIn("?error=account_refused&email=someone.else%40gmail.com")

    expect(screen.getByRole("heading", { name: C_AUTH_3_TITLE })).toHaveFocus()
    expect(button).toBeEnabled()
  })

  it("shows C-AUTH-2 as a status after the session expired", async () => {
    await openSignIn("?next=%2Fblocked&reason=expired")

    expect(screen.getByRole("status")).toHaveTextContent(C_AUTH_2)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("prefers the backend's error over the expiry reason", async () => {
    await openSignIn("?reason=expired&error=cancelled")

    expect(screen.getByRole("alert")).toHaveTextContent(C_AUTH_1)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("ignores unknown error and reason values", async () => {
    await openSignIn("?error=teapot&reason=bored")

    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
})

describe("return to the requested page", () => {
  it("starts Google sign-in with next unchanged", async () => {
    const next = "/applications/R-1042?tab=documents#resume"
    const { button } = await openSignIn(`?next=${encodeURIComponent(next)}`)

    expect(submissionUrl(button)).toBe(
      `/v1/auth/google/start?next=${encodeURIComponent(next)}`
    )
  })

  it("starts Google sign-in with next after a refused account", async () => {
    const { button } = await openSignIn("?error=account_refused&email=a%40b.c&next=%2Fblocked")

    expect(submissionUrl(button)).toBe("/v1/auth/google/start?next=%2Fblocked")
  })

  it.each([
    ["missing", ""],
    ["another origin", "?next=https%3A%2F%2Fevil.example%2F"],
    ["protocol-relative", "?next=%2F%2Fevil.example"],
    ["an API path", "?next=%2Fv1%2Fsession"],
    ["the sign-in page", "?next=%2Fsign-in%3Fnext%3D%252Fblocked"],
  ])("returns to Home when next is %s", async (_case, query) => {
    const { button } = await openSignIn(query)

    expect(submissionUrl(button)).toBe("/v1/auth/google/start?next=%2Fdashboard")
  })

  it("shows the loading label while the browser opens Google", async () => {
    const user = userEvent.setup({ delay: null })
    const { button } = await openSignIn("?next=%2Fblocked")
    const form = button.closest("form")
    form?.addEventListener("submit", (event) => event.preventDefault())

    await user.click(button)

    const loading = screen.getByRole("button", { name: "Opening Google…" })
    expect(loading).toHaveAttribute("aria-busy", "true")
    expect(loading).toHaveAttribute("aria-disabled", "true")
  })
})
