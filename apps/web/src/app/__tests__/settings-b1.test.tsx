import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { DEFAULT_ROLE_FAMILY_TIERS, type JobCriteriaResponse } from "@eve/contracts"

import {
  createCareerSetupApi,
  createDiscoveryApi,
  createDocumentsApi,
  createPreferencesApi,
  defaultJobCriteria,
  preferencesRecord,
  server,
  signedInSession,
} from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { renderApp } from "./test-app"

/** EPIC-0002 settings-b1.feature (design-spec.r6 "B1 interim Settings"), frontend and both rows. */
const ALL_FAMILIES = Object.keys(DEFAULT_ROLE_FAMILY_TIERS) as JobCriteriaResponse["targetRoleFamilies"]
const except = (...gone: string[]) => ALL_FAMILIES.filter((f) => !gone.includes(f))

function open(options: { families?: JobCriteriaResponse["targetRoleFamilies"]; criteria?: Partial<JobCriteriaResponse>; prefsVersion?: number } = {}) {
  const career = createCareerSetupApi({
    jobCriteria: { ...defaultJobCriteria(), version: 1, targetRoleFamilies: options.families ?? ALL_FAMILIES, ...options.criteria },
  })
  const prefs = createPreferencesApi({ record: preferencesRecord(options.prefsVersion ?? 4, { dailyCap: 5 }) })
  server.use(signedInSession, ...career.handlers, ...createDiscoveryApi().handlers, ...createDocumentsApi().handlers, ...prefs.handlers)
  const user = userEvent.setup({ delay: null })
  return { ...renderApp("/settings"), career, prefs, user }
}

const prefsRegion = () => screen.findByRole("region", { name: "Job preferences" })
const criteriaRegion = () => screen.findByRole("region", { name: "Job criteria" })
const contactRegion = () => screen.findByRole("region", { name: "Contact details" })

describe("settings-b1.feature", () => {
  it(":35 shows Job preferences, Job criteria, Contact details and the Advanced switch in that order (Monthly cost moved to Pause and cost), with their anchors", async () => {
    open()
    await prefsRegion()
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(titles.filter((t) => ["Job preferences", "Job criteria", "Contact details", "Advanced: automatic applying"].includes(t ?? ""))).toEqual([
      "Job preferences",
      "Job criteria",
      "Contact details",
      "Advanced: automatic applying",
    ])
    expect(titles.indexOf("Job preferences")).toBe(0)
    expect((await prefsRegion()).id).toBe("preferences")
    expect((await criteriaRegion()).id).toBe("job-criteria")
  })

  it(":41 has no Location and work authorization section; Job preferences holds country, work authorization and sponsorship", async () => {
    open()
    const prefs = await prefsRegion()
    expect(screen.queryByRole("region", { name: "Location and work authorization" })).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Work authorization" })).toBeNull()
    expect(screen.queryByText(/Sponsorship need: always answered Yes/)).toBeNull()
    expect(within(prefs).getByRole("button", { name: /Home country/ })).toBeVisible()
    expect(within(prefs).getByText("Countries you can work in without sponsorship")).toBeVisible()
    expect(within(prefs).getByRole("radiogroup", { name: /visa sponsorship/ })).toBeVisible()
  })

  it(":51 names the Job criteria groups for what they decide on the board", async () => {
    open()
    const region = await criteriaRegion()
    expect(within(region).getByRole("group", { name: "Families on your board" })).toBeVisible()
    expect(
      within(region).getByText("Unselected families are hidden and get no AI check. Select one again and its postings return unchanged. Job preferences ranks or excludes visible families.")
    ).toBeVisible()
    const prefsLink = within(region).getByRole("link", { name: "Go to Job preferences" })
    expect(prefsLink).toHaveAttribute("href", "/settings#preferences")
    // DR-B1-01: a standalone link grows to a 40px target on coarse pointers (DESIGN.md:64).
    expect(prefsLink).toHaveClass("inline-flex", "items-center", "pointer-coarse:min-h-10")
    expect(within(region).getByRole("radiogroup", { name: "Entry-level roles on your board" })).toBeVisible()
    expect(within(region).queryByRole("group", { name: "Role families" })).toBeNull()
    expect(within(region).queryByRole("radiogroup", { name: "Seniority" })).toBeNull()
  })

  it(":60 each family hidden on the board shows Hidden in the tiers, with the plural note and the link", async () => {
    open({ families: except("devops_platform", "data_ml", "solutions_customer", "other") })
    const region = await prefsRegion()
    for (const name of ["DevOps and SRE", "Data and ML", "Solutions and customer engineering", "Other"]) {
      expect(within(region).getByRole("radiogroup", { name: `${name}, Hidden` })).toBeVisible()
    }
    expect(within(region).getAllByText("Hidden")).toHaveLength(4)
    const dataMl = within(region).getByRole("radiogroup", { name: "Data and ML, Hidden" })
    for (const radio of within(dataMl).getAllByRole("radio")) expect(radio).not.toHaveAttribute("aria-disabled")
    expect(within(region).getByText("4 families are hidden by Job criteria, so their tier has no effect until you select them there.")).toBeVisible()
    expect(within(region).getByRole("link", { name: "Go to Job criteria" })).toHaveAttribute("href", "/settings#job-criteria")
  })

  it(":71 one hidden family uses the singular note", async () => {
    open({ families: except("other") })
    const region = await prefsRegion()
    expect(within(region).getByRole("radiogroup", { name: "Other, Hidden" })).toBeVisible()
    expect(within(region).getByText("1 family is hidden by Job criteria, so its tier has no effect until you select it there.")).toBeVisible()
  })

  it(":78 with every family on the board, no Hidden label, note or link", async () => {
    open()
    const region = await prefsRegion()
    expect(within(region).queryByText("Hidden")).toBeNull()
    expect(within(region).queryByText(/hidden by Job criteria/)).toBeNull()
    expect(within(region).queryByRole("link", { name: "Go to Job criteria" })).toBeNull()
  })

  it(":86 saving the board families updates the Hidden labels without saving Job preferences", async () => {
    const { user, prefs } = open({ families: except("other") })
    const prefsR = await prefsRegion()
    expect(within(prefsR).getByRole("radiogroup", { name: "Other, Hidden" })).toBeVisible()
    const criteria = await criteriaRegion()
    await user.click(within(within(criteria).getByRole("group", { name: "Families on your board" })).getByRole("checkbox", { name: /^Other/ }))
    await user.click(within(criteria).getByRole("button", { name: "Save job criteria" }))
    await findToast("Job criteria saved.")
    await waitFor(() => expect(within(prefsR).getByRole("radiogroup", { name: "Other" })).toBeVisible())
    expect(within(prefsR).queryByText(/hidden by Job criteria/)).toBeNull()
    expect(prefs.state.record?.version).toBe(4)
    expect(prefs.puts).toHaveLength(0)
  })

  it(":94 the Hidden labels are not part of the Job preferences form", async () => {
    const { user, prefs } = open({ families: except("other") })
    const region = await prefsRegion()
    expect(within(region).getByRole("button", { name: "Save preferences" })).toHaveAttribute("aria-disabled", "true")
    await user.click(within(region).getByRole("radio", { name: "3 per day" }))
    await user.click(within(region).getByRole("button", { name: "Save preferences" }))
    await findToast("Preferences saved.")
    const body = JSON.stringify(prefs.puts[0])
    expect(body).not.toMatch(/hidden|targetRoleFamilies|board/i)
  })

  it(":121 each save is named by its visible label, is last in its own section, with the scope lines", async () => {
    open()
    const prefs = await prefsRegion()
    const criteria = await criteriaRegion()
    const contact = await contactRegion()
    const saves = screen.getAllByRole("button", { name: /^Save / })
    expect(saves.map((b) => b.textContent)).toEqual(["Save preferences", "Save job criteria", "Save changes"])
    expect(within(prefs).getByRole("button", { name: "Save preferences" })).toBe(saves[0])
    expect(within(criteria).getByRole("button", { name: "Save job criteria" })).toBe(saves[1])
    expect(within(contact).getByRole("button", { name: "Save changes" })).toBe(saves[2])
    for (const [region, button] of [[prefs, saves[0]], [criteria, saves[1]], [contact, saves[2]]] as const) {
      const focusables = within(region).getAllByRole("button").concat(within(region).queryAllByRole("textbox"))
      const last = [...region.querySelectorAll("button, input, select, textarea, a[href]")].at(-1)
      expect(last).toBe(button)
      expect(focusables.length).toBeGreaterThan(0)
    }
    const scope = within(criteria).getByText("This saves Job criteria only. Job preferences has its own save.")
    expect(scope.nextElementSibling?.contains(saves[1])).toBe(true)
    expect(
      within(prefs).getByText("This saves Job preferences only. It re-checks the jobs Eve already found against your saved keyword and role families. It sends no applications.")
    ).toBeVisible()
  })

  it(":130 saving Job criteria leaves unsaved Job preferences and Contact edits on screen and unsaved", async () => {
    const { user, prefs, career } = open()
    const prefsR = await prefsRegion()
    await user.click(within(prefsR).getByRole("radio", { name: "3 per day" }))
    const contact = await contactRegion()
    const name = within(contact).getByLabelText(/Full name/)
    await user.clear(name)
    await user.type(name, "Kofi A. Mensah")
    const criteria = await criteriaRegion()
    const match = within(criteria).getByLabelText("Minimum core Match")
    await user.clear(match)
    await user.type(match, "75")
    await user.click(within(criteria).getByRole("button", { name: "Save job criteria" }))
    await findToast("Job criteria saved.")
    expect(career.state.jobCriteria.minCoreMatchPercent).toBe(75)
    expect(within(prefsR).getByRole("radio", { name: "3 per day" })).toBeChecked()
    expect(name).toHaveValue("Kofi A. Mensah")
    expect(prefs.state.record?.version).toBe(4)
    expect(prefs.state.record?.values.dailyCap).toBe(5)
  })

  it(":141 saving Job preferences leaves unsaved Job criteria edits on screen and unsaved", async () => {
    const { user, prefs, career } = open()
    const criteria = await criteriaRegion()
    const match = within(criteria).getByLabelText("Minimum core Match")
    await user.clear(match)
    await user.type(match, "85")
    const prefsR = await prefsRegion()
    await user.click(within(prefsR).getByRole("radio", { name: "3 per day" }))
    await user.click(within(prefsR).getByRole("button", { name: "Save preferences" }))
    await findToast("Preferences saved.")
    expect(prefs.state.record?.version).toBe(5)
    expect(prefs.state.record?.values.dailyCap).toBe(3)
    expect(match).toHaveValue("85")
    expect(career.state.jobCriteria.minCoreMatchPercent).toBe(70)
  })

  it(":150 a Job criteria field error does not block or appear in the Job preferences save", async () => {
    const { user, prefs } = open()
    const criteria = await criteriaRegion()
    const match = within(criteria).getByLabelText("Minimum core Match")
    await user.clear(match)
    await user.type(match, "150")
    const prefsR = await prefsRegion()
    await user.click(within(prefsR).getByRole("radio", { name: "3 per day" }))
    await user.click(within(prefsR).getByRole("button", { name: "Save preferences" }))
    await findToast("Preferences saved.")
    expect(prefs.state.record?.values.dailyCap).toBe(3)
    expect(within(prefsR).queryByRole("alert")).toBeNull()
    expect(match).toHaveValue("150")
  })
})
