import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { operatorMe, submissionStatus } from "@/shared/testing"
import { openEve } from "./epic-0011-helpers"

// CR-01 (advanced-switch.r1.feature ADV:101): enabling automatic submission must refresh the
// cached `/v1/me` viewer, or the Advanced switch stays unlocked for up to five minutes.
describe("CR-01: the Advanced lock refreshes in the same session", () => {
  it("ADV:101 turning on automatic submission locks the Advanced switch without a reload", async () => {
    const { user, meApi } = openEve("/pause-and-cost", {
      me: operatorMe({ advancedEnabled: false }),
      status: submissionStatus({ gatePassedAt: "2026-10-19T09:00:00.000Z" }),
    })
    // Advanced is off, so the switch is off and unlocked before the change.
    expect(await screen.findByText("This is part of Advanced: automatic applying.")).toBeVisible()

    await user.click(await screen.findByRole("button", { name: "Turn on automatic submission" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Turn on automatic submission?" })
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }))
    expect(await screen.findByText("Automatic submission is on")).toBeVisible()

    // Same session, no reload: open Settings and read the switch.
    await user.click(screen.getByRole("link", { name: "Settings" }))
    const toggle = await screen.findByRole("switch", { name: "Show automatic applying" })
    await waitFor(() => expect(toggle).toBeChecked(), { timeout: 2000 })
    expect(toggle).toHaveAttribute("aria-disabled", "true")
    expect(toggle).toHaveAccessibleDescription(/Automatic applying is on\. Turn it off first/)
    expect(screen.getByRole("link", { name: "Go to automatic applying" })).toHaveAttribute("href", "/pause-and-cost#automatic")
    expect(meApi.state.me).toMatchObject({ advancedEnabled: true, advancedLocked: true })
  })
})
