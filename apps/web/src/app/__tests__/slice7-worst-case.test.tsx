import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { MinimalRecord } from "@eve/contracts"
import { controls, costPause, createControlsApi, readyApplication, server, type ControlsApiState } from "@/shared/testing"
import { openDocuments } from "./documents-helpers"

/** break-ui pass: realistic worst-case values through the same MSW boundary as the demo data. */
const LONG_COMPANY = "Northwind Industries Holdings (Europe, Middle East and Africa) Limited"
const LONG_URL = "https://boards.greenhouse.io/northwindindustriesholdingsemea/jobs/4012345678901234567?gh_src=8f3a2b1c9d&utm_source=linkedin&utm_medium=jobs"
const LONG_REQ = "NWIH-EMEA-2026-PLATFORM-FRONTEND-ENGINEERING-SENIOR-0000412"

function open(path: string, initial: Partial<ControlsApiState> = {}) {
  const view = openDocuments(path, { applications: [] })
  server.use(...createControlsApi(initial).handlers)
  return view
}

const record = (i: number, o: Partial<MinimalRecord> = {}): MinimalRecord => ({
  applicationId: `50000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  company: i % 3 === 0 ? null : i % 3 === 1 ? LONG_COMPANY : "Jo",
  applicationUrl: LONG_URL,
  requisitionId: i % 2 ? LONG_REQ : "A",
  createdAt: "2026-10-01T10:00:00.000Z",
  detailsDeletedAt: "2026-10-16T10:00:00.000Z",
  finalStatus: i % 4 === 0 ? "some_future_state" : "rejection",
  ...o,
})

describe("Slice 7 worst case (break-ui)", () => {
  it("spend over the ceiling and at the USD 100.00 limit: the bar is capped and every number still prints", async () => {
    open("/dashboard", { controls: controls({ costPause: costPause({ nextAction: null, nextActionEstimate: null }), spend: { spent: "100.00", ceiling: "100.00", raised: true, canRaise: false, percentUsed: 250 } }) })
    const card = (await screen.findByRole("heading", { name: "Spend" })).closest('[data-slot="card"]') as HTMLElement
    expect(within(card).getByRole("progressbar", { name: "USD 100.00 of USD 100.00 spent this month" })).toHaveAttribute("aria-valuenow", "100")
    expect(card).toHaveTextContent("You've used 250% of this month's ceiling.")
    expect(screen.getByText(/^Eve has paused checks until/)).toBeVisible()
  })

  it("100 minimal records with null, one-letter and long companies, long URLs and IDs, and an unknown final status", async () => {
    open("/privacy#records", { records: Array.from({ length: 100 }, (_, i) => record(i)) })
    const section = await screen.findByRole("region", { name: "Minimal requisition records" })
    const table = await within(section).findByRole("region", { name: "Minimal requisition records, scrolls horizontally" })
    expect(await within(table).findAllByRole("row")).toHaveLength(101)
    // Null company falls back to the requisition ID in the Clear button's name; unknown statuses print as sent.
    expect(within(table).getAllByRole("button", { name: `Clear A at A` }).length).toBeGreaterThan(0)
    expect(within(table).getAllByText("some_future_state").length).toBeGreaterThan(0)
  })

  it("a minimal record with no company and a long requisition ID still has a heading and Clear record", async () => {
    const app = readyApplication({ company: null, roleTitle: null, requisitionId: LONG_REQ, applicationUrl: LONG_URL, documents: [], detailsDeletedAt: "2026-10-16T10:00:00.000Z" })
    const view = openDocuments(`/applications/${app.id}`, { applications: [app] })
    server.use(...createControlsApi({ applications: view.api.state.applications }).handlers)
    expect(await screen.findByRole("heading", { level: 1, name: LONG_REQ })).toBeVisible()
    expect(screen.getByText(LONG_URL)).toBeVisible()
    expect(screen.getByRole("button", { name: "Clear record" })).toBeVisible()
  })
})
