import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  createControlsApi,
  readyApplication,
  server,
  submissionStatus,
} from "@/shared/testing"
import { findDialog } from "./career-setup-helpers"
import { openDiscovery } from "./discovery-helpers"
import { openDocuments } from "./documents-helpers"
import { openCheck, openHiring } from "./hiring-view-helpers"
import { openSubmission } from "./submission-helpers"

/**
 * The real dialogs, opened from their real screens rather than a harness: a
 * popup that renders the corner Close marks itself `data-has-close`, and its
 * title reserves the 40px the Close takes (`in-data-[has-close]:pe-10`). A
 * popup without the default Close reserves nothing — Verify alert source keeps
 * its own Close in the header row, and Confirm is an AlertDialog that never
 * had one — so no title hides its end under an absent button.
 */
function titleOf(dialog: HTMLElement): HTMLElement {
  const title = dialog.querySelector('[data-slot="dialog-title"], [data-slot="alert-dialog-title"]')
  expect(title).not.toBeNull()
  return title as HTMLElement
}

function expectCloseReserved(dialog: HTMLElement) {
  expect(dialog).toHaveAttribute("data-has-close", "")
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument()
  expect(titleOf(dialog)).toHaveClass("in-data-[has-close]:pe-10", "[overflow-wrap:anywhere]")
}

function expectNoReservation(dialog: HTMLElement) {
  // No corner Close, so the popup never sets the attribute the title's padding reads.
  expect(dialog).not.toHaveAttribute("data-has-close")
  // The title carries only the conditional class; nothing pads it unconditionally.
  expect(titleOf(dialog)).not.toHaveClass("pe-10")
}

describe("the default Close and the title's reserved end", () => {
  it("Add a job link: the popup renders Close, so the title reserves its width", async () => {
    const { user } = openDiscovery("/postings")

    await user.click(await screen.findByRole("button", { name: "Add a job link" }))

    expectCloseReserved(await screen.findByRole("dialog", { name: "Add a job link" }))
  })

  it("Check this job: the popup renders Close, so the title reserves its width", async () => {
    openHiring()

    expectCloseReserved(await openCheck())
  })

  it("Mark verified: the popup renders Close, so the title reserves its width", async () => {
    const { user } = openDiscovery("/sources")

    const row = await screen.findByRole("listitem", { name: "We Work Remotely" })
    await user.click(within(row).getByRole("button", { name: /Mark verified/ }))

    expectCloseReserved(await screen.findByRole("dialog", { name: "Mark verified: We Work Remotely" }))
  })

  it("Raise this month's ceiling: the popup renders Close, so the title reserves its width", async () => {
    const controlsApi = createControlsApi()
    const { user } = openSubmission("/pause-and-cost#cost", [], { status: submissionStatus() })
    server.use(...controlsApi.handlers)

    const section = await screen.findByRole("region", { name: "Monthly cost" })
    await user.click(await within(section).findByRole("button", { name: "Raise this month's ceiling" }))

    expectCloseReserved(await screen.findByRole("dialog", { name: "Raise this month's ceiling" }))
  })

  it("Outcome: the popup renders Close, so the title reserves its width", async () => {
    const app = readyApplication()
    const { user } = openDocuments(`/applications/${app.id}`, { applications: [app] })

    const outcomes = await screen.findByRole("region", { name: "Outcomes" })
    await user.click(await within(outcomes).findByRole("button", { name: "Record Outcome" }))

    expectCloseReserved(await screen.findByRole("dialog", { name: "Record Outcome" }))
  })

  it("Existing applications: the popup renders Close, so the title reserves its width", async () => {
    const { user } = openSubmission("/existing-applications", [], {
      status: submissionStatus(),
      existing: [],
    })

    await user.click(await screen.findByRole("button", { name: "Add existing application" }))

    expectCloseReserved(await screen.findByRole("dialog", { name: "Add existing application" }))
  })

  it("Verify alert source: no default Close, so the title reserves nothing while its header Close stays", async () => {
    const { user } = openHiring({ path: "/find-jobs?view=hiring#set-up-alerts" })

    await user.click(await screen.findByRole("button", { name: "I confirm" }))
    const dialog = await screen.findByRole("dialog", { name: "Confirm you may use these feeds" })

    expectNoReservation(dialog)
    // The header row's own Close is still there; only the corner one is absent.
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument()
  })

  it("Confirm: an AlertDialog never has a corner Close, so its title reserves nothing", async () => {
    const { user } = openDiscovery("/sources")

    await user.click(await screen.findByRole("button", { name: "Approve employer list" }))
    const dialog = await findDialog("Approve this employer list?")

    expectNoReservation(dialog)
    expect(dialog).not.toHaveAttribute("data-slot", "dialog-content")
    expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
  })
})
