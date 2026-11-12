import { screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { blocked, submission, uncertain } from "@/shared/testing"
import { entry, openSubmission } from "./submission-helpers"

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:http://localhost/1")
  URL.revokeObjectURL = vi.fn()
})

const evidence = async () => (await screen.findByRole("heading", { name: "Evidence" })).closest('[data-slot="card"]') as HTMLElement

describe("Application detail: submission states (slice 5)", () => {
  it("a Confirmed Submission shows its badge, how it was sent, submitted time and the evidence", async () => {
    const app = entry(
      submission({
        state: "confirmed",
        kind: "automatic",
        attemptNumber: 1,
        submittedAt: "2026-10-20T09:15:00.000Z",
        submittedWatDay: "2026-10-20",
        evidence: { kind: "application_id", text: "LV-48213", observedAt: "2026-10-20T09:16:00.000Z" },
      }),
      { coverLetterStatus: "uploaded" }
    )
    const { user } = openSubmission(`/applications/${app.app.id}`, [app])

    const card = await evidence()
    expect(screen.getAllByText("Confirmed Submission")[0]).toBeVisible()
    expect(screen.getByText("Automatic")).toBeVisible()
    expect(screen.getByText("20 Oct 2026, 10:15 WAT")).toBeVisible()
    expect(card).toHaveTextContent("Application ID")
    expect(card).toHaveTextContent("LV-48213")
    expect(card).toHaveTextContent("Observed 20 Oct 2026, 10:16 WAT")
    await user.click(screen.getByRole("tab", { name: "Cover letter" }))
    expect(await screen.findByText("Uploaded with the Application.")).toBeVisible()
  })

  it("marked confirmed reads 'Marked confirmed by you'; a sample is 'Approved sample'", async () => {
    const app = entry(
      submission({
        state: "confirmed",
        kind: "sample",
        submittedAt: "2026-10-20T09:15:00.000Z",
        evidence: { kind: "marked_confirmed", text: null, observedAt: "2026-10-21T09:00:00.000Z" },
        sample: { state: "approved", rejectReason: null, counts: true },
      })
    )
    openSubmission(`/applications/${app.app.id}`, [app])
    expect(await evidence()).toHaveTextContent("Marked confirmed by you")
    expect(screen.getByText("Approved sample")).toBeVisible()
  })

  it("an Uncertain Submission shows C-UNC-5 with the CAPTCHA badge and a link to resolve it", async () => {
    const app = entry(uncertain({ captchaAfterSubmit: true }))
    openSubmission(`/applications/${app.app.id}`, [app])
    const card = await evidence()
    expect(within(card).getByText("CAPTCHA after submit")).toBeVisible()
    expect(card).toHaveTextContent("then a CAPTCHA appeared")
    expect(within(card).getByRole("link", { name: "Open Uncertain Submissions" })).toHaveAttribute("href", "/uncertain")
  })

  it("a Blocked Application shows the reason and its detail line", async () => {
    const app = entry(blocked("login", "The form needs you to sign in to an account. The assistant doesn't sign in or create accounts."))
    openSubmission(`/applications/${app.app.id}`, [app])
    const card = await evidence()
    expect(card).toHaveTextContent("Login")
    expect(card).toHaveTextContent("The form needs you to sign in to an account.")
    expect(screen.getAllByText("Blocked Application")[0]).toBeVisible()
  })

  it("queued again: badge and C-UNC-6 with the marked date", async () => {
    const app = entry(submission({ state: "queued", kind: "automatic", attemptNumber: 1, markedNotSubmittedAt: "2026-10-19T11:00:00.000Z" }), { updatedAt: "2026-10-20T11:00:00.000Z" })
    openSubmission(`/applications/${app.app.id}`, [app])
    expect(await screen.findByText("Queued again")).toBeVisible()
    expect(
      screen.getByText(
        "You marked this not submitted on 19 Oct 2026. It's back in the automatic queue for one more attempt, under the usual cap, duplicate, same-company, closed-posting and pause rules."
      )
    ).toBeVisible()
  })

  it("queued, first attempt: badge and line C-QUEUE-1", async () => {
    const app = entry(submission({ state: "queued", kind: "automatic", attemptNumber: 0 }))
    openSubmission(`/applications/${app.app.id}`, [app])
    expect(await screen.findByText("Queued")).toBeVisible()
    expect(
      screen.getByText("Waiting in today's automatic queue. The assistant sends it under the daily cap, duplicate, same-company, closed-posting and pause rules.")
    ).toBeVisible()
  })

  it("queued for tomorrow: badge and C-CAP-3", async () => {
    const app = entry(submission({ state: "queued", kind: "automatic", queuedForWatDay: "2026-10-21" }))
    openSubmission(`/applications/${app.app.id}`, [app])
    expect(await screen.findByText("Queued for tomorrow")).toBeVisible()
    expect(
      screen.getByText("Today's 5 automatic submissions are used. This goes into tomorrow's queue and is ranked again with tomorrow's new Job Postings.")
    ).toBeVisible()
  })

  it.each([
    ["automatic", "Not submitted. The assistant won't try this one again. You can still apply on the employer site yourself."],
    [
      "sample",
      "You marked this sample not submitted on 19 Oct 2026. It doesn't count toward the 5, and the assistant won't send it again on its own. You can still apply on the employer site yourself.",
    ],
  ] as const)("not submitted (%s) shows its final line", async (kind, line) => {
    const app = entry(submission({ state: "not_submitted", kind, attemptNumber: 2, markedNotSubmittedAt: "2026-10-19T11:00:00.000Z" }), { updatedAt: "2026-10-20T11:00:00.000Z" })
    openSubmission(`/applications/${app.app.id}`, [app])
    expect(await screen.findByText(line)).toBeVisible()
    expect(screen.getByText("Not submitted")).toBeVisible()
  })

  it("declined at same-company review: C-BLOCK-13 with the stored reason as plain text", async () => {
    const app = entry(submission({ state: "declined", kind: "automatic", declinedReason: "Already in process with <b>Northwind</b> Health", declinedAt: "2026-10-19T11:00:00.000Z" }), {
      updatedAt: "2026-10-20T11:00:00.000Z",
    })
    openSubmission(`/applications/${app.app.id}`, [app])
    expect(await screen.findByText("You declined this at same-company review on 19 Oct 2026.")).toBeVisible()
    expect(screen.getByText("Your reason:")).toBeVisible()
    expect(screen.getByText("Already in process with <b>Northwind</b> Health")).toBeVisible()
    expect(screen.getByText("Declined")).toBeVisible()
  })

  it("before submission nothing new shows: no Evidence card", async () => {
    const app = entry(submission())
    openSubmission(`/applications/${app.app.id}`, [app])
    expect(await screen.findByText("Draft")).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Evidence" })).not.toBeInTheDocument()
  })
})
