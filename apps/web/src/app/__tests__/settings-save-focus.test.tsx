import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse, type JsonBodyType } from "msw"
import { describe, expect, it } from "vitest"
import { CANDIDATE_CONTACT_PATH, JOB_CRITERIA_PATH } from "@eve/contracts"

import { defaultJobCriteria, server } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openWithCriteria } from "./job-criteria-helpers"

/**
 * Decision O4: every Settings Save button keeps keyboard focus while its save
 * is in flight and after it ends, cannot be activated again while pending, and
 * announces the pending state (aria-disabled and aria-busy). Job criteria
 * already does this and is the reference; Contact (EPIC-0002 B1 removed Work authorization) and Contact
 * details must match it.
 */

type Section = {
  name: string
  path: string
  response: JsonBodyType
  /** A text field in the section, for implicit (Enter) form submission. */
  field: (region: HTMLElement) => HTMLElement
  /** The section's Save label and success toast (EPIC-0002 B1: Job criteria is "Save job criteria"). */
  saveLabel: string
  savedToast: string
}

const sections: Section[] = [
  {
    name: "Job criteria",
    path: JOB_CRITERIA_PATH,
    response: { ...defaultJobCriteria(), version: 2 },
    field: (region) => within(region).getByLabelText("Minimum core Match"),
    saveLabel: "Save job criteria",
    savedToast: "Job criteria saved.",
  },
  {
    name: "Contact details",
    path: CANDIDATE_CONTACT_PATH,
    response: { fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] },
    field: (region) => within(region).getByLabelText("Full name (Required)"),
    saveLabel: "Save changes",
    savedToast: "Saved.",
  },
]

/** Holds every PUT to `path` until `release` is called, counting requests. */
function holdSaves(path: string, response: JsonBodyType) {
  const held = { count: 0, release: (): void => undefined }
  const gate = new Promise<void>((resolve) => (held.release = resolve))
  server.use(
    http.put(path, async () => {
      held.count += 1
      await gate
      return HttpResponse.json(response)
    })
  )
  return held
}

describe("Settings Save buttons keep focus while saving (decision O4)", () => {
  it.each(sections)("$name: focus stays on Save during and after saving", async (section) => {
    const { user } = openWithCriteria("/settings")
    const region = await screen.findByRole("region", { name: section.name })
    const held = holdSaves(section.path, section.response)

    const save = within(region).getByRole("button", { name: section.saveLabel })
    save.focus()
    await user.keyboard("{Enter}")

    const pending = await within(region).findByRole("button", { name: "Saving…" })
    expect(pending).toBe(save)
    expect(pending).toHaveFocus()
    // jsdom keeps focus on a natively disabled button; browsers drop it to
    // <body>. The native attribute is what loses focus, so it must be absent.
    expect(pending).not.toHaveAttribute("disabled")
    expect(pending).toHaveAttribute("aria-disabled", "true")
    expect(pending).toHaveAttribute("aria-busy", "true")

    held.release()
    expect(await findToast(section.savedToast)).toBeInTheDocument()
    const done = await within(region).findByRole("button", { name: section.saveLabel })
    expect(done).toHaveFocus()
    expect(done).not.toHaveAttribute("aria-disabled", "true")
    expect(done).not.toHaveAttribute("aria-busy", "true")
  })

  it.each(sections)("$name: a pending Save cannot be activated again", async (section) => {
    const { user } = openWithCriteria("/settings")
    const region = await screen.findByRole("region", { name: section.name })
    const held = holdSaves(section.path, section.response)

    await user.click(within(region).getByRole("button", { name: section.saveLabel }))
    const pending = await within(region).findByRole("button", { name: "Saving…" })
    await waitFor(() => expect(held.count).toBe(1))

    await user.click(pending)
    pending.focus()
    await user.keyboard("{Enter}")
    await user.keyboard(" ")
    const field = section.field(region)
    field.focus()
    await user.keyboard("{Enter}")

    // Any other submission path (a direct submit event) is ignored too.
    fireEvent.submit(field.closest("form")!)

    expect(held.count).toBe(1)
    held.release()
    expect(await findToast(section.savedToast)).toBeInTheDocument()
    expect(held.count).toBe(1)
  })
})
