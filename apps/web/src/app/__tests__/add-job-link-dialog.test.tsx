import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { JOB_POSTING_LINKS_PATH } from "@eve/contracts"
import { apiErrorResponse, inviteeMe, rankedPosting, server } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openDiscovery } from "./discovery-helpers"
import { openEve } from "./epic-0011-helpers"

/**
 * Add a job link on `/postings` (EPIC-0011): the form opens in a dialog from one
 * outline button. Home keeps its own paste box and never shows this trigger.
 */
type User = ReturnType<typeof openDiscovery>["user"]

const LINK_ACCEPTED =
  "Checking the link. It goes through the same Eligibility, Match, duplicate and cap rules as discovered postings."
const LINK_EMPTY = "Paste a job link."
const LINK_INVALID = "Enter a full link that starts with https:// or http://."
const FAILED = "Couldn't check the link. Nothing changed. Try again."
const FAILED_JOB = "Couldn't check the job. Nothing changed. Try again."
const HELP = "Paste a link to a job. Eve checks how well it fits your profile."
const URL = "https://jobs.lever.co/globex/abc-123"
const DESCRIPTION = `Senior Frontend Engineer\n\n${"Build merchant dashboards in React and TypeScript. ".repeat(6)}`

function trigger() {
  return screen.getByRole("button", { name: "Add a job link" })
}

/** Opens the dialog from its trigger unless it is already open. */
async function openAddJobLink(user: User) {
  const existing = screen.queryByRole("dialog", { name: "Add a job link" })
  if (existing) return existing
  await user.click(await screen.findByRole("button", { name: "Add a job link" }))
  return await screen.findByRole("dialog", { name: "Add a job link" })
}

/** Types a link into the dialog's field and submits with "Check link". */
async function check(user: User, dialog: HTMLElement, url: string) {
  await user.type(within(dialog).getByLabelText("Job link"), url)
  await user.click(within(dialog).getByRole("button", { name: "Check link" }))
}

function toasts() {
  return screen.getByRole("region", { name: "Messages" })
}

/** Opens the description panel and fills the description, title and company. */
async function fillDescription(user: User, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole("button", { name: "Add the job description" }))
  const description = within(dialog).getByRole("textbox", { name: /^Job description/ })
  await user.click(description)
  await user.paste(DESCRIPTION)
  await user.type(within(dialog).getByRole("textbox", { name: "Job title" }), "Senior Frontend Engineer")
  await user.type(within(dialog).getByRole("textbox", { name: "Company" }), "Globex")
  return description
}

/** True when `first` comes before `second` in document order. */
function precedes(first: HTMLElement, second: HTMLElement) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe("Add a job link dialog (EPIC-0011)", () => {
  it("shows one outline trigger and no form until it opens", async () => {
    openDiscovery("/postings")

    expect(await screen.findByRole("button", { name: "Add a job link" })).toBeVisible()
    expect(screen.queryByRole("region", { name: "Add a job link" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Job link")).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog", { name: "Add a job link" })).not.toBeInTheDocument()
  })

  it("opens a dialog named Add a job link with the link field focused", async () => {
    const { user } = openDiscovery("/postings")
    const dialog = await openAddJobLink(user)

    expect(within(dialog).getByRole("heading", { name: "Add a job link" })).toBeVisible()
    const field = within(dialog).getByLabelText("Job link")
    expect(field).toHaveFocus()
    expect(field).toHaveAccessibleDescription(HELP)
  })

  it("renders the help once, as the dialog description, with no duplicate line in the form", async () => {
    const { user } = openDiscovery("/postings")
    const dialog = await openAddJobLink(user)

    const help = within(dialog).getAllByText(HELP)
    expect(help).toHaveLength(1)
    expect(help[0]).toHaveAttribute("data-slot", "dialog-description")
    // Directly above the form's field, not repeated below it.
    expect(precedes(help[0], within(dialog).getByLabelText("Job link"))).toBe(true)
  })

  it("caps the popup at the viewport height and scrolls the body, with the description panel open too", async () => {
    const { user } = openDiscovery("/postings")
    const dialog = await openAddJobLink(user)

    const popup = document.querySelector('[data-slot="dialog-content"]') as HTMLElement
    expect(popup.className).toContain("max-h-[calc(100dvh-2rem)]")
    expect(popup.className).toContain("overflow-hidden")
    expect(popup.className).toContain("flex-col")

    const body = dialog.querySelector('[data-slot="add-job-link-body"]') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.className).toContain("min-h-0")
    expect(body.className).toContain("flex-1")
    expect(body.className).toContain("overflow-y-auto")
    expect(body.className).toContain("overscroll-contain")
    // Pinned header, hairline under it, and the body still the only scroller. `pb-3`
    // keeps the rule off the title so it reads as a divider, not an underline.
    const header = dialog.querySelector('[data-slot="dialog-header"]') as HTMLElement
    expect(header).toHaveClass("flex-none", "border-b", "border-border", "pb-3")
    expect(body.className).toContain("-mx-6")
    expect(body.className).toContain("px-6")
    expect(popup.className).not.toContain("overflow-y-auto")
    // The title stays outside the scrolling body; the link field and panel are inside it.
    expect(body.contains(within(dialog).getByRole("heading", { name: "Add a job link" }))).toBe(false)
    expect(body.contains(within(dialog).getByLabelText("Job link"))).toBe(true)

    await user.click(within(dialog).getByRole("button", { name: "Add the job description" }))
    expect(body.contains(within(dialog).getByRole("textbox", { name: /^Job description/ }))).toBe(true)
    expect(body.className).toContain("overflow-y-auto")

    // The panel's textarea is capped against the visible viewport, not the full one.
    const textarea = within(dialog).getByRole("textbox", { name: /^Job description/ })
    expect(textarea).toHaveClass("max-h-[50dvh]", "min-h-40", "overflow-y-auto")
    expect(textarea).not.toHaveClass("max-h-[50vh]")
  })

  it("closes on Escape and returns focus to the trigger", async () => {
    const { user } = openDiscovery("/postings")
    await openAddJobLink(user)

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a job link" })).not.toBeInTheDocument())
    expect(trigger()).toHaveFocus()
  })

  it("closes on an overlay click and returns focus to the trigger", async () => {
    const { user } = openDiscovery("/postings")
    await openAddJobLink(user)

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).not.toBeNull()
    await user.click(overlay as HTMLElement)

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a job link" })).not.toBeInTheDocument())
    expect(trigger()).toHaveFocus()
  })

  it("closes on Close and returns focus to the trigger", async () => {
    const { user } = openDiscovery("/postings")
    const dialog = await openAddJobLink(user)

    await user.click(within(dialog).getByRole("button", { name: "Close" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a job link" })).not.toBeInTheDocument())
    expect(trigger()).toHaveFocus()
  })

  it("keeps Tab inside the dialog and cycles back to the link field", async () => {
    const { user } = openDiscovery("/postings")
    const dialog = await openAddJobLink(user)
    const field = within(dialog).getByLabelText("Job link")

    expect(field).toHaveFocus()
    // The dialog's tabbables, in order: the link field, Check link, the description
    // toggle, then Close (the last child of the popup).
    await user.tab()
    expect(within(dialog).getByRole("button", { name: "Check link" })).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole("button", { name: "Add the job description" })).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus()
    // One more Tab reaches the trap's guard, which sends focus back to the first tabbable.
    await user.tab()
    await waitFor(() => expect(field).toHaveFocus())
    // And the other direction: the guard before the field sends focus to Close.
    await user.tab({ shift: true })
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus())
  })

  it.each([
    ["", LINK_EMPTY],
    ["not a url", LINK_INVALID],
  ])("refuses %j inline: the dialog stays open, the field is marked and focused, and nothing is sent", async (input, error) => {
    const { user, api } = openDiscovery("/postings")
    const dialog = await openAddJobLink(user)
    const field = within(dialog).getByLabelText("Job link")
    if (input) await user.type(field, input)
    await user.click(within(dialog).getByRole("button", { name: "Check link" }))

    expect(await within(dialog).findByText(error)).toBeVisible()
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(field).toHaveAccessibleDescription(expect.stringContaining(error))
    expect(field).toHaveFocus()
    expect(dialog).toBeVisible()
    expect(api.requests).toEqual([])
  })

  it("a visible posting closes the dialog, toasts C-LINK-1 and lists it as Checking on All", async () => {
    const { user, api } = openDiscovery("/postings?tab=all")
    const dialog = await openAddJobLink(user)

    await check(user, dialog, URL)

    expect(await findToast(LINK_ACCEPTED)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a job link" })).not.toBeInTheDocument())
    expect(trigger()).toHaveFocus()
    expect(api.requests).toEqual([{ method: "POST", path: JOB_POSTING_LINKS_PATH, body: { url: URL } }])
    const table = await screen.findByRole("region", { name: "Job Postings, scrolls horizontally" })
    expect(await within(table).findByText("Checking")).toBeVisible()
    expect(within(table).getByText(URL)).toBeVisible()

    // Closing on save releases the pending guard: the next dialog closes at once.
    const reopened = await openAddJobLink(user)
    expect(within(reopened).getByLabelText("Job link")).toHaveValue("")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a job link" })).not.toBeInTheDocument())
  })

  it("a hidden posting stays open with the B7 status line, View it and no toast; reopening is empty", async () => {
    const { user, api } = openDiscovery("/postings", {
      nextPasted: (url) => rankedPosting({ applicationUrl: url, applyUrl: url, status: "not_checked", rank: null, hiddenReason: "undated" }),
    })
    const dialog = await openAddJobLink(user)

    await check(user, dialog, URL)

    const line = await within(dialog).findByText("Saved, but hidden: no posted date.", { exact: false })
    expect(line).toHaveAttribute("role", "status")
    expect(dialog).toBeVisible()
    const created = api.state.postings[0]!
    expect(within(line).getByRole("link", { name: "View it" })).toHaveAttribute("href", `/postings/${created.id}`)
    expect(within(toasts()).queryByText(LINK_ACCEPTED)).not.toBeInTheDocument()
    // The line sits under the input group, above the description toggle.
    expect(precedes(line, within(dialog).getByRole("button", { name: "Add the job description" }))).toBe(true)

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a job link" })).not.toBeInTheDocument())
    const reopened = await openAddJobLink(user)
    expect(within(reopened).getByLabelText("Job link")).toHaveValue("")
    expect(within(reopened).queryByText(/Saved, but hidden/)).not.toBeInTheDocument()
  })

  it("an already stored link shows C-LINK-2 with View it and keeps the dialog open", async () => {
    const stored = rankedPosting({ applicationUrl: URL, title: "Product Engineer", company: "Globex" })
    const { user, api } = openDiscovery("/postings", { postings: [stored] })
    const dialog = await openAddJobLink(user)

    await check(user, dialog, URL)

    expect(await within(dialog).findByText(/You already have this Job Posting\./)).toBeVisible()
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole("link", { name: "View it" })).toHaveAttribute("href", `/postings/${stored.id}`)
    expect(api.state.postings).toHaveLength(1)
  })

  it("a description result line sits under the input group, above the toggle, and clears the values", async () => {
    const { user, api } = openDiscovery("/postings")
    const dialog = await openAddJobLink(user)

    await fillDescription(user, dialog)
    await user.click(within(dialog).getByRole("button", { name: "Check this job" }))

    const line = (await within(dialog).findByText("Saved from your description. Eve is checking it.")).closest("p")!
    expect(line).toHaveAttribute("role", "status")
    const toggle = within(dialog).getByRole("button", { name: "Add the job description" })
    expect(precedes(line, toggle)).toBe(true)
    expect(within(dialog).queryByRole("textbox", { name: /^Job description/ })).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText("Job link")).toHaveValue("")
    expect(api.state.postings[0]!.origin).toBe("pasted_description")
  })

  it("a description paste that fails shows C-PD-26 inline, keeps the values and the dialog open, and sends no toast", async () => {
    const { user } = openDiscovery("/postings")
    server.use(http.post(JOB_POSTING_LINKS_PATH, () => apiErrorResponse("internal_error")))
    const dialog = await openAddJobLink(user)
    const description = await fillDescription(user, dialog)

    await user.click(within(dialog).getByRole("button", { name: "Check this job" }))

    const alert = await within(dialog).findByRole("alert")
    expect(alert).toHaveTextContent(FAILED_JOB)
    expect(dialog).toBeVisible()
    expect(description).toHaveValue(DESCRIPTION)
    expect(within(dialog).getByRole("textbox", { name: "Job title" })).toHaveValue("Senior Frontend Engineer")
    expect(within(dialog).getByRole("textbox", { name: "Company" })).toHaveValue("Globex")
    expect(within(toasts()).queryByText(FAILED_JOB)).not.toBeInTheDocument()
  })

  it("a job_link_invalid refusal from the server shows inline and keeps the dialog open", async () => {
    const { user } = openDiscovery("/postings")
    server.use(http.post(JOB_POSTING_LINKS_PATH, () => apiErrorResponse("job_link_invalid")))
    const dialog = await openAddJobLink(user)

    await check(user, dialog, "https://localhost")

    expect(await within(dialog).findByText(LINK_INVALID)).toBeVisible()
    expect(within(dialog).getByLabelText("Job link")).toHaveAttribute("aria-invalid", "true")
    expect(dialog).toBeVisible()
  })

  it("a failed request shows C-ERR-2 as an alert, keeps the value and focus, and sends no toast; the next submit clears it", async () => {
    const { user } = openDiscovery("/postings")
    let attempts = 0
    server.use(
      http.post(JOB_POSTING_LINKS_PATH, () => {
        attempts += 1
        return attempts === 1 ? apiErrorResponse("internal_error") : undefined
      })
    )
    const dialog = await openAddJobLink(user)
    const field = within(dialog).getByLabelText("Job link")
    await check(user, dialog, URL)

    const alert = await within(dialog).findByRole("alert")
    expect(alert).toHaveTextContent(FAILED)
    expect(field).toHaveValue(URL)
    expect(field).toHaveFocus()
    expect(field).toHaveAccessibleDescription(expect.stringContaining(FAILED))
    expect(dialog).toBeVisible()
    expect(within(toasts()).queryByText(FAILED)).not.toBeInTheDocument()

    // The alert goes on the next submit; this time the request succeeds and closes the dialog.
    await user.click(within(dialog).getByRole("button", { name: "Check link" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a job link" })).not.toBeInTheDocument())
    expect(await findToast(LINK_ACCEPTED)).toBeInTheDocument()
  })

  it("a request in flight keeps the dialog open: Escape does nothing and Close is disabled until it settles", async () => {
    const { user } = openDiscovery("/postings")
    server.use(http.post(JOB_POSTING_LINKS_PATH, () => new Promise(() => {})))
    const dialog = await openAddJobLink(user)

    await check(user, dialog, URL)

    expect(await within(dialog).findByRole("button", { name: /Checking/ })).toBeDisabled()
    const close = within(dialog).getByRole("button", { name: "Close" })
    expect(close).toBeDisabled()
    await user.keyboard("{Escape}")
    expect(dialog).toBeVisible()
    await user.click(close)
    expect(dialog).toBeVisible()
  })

  it("Home keeps its own paste box: the region and the field, and no dialog trigger", async () => {
    openEve("/dashboard", { me: inviteeMe() })

    const region = await screen.findByRole("region", { name: "Paste a job" })
    expect(await within(region).findByRole("textbox", { name: "Job link or description" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Add a job link" })).not.toBeInTheDocument()
  })
})
