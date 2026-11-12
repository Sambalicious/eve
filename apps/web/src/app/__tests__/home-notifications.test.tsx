import { NOTIFICATION_STATUS_PATH } from "@eve/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, notificationFailure, notificationStatusHandler, server, submissionStatus } from "@/shared/testing"
import { openSubmission } from "./submission-helpers"

const APP_ID = "0b6f7a52-3c1d-4f4e-9a8b-2c6d1e0f9a11"
const TITLE = "An email didn't send"

const statusCard = async () => (await screen.findByRole("heading", { name: "Automatic submission is off" })).closest('[data-slot="card"]') as HTMLElement

describe("Home: notification send failure (C-NOTIFY-1, design F7.6)", () => {
  it("the latest failed Blocked Application email shows C-NOTIFY-1 under the Automation status card, linking to that Application", async () => {
    server.use(notificationStatusHandler({ latestFailure: notificationFailure({ emailType: "blocked_application", applicationId: APP_ID }) }))
    const { user, currentPath } = openSubmission("/dashboard", [], { status: submissionStatus() })
    const alert = (await screen.findByText(TITLE)).closest('[role="alert"]') as HTMLElement
    expect(alert).toHaveTextContent("The Blocked Application email from 20 Oct 2026, 10:15 WAT couldn't be sent from your Gmail account. Nothing was resubmitted or changed.")
    // Under the Automation status card, in document order.
    const card = await statusCard()
    expect(card.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // A past event: it never takes focus.
    expect(alert).not.toContainElement(document.activeElement as HTMLElement)
    await user.click(within(alert).getByRole("link", { name: "See what wasn't sent" }))
    await waitFor(() => expect(currentPath()).toBe(`/applications/${APP_ID}`))
  })

  it("a failed daily summary links to Home", async () => {
    server.use(notificationStatusHandler({ latestFailure: notificationFailure({ emailType: "daily_summary", applicationId: null, watDay: "2026-10-20" }) }))
    openSubmission("/dashboard")
    const alert = (await screen.findByText(TITLE)).closest('[role="alert"]') as HTMLElement
    expect(alert).toHaveTextContent("The daily summary email from")
    expect(within(alert).getByRole("link", { name: "See what wasn't sent" })).toHaveAttribute("href", "/dashboard")
  })

  it("a failed cost-pause email shows C-NOTIFY-1 with 'cost pause', linking to /settings#cost", async () => {
    server.use(notificationStatusHandler({ costPauseEmailFailedAt: "2026-10-25T11:00:00.000Z" }))
    openSubmission("/dashboard")
    const alert = (await screen.findByText(TITLE)).closest('[role="alert"]') as HTMLElement
    expect(alert).toHaveTextContent("The cost pause email from 25 Oct 2026, 12:00 WAT couldn't be sent from your Gmail account. Nothing was resubmitted or changed.")
    expect(within(alert).getByRole("link", { name: "See what wasn't sent" })).toHaveAttribute("href", "/settings#cost")
  })

  it("no failure (or a later email sent): no alert", async () => {
    server.use(notificationStatusHandler({ latestFailure: null, pendingCount: 3 }))
    openSubmission("/dashboard")
    await statusCard()
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it("a status read that fails hides the alert and leaves the rest of Home working", async () => {
    server.use(http.get(NOTIFICATION_STATUS_PATH, () => apiErrorResponse("internal_error")))
    openSubmission("/dashboard")
    expect(await screen.findByRole("heading", { name: "Today's cap" })).toBeVisible()
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })
})

describe("Home: unsent access requests (EPIC-0003 request-access.feature, AC 11.16, OQ7)", () => {
  const WAITING = "Access requests are waiting"
  const FAILED = "Access request emails didn't send"

  it("with the mailer unconfigured and 2 waiting, shows the waiting alert with the count under the status card", async () => {
    server.use(notificationStatusHandler({ senderConfigured: false, accessRequests: { waiting: 2, failed: 0 } }))
    openSubmission("/dashboard", [], { status: submissionStatus() })
    const alert = (await screen.findByText(WAITING)).closest('[role="status"]') as HTMLElement
    expect(alert).toHaveTextContent("2 access requests are waiting because email isn't set up.")
    const card = await statusCard()
    expect(card.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("a request email that failed every attempt raises the failed alert with the count 1", async () => {
    server.use(notificationStatusHandler({ senderConfigured: true, accessRequests: { waiting: 0, failed: 1 } }))
    openSubmission("/dashboard")
    const alert = (await screen.findByText(FAILED)).closest('[role="status"]') as HTMLElement
    expect(alert).toHaveTextContent("1 access request couldn't be emailed to you from your Gmail account.")
  })

  it("clears once nothing is waiting or failed, and stays hidden when the API omits the field", async () => {
    server.use(notificationStatusHandler({ senderConfigured: true, accessRequests: { waiting: 0, failed: 0 } }))
    openSubmission("/dashboard")
    await statusCard()
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument()
  })

  it("an API without accessRequests shows no access-request alert", async () => {
    server.use(notificationStatusHandler({ senderConfigured: false }))
    openSubmission("/dashboard")
    await statusCard()
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument()
  })
})
