import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { CSRF_HEADER, JOB_CRITERIA_PATH } from "@eve/contracts"

import { TEST_CSRF_TOKEN, server } from "@/shared/testing"
import { http } from "msw"
import { findToast } from "./career-setup-helpers"
import { DEFAULT_TARGETS, FAMILY_LABELS, openBoard } from "./epic-0006-helpers"

/**
 * EPIC-0006 QA test authoring (step [5e]), Settings > Job criteria: Role
 * families and Seniority (target-families-and-seniority-settings.feature UI
 * scenarios, role-family-catalog AC-1.2 labels, design-spec.r1 B1 a11y).
 * Expected to fail until the EPIC-0006 frontend lands.
 */

const LABELS = FAMILY_LABELS.map(([, label]) => label)
const DEFAULT_LABELS = FAMILY_LABELS.filter(([key]) => (DEFAULT_TARGETS as readonly string[]).includes(key)).map(([, l]) => l)
const HIDE = "Hide intern, junior, graduate and entry-level roles"
const ALL = "Show all levels"

async function open(over: Parameters<typeof openBoard>[1] = {}) {
  const view = openBoard("/settings#job-criteria", over)
  const region = await screen.findByRole("region", { name: "Job criteria" })
  const families = await within(region).findByRole("group", { name: "Families on your board" })
  const seniority = within(region).getByRole("radiogroup", { name: "Entry-level roles on your board" })
  const checked = () => within(families).getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked || c.getAttribute("aria-checked") === "true").map((c) => c.getAttribute("aria-label") ?? c.closest("label")?.textContent ?? "")
  const save = () => within(region).getByRole("button", { name: /Save job criteria|Saving…/ })
  const puts = () => view.requests.filter((r) => r.method === "PUT" && r.path === JOB_CRITERIA_PATH)
  return { ...view, region, families, seniority, checked, save, puts }
}

describe("AC-1.5 @AC-1.5 @AC-2.1 @AC-1.2 the Role families and Seniority fields", () => {
  it("target-families:33 thirteen checkboxes in catalog order with the AC-1.2 labels", async () => {
    const { families } = await open()
    const boxes = within(families).getAllByRole("checkbox")
    expect(boxes.map((b) => b.getAttribute("aria-label") ?? "")).toHaveLength(13)
    for (const [i, label] of LABELS.entries()) expect(boxes[i]).toHaveAccessibleName(label)
  })

  it("target-families:51 Seniority offers exactly two options, one selected", async () => {
    const { seniority } = await open()
    const radios = within(seniority).getAllByRole("radio")
    expect(radios.map((r) => r.textContent || r.getAttribute("aria-label"))).toHaveLength(2)
    expect(within(seniority).getByRole("radio", { name: ALL })).toBeVisible()
    expect(within(seniority).getByRole("radio", { name: HIDE })).toBeVisible()
    expect(within(seniority).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true" || (r as HTMLInputElement).checked)).toHaveLength(1)
  })

  it("target-families:57 the section holds the five fields and one Save changes action", async () => {
    const { region } = await open()
    expect(within(region).getByLabelText("Minimum core Match")).toBeVisible()
    expect(within(region).getByRole("textbox", { name: "Frameworks" })).toBeVisible()
    expect(within(region).getByRole("textbox", { name: "Technologies" })).toBeVisible()
    expect(within(region).getAllByRole("button", { name: "Save job criteria" })).toHaveLength(1)
  })

  it("target-families:64 / :73 defaults: the nine checked, four unchecked, Hide entry selected; Match and Frameworks kept", async () => {
    const { families, seniority, region } = await open({ criteria: { minCoreMatchPercent: 80, frameworks: ["React"], technologies: [], targetRoleFamilies: [...DEFAULT_TARGETS], seniorityFloor: "hide_entry_level", version: 3 } })
    for (const label of LABELS) {
      const box = within(families).getByRole("checkbox", { name: label })
      if (DEFAULT_LABELS.includes(label)) expect(box).toBeChecked()
      else expect(box).not.toBeChecked()
    }
    expect(within(seniority).getByRole("radio", { name: HIDE })).toBeChecked()
    expect(within(region).getByLabelText("Minimum core Match")).toHaveValue("80")
    expect(within(region).getByRole("list", { name: "Frameworks" })).toHaveTextContent("React")
  })

  it("the counter reads '9 of 13' and is a description of the group, not part of its name", async () => {
    const { families } = await open()
    expect(families).toHaveAccessibleName("Families on your board")
    expect(families).toHaveAccessibleDescription(/9 of 13/)
  })

  it("each checkbox's description is its example line", async () => {
    const { families } = await open()
    expect(within(families).getByRole("checkbox", { name: "Data and ML" })).toHaveAccessibleDescription("e.g. Data Engineer, Data Scientist, ML Engineer")
    expect(within(families).getByRole("checkbox", { name: "Software engineering" })).toHaveAccessibleDescription("e.g. Software Engineer, Staff Engineer, Principal Engineer")
  })
})

describe("AC-1.5 @AC-1.5 @AC-2.1 @AC-4.2 saving families and seniority (target-families:79-140)", () => {
  it("target-families:81 checking Data and ML and saving sends both fields with the CSRF token; Saved.; kept after reload", async () => {
    const { families, save, user, puts, unmount } = await open()
    const seen: string[] = []
    server.events.on("request:start", ({ request }) => {
      if (request.method === "PUT" && new URL(request.url).pathname === JOB_CRITERIA_PATH) seen.push(request.headers.get(CSRF_HEADER) ?? "")
    })
    await user.click(within(families).getByRole("checkbox", { name: "Data and ML" }))
    expect(families).toHaveAccessibleDescription(/10 of 13/)
    await user.click(save())
    await findToast("Job criteria saved.")
    expect(puts()).toHaveLength(1)
    expect(puts()[0]!.body).toMatchObject({ targetRoleFamilies: expect.arrayContaining([...DEFAULT_TARGETS, "data_ml"]), seniorityFloor: "hide_entry_level" })
    expect(seen).toEqual([TEST_CSRF_TOKEN])
    server.events.removeAllListeners()
    unmount()
  })

  it("target-families:89 unchecking Engineering management and saving stores it unchecked", async () => {
    const { families, save, user, state } = await open()
    await user.click(within(families).getByRole("checkbox", { name: "Engineering management" }))
    await user.click(save())
    await findToast("Job criteria saved.")
    expect(state.criteria.targetRoleFamilies).not.toContain("people_management")
  })

  it("target-families:96 Show all levels saves all_levels", async () => {
    const { seniority, save, user, state } = await open()
    await user.click(within(seniority).getByRole("radio", { name: ALL }))
    await user.click(save())
    await findToast("Job criteria saved.")
    expect(state.criteria.seniorityFloor).toBe("all_levels")
  })

  it("target-families:103 one save stores Match 75, DevOps and SRE, and all levels together", async () => {
    const { region, families, seniority, save, user, state, puts } = await open()
    const match = within(region).getByLabelText("Minimum core Match")
    await user.clear(match)
    await user.type(match, "75")
    await user.click(within(families).getByRole("checkbox", { name: "DevOps and SRE" }))
    await user.click(within(seniority).getByRole("radio", { name: ALL }))
    await user.click(save())
    await findToast("Job criteria saved.")
    expect(puts()).toHaveLength(1)
    expect(state.criteria).toMatchObject({ minCoreMatchPercent: 75, seniorityFloor: "all_levels" })
    expect([...state.criteria.targetRoleFamilies].sort()).toEqual([...DEFAULT_TARGETS, "devops_platform"].sort())
  })

  it("target-families:113 exactly one family is accepted", async () => {
    const { families, save, user, state } = await open()
    for (const label of DEFAULT_LABELS.filter((l) => l !== "Frontend")) await user.click(within(families).getByRole("checkbox", { name: label }))
    await user.click(save())
    await findToast("Job criteria saved.")
    expect(state.criteria.targetRoleFamilies).toEqual(["senior_frontend"])
  })

  it("target-families:120 all thirteen can be saved", async () => {
    const { families, save, user, state } = await open()
    for (const label of LABELS.filter((l) => !DEFAULT_LABELS.includes(l))) await user.click(within(families).getByRole("checkbox", { name: label }))
    await user.click(save())
    await findToast("Job criteria saved.")
    expect(state.criteria.targetRoleFamilies).toHaveLength(13)
  })
})

describe("AC-1.5 @AC-1.5 @validation zero families is refused in the UI (target-families:132-160)", () => {
  it("target-families:133 unchecking all and saving shows the message on the group, focuses the first checkbox, sends nothing", async () => {
    const { families, save, user, puts, state } = await open()
    for (const label of DEFAULT_LABELS) await user.click(within(families).getByRole("checkbox", { name: label }))
    expect(families).toHaveAccessibleDescription(/0 of 13/)
    await user.click(save())
    expect(await within(families).findByText("Choose at least one role family.")).toBeVisible()
    expect(families).toHaveAttribute("aria-invalid", "true")
    expect(families).toHaveAccessibleDescription(/Choose at least one role family\./)
    await waitFor(() => expect(within(families).getAllByRole("checkbox")[0]).toHaveFocus())
    expect(puts()).toEqual([])
    expect(state.criteria.targetRoleFamilies).toEqual([...DEFAULT_TARGETS])
    for (const box of within(families).getAllByRole("checkbox")) expect(box).toBeEnabled()
  })

  it("target-families:143 checking a family clears the message and the save goes through", async () => {
    const { families, save, user, state } = await open()
    for (const label of DEFAULT_LABELS) await user.click(within(families).getByRole("checkbox", { name: label }))
    await user.click(save())
    await within(families).findByText("Choose at least one role family.")
    await user.click(within(families).getByRole("checkbox", { name: "Fullstack" }))
    expect(within(families).queryByText("Choose at least one role family.")).toBeNull()
    await user.click(save())
    await findToast("Job criteria saved.")
    expect(state.criteria.targetRoleFamilies).toEqual(["fullstack"])
  })

  it("target-families:151 a refused empty selection keeps the unsaved Match value", async () => {
    const { region, families, save, user, state } = await open()
    const match = within(region).getByLabelText("Minimum core Match")
    await user.clear(match)
    await user.type(match, "85")
    for (const label of DEFAULT_LABELS) await user.click(within(families).getByRole("checkbox", { name: label }))
    await user.click(save())
    await within(families).findByText("Choose at least one role family.")
    expect(match).toHaveValue("85")
    expect(state.criteria.minCoreMatchPercent).toBe(70)
  })

  it("a 400 field error on targetRoleFamilies shows the server message under the group", async () => {
    const { families, save, user } = await open()
    server.use(
      http.put(JOB_CRITERIA_PATH, () =>
        Response.json({ error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "targetRoleFamilies", position: 1, problem: "unknown_entry" }] } }, { status: 400 })
      )
    )
    await user.click(within(families).getByRole("checkbox", { name: "Data and ML" }))
    await user.click(save())
    expect(await within(families).findByText("Couldn't save your role families. Reload the page and choose them again.")).toBeVisible()
  })
})

describe("AC-1.5 @AC-1.5 @AC-2.1 keyboard and names (target-families:325)", () => {
  it("each family toggles with Space and each Seniority option is reachable by keyboard", async () => {
    const { families, seniority, user } = await open()
    const data = within(families).getByRole("checkbox", { name: "Data and ML" })
    data.focus()
    await user.keyboard(" ")
    expect(data).toBeChecked()
    const hide = within(seniority).getByRole("radio", { name: HIDE })
    hide.focus()
    await user.keyboard("{ArrowUp}")
    expect(within(seniority).getByRole("radio", { name: ALL })).toBeChecked()
  })
})

describe("AC-1.2 @AC-1.2 labels in the Posting filter panel (role-family-catalog:52-82)", () => {
  it("the Role family panel lists the thirteen labels in order and none of the old three", async () => {
    const { user } = openBoard("/postings", { targetRoleFamilies: FAMILY_LABELS.map(([k]) => k) })
    await user.click(await screen.findByRole("button", { name: /^Role family/ }))
    const panel = await screen.findByRole("dialog", { name: "Role family" })
    const boxes = within(panel).getAllByRole("checkbox")
    expect(boxes).toHaveLength(13)
    for (const [i, label] of LABELS.entries()) expect(boxes[i]).toHaveAccessibleName(label)
    expect(within(panel).queryByText("Senior frontend")).toBeNull()
    expect(within(panel).queryByText("DevOps and platform")).toBeNull()
    expect(within(panel).queryByText("People management")).toBeNull()
  })
})
