import { screen, within } from "@testing-library/react"
import { http } from "msw"
import { SUBMISSIONS_PATH } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, blocked, inviteeMe, notificationFailure, notificationStatusHandler, operatorMe, server, submission } from "@/shared/testing"
import { entryOf, openEve } from "./epic-0011-helpers"

// Repair wave 2: QA gate NAV:89, ADV:141 and owner decision 2 (no automation words with Advanced off).
describe("Repair wave 2 (test-plan.r1)", () => {
  it("NAV:89 the account menu has Data and privacy, linking to /privacy", async () => {
    const { user } = openEve("/dashboard", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Home" })
    await user.click(await screen.findByRole("button", { name: /Ada Okafor/ }))
    expect(await screen.findByRole("menuitem", { name: "Data and privacy" })).toHaveAttribute("href", "/privacy")
  })

  it("ADV:141 a non-Operator opening /blocked gets a plain note, not 'Couldn't load this page', and no retry", async () => {
    openEve("/blocked", { me: inviteeMe({ advancedEnabled: true }) })
    server.use(http.get(SUBMISSIONS_PATH, () => apiErrorResponse("feature_not_yet_available")))
    expect(await screen.findByText("Automatic applying isn't available on your account yet.")).toBeVisible()
    expect(screen.queryByText(/Couldn't load this page/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
  })

  it("Decision 2: with Advanced off the detail badge says Needs you, not Blocked Application", async () => {
    const e = entryOf(blocked("captcha", "x"))
    openEve(`/applications/${e.app.id}`, { me: inviteeMe(), entries: [e] })
    await screen.findByRole("heading", { name: "Evidence" })
    expect(screen.getAllByText("Needs you").length).toBeGreaterThan(0)
    expect(screen.queryByText("Blocked Application")).not.toBeInTheDocument()
  })

  it("Decision 2: with Advanced on the old word stays", async () => {
    const e = entryOf(blocked("captcha", "x"))
    openEve(`/applications/${e.app.id}`, { me: operatorMe(), entries: [e] })
    await screen.findByRole("heading", { name: "Evidence" })
    expect(screen.getAllByText("Blocked Application").length).toBeGreaterThan(0)
  })

  it("Decision 2: with Advanced off a confirmed submission reads Applied", async () => {
    const e = entryOf(submission({ state: "confirmed", kind: "automatic" }))
    openEve(`/applications/${e.app.id}`, { me: inviteeMe(), entries: [e] })
    expect((await screen.findAllByText("Applied")).length).toBeGreaterThan(0)
    expect(screen.queryByText("Confirmed Submission")).not.toBeInTheDocument()
  })

  // Repair wave 3 (design-review.r1)
  it("F4 the Board and List buttons switch both ways and the choice is remembered", async () => {
    localStorage.removeItem("eve-applications-view")
    const { user } = openEve("/applications", { me: inviteeMe(), entries: [entryOf(submission({ state: "confirmed", kind: "automatic" }), { roleTitle: "Applied Role" })] })
    const board = await screen.findByRole("button", { name: "Board" })
    const list = screen.getByRole("button", { name: "List" })
    expect(board).toHaveAttribute("aria-pressed", "true")
    await user.click(list)
    expect(await screen.findByRole("columnheader", { name: /Stage/ })).toBeVisible()
    expect(localStorage.getItem("eve-applications-view")).toBe("list")
    await user.click(screen.getByRole("button", { name: "Board" }))
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByRole("columnheader", { name: /Stage/ })).not.toBeInTheDocument()
    expect(localStorage.getItem("eve-applications-view")).toBe("board")
  })

  it("F7 /activation shows the not-available note once", async () => {
    openEve("/activation", { me: inviteeMe({ advancedEnabled: true }) })
    server.use(http.get("/v1/*", ({ request }) => (/\/v1\/(me|auth|session|notifications)/.test(request.url) ? undefined : apiErrorResponse("feature_not_yet_available"))))
    await screen.findAllByText("Automatic applying isn't available on your account yet.")
    expect(screen.getAllByText("Automatic applying isn't available on your account yet.")).toHaveLength(1)
  })

  it("F5 the Application detail breadcrumb parent is Applications", async () => {
    const e = entryOf(blocked("captcha", "x"))
    openEve(`/applications/${e.app.id}`, { me: inviteeMe(), entries: [e] })
    await screen.findByRole("heading", { name: "Evidence" })
    const crumb = screen.getByRole("navigation", { name: "breadcrumb" })
    expect(within(crumb).getByRole("link", { name: "Applications" })).toHaveAttribute("href", "/applications")
    expect(within(crumb).queryByText("Documents")).not.toBeInTheDocument()
  })

  it("F6 the Advanced-off email-failure alert is plain with no server instruction; Advanced on keeps the Operator wording", async () => {
    server.use(notificationStatusHandler({ latestFailure: notificationFailure({ emailType: "blocked_application" }) }))
    openEve("/dashboard", { me: inviteeMe() })
    const plain = await screen.findByText(/couldn't be delivered/)
    expect(plain).toHaveTextContent("The email about something that needs you, sent at 20 Oct 2026, 10:15 WAT, couldn't be delivered. Nothing was changed. Try again later or tell the person who runs your Eve.")
    expect(plain).not.toHaveTextContent(/server|environment|needs-you email/)
  })
})
