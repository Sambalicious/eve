import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it, vi } from "vitest"

import { RETENTION_PATH, type ApplicationDetail, type MinimalRecord, type RetentionResponse } from "@eve/contracts"
import {
  apiErrorResponse,
  controls,
  createControlsApi,
  readyApplication,
  retention,
  server,
  uncertain,
  type ControlsApiState,
  type DocumentsState,
} from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openDocuments } from "./documents-helpers"
import { entry, openSubmission } from "./submission-helpers"

// gherkin/automatic-expiry.feature, the web surfaces of E5.* (plus E3.1, E3.8,
// E4.6 and E6.4 where they show on /privacy). Strings come from
// copy-deck-12-month-expiry.md; the PRD's verbatim ones are asserted exactly.

const RULE = /^Detailed records are deleted automatically 12 months after creation, on the same date one year later\..*Minimal records stay to block duplicates\.$/
const FAILED_20_OCT = "Automatic deletion failed on 20 Oct 2026. It will try again tomorrow."

const id = (n: number) => `30000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`
const app = (requisitionId: string, expiresOn: string | null, o: Partial<ApplicationDetail> = {}) =>
  readyApplication({ id: id(requisitionId.charCodeAt(0) * 10 + requisitionId.length), requisitionId, roleTitle: `Engineer ${requisitionId}`, expiresOn, ...o })

function open(
  path: string,
  apps: ApplicationDetail[] = [],
  initial: Partial<ControlsApiState> = {},
  documents: Partial<Omit<DocumentsState, "applications">> = {}
) {
  const view = openDocuments(path, { applications: apps, ...documents })
  const controlsApi = createControlsApi({ applications: view.api.state.applications, ...initial })
  server.use(...controlsApi.handlers)
  return { ...view, controlsApi }
}

const retentionRegion = () => screen.findByRole("region", { name: "Retention" })
/** The region once the facts have loaded (the due row's label always shows). */
async function retentionFacts() {
  const region = await retentionRegion()
  await within(region).findByText("Due in the next 30 days")
  return region
}
const facts = (o: Partial<RetentionResponse>) => ({ retention: retention(o) })
/** CR9-02 (WCAG 2.5.3): no aria-label; the visible text first, the rest of the name sr-only after it. */
function expectLabelInName(link: HTMLElement, visible: string, srOnly: string) {
  expect(link).not.toHaveAttribute("aria-label")
  const hidden = link.querySelector("[data-name-suffix]")
  expect(hidden).toHaveTextContent(srOnly)
  expect(link.textContent).toBe(visible + srOnly)
  expect(link.textContent?.startsWith(visible)).toBe(true)
}
/** Data rows of the md+ table (the body rows, header excluded). */
const tableRows = () => within(screen.getByRole("region", { name: "Applications, scrolls horizontally" })).getAllByRole("row").slice(1)
const listedRequisitions = () => tableRows().map((row) => within(row).getAllByRole("cell")[2].textContent)

describe("E5.1 the Retention rule (C-RET-1 replaces C-DATA-1)", () => {
  it("EPIC-0007 C-DATA-1 (Phase 3): the Retention section states the Stack posts and Hiring posts limits", async () => {
    open("/privacy")
    const region = await retentionRegion()
    expect(
      within(region).getByText(
        "Eve deletes posts from your field and Hiring posts 90 days after it first finds them, and keeps no more than your newest 2,000 of each."
      )
    ).toBeVisible()
    expect(within(region).getByText(RULE)).toBeVisible()
    expect(region).not.toHaveTextContent("Outcomes stay until you delete them")
  })

  it("@ac-E5.1 says detailed records go automatically 12 months after creation, minimal records stay, and no longer says nothing is deleted", async () => {
    open("/privacy")
    const region = await retentionRegion()
    expect(within(region).getByText(RULE)).toBeVisible()
    expect(region).not.toHaveTextContent("Nothing is deleted automatically.")
    expect(screen.queryByText(/Nothing is deleted automatically/)).not.toBeInTheDocument()
  })

  it("@ac-E3.1 @ac-E3.8 offers no setting or control to turn automatic expiry off, and no action to run it now", async () => {
    open("/privacy", [], facts({ dueNext30Days: { count: 2, earliestOn: "2026-10-24" } }))
    const region = await retentionFacts()
    expect(within(region).queryByRole("switch")).not.toBeInTheDocument()
    expect(within(region).queryByRole("checkbox")).not.toBeInTheDocument()
    expect(within(region).queryByRole("button")).not.toBeInTheDocument()
  })
})

describe("E5.2 due in the next 30 days", () => {
  it("@ac-E5.2 shows 3 Applications due and the earliest expiry date 24 Oct 2026, with a link to them", async () => {
    open("/privacy", [], facts({ dueNext30Days: { count: 3, earliestOn: "2026-10-24" } }))
    const region = await retentionFacts()
    expect(within(region).getByText("3 Applications, the first on 24 Oct 2026")).toBeVisible()
    const link = within(region).getByRole("link", { name: "Show these Applications, 3 due in the next 30 days" })
    expectLabelInName(link, "Show these Applications", ", 3 due in the next 30 days")
    expect(link).toHaveAttribute("href", "/applications?retention=due")
  })

  it("1 due reads in the singular (C-RET-3 one, C-RET-5 one, C-RET-A1 one)", async () => {
    open("/privacy", [], facts({ dueNext30Days: { count: 1, earliestOn: "2026-10-24" } }))
    const region = await retentionFacts()
    expect(within(region).getByText("1 Application, on 24 Oct 2026")).toBeVisible()
    expectLabelInName(within(region).getByRole("link", { name: "Show this Application, due in the next 30 days" }), "Show this Application", ", due in the next 30 days")
  })

  it("a count with no date (contract bug) shows the count alone, never 'on null'; 1,250 is grouped", async () => {
    open("/privacy", [], facts({ dueNext30Days: { count: 1250, earliestOn: null } }))
    const region = await retentionFacts()
    expect(within(region).getByText("1,250 Applications")).toBeVisible()
    expect(region).not.toHaveTextContent("null")
  })

  it.each([
    ["@empty-state the only Application expires after the window", [app("R-1042", "2026-11-20")]],
    ["@empty-state a new Candidate with no Applications", []],
  ])("@ac-E5.2 %s: the no-records line and no earliest date or link", async (_, apps) => {
    open("/privacy", apps)
    const region = await retentionFacts()
    expect(within(region).getByText("No Applications are due in the next 30 days.")).toBeVisible()
    expect(region).not.toHaveTextContent(/\d{1,2} [A-Z][a-z]{2} \d{4}/)
    expect(within(region).queryByRole("link", { name: /due in the next 30 days/ })).not.toBeInTheDocument()
  })

  it("@ac-E5.2 @ac-E5.6 an Application record shows its expiry date while its details exist", async () => {
    const r = app("R-1042", "2026-10-20", { createdAt: "2025-10-19T23:30:00Z" })
    open(`/applications/${r.id}`, [r])
    const header = (await screen.findByRole("heading", { level: 1, name: "Engineer R-1042 at Acme Payments" })).closest("header") as HTMLElement
    const item = within(header).getByText("Detailed records expire").parentElement as HTMLElement
    expect(within(item).getByText("20 Oct 2026")).toHaveAttribute("datetime", "2026-10-20")
  })

  it("@ac-E5.2 @ac-E5.6 a record deleted by automatic expiry shows the minimal record view with C-RET-19 and no expiry date", async () => {
    const r = app("R-1042", null, { roleTitle: null, documents: [], detailsDeletedAt: "2026-10-20T02:00:00.000Z" })
    const record: MinimalRecord = {
      applicationId: r.id,
      company: "Acme Payments",
      applicationUrl: r.applicationUrl,
      requisitionId: "R-1042",
      createdAt: "2025-10-19T23:30:00.000Z",
      detailsDeletedAt: "2026-10-20T02:00:00.000Z",
      finalStatus: "confirmed",
      deletedBy: "expiry",
    }
    open(`/applications/${r.id}`, [r], { records: [record] })
    expect(
      await screen.findByText("Detailed records were deleted automatically on 20 Oct 2026, after 12 months. This minimal record still blocks duplicate Applications.")
    ).toBeVisible()
    expect(screen.queryByText(/^Detailed records were deleted on/)).not.toBeInTheDocument()
    expect(screen.queryByText("Detailed records expire")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear record" })).toBeVisible()
  })

  it("a record the Candidate deleted keeps C-DATA-3 on the minimal record view", async () => {
    const r = app("L-77", null, { roleTitle: null, documents: [], detailsDeletedAt: "2026-03-02T10:00:00.000Z" })
    const record: MinimalRecord = {
      applicationId: r.id,
      company: "Acme Payments",
      applicationUrl: r.applicationUrl,
      requisitionId: "L-77",
      createdAt: r.createdAt,
      detailsDeletedAt: "2026-03-02T10:00:00.000Z",
      finalStatus: "rejection",
      deletedBy: "candidate",
    }
    open(`/applications/${r.id}`, [r], { records: [record] })
    expect(await screen.findByText("Detailed records were deleted on 2 Mar 2026. This minimal record still blocks duplicate Applications.")).toBeVisible()
  })
})

describe("E5.3 who deleted each minimal record", () => {
  const minimal = (requisitionId: string, n: number, deletedBy: MinimalRecord["deletedBy"]): MinimalRecord => ({
    applicationId: id(n),
    company: "Acme Payments",
    applicationUrl: `https://boards.greenhouse.io/acme/jobs/${requisitionId}`,
    requisitionId,
    createdAt: "2025-10-20T08:15:00.000Z",
    detailsDeletedAt: "2026-10-20T02:00:00.000Z",
    finalStatus: "confirmed",
    ...(deletedBy && { deletedBy }),
  })
  const rowFor = (section: HTMLElement, requisitionId: string, tag: "tr" | "li") =>
    within(section).getAllByText(requisitionId).map((cell) => cell.closest(tag)).find(Boolean) as HTMLElement

  it("@ac-E5.3 @ac-E6.1 L-77 shows 'You' and R-1042 'Automatic, 12 months', in the table column and the narrow-screen line", async () => {
    open("/privacy#records", [], { records: [minimal("L-77", 1, "candidate"), minimal("R-1042", 2, "expiry")] })
    const section = await screen.findByRole("region", { name: "Minimal requisition records" })
    await within(section).findAllByText("R-1042")
    const headers = within(section).getAllByRole("columnheader").map((h) => h.textContent)
    expect(headers.slice(4, 6)).toEqual(["Final status", "Deleted by"])
    expect(within(rowFor(section, "L-77", "tr")).getAllByRole("cell")[5]).toHaveTextContent(/^You$/)
    expect(within(rowFor(section, "R-1042", "tr")).getAllByRole("cell")[5]).toHaveTextContent(/^Automatic, 12 months$/)
    expect(rowFor(section, "L-77", "li")).toHaveTextContent("20 Oct 2025 · Confirmed Submission · You")
    expect(rowFor(section, "R-1042", "li")).toHaveTextContent("20 Oct 2025 · Confirmed Submission · Automatic, 12 months")
    // DR9 NOTE: the line wraps only after a " · ", never inside a fragment ("12 / months").
    const fragments = [...rowFor(section, "R-1042", "li").querySelectorAll("[data-meta-fragment]")].map((f) => f.textContent)
    expect(fragments).toEqual(["20 Oct 2025", "Confirmed Submission", "Automatic, 12 months"])
    for (const f of rowFor(section, "R-1042", "li").querySelectorAll("[data-meta-fragment]")) expect(f).toHaveClass("inline-block")
    // DR9-02: in the table, "Automatic, 12 months" may wrap only at the comma.
    const parts = [...within(rowFor(section, "R-1042", "tr")).getAllByRole("cell")[5].querySelectorAll(".whitespace-nowrap")].map((p) => p.textContent)
    expect(parts).toEqual(["Automatic,", "12 months"])
  })

  // B-5 has no stored value; the api sends `candidate` for it (contract v1.17.0,
  // apps/api retention.int-spec), so the page receives what A-9 receives.
  it.each([
    ["@ac-E5.3 A-9, backfilled as 'candidate', shows 'You'", "A-9"],
    ["@boundary @ac-E5.3 B-5, with no value for who deleted it (sent as 'candidate'), shows 'You'", "B-5"],
  ])("%s", async (_, requisitionId) => {
    open("/privacy#records", [], { records: [minimal(requisitionId, 3, "candidate")] })
    const section = await screen.findByRole("region", { name: "Minimal requisition records" })
    await within(section).findAllByText(requisitionId)
    expect(within(rowFor(section, requisitionId, "tr")).getAllByRole("cell")[5]).toHaveTextContent(/^You$/)
  })

  it("an older api with no deletedBy field: the cell is empty and the narrow line drops it; the UI never guesses 'You'", async () => {
    open("/privacy#records", [], { records: [minimal("Z-1", 4, undefined)] })
    const section = await screen.findByRole("region", { name: "Minimal requisition records" })
    await within(section).findAllByText("Z-1")
    expect(within(rowFor(section, "Z-1", "tr")).getAllByRole("cell")[5]).toHaveTextContent(/^$/)
    expect(rowFor(section, "Z-1", "li")).toHaveTextContent("20 Oct 2025 · Confirmed Submission")
    expect(rowFor(section, "Z-1", "li")).not.toHaveTextContent("You")
  })

  it("a manual deletion becomes a minimal record deleted by 'You' (E3.6, E5.3)", async () => {
    const r = app("R-1042", "2026-10-20")
    const { user } = open(`/applications/${r.id}`, [r])
    await user.click(await screen.findByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete detailed records" }))
    await user.click(within(await screen.findByRole("alertdialog", { name: "Delete detailed records?" })).getByRole("button", { name: "Delete records" }))
    expect(await screen.findByText(/^Detailed records were deleted on/)).toBeVisible()
    expect(screen.queryByText("Detailed records expire")).not.toBeInTheDocument()
  })
})

describe("E5.5 waiting for your decision", () => {
  it.each([
    ["2026-11-18", 0, null],
    ["2026-11-19", 1, "1 record is past 12 months and waits for your decision"],
  ])("@boundary @ac-E5.5 on %s (waiting count %i) the row reads %s", async (_, count, line) => {
    open("/privacy", [], facts({ waitingForDecision: { count } }))
    const region = await retentionFacts()
    if (line === null) {
      expect(within(region).queryByText("Waiting for your decision")).not.toBeInTheDocument()
      expect(region).not.toHaveTextContent(/waits? for your decision/)
    } else {
      expect(within(region).getByText("Waiting for your decision")).toBeVisible()
      expect(within(region).getByText(line)).toBeVisible()
      expectLabelInName(within(region).getByRole("link", { name: "Review it, 1 record waiting for your decision" }), "Review it", ", 1 record waiting for your decision")
    }
  })

  it("@ac-E5.5 the link in '2 records are past 12 months and wait for your decision' opens the waiting list: R-1042 and L-77, not A-9", async () => {
    const r = app("R-1042", "2026-10-20", { createdAt: "2025-10-20T08:00:00.000Z" })
    const l = app("L-77", "2026-10-20", { createdAt: "2025-10-20T09:00:00.000Z" })
    const a = app("A-9", "2026-10-20", { state: "generating" })
    const { user, currentPath } = open("/privacy", [r, l, a], facts({ waitingForDecision: { count: 2 } }), {
      retention: { today: "2026-12-01", waiting: [r.id, l.id] },
    })
    const region = await retentionFacts()
    const line = within(region).getByText("2 records are past 12 months and wait for your decision")
    const link = within(line.closest("dd") as HTMLElement).getByRole("link", { name: "Review them, 2 records waiting for your decision" })
    expectLabelInName(link, "Review them", ", 2 records waiting for your decision")
    await user.click(link)
    await waitFor(() => expect(currentPath()).toBe("/applications?retention=waiting"))
    await waitFor(() => expect(listedRequisitions()).toEqual(["R-1042", "L-77"]))
  })
})

describe("E6.4 failed runs and the global pause on /privacy", () => {
  it.each([
    ["@sad @ac-E6.4 the run on 20 Oct failed", { lastRun: { watDate: "2026-10-20", outcome: "failed", deletedCount: 0 }, lastFailure: { watDate: "2026-10-20" } }, true],
    ["@boundary @ac-E6.4 a paused run on 21 Oct does not clear it", { lastRun: { watDate: "2026-10-21", outcome: "skipped_global_paused", deletedCount: 0 }, lastFailure: { watDate: "2026-10-20" } }, true],
    ["@happy @ac-E6.4 a completed run on 21 Oct clears it", { lastRun: { watDate: "2026-10-21", outcome: "completed", deletedCount: 0 }, lastFailure: null }, false],
  ] as const)("%s", async (_, state, shown) => {
    open("/privacy", [], facts(state))
    const region = await retentionFacts()
    if (shown) expect(within(region).getByRole("status")).toHaveTextContent(FAILED_20_OCT)
    else expect(region).not.toHaveTextContent(/Automatic deletion failed/)
  })

  it("@ac-E3.3 while automation is paused the section says deletion waits (C-RET-10)", async () => {
    open("/privacy", [], { controls: controls({ globalPaused: true, globalPausedAt: "2026-10-20T08:00:00.000Z" }) })
    const region = await retentionFacts()
    expect(within(region).getByText("Automatic deletion is paused with automation. It catches up after you resume.")).toBeVisible()
  })

  it("no pause: no paused note", async () => {
    open("/privacy")
    const region = await retentionFacts()
    expect(region).not.toHaveTextContent("paused with automation")
  })
})

describe("E4.6 launch grace on /privacy (C-RET-22, DR9-02)", () => {
  const graceLine = (region: HTMLElement) => within(region).queryByText((_, el) => el?.tagName === "P" && /^Automatic deletion starts on /.test(el.textContent ?? ""))

  it("@ac-E4.6 @ac-E5.6 with nothing due, the Retention section shows that automatic deletion starts on 1 Dec 2026", async () => {
    open("/privacy", [], facts({ graceEndsOn: "2026-12-01" }))
    const region = await retentionFacts()
    const line = graceLine(region)
    expect(line).toHaveTextContent("Automatic deletion starts on 1 Dec 2026.")
    expect(within(line as HTMLElement).getByText("1 Dec 2026")).toHaveAttribute("datetime", "2026-12-01")
    expect(within(region).getByText("No Applications are due in the next 30 days.")).toBeVisible()
    expect(within(line as HTMLElement).queryByRole("link")).not.toBeInTheDocument()
    expect(within(line as HTMLElement).queryByRole("button")).not.toBeInTheDocument()
  })

  it("@ac-E4.6 @ac-E5.6 with 12 due, the grace line shows and the due row keeps the grace date (C-RET-3, D-E5)", async () => {
    open("/privacy", [], facts({ graceEndsOn: "2026-12-01", dueNext30Days: { count: 12, earliestOn: "2026-12-01" } }))
    const region = await retentionFacts()
    expect(graceLine(region)).toHaveTextContent("Automatic deletion starts on 1 Dec 2026.")
    expect(within(region).getByText("12 Applications, the first on 1 Dec 2026")).toBeVisible()
  })

  it("after the grace (graceEndsOn null) there is no grace line", async () => {
    open("/privacy", [], facts({ dueNext30Days: { count: 2, earliestOn: "2026-10-24" } }))
    const region = await retentionFacts()
    expect(graceLine(region)).toBeNull()
  })

  it("order: failed alert, paused note, grace line, then the due row", async () => {
    open("/privacy", [], {
      ...facts({ graceEndsOn: "2026-12-01", lastRun: { watDate: "2026-10-20", outcome: "failed", deletedCount: 0 }, lastFailure: { watDate: "2026-10-20" } }),
      controls: controls({ globalPaused: true, globalPausedAt: "2026-10-20T08:00:00.000Z" }),
    })
    const region = await retentionFacts()
    const text = region.textContent ?? ""
    const at = (s: string) => text.indexOf(s)
    expect(at("Automatic deletion failed")).toBeGreaterThan(-1)
    expect(at("Automatic deletion failed")).toBeLessThan(at("paused with automation"))
    expect(at("paused with automation")).toBeLessThan(at("Automatic deletion starts on"))
    expect(at("Automatic deletion starts on")).toBeLessThan(at("Due in the next 30 days"))
  })
})

describe("E5.6 the retention data fails to load (F-R5)", () => {
  it("the rule stays; the facts area shows C-ERR-1 and 'Try again' loads them", async () => {
    const { user } = open("/privacy", [], facts({ dueNext30Days: { count: 2, earliestOn: "2026-10-24" } }))
    let fail = true
    server.use(http.get(RETENTION_PATH, () => (fail ? apiErrorResponse("internal_error") : undefined)))
    const region = await retentionRegion()
    expect(within(region).getByText(RULE)).toBeVisible()
    expect(await within(region).findByText("Couldn't load this page.", {}, { timeout: 10_000 })).toBeVisible()
    fail = false
    await user.click(within(region).getByRole("button", { name: "Try again" }))
    expect(await within(region).findByText("2 Applications, the first on 24 Oct 2026")).toBeVisible()
  }, 20_000)
})

describe("E5.7 the Expires column", () => {
  it("@ac-E5.7 'Expires' comes right after 'Created'; R-1042 shows Created 20 Oct 2025 and Expires 20 Oct 2026", async () => {
    open("/applications?view=list", [app("R-1042", "2026-10-20", { createdAt: "2025-10-19T23:30:00Z" })])
    await screen.findByRole("checkbox", { name: "Select all on this page" })
    const table = screen.getByRole("region", { name: "Applications, scrolls horizontally" })
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent)
    expect(headers.slice(-2)).toEqual(["Created", "Expires"])
    const cells = within(tableRows()[0]).getAllByRole("cell")
    expect(cells.at(-2)).toHaveTextContent("20 Oct 2025")
    expect(cells.at(-1)).toHaveTextContent("20 Oct 2026")
    expect(within(cells.at(-1) as HTMLElement).getByText("20 Oct 2026")).toHaveAttribute("datetime", "2026-10-20")
  })

  it("@boundary @ac-E5.7 below 768px the row's details line shows 'Expires 20 Oct 2026' (row list; widths checked in the browser)", async () => {
    open("/applications?view=list", [app("R-1042", "2026-10-20", { createdAt: "2025-10-20T08:15:00.000Z" })])
    const list = await screen.findByRole("list", { name: "Applications" })
    const row = within(list).getAllByRole("listitem")[0]
    expect(within(row).getByText("Expires 20 Oct 2026")).toHaveAttribute("datetime", "2026-10-20")
    expect(row).toHaveTextContent("Created 20 Oct 2025 · Expires 20 Oct 2026")
  })

  it("an Application with no expiry date (older api) shows '—' with 'No expiry date' for screen readers", async () => {
    open("/applications?view=list", [app("R-1042", null)])
    await screen.findByRole("checkbox", { name: "Select all on this page" })
    const cell = within(tableRows()[0]).getAllByRole("cell").at(-1) as HTMLElement
    expect(within(cell).getByText("No expiry date")).toHaveClass("sr-only")
    expect(within(cell).getByText("—")).toHaveAttribute("aria-hidden", "true")
  })
})

describe("E5.7 the retention filters", () => {
  const dueFixture = () => [
    app("R-1042", "2026-11-03"),
    app("L-77", "2026-10-24"),
    app("A-9", "2026-11-19"),
    app("B-5", "2026-11-20"),
  ]

  it("@ac-E5.7 @ac-E5.2 following the due link lists L-77, R-1042 and A-9 in that order, not B-5", async () => {
    const { user, currentPath, api } = open("/privacy", dueFixture(), facts({ dueNext30Days: { count: 3, earliestOn: "2026-10-24" } }))
    void api
    const region = await retentionFacts()
    await user.click(within(region).getByRole("link", { name: "Show these Applications, 3 due in the next 30 days" }))
    await waitFor(() => expect(currentPath()).toBe("/applications?retention=due"))
    await waitFor(() => expect(listedRequisitions()).toEqual(["L-77", "R-1042", "A-9"]))
  })

  it("@ac-E5.7 @ac-E5.5 the waiting filter lists R-1042 and L-77 in that order, not A-9", async () => {
    const l = app("L-77", "2026-10-25")
    const r = app("R-1042", "2026-10-20")
    const a = app("A-9", "2026-11-15")
    open("/applications?retention=waiting", [l, r, a], {}, { retention: { today: "2026-12-01", waiting: [l.id, r.id, a.id] } })
    await waitFor(() => expect(listedRequisitions()).toEqual(["R-1042", "L-77"]))
  })

  it.each([
    ["due", "Due in the next 30 days, earliest first."],
    ["waiting", "Past 12 months, waiting for your decision, earliest first. Each is deleted after you decide."],
  ])("@ac-E5.7 the %s filter shows its notice with 'Show all Applications' before the list", async (filter, notice) => {
    const r = app("R-1042", "2026-10-24")
    open(`/applications?retention=${filter}`, [r], {}, { retention: { today: filter === "due" ? "2026-10-20" : "2026-12-01", waiting: filter === "due" ? [] : [r.id] } })
    const text = await screen.findByText((_, el) => el?.tagName === "P" && el.textContent === `${notice} Show all Applications`)
    const showAll = within(text).getByRole("link", { name: "Show all Applications" })
    expect(showAll).toHaveAttribute("href", "/applications?view=list")
    await screen.findByRole("checkbox", { name: "Select all on this page" })
    expect(text.compareDocumentPosition(screen.getByRole("checkbox", { name: "Select all on this page" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("@ac-E5.7 'Show all Applications' removes the filter and lists every Application whose details exist", async () => {
    const { user, currentPath } = open("/applications?retention=due", dueFixture())
    await waitFor(() => expect(listedRequisitions()).toEqual(["L-77", "R-1042", "A-9"]))
    await user.click(screen.getByRole("link", { name: "Show all Applications" }))
    await waitFor(() => expect(currentPath()).toBe("/applications?view=list"))
    await waitFor(() => expect(listedRequisitions()).toEqual(["R-1042", "L-77", "A-9", "B-5"]))
    expect(screen.queryByText("Due in the next 30 days, earliest first.")).not.toBeInTheDocument()
  })

  it("@ac-E5.7 bulk delete works inside the due filter", async () => {
    const { user, controlsApi } = open("/applications?retention=due", [app("L-77", "2026-10-24"), app("R-1042", "2026-11-03")])
    await waitFor(() => expect(listedRequisitions()).toEqual(["L-77", "R-1042"]))
    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }))
    await user.click(await screen.findByRole("button", { name: "Delete detailed records (2)" }))
    await user.click(within(await screen.findByRole("alertdialog", { name: "Delete detailed records for 2 Applications?" })).getByRole("button", { name: "Delete records" }))
    expect(await findToast("Detailed records deleted for 2 Application(s).")).toBeInTheDocument()
    expect(controlsApi.state.records.map((r) => r.requisitionId).sort()).toEqual(["L-77", "R-1042"])
    expect(await screen.findByText("No Applications match right now.")).toBeVisible()
  })

  it.each(["due", "waiting"])("@empty-state @ac-E5.7 the %s filter with no match says so and still offers 'Show all Applications'", async (filter) => {
    open(`/applications?retention=${filter}`, [app("R-1042", "2027-03-01")])
    expect(await screen.findByText("No Applications match right now.")).toBeVisible()
    expect(screen.getByRole("link", { name: "Show all Applications" })).toBeVisible()
    expect(screen.queryByText("Applications appear here once you prepare one. Paste a job on Home to start.")).not.toBeInTheDocument()
  })

  it.each(["overdue", "DUE", "", "due,waiting", "due&retention=waiting"])(
    "@validation @ac-E5.7 retention=%s shows the full list with no notice and no error",
    async (value) => {
      open(`/applications?retention=${value}`, [app("R-1042", "2026-10-24"), app("L-77", "2027-01-05")])
      await waitFor(() => expect(listedRequisitions()).toEqual(["R-1042", "L-77"]))
      expect(screen.queryByRole("link", { name: "Show all Applications" })).not.toBeInTheDocument()
      expect(screen.queryByText("Couldn't load this page.")).not.toBeInTheDocument()
    }
  )

  it("a failed filtered load shows C-ERR-1 under the notice", async () => {
    open("/applications?retention=due", [])
    server.use(http.get("/v1/applications", () => apiErrorResponse("internal_error")))
    expect(await screen.findByText("Couldn't load this page.", {}, { timeout: 10_000 })).toBeVisible()
    expect(screen.getByRole("link", { name: "Show all Applications" })).toBeVisible()
  }, 20_000)
})

describe("E5.8 and the detail suffixes past the date", () => {
  function openOn(today: string, path: string, entries: ReturnType<typeof entry>[]) {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(`${today}T12:00:00+01:00`))
    return openSubmission(path, entries)
  }
  const expireItem = async () => (await screen.findByText("Detailed records expire")).parentElement as HTMLElement

  it("@ac-E5.8 an Uncertain Submission 12 days past its date shows the date and 'Kept until you decide'", async () => {
    const e = entry(uncertain(), { requisitionId: "R-1042", expiresOn: "2026-10-20" })
    openOn("2026-11-01", `/applications/${e.app.id}`, [e])
    const item = await expireItem()
    await waitFor(() => expect(item).toHaveTextContent("20 Oct 2026. Kept until you decide."))
    expect(within(item).getByText("20 Oct 2026")).toHaveAttribute("datetime", "2026-10-20")
  })

  it("before its date a waiting record shows only the date", async () => {
    const e = entry(uncertain(), { requisitionId: "R-1042", expiresOn: "2026-10-20" })
    openOn("2026-10-19", `/applications/${e.app.id}`, [e])
    const item = await expireItem()
    await screen.findByText("Uncertain Submission")
    expect(item).toHaveTextContent(/^Detailed records expire20 Oct 2026$/)
  })

  it("@ac-E3.5 past its date while generating it says it goes once the current step finishes (C-RET-15b)", async () => {
    const r = app("A-9", "2026-10-20", { state: "generating", documents: [] })
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-21T12:00:00+01:00"))
    open(`/applications/${r.id}`, [r])
    const item = await expireItem()
    expect(item).toHaveTextContent("20 Oct 2026. Deleted once the current step finishes.")
  })
})
