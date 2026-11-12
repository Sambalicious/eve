import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { beforeEach, describe, expect, it } from "vitest"

import { LEADS_PATH } from "@eve/contracts"
import { server, signedInSession } from "@/shared/testing"
import { renderApp } from "./test-app"

/**
 * v1.29.0 Pipeline page: the Candidate's own stages. Four columns, one-click
 * "Mark applied" with Undo, a stage selector, and removal. Eve sends nothing
 * from here.
 */
const lead = (overrides: Partial<Record<string, unknown>> = {}) => ({
  jobPostingId: crypto.randomUUID(),
  stage: "saved",
  stageChangedAt: "2026-11-10T09:00:00.000Z",
  roleTitle: "Senior Frontend Engineer",
  company: "Acme Payments",
  roleFamily: "senior_frontend",
  postingStatus: "ranked",
  skipReason: null,
  applicationSystem: "greenhouse",
  applicationId: null,
  ...overrides,
})

let leads: ReturnType<typeof lead>[]
let calls: { method: string; path: string; body: unknown }[]

beforeEach(() => {
  leads = [
    lead({ roleTitle: "Saved role", stage: "saved" }),
    lead({ roleTitle: "Applied role", stage: "applied" }),
    lead({ roleTitle: "Offer role", stage: "offer" }),
  ]
  calls = []
  server.use(
    signedInSession,
    http.get(LEADS_PATH, () => HttpResponse.json({ leads })),
    http.put("/v1/leads/:id", async ({ request, params }) => {
      const body = (await request.json()) as { stage: string }
      calls.push({ method: "PUT", path: `/v1/leads/${String(params.id)}`, body })
      const moved = leads.find((candidate) => candidate.jobPostingId === params.id)!
      moved.stage = body.stage
      return HttpResponse.json(moved)
    }),
    http.delete("/v1/leads/:id", ({ params }) => {
      calls.push({ method: "DELETE", path: `/v1/leads/${String(params.id)}`, body: null })
      leads = leads.filter((candidate) => candidate.jobPostingId !== params.id)
      return new HttpResponse(null, { status: 204 })
    })
  )
})

describe("Pipeline page", () => {
  it("puts each lead in its column, with one Closed column for Offer", async () => {
    renderApp("/pipeline")
    expect(await screen.findByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible()
    const saved = await screen.findByRole("region", { name: "Saved" })
    const applied = screen.getByRole("region", { name: "Applied" })
    const closed = screen.getByRole("region", { name: "Closed" })
    expect(within(saved).getByText("Saved role")).toBeVisible()
    expect(within(applied).getByText("Applied role")).toBeVisible()
    expect(within(closed).getByText("Offer role")).toBeVisible()
    // Only a Saved card offers the one-click move.
    expect(within(saved).getByRole("button", { name: /Mark applied/ })).toBeVisible()
    expect(within(applied).queryByRole("button", { name: /Mark applied/ })).toBeNull()
  })

  it("marks applied in one click and offers Undo back to the previous stage", async () => {
    const user = userEvent.setup({ delay: null })
    renderApp("/pipeline")
    const saved = await screen.findByRole("region", { name: "Saved" })
    await user.click(await within(saved).findByRole("button", { name: /Mark applied/ }))
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { stage: "applied" } })
    expect(await screen.findByText("Saved role marked applied.")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Undo" }))
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { stage: "saved" } })
  })

  it("moves a lead through the stage selector", async () => {
    const user = userEvent.setup({ delay: null })
    renderApp("/pipeline")
    const applied = await screen.findByRole("region", { name: "Applied" })
    await user.selectOptions(within(applied).getByRole("combobox", { name: /Stage: Applied role/ }), "interviewing")
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { stage: "interviewing" } })
  })

  it("removes a lead from the pipeline", async () => {
    const user = userEvent.setup({ delay: null })
    renderApp("/pipeline")
    const saved = await screen.findByRole("region", { name: "Saved" })
    await user.click(within(saved).getByRole("button", { name: /Remove from pipeline: Saved role/ }))
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" })
    expect(await screen.findByText("Saved role removed from your pipeline.")).toBeVisible()
  })
})
