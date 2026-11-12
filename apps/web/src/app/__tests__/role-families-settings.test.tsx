import { screen, waitFor, within } from "@testing-library/react"
import { CSRF_HEADER, DEFAULT_TARGET_ROLE_FAMILIES, JOB_CRITERIA_PATH } from "@eve/contracts"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, rankedPosting, server, TEST_CSRF_TOKEN } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { criteriaSection, openWithCriteria } from "./job-criteria-helpers"

/** target-families-and-seniority-settings.feature against the v1.18.0 Job criteria fake. */

const LABELS = [
  "Frontend",
  "Hands-on technical lead",
  "Fullstack",
  "Product engineering",
  "Software engineering",
  "Backend",
  "Mobile",
  "Platform engineering",
  "DevOps and SRE",
  "Engineering management",
  "Data and ML",
  "Solutions and customer engineering",
  "Other",
]
const DEFAULT_LABELS = LABELS.filter((l) => !["DevOps and SRE", "Data and ML", "Solutions and customer engineering", "Other"].includes(l))
const HIDE_ENTRY = "Hide intern, junior, graduate and entry-level roles"
const ERROR_NONE = "Choose at least one role family."

async function setup(...args: Parameters<typeof openWithCriteria>) {
  const view = openWithCriteria(...args)
  const region = await criteriaSection()
  const families = () => within(region).getByRole("group", { name: "Families on your board" })
  const box = (label: string) => within(families()).getByRole("checkbox", { name: label })
  const labelOf = (b: HTMLElement) => document.getElementById(b.getAttribute("aria-labelledby")!)!.textContent
  const checked = () => within(families()).getAllByRole("checkbox").filter((b) => b.getAttribute("aria-checked") === "true").map(labelOf)
  const seniority = () => within(region).getByRole("radiogroup", { name: "Entry-level roles on your board" })
  const save = () => within(region).getByRole("button", { name: /Save job criteria|Saving…/ })
  const puts = () => view.career.requestsTo("PUT", JOB_CRITERIA_PATH)
  return { ...view, region, families, box, checked, seniority, save, puts }
}

describe("Role families field (AC-1.5, AC-1.6)", () => {
  it("lists the 13 families in catalog order under the accessible name exactly 'Role families'", async () => {
    const { families } = await setup("/settings")
    const group = families()
    expect(group.tagName).toBe("FIELDSET")
    expect(within(group).getAllByRole("checkbox").map((b) => document.getElementById(b.getAttribute("aria-labelledby")!)!.textContent)).toEqual(LABELS)
    // The counter and helper describe the group; they are not part of its name.
    expect(group).toHaveAccessibleDescription(
      "9 of 13 Unselected families are hidden and get no AI check. Select one again and its postings return unchanged. Job preferences ranks or excludes visible families."
    )
  })

  it("each checkbox is named by its label and described by its example line", async () => {
    const { box } = await setup("/settings")
    expect(box("Software engineering")).toHaveAccessibleDescription("e.g. Software Engineer, Staff Engineer, Principal Engineer")
    expect(box("Other")).toHaveAccessibleDescription("Anything else, e.g. QA or Hardware Engineer")
  })

  it("a Candidate who never edited Job criteria sees the nine defaults and the entry-level floor", async () => {
    const { checked, seniority } = await setup("/settings")
    expect(checked()).toEqual(DEFAULT_LABELS)
    expect(within(seniority()).getByRole("radio", { name: HIDE_ENTRY })).toBeChecked()
    expect(within(seniority()).getByRole("radio", { name: "Show all levels" })).not.toBeChecked()
  })

  it("the section reads Role families, Seniority, Match, Frameworks, Technologies with one Save changes", async () => {
    const { region } = await setup("/settings")
    const names = [...region.querySelectorAll("legend, label[for]")].map((n) => n.textContent)
    expect(names.slice(0, 2)).toEqual(["Families on your board", "Entry-level roles on your board"])
    expect(within(region).getAllByRole("button", { name: "Save job criteria" })).toHaveLength(1)
    expect(within(region).getByText("These criteria decide which postings Eve shows and ranks. Saving applies them to postings Eve already found.")).toBeVisible()
  })
})

describe("Saving families and the floor (AC-1.5, AC-2.1, AC-4.2)", () => {
  it("one save sends all five fields with the CSRF token; the counter follows the checkboxes", async () => {
    let csrf: string | null = null
    server.events.on("request:start", ({ request }) => {
      if (request.method === "PUT") csrf = request.headers.get(CSRF_HEADER)
    })
    const view = await setup("/settings")
    await view.user.click(view.box("DevOps and SRE"))
    expect(view.families()).toHaveAccessibleDescription(expect.stringContaining("10 of 13"))
    await view.user.click(within(view.seniority()).getByRole("radio", { name: "Show all levels" }))
    await view.user.clear(within(view.region).getByLabelText("Minimum core Match"))
    await view.user.type(within(view.region).getByLabelText("Minimum core Match"), "75")
    await view.user.click(view.save())

    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    server.events.removeAllListeners()
    expect(csrf).toBe(TEST_CSRF_TOKEN)
    expect(view.puts().map((r) => r.body)).toEqual([
      {
        minCoreMatchPercent: 75,
        frameworks: [],
        technologies: [],
        targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES.slice(0, 8), "devops_platform", "people_management"],
        seniorityFloor: "all_levels",
      },
    ])
    expect(view.career.state.jobCriteria).toMatchObject({ seniorityFloor: "all_levels", version: 2 })
  })

  it("exactly one family is accepted", async () => {
    const view = await setup("/settings")
    for (const label of DEFAULT_LABELS.slice(1)) await view.user.click(view.box(label))
    await view.user.click(view.save())
    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria.targetRoleFamilies).toEqual(["senior_frontend"])
  })

  it("all thirteen can be checked", async () => {
    const view = await setup("/settings")
    for (const label of LABELS.filter((l) => !DEFAULT_LABELS.includes(l))) await view.user.click(view.box(label))
    await view.user.click(view.save())
    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria.targetRoleFamilies).toHaveLength(13)
  })
})

describe("Zero families is refused in the UI (AC-1.5)", () => {
  it("shows the message linked to the field, focuses the first checkbox and sends nothing", async () => {
    const view = await setup("/settings")
    await view.user.clear(within(view.region).getByLabelText("Minimum core Match"))
    await view.user.type(within(view.region).getByLabelText("Minimum core Match"), "85")
    for (const label of DEFAULT_LABELS) await view.user.click(view.box(label))
    await view.user.click(view.save())

    const error = await within(view.region).findByText(ERROR_NONE)
    expect(error).toBeVisible()
    // DP-7: announced once, through focus plus the description, never as a live alert.
    expect(error.closest("[role=alert]")).toBeNull()
    expect(error.closest("[aria-live]")).toBeNull()
    expect(within(view.region).queryByRole("alert")).not.toBeInTheDocument()
    expect(view.families()).toHaveAttribute("aria-invalid", "true")
    expect(view.families()).toHaveAccessibleDescription(expect.stringContaining(ERROR_NONE))
    expect(view.families()).toHaveAccessibleDescription(expect.stringContaining("0 of 13"))
    await waitFor(() => expect(view.box("Frontend")).toHaveFocus())
    expect(view.puts()).toHaveLength(0)
    expect(within(view.region).getByLabelText("Minimum core Match")).toHaveValue("85")
    expect(view.career.state.jobCriteria.targetRoleFamilies).toEqual([...DEFAULT_TARGET_ROLE_FAMILIES])
  })

  it("checking a family clears the message, and the next save stores it", async () => {
    const view = await setup("/settings")
    for (const label of DEFAULT_LABELS) await view.user.click(view.box(label))
    await view.user.click(view.save())
    expect(await within(view.region).findByText(ERROR_NONE)).toBeVisible()
    await view.user.click(view.box("Fullstack"))
    expect(within(view.region).queryByText(ERROR_NONE)).not.toBeInTheDocument()
    await view.user.click(view.save())
    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(view.career.state.jobCriteria.targetRoleFamilies).toEqual(["fullstack"])
  })
})

describe("Server refusals (AC-1.9, AC-4.2)", () => {
  it("a 400 field error on families shows errorServer under the legend", async () => {
    const view = await setup("/settings")
    server.use(
      http.put(JOB_CRITERIA_PATH, () =>
        HttpResponse.json(
          { error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "targetRoleFamilies", position: 2, problem: "unknown_entry" }] } },
          { status: 400 }
        )
      )
    )
    await view.user.click(view.save())
    expect(await within(view.region).findByText("Couldn't save your role families. Reload the page and choose them again.")).toBeVisible()
    expect(within(view.region).queryByText("The request is not valid.")).not.toBeInTheDocument()
    await waitFor(() => expect(view.box("Frontend")).toHaveFocus())
  })

  it("a 500 keeps every unsaved choice and shows the retry line", async () => {
    const view = await setup("/settings")
    server.use(http.put(JOB_CRITERIA_PATH, () => apiErrorResponse("internal_error")))
    await view.user.click(view.box("Data and ML"))
    await view.user.click(within(view.seniority()).getByRole("radio", { name: "Show all levels" }))
    await view.user.click(view.save())
    expect(await within(view.region).findByText("Couldn't save your job criteria. Nothing changed. Try again.")).toBeVisible()
    expect(view.box("Data and ML")).toBeChecked()
    expect(within(view.seniority()).getByRole("radio", { name: "Show all levels" })).toBeChecked()
  })
})

describe("Keyboard (accessibility scenario)", () => {
  it("Tab reaches each checkbox and Space toggles it; arrow keys choose a seniority option", async () => {
    const view = await setup("/settings")
    view.box("Frontend").focus()
    await view.user.keyboard(" ")
    expect(view.box("Frontend")).not.toBeChecked()
    await view.user.tab()
    expect(view.box("Hands-on technical lead")).toHaveFocus()
    within(view.seniority()).getByRole("radio", { name: HIDE_ENTRY }).focus()
    await view.user.keyboard("{ArrowUp}")
    await waitFor(() => expect(within(view.seniority()).getByRole("radio", { name: "Show all levels" })).toBeChecked())
  })
})

describe("Saving families updates the Posting filter panel (AC-3.7)", () => {
  it("lists a newly chosen family after a save", async () => {
    const view = openWithCriteria("/settings", { discovery: { postings: [rankedPosting()] } })
    const region = await criteriaSection()
    view.career.onJobCriteriaSaved((saved) => {
      view.discovery.state.targetRoleFamilies = [...saved.targetRoleFamilies]
    })
    await view.user.click(within(region).getByRole("checkbox", { name: "Data and ML" }))
    await view.user.click(within(region).getByRole("checkbox", { name: "Mobile" }))
    await view.user.click(within(region).getByRole("button", { name: "Save job criteria" }))
    expect(await findToast("Job criteria saved.")).toBeInTheDocument()

    await view.user.click(screen.getByRole("link", { name: "Jobs" }))
    await view.user.click(await screen.findByRole("button", { name: "Role family" }))
    const panel = await screen.findByRole("dialog", { name: "Role family" })
    const labels = within(panel).getAllByRole("checkbox").map((b) => b.closest("label")?.textContent)
    expect(labels).toContain("Data and ML")
    expect(labels).not.toContain("Mobile")
  })
})
