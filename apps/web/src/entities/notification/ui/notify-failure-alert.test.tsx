import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import type { NotificationFailure } from "../model/notification"
import { NotifyFailureAlert } from "./notify-failure-alert"

const renderAlert = (failure: NotificationFailure) =>
  render(
    <MemoryRouter>
      <NotifyFailureAlert failure={failure} />
    </MemoryRouter>
  )

describe("NotifyFailureAlert (C-NOTIFY-1)", () => {
  it.each([
    ["confirmed_submission", "Confirmed Submission"],
    ["blocked_application", "Blocked Application"],
    ["daily_summary", "daily summary"],
  ] as const)("names the %s email and its WAT time", (emailType, label) => {
    renderAlert({ failedAt: "2026-10-20T20:05:00.000Z", emailType, targetPath: "/dashboard" })
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("An email didn't send")
    expect(alert).toHaveTextContent(
      `The ${label} email from 20 Oct 2026, 21:05 WAT couldn't be sent from your Gmail account. Nothing was resubmitted or changed. If this keeps happening, check the Gmail app password in the server's environment.`
    )
  })

  it("is announced as an alert, not passive status, because a failed send needs noticing", () => {
    renderAlert({ failedAt: "2026-10-20T20:05:00.000Z", emailType: "daily_summary", targetPath: "/dashboard" })
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("'See what wasn't sent' opens what the email was about", () => {
    renderAlert({ failedAt: "2026-10-20T09:15:00.000Z", emailType: "blocked_application", targetPath: "/applications/abc" })
    expect(screen.getByRole("link", { name: "See what wasn't sent" })).toHaveAttribute("href", "/applications/abc")
  })
})
