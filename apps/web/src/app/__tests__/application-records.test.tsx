import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import type { ApplicationDetail, MinimalRecord, Outcome } from "@eve/contracts"
import { apiErrorResponse, createControlsApi, formAnswer, readyApplication, server, type ControlsApiState } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openDocuments } from "./documents-helpers"

const APP = "30000000-0000-4000-8000-0000000000a1"

function open(path: string, apps: ApplicationDetail[], initial: Partial<ControlsApiState> = {}) {
  const view = openDocuments(path, { applications: apps })
  const controlsApi = createControlsApi({ applications: view.api.state.applications, ...initial })
  server.use(...controlsApi.handlers)
  return { ...view, controlsApi }
}

const outcome = (o: Partial<Outcome> = {}): Outcome => ({
  id: "40000000-0000-4000-8000-0000000000b1",
  applicationId: APP,
  type: "confirmation",
  source: "candidate",
  excerpt: null,
  createdAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:00:00.000Z",
  ...o,
})

const outcomesRegion = () => screen.findByRole("region", { name: "Outcomes" })

describe("Manual Outcomes on the Application page (outcome-tracking.feature, dashboard.feature, F9 step 4)", () => {
  it("no Outcomes: C-OUT-1 and Record Outcome", async () => {
    open(`/applications/${APP}`, [readyApplication({ id: APP })])
    const region = await outcomesRegion()
    expect(await within(region).findByText("No Outcomes yet.")).toBeVisible()
    expect(within(region).getByRole("button", { name: "Record Outcome" })).toBeVisible()
  })

  it("records 'interview invitation' by hand: the row shows its badge, date and 'Recorded by you', and 'Outcome saved.'", async () => {
    const { user, controlsApi } = open(`/applications/${APP}`, [readyApplication({ id: APP })])
    await user.click(within(await outcomesRegion()).getByRole("button", { name: "Record Outcome" }))
    const dialog = await screen.findByRole("dialog", { name: "Record Outcome" })
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /Outcome type/ }), "Interview invitation")
    await user.click(within(dialog).getByRole("button", { name: "Save Outcome" }))
    expect(await findToast("Outcome saved.")).toBeInTheDocument()
    const region = await outcomesRegion()
    const row = (await within(region).findByText("Interview invitation")).closest("li") as HTMLElement
    expect(row).toHaveTextContent("Recorded by you")
    expect(row).toHaveTextContent("20 Oct 2026")
    expect(controlsApi.requests).toContainEqual({ method: "POST", path: `/v1/applications/${APP}/outcomes`, body: { type: "interview_invitation" } })
    expect(controlsApi.state.outcomes).toHaveLength(1)
  })

  it("Save Outcome without a type shows an inline error and sends nothing", async () => {
    const { user, controlsApi } = open(`/applications/${APP}`, [readyApplication({ id: APP })])
    await user.click(within(await outcomesRegion()).getByRole("button", { name: "Record Outcome" }))
    const dialog = await screen.findByRole("dialog", { name: "Record Outcome" })
    await user.click(within(dialog).getByRole("button", { name: "Save Outcome" }))
    expect(within(dialog).getByText("Choose an Outcome type.")).toBeVisible()
    expect(controlsApi.requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  it.each([
    ["confirmation", "Rejection", "rejection"],
    ["request_for_action", "Interview invitation", "interview_invitation"],
  ] as const)("Edit changes %s to %s and keeps exactly one Outcome", async (from, label, to) => {
    const { user, controlsApi } = open(`/applications/${APP}`, [readyApplication({ id: APP })], { outcomes: [outcome({ type: from })] })
    const region = await outcomesRegion()
    await user.click(await within(region).findByRole("button", { name: /^Edit Outcome:/ }))
    const dialog = await screen.findByRole("dialog", { name: "Edit Outcome" })
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /Outcome type/ }), label)
    await user.click(within(dialog).getByRole("button", { name: "Save Outcome" }))
    expect(await within(region).findByText(label)).toBeVisible()
    expect(within(region).getAllByRole("listitem")).toHaveLength(1)
    expect(controlsApi.requests).toContainEqual({ method: "PATCH", path: `/v1/outcomes/${outcome().id}`, body: { type: to } })
  })

  it("a failed save is C-ERR-2 and the dialog stays open with its value", async () => {
    const { user } = open(`/applications/${APP}`, [readyApplication({ id: APP })])
    server.use(http.post("/v1/applications/:id/outcomes", () => apiErrorResponse("internal_error")))
    await user.click(within(await outcomesRegion()).getByRole("button", { name: "Record Outcome" }))
    const dialog = await screen.findByRole("dialog", { name: "Record Outcome" })
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /Outcome type/ }), "Rejection")
    await user.click(within(dialog).getByRole("button", { name: "Save Outcome" }))
    expect(await findToast("Couldn't save the Outcome. Nothing changed. Try again.")).toBeInTheDocument()
    expect(within(screen.getByRole("dialog", { name: "Record Outcome" })).getByRole("combobox", { name: /Outcome type/ })).toHaveValue("rejection")
  })
})

describe("Answers used (#answers, CR6-01)", () => {
  it("the Application page has an #answers section that takes focus from E1's 'View the answers used' link", async () => {
    const view = openDocuments(`/applications/${APP}#answers`, { applications: [readyApplication({ id: APP })] })
    server.use(
      http.get("/v1/applications/:id/form-answers", () =>
        Response.json({ available: true, readAt: "2026-10-20T09:00:00.000Z", answers: [formAnswer({ question: "Notice period", source: "approved_answer_standard", value: "4 weeks" })] })
      )
    )
    void view
    const heading = await screen.findByRole("heading", { level: 2, name: "Answers used" })
    expect(heading).toHaveAttribute("id", "answers")
    await waitFor(() => expect(heading).toHaveFocus())
    const card = heading.closest('[data-slot="card"]') as HTMLElement
    expect(await within(card).findByText("4 weeks")).toBeVisible()
    expect(within(card).getByText("Notice period")).toBeVisible()
  })
})

describe("Deleting detailed records (data-retention-and-privacy.feature, F10)", () => {
  it("one Application: overflow menu, C-CONFIRM-11, then the minimal record view with C-DATA-3 and C-DATA-4", async () => {
    const app = readyApplication({ id: APP, requisitionId: "R-1042", createdAt: "2026-10-01T10:00:00.000Z" })
    const { user, controlsApi } = open(`/applications/${APP}`, [app], { outcomes: [outcome({ type: "rejection" })] })
    await user.click(await screen.findByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete detailed records" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete detailed records?" })
    expect(dialog).toHaveTextContent(
      "This deletes the Application record, documents, answers and Outcomes for Senior Frontend Engineer at Acme Payments. A minimal record stays to prevent duplicates. This can't be undone."
    )
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus())
    await user.click(within(dialog).getByRole("button", { name: "Delete records" }))
    expect(await findToast("Detailed records deleted for 1 Application(s).")).toBeInTheDocument()
    expect(await screen.findByText("Detailed records were deleted on 20 Oct 2026. This minimal record still blocks duplicate Applications.")).toBeVisible()
    expect(controlsApi.requests).toContainEqual({ method: "POST", path: "/v1/applications/delete-details", body: { applicationIds: [APP] } })
    // Minimal record: company, URL, requisition ID, date, final status; no documents, answers or Outcomes.
    expect(screen.getByRole("heading", { level: 1, name: "Acme Payments" })).toBeVisible()
    expect(screen.getByText("https://boards.greenhouse.io/acme/jobs/1042")).toBeVisible()
    expect(screen.getByText("R-1042")).toBeVisible()
    expect(screen.getByText("1 Oct 2026")).toBeVisible()
    expect(await screen.findByText("Rejection")).toBeVisible()
    expect(screen.queryByRole("region", { name: "Documents" })).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Outcomes" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Answers used" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear record" })).toBeVisible()
  })

  it("Cancel deletes nothing", async () => {
    const { user, controlsApi } = open(`/applications/${APP}`, [readyApplication({ id: APP })])
    await user.click(await screen.findByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete detailed records" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(controlsApi.requests.filter((r) => r.path === "/v1/applications/delete-details")).toHaveLength(0)
    expect(screen.getByRole("region", { name: "Outcomes" })).toBeVisible()
  })

  it("a refusal (an attempt in flight) shows the contract message and nothing is deleted", async () => {
    const { user } = open(`/applications/${APP}`, [readyApplication({ id: APP })])
    server.use(http.post("/v1/applications/delete-details", () => apiErrorResponse("application_state_conflict")))
    await user.click(await screen.findByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete detailed records" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete records" }))
    expect(await findToast("This Application can't do that in its current state.")).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Outcomes" })).toBeVisible()
  })

  it("an email link to a deleted Application shows the minimal record with C-DATA-6", async () => {
    const deleted = readyApplication({ id: APP, roleTitle: null, documents: [], detailsDeletedAt: "2026-10-16T10:00:00.000Z" })
    open(`/applications/${APP}#answers`, [deleted])
    expect(await screen.findByText("The documents and answers for this Application were deleted on 16 Oct 2026.")).toBeVisible()
    expect(screen.getByText("Detailed records were deleted on 16 Oct 2026. This minimal record still blocks duplicate Applications.")).toBeVisible()
  })

  it("Clear record (C-CONFIRM-13) removes the minimal record and toasts C-DATA-5", async () => {
    const deleted = readyApplication({ id: APP, requisitionId: "R-1042", roleTitle: null, documents: [], detailsDeletedAt: "2026-10-16T10:00:00.000Z" })
    const record: MinimalRecord = {
      applicationId: APP,
      company: "Acme Payments",
      applicationUrl: deleted.applicationUrl,
      requisitionId: "R-1042",
      createdAt: deleted.createdAt,
      detailsDeletedAt: "2026-10-16T10:00:00.000Z",
      finalStatus: "rejection",
    }
    const { user, controlsApi } = open(`/applications/${APP}`, [deleted], { records: [record] })
    await user.click(await screen.findByRole("button", { name: "Clear record" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Clear this record?" })
    expect(dialog).toHaveTextContent("The assistant could then apply to requisition R-1042 at Acme Payments again.")
    await user.click(within(dialog).getByRole("button", { name: "Clear record" }))
    expect(await findToast("Record cleared. This requisition is no longer blocked.")).toBeInTheDocument()
    expect(controlsApi.state.records).toHaveLength(0)
  })
})

describe("Bulk deletion on /applications (data-retention-and-privacy.feature, F10 retention step 2)", () => {
  const three = () => [
    readyApplication({ requisitionId: "R-1042", roleTitle: "Senior Frontend Engineer" }),
    readyApplication({ requisitionId: "L-77", roleTitle: "Staff Engineer" }),
    readyApplication({ requisitionId: "A-9", roleTitle: "Frontend Lead" }),
  ]

  it("select all on this page, then 'Delete detailed records (3)' with C-CONFIRM-12 and C-DATA-4", async () => {
    const apps = three()
    const { user, controlsApi } = open("/applications?view=list", apps)
    await user.click(await screen.findByRole("checkbox", { name: "Select all on this page" }))
    const action = await screen.findByRole("button", { name: "Delete detailed records (3)" })
    await user.click(action)
    const dialog = await screen.findByRole("alertdialog", { name: "Delete detailed records for 3 Applications?" })
    expect(dialog).toHaveTextContent("Documents, answers and Outcomes are deleted. Minimal records stay to prevent duplicates. This can't be undone.")
    await user.click(within(dialog).getByRole("button", { name: "Delete records" }))
    expect(await findToast("Detailed records deleted for 3 Application(s).")).toBeInTheDocument()
    const sent = controlsApi.requests.find((r) => r.path === "/v1/applications/delete-details")?.body as { applicationIds: string[] }
    expect([...sent.applicationIds].sort()).toEqual(apps.map((a) => a.id).sort())
    // Deleted Applications leave the list; their minimal records are on /privacy.
    expect(await screen.findByText("Applications appear here once you prepare one. Paste a job on Home to start.")).toBeVisible()
  })

  it("one selected row: the toolbar counts it; nothing shows with no selection", async () => {
    const { user } = open("/applications?view=list", three())
    await screen.findByRole("checkbox", { name: "Select all on this page" })
    expect(screen.queryByRole("button", { name: /Delete detailed records/ })).not.toBeInTheDocument()
    await user.click(screen.getAllByRole("checkbox", { name: /^Select / }).find((c) => c.getAttribute("aria-label")?.includes("Staff Engineer")) as HTMLElement)
    expect(await screen.findByRole("button", { name: "Delete detailed records (1)" })).toBeVisible()
  })
})

describe("Pagination and the 100-ID limit on /applications (CR7-01, F9 step 1: 25 rows per page)", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => readyApplication({ requisitionId: `R-${1000 + i}`, roleTitle: `Engineer ${i + 1}` }))
  const deleteRequests = (api: { requests: { path: string; body: unknown }[] }) =>
    api.requests.filter((r) => r.path === "/v1/applications/delete-details").map((r) => (r.body as { applicationIds: string[] }).applicationIds)

  it("with 101 Applications, select all selects only this page (25) and the delete sends at most 100 IDs and succeeds", async () => {
    const apps = many(101)
    const { user, controlsApi } = open("/applications?view=list", apps)
    await user.click(await screen.findByRole("checkbox", { name: "Select all on this page" }))
    await user.click(await screen.findByRole("button", { name: "Delete detailed records (25)" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete detailed records for 25 Applications?" })
    await user.click(within(dialog).getByRole("button", { name: "Delete records" }))
    expect(await findToast("Detailed records deleted for 25 Application(s).")).toBeInTheDocument()
    const sent = deleteRequests(controlsApi)
    expect(sent.length).toBeGreaterThan(0)
    for (const ids of sent) expect(ids.length).toBeLessThanOrEqual(100)
    expect(sent.flat().sort()).toEqual(apps.slice(0, 25).map((a) => a.id).sort())
    expect(controlsApi.state.records).toHaveLength(25)
  }, 20_000)

  it("shows 25 rows per page with page controls; the next page shows the rest and select all covers only it", async () => {
    const apps = many(30)
    const { user } = open("/applications?view=list", apps)
    const nav = await screen.findByRole("navigation", { name: "Pagination" })
    expect(within(nav).getByText("Page 1 of 2")).toBeVisible()
    expect(within(nav).getByRole("button", { name: "Previous page" })).toBeDisabled()
    const table = () => screen.getByRole("region", { name: "Applications, scrolls horizontally" })
    expect(within(table()).getAllByRole("checkbox")).toHaveLength(25)
    await user.click(within(nav).getByRole("button", { name: "Next page" }))
    expect(within(nav).getByText("Page 2 of 2")).toBeVisible()
    expect(within(nav).getByRole("button", { name: "Next page" })).toBeDisabled()
    expect(within(table()).getAllByRole("checkbox")).toHaveLength(5)
    expect(within(table()).getByText("Engineer 26 at Acme Payments", { exact: false })).toBeInTheDocument()
    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }))
    expect(await screen.findByRole("button", { name: "Delete detailed records (5)" })).toBeVisible()
  }, 20_000)

  it("25 or fewer Applications: no page controls", async () => {
    open("/applications?view=list", many(25))
    await screen.findByRole("checkbox", { name: "Select all on this page" })
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument()
  })
})

describe("Data and privacy: retention and minimal records (F10 retention step 3)", () => {
  it("shows C-RET-1 (C-DATA-1 is retired by slice 9), C-DATA-2 and the minimal records table with Clear", async () => {
    const record: MinimalRecord = {
      applicationId: APP,
      company: "Acme Payments",
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1042",
      requisitionId: "R-1042",
      createdAt: "2026-10-01T10:00:00.000Z",
      detailsDeletedAt: "2026-10-16T10:00:00.000Z",
      finalStatus: "rejection",
    }
    const { user, controlsApi } = open("/privacy#records", [], { records: [record] })
    expect(await screen.findByText(/^Detailed records are deleted automatically 12 months after creation/)).toBeVisible()
    const section = await screen.findByRole("region", { name: "Minimal requisition records" })
    expect(section).toHaveTextContent("After detailed records are deleted, a minimal record (company, URL, requisition ID, date, final status) stays")
    const row = (await within(section).findAllByText("R-1042"))[0].closest("tr, li") as HTMLElement
    expect(row).toHaveTextContent("Acme Payments")
    expect(row).toHaveTextContent("Rejection")
    await user.click(within(row).getByRole("button", { name: "Clear R-1042 at Acme Payments" }))
    await user.click(within(await screen.findByRole("alertdialog", { name: "Clear this record?" })).getByRole("button", { name: "Clear record" }))
    expect(await within(section).findByText("No minimal records.")).toBeVisible()
    expect(controlsApi.requests).toContainEqual({ method: "DELETE", path: `/v1/minimal-records/${APP}`, body: null })
  })

  it("no minimal records: C-EMPTY-6", async () => {
    open("/privacy", [])
    const section = await screen.findByRole("region", { name: "Minimal requisition records" })
    expect(await within(section).findByText("No minimal records.")).toBeVisible()
  })
})
