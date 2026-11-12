import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, server } from "@/shared/testing"
import { CANDIDATE_CONTACT_PATH } from "@eve/contracts"
import { findToast } from "./career-setup-helpers"
import { openDocuments } from "./documents-helpers"

async function card() {
  return screen.findByRole("region", { name: "Contact details" })
}

function sidebarFooter() {
  return document.querySelector<HTMLElement>('[data-slot="sidebar-footer"]')
}

describe("Sidebar user name", () => {
  it("shows the contact details name instead of \"Candidate\"", async () => {
    openDocuments("/settings")

    await card()
    await waitFor(() => expect(within(sidebarFooter()!).getByText("Ada Okafor")).toBeVisible())
    expect(within(sidebarFooter()!).queryByText("Candidate")).not.toBeInTheDocument()
  })

  it("falls back to \"Candidate\" until a name is saved, then shows the saved name", async () => {
    const { user } = openDocuments("/settings", { contact: { fullName: "", lines: [] } })

    const region = await card()
    await waitFor(() => expect(within(sidebarFooter()!).getByText("Candidate")).toBeVisible())
    await user.type(within(region).getByLabelText("Full name (Required)"), "Ada Okafor")
    await user.click(within(region).getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(within(sidebarFooter()!).getByText("Ada Okafor")).toBeVisible())
  })
})

describe("Settings: contact details (C-SET-3 to C-SET-6)", () => {
  it("shows the heading, C-SET-4 help, the required name and one input per saved line", async () => {
    openDocuments("/settings")

    const region = await card()
    expect(
      within(region).getByText("These appear at the top of every resume and cover letter. Eve adds them after writing, so they're never sent to Anthropic.")
    ).toBeVisible()
    expect(within(region).getByLabelText("Full name (Required)")).toHaveValue("Ada Okafor")
    const lines = within(region).getByRole("group", { name: "Contact lines" })
    expect(within(lines).getByText("Up to 6 lines, such as your job title, city, email, phone and a profile link.")).toBeVisible()
    expect(within(lines).getByLabelText("Contact line 1")).toHaveValue("Lagos, Nigeria")
    expect(within(lines).getByLabelText("Contact line 2")).toHaveValue("ada@example.com")
    expect(within(lines).getByRole("button", { name: "Remove line 2" })).toBeVisible()
  })

  it("adds lines up to 6, then disables Add line", async () => {
    const { user } = openDocuments("/settings")

    const lines = within(await card()).getByRole("group", { name: "Contact lines" })
    await user.click(within(lines).getByRole("button", { name: "Add line" }))
    await waitFor(() => expect(within(lines).getByLabelText("Contact line 3")).toHaveFocus())
    await user.click(within(lines).getByRole("button", { name: "Add line" }))
    await user.click(within(lines).getByRole("button", { name: "Add line" }))
    await user.click(within(lines).getByRole("button", { name: "Add line" }))
    expect(within(lines).getByLabelText("Contact line 6")).toBeVisible()
    expect(within(lines).getByRole("button", { name: "Add line" })).toBeDisabled()
  })

  it("Remove line 1 removes that line only", async () => {
    const { user, api } = openDocuments("/settings")

    const region = await card()
    await user.click(within(region).getByRole("button", { name: "Remove line 1" }))
    expect(within(region).getByLabelText("Contact line 1")).toHaveValue("ada@example.com")
    expect(within(region).queryByLabelText("Contact line 2")).not.toBeInTheDocument()
    await user.click(within(region).getByRole("button", { name: "Save changes" }))

    expect(await findToast("Saved.")).toBeInTheDocument()
    expect(api.requests).toEqual([{ method: "PUT", path: CANDIDATE_CONTACT_PATH, body: { fullName: "Ada Okafor", lines: ["ada@example.com"] } }])
  })

  it("saves a trimmed name and drops blank lines", async () => {
    const { user, api } = openDocuments("/settings", { contact: { fullName: "", lines: [] } })

    const region = await card()
    expect(within(region).getByLabelText("Full name (Required)")).toHaveValue("")
    await user.type(within(region).getByLabelText("Full name (Required)"), "  Ada Okafor ")
    await user.click(within(region).getByRole("button", { name: "Add line" }))
    await user.type(within(region).getByLabelText("Contact line 1"), "Lagos, Nigeria")
    await user.click(within(region).getByRole("button", { name: "Add line" }))
    await user.click(within(region).getByRole("button", { name: "Save changes" }))

    expect(await findToast("Saved.")).toBeInTheDocument()
    expect(api.requests).toEqual([{ method: "PUT", path: CANDIDATE_CONTACT_PATH, body: { fullName: "Ada Okafor", lines: ["Lagos, Nigeria"] } }])
  })

  it("C-VAL-SET-3: requires a name and sends nothing without one", async () => {
    const { user, api } = openDocuments("/settings", { contact: { fullName: "", lines: [] } })

    const region = await card()
    await user.click(within(region).getByRole("button", { name: "Save changes" }))

    const name = within(region).getByLabelText("Full name (Required)")
    expect(within(region).getByText("Enter your name.")).toBeVisible()
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(name).toHaveAccessibleDescription("Enter your name.")
    expect(api.requests).toEqual([])
  })

  it("C-VAL-SET-4: refuses a 121-character name and a 121-character line, on the field that's too long", async () => {
    const { user, api } = openDocuments("/settings")

    const region = await card()
    const name = within(region).getByLabelText("Full name (Required)")
    await user.clear(name)
    await user.click(name)
    await user.paste("A".repeat(121))
    await user.click(within(region).getByRole("button", { name: "Save changes" }))
    expect(within(region).getByText("Use 120 characters or fewer for your name.")).toBeVisible()
    expect(name).toHaveFocus()

    await user.clear(name)
    await user.type(name, "Ada Okafor")
    const line2 = within(region).getByLabelText("Contact line 2")
    await user.clear(line2)
    await user.click(line2)
    await user.paste("b".repeat(121))
    await user.click(within(region).getByRole("button", { name: "Save changes" }))
    expect(line2).toHaveAccessibleDescription("Use 120 characters or fewer on each line.")
    expect(line2).toHaveFocus()
    expect(within(region).getByLabelText("Contact line 1")).not.toHaveAttribute("aria-invalid")
    expect(api.requests).toEqual([])
  })

  it("a failed save toasts C-ERR-2 and keeps the entries", async () => {
    const { user } = openDocuments("/settings")
    server.use(http.put(CANDIDATE_CONTACT_PATH, () => apiErrorResponse("internal_error")))

    const region = await card()
    const name = within(region).getByLabelText("Full name (Required)")
    await user.clear(name)
    await user.type(name, "Ada O.")
    await user.click(within(region).getByRole("button", { name: "Save changes" }))

    expect(await findToast("Couldn't save your contact details. Nothing changed. Try again.")).toBeInTheDocument()
    expect(name).toHaveValue("Ada O.")
  })
})
