import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { findToast } from "./career-setup-helpers"
import { openDocuments } from "./documents-helpers"

async function form() {
  const heading = await screen.findByRole("heading", { name: "ATS minimum" })
  return heading.closest("section")!
}

describe("Settings: ATS minimum", () => {
  it("shows the saved minimum and saves a new one", async () => {
    const { user, api } = openDocuments("/settings", { atsMinimum: 40 })
    const section = await form()
    const input = within(section).getByLabelText("Minimum ATS match (%)")
    expect(input).toHaveValue("40")
    await user.clear(input)
    await user.type(input, "55")
    await user.click(within(section).getByRole("button", { name: "Save" }))
    expect(await findToast("Saved.")).toBeVisible()
    expect(api.state.atsMinimum).toBe(55)
  })

  it("refuses a value outside 0 to 100 without saving", async () => {
    const { user, api } = openDocuments("/settings", { atsMinimum: 40 })
    const section = await form()
    const input = within(section).getByLabelText("Minimum ATS match (%)")
    await user.clear(input)
    await user.type(input, "150")
    await user.click(within(section).getByRole("button", { name: "Save" }))
    expect(await within(section).findByText("Enter a whole number from 0 to 100.")).toBeVisible()
    expect(api.state.atsMinimum).toBe(40)
  })
})
