import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { awaitingSample, blocked, server, submissionStatus, uncertain } from "@/shared/testing"
import { entry, openSubmission } from "./submission-helpers"

const C_GATE_1 =
  "Automatic submission stays off until you approve your Career Profile, mark existing applications complete, and approve 5 sample Applications."
const C_CAP_5 =
  "Counts Confirmed Submissions sent automatically today (WAT). Manual Applications, approved samples and unresolved Uncertain Submissions don't count."

const needsYou = async () => (await screen.findByRole("heading", { name: "Needs you" })).closest('[data-slot="card"]') as HTMLElement
const capCard = async () => (await screen.findByRole("heading", { name: "Today's cap" })).closest('[data-slot="card"]') as HTMLElement

describe("Home: automation status, today's cap and Needs you", () => {
  it("a new installation: automatic submission is off with C-GATE-1, 0 of 5 today, every Needs you row 'None'", async () => {
    openSubmission("/dashboard", [], { status: submissionStatus({ countingSamples: 0 }) })
    expect(await screen.findByRole("heading", { name: "Automatic submission is off" })).toBeVisible()
    expect(screen.getByText(C_GATE_1)).toBeVisible()
    const cap = await capCard()
    expect(cap).toHaveTextContent("0of 5 automatic submissions today")
    expect(cap).toHaveTextContent(C_CAP_5)
    const list = await needsYou()
    for (const name of ["Samples awaiting review", "Blocked Applications", "Uncertain Submissions"]) {
      expect(within(list).getByRole("link", { name: `${name}, None` })).toBeVisible()
    }
  })

  it("counts what needs the Candidate, each row linking to its list", async () => {
    openSubmission("/dashboard", [
      entry(awaitingSample(), { roleTitle: "Sample" }),
      entry(blocked("login", "x"), { roleTitle: "B1" }),
      entry(blocked("same_company_review", "x"), { roleTitle: "B2" }),
      entry(uncertain(), { roleTitle: "U1" }),
    ])
    const list = await needsYou()
    expect(await within(list).findByRole("link", { name: "Samples awaiting review, 1" })).toHaveAttribute("href", "/activation")
    expect(within(list).getByRole("link", { name: "Blocked Applications, 2" })).toHaveAttribute("href", "/blocked")
    expect(within(list).getByRole("link", { name: "Uncertain Submissions, 1" })).toHaveAttribute("href", "/uncertain")
    expect(await screen.findByRole("link", { name: "Check first sends, 1" })).toBeVisible()
  })

  it("after the gate passed the samples row is gone; on shows C-GATE-4", async () => {
    openSubmission("/dashboard", [], { status: submissionStatus({ countingSamples: 5, gatePassedAt: "2026-10-21T13:30:00.000Z", automaticEnabled: true }) })
    expect(await screen.findByRole("heading", { name: "Automatic submission is on" })).toBeVisible()
    expect(screen.getByText("The assistant submits up to 5 Applications per WAT day. Pause any time.")).toBeVisible()
    expect(within(await needsYou()).queryByText("Samples awaiting review")).not.toBeInTheDocument()
  })

  it("the cap reached with postings queued: C-CAP-6 and C-CAP-8 with 'See them'", async () => {
    openSubmission("/dashboard", [], { status: submissionStatus({ todayCount: 5, queuedForTomorrow: 2 }) })
    const cap = await capCard()
    expect(cap).toHaveTextContent("Today's cap is reached. Automatic submission resumes at 00:00 WAT.")
    expect(cap).toHaveTextContent("2 Job Posting(s) queued for tomorrow.")
    expect(within(cap).getByRole("link", { name: "See them" })).toHaveAttribute("href", "/postings?tab=good")
    expect(within(cap).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5")
  })

  it("over the cap after a late confirmation: C-CAP-2, bar stays full", async () => {
    openSubmission("/dashboard", [], { status: submissionStatus({ todayCount: 6 }) })
    const cap = await capCard()
    expect(cap).toHaveTextContent("6 of 5. A late confirmation counted toward the day it was submitted.")
    expect(within(cap).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5")
  })

  it("while paused the status card reads 'Paused'", async () => {
    openSubmission("/dashboard", [], { status: submissionStatus({ globalPaused: true }) })
    expect(await screen.findByRole("heading", { name: "Paused" })).toBeVisible()
  })

  it("counts come from one GET /v1/submissions/summary; no per-Application reads and no list fetch (FE5-B1)", async () => {
    const paths: string[] = []
    server.events.on("request:start", ({ request }) => void paths.push(new URL(request.url).pathname + new URL(request.url).search))
    openSubmission("/dashboard", [entry(awaitingSample(), { roleTitle: "S" }), entry(blocked("login", "x"), { roleTitle: "B" })])
    expect(await within(await needsYou()).findByRole("link", { name: "Blocked Applications, 1" })).toBeVisible()
    server.events.removeAllListeners()
    expect(paths).toContain("/v1/submissions/summary")
    expect(paths.filter((p) => p.endsWith("/submission"))).toEqual([])
    expect(paths.filter((p) => p.startsWith("/v1/submissions?"))).toEqual([])
    expect(paths.filter((p) => p.startsWith("/v1/samples"))).toEqual([])
  })
})
