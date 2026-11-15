import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { JOB_POSTING_LINKS_PATH } from "@eve/contracts"
import { hiringCopy } from "@/entities/stack-post"
import { apiErrorResponse, server } from "@/shared/testing"
import { checkLink, openCheck, openHiring } from "./hiring-view-helpers"

/**
 * The Check this job dialog (EPIC-0011 owner decision, follow-ups): it reports a
 * failed request in place, as the Add a job link dialog does, and it cannot be
 * dismissed while that request is in flight. Its header stays put and its body
 * scrolls, capped at the viewport height. The header also carries the help line
 * as the dialog description, which is the link field's one description.
 */
const FAILED_JOB = "Couldn't check the job. Nothing changed. Try again."
const GREENHOUSE = "https://boards.greenhouse.io/acme/jobs/4012345"
const DESCRIPTION = `Senior Frontend Engineer\n\n${"Build merchant dashboards in React and TypeScript. ".repeat(6)}`

function toasts() {
  return screen.getByRole("region", { name: "Messages" })
}

describe("Check this job dialog follow-ups", () => {
  it("a failed description paste shows C-PD-26 as an alert inside the dialog, keeps the values and panel, and sends no toast", async () => {
    const { user } = openHiring()
    server.use(http.post(JOB_POSTING_LINKS_PATH, () => apiErrorResponse("internal_error")))
    const dialog = await openCheck()
    await user.click(within(dialog).getByRole("button", { name: "Add the job description" }))
    const description = within(dialog).getByRole("textbox", { name: /^Job description/ })
    await user.click(description)
    await user.paste(DESCRIPTION)
    await user.type(within(dialog).getByRole("textbox", { name: "Job title" }), "Senior Frontend Engineer")
    await user.type(within(dialog).getByRole("textbox", { name: "Company" }), "Globex")

    await user.click(within(dialog).getByRole("button", { name: "Check this job" }))

    const alert = await within(dialog).findByRole("alert")
    expect(alert).toHaveTextContent(FAILED_JOB)
    expect(dialog).toBeVisible()
    // The panel and what was typed stay, so the Candidate can send again.
    expect(description).toHaveValue(DESCRIPTION)
    expect(within(dialog).getByRole("textbox", { name: "Job title" })).toHaveValue("Senior Frontend Engineer")
    expect(within(dialog).getByRole("textbox", { name: "Company" })).toHaveValue("Globex")
    expect(within(toasts()).queryByText(FAILED_JOB)).not.toBeInTheDocument()
  })

  it("shows the help once inside the dialog, as the link field's only description", async () => {
    openHiring()
    const dialog = await openCheck()

    // Exactly one of the two help variants is in the popup: the description under
    // the title, not a second copy the form repeats.
    const shown = [hiringCopy.checkHelp, hiringCopy.checkHelpSolo].flatMap((help) =>
      within(dialog).queryAllByText(help, { exact: true })
    )
    expect(shown).toHaveLength(1)
    const [description] = shown
    expect(description).toBeVisible()
    expect(description.getAttribute("data-slot")).toBe("dialog-description")
    const help = description.textContent ?? ""

    // The field's description is that element and nothing outside the popup.
    const field = within(dialog).getByRole("textbox", { name: "Application link" })
    const ids = (field.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    expect(ids).toHaveLength(1)
    expect(document.getElementById(ids[0]!)).toBe(description)
    expect(dialog.contains(document.getElementById(ids[0]!))).toBe(true)
    // What a screen reader announces with the field is the text on screen.
    expect(within(dialog).getByRole("textbox", { name: "Application link", description: help })).toBe(field)
  })

  it("a request in flight cannot be dismissed: Escape and the disabled Close do nothing", async () => {
    const { user } = openHiring()
    server.use(http.post(JOB_POSTING_LINKS_PATH, () => new Promise(() => {})))
    const dialog = await openCheck()
    await user.type(within(dialog).getByRole("textbox", { name: "Application link" }), GREENHOUSE)

    await user.click(checkLink())

    const close = within(dialog).getByRole("button", { name: "Close" })
    await waitFor(() => expect(close).toBeDisabled())
    await user.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "Check this job" })).toBeInTheDocument()
    await user.click(close)
    expect(screen.getByRole("dialog", { name: "Check this job" })).toBeInTheDocument()
  })

  it("caps the popup at the viewport height and scrolls only its body, with the title and field kept", async () => {
    const { user } = openHiring()
    const dialog = await openCheck()

    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-hidden", "flex", "flex-col", "sm:max-w-md")
    const header = dialog.querySelector('[data-slot="dialog-header"]') as HTMLElement
    expect(header).toHaveClass("flex-none")
    // Pinned above the scroll, with a hairline under it: at 375x420 the help is cut
    // in half by the scroll edge, and the rule makes that edge explicit. `pb-3` keeps
    // the rule off the last line, so it reads as a divider and not an underline.
    expect(header).toHaveClass("border-b", "border-border", "pb-3")

    const body = dialog.querySelector('[data-slot="check-this-job-body"]') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.className).toContain("min-h-0")
    expect(body.className).toContain("flex-1")
    expect(body.className).toContain("overflow-y-auto")
    expect(body.className).toContain("overscroll-contain")
    // The rule and the body's content share one width: the body pulls out past the
    // popup's padding and re-insets itself, and it stays the only scroller.
    expect(body.className).toContain("-mx-6")
    expect(body.className).toContain("px-6")
    expect(header.className).not.toContain("overflow")
    // The title stays outside the scrolling body; the link field and panel are inside it.
    expect(body.contains(within(dialog).getByRole("heading", { name: "Check this job" }))).toBe(false)
    expect(body.contains(within(dialog).getByRole("textbox", { name: "Application link" }))).toBe(true)

    await user.click(within(dialog).getByRole("button", { name: "Add the job description" }))
    expect(body.contains(within(dialog).getByRole("textbox", { name: /^Job description/ }))).toBe(true)

    // The panel's textarea is capped against the visible viewport, not the full one.
    const textarea = within(dialog).getByRole("textbox", { name: /^Job description/ })
    expect(textarea).toHaveClass("max-h-[50dvh]", "min-h-40", "overflow-y-auto")
    expect(textarea).not.toHaveClass("max-h-[50vh]")
  })
})
