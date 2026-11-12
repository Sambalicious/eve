import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { SUBMISSIONS_SUMMARY_PATH } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import {
  approvedState,
  createDiscoveryApi,
  draftSources,
  existingApplication,
  existingApplicationsHandler,
  notificationFailure,
  notificationStatusHandler,
  server,
  version,
} from "@/shared/testing"
import { openSignedIn } from "./career-setup-helpers"

function checklistRows() {
  const card = screen.getByRole("region", { name: "Set up Eve" })
  return within(card).getAllByRole("listitem")
}

describe("setup checklist on Home (F1)", () => {
  it("first run: approve Anthropic is next, and the profile item waits for it", async () => {
    openSignedIn("/dashboard")

    const card = await screen.findByRole("region", { name: "Set up Eve" })
    expect(within(card).getByText("0 of 5 done")).toBeVisible()
    const [ai, profile, answers] = checklistRows()
    expect(ai).toHaveTextContent("Approve Anthropic as your AI provider")
    expect(within(ai).getByRole("link", { name: "Start: Approve Anthropic as your AI provider" })).toHaveAttribute(
      "href",
      "/privacy#ai-provider"
    )
    expect(profile).toHaveTextContent("Upload your resume and approve your Career Profile")
    expect(profile).toHaveTextContent("Required for automatic submission")
    expect(profile).toHaveTextContent("Needs Anthropic approved first")
    // Start is a link with the link role, not a button (CR2-08).
    expect(within(ai).queryByRole("button")).not.toBeInTheDocument()
    expect(within(profile).queryByRole("link")).not.toBeInTheDocument()
    expect(within(answers).getByRole("link", { name: /^Start: Add Approved Answers/ })).toHaveAttribute("href", "/answers")
  })

  it("marks done items and offers Continue for a draft", async () => {
    openSignedIn("/dashboard", { ...approvedState(), versions: [version(1, "draft")] })

    await screen.findByText("1 of 5 done")
    const [ai, profile] = checklistRows()
    expect(ai).toHaveTextContent("Done")
    expect(within(profile).getByRole("link", { name: /^Continue: Upload your resume/ })).toHaveAttribute("href", "/profile")
  })

  it("item 4 (2026-10-30): Start with nothing recorded, Continue with one recorded, Done once marked complete", async () => {
    openSignedIn("/dashboard")
    await screen.findByText("0 of 5 done")
    const item = checklistRows()[3]
    expect(item).toHaveTextContent("Record existing applications and mark the step complete")
    expect(item).toHaveTextContent("Required for automatic submission")
    expect(within(item).getByRole("link", { name: "Start: Record existing applications and mark the step complete" })).toHaveAttribute(
      "href",
      "/existing-applications"
    )
  })

  it("item 4 reads Continue once one existing application is recorded", async () => {
    server.use(existingApplicationsHandler({ applications: [existingApplication()] }))
    openSignedIn("/dashboard")
    await screen.findByText("0 of 5 done")
    expect(within(checklistRows()[3]).getByRole("link", { name: /^Continue: Record existing applications/ })).toBeVisible()
  })

  it("item 4 is Done, as plain text, once the step is marked complete", async () => {
    server.use(existingApplicationsHandler({ completedAt: "2026-10-17T09:00:00.000Z" }))
    openSignedIn("/dashboard")
    await screen.findByText("1 of 5 done")
    const item = checklistRows()[3]
    expect(item).toHaveTextContent("Done")
    expect(within(item).queryByRole("link")).not.toBeInTheDocument()
  })

  it("hides once Anthropic, the Career Profile, Approved Answers with a gross-salary policy and the employer list are done", async () => {
    const draft = draftSources()
    const approvedList = { ...draft, employerList: { ...draft.employerList, status: "approved" as const, approvedAt: "2026-10-19T09:00:00.000Z" }, scheduledDiscoveryOn: true }
    server.use(...createDiscoveryApi({ sources: approvedList }).handlers, existingApplicationsHandler({ completedAt: "2026-10-17T09:00:00.000Z" }))
    openSignedIn("/dashboard", {
      ...approvedState(),
      versions: [version(1, "approved")],
      answers: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          group: "standard",
          topic: "notice_period",
          skill: null,
          value: "4 weeks",
          updatedAt: "2026-10-17T09:00:00.000Z",
        },
      ],
      salary: {
        grossSalaryPolicy: { amount: 48000, currency: "USD", period: "year", display: "USD 48,000 per year" },
        currentSalary: null,
        preferredNetPay: null,
      },
    })

    await screen.findByRole("heading", { name: "Home" })
    await screen.findByRole("link", { name: "Profile" })
    expect(screen.queryByRole("region", { name: "Set up Eve" })).not.toBeInTheDocument()
    expect(screen.getByText("Setup is done. Nothing needs you right now.")).toBeVisible()
    expect(screen.queryByText(/Anthropic isn't approved yet/)).not.toBeInTheDocument()
  })

  it("C-HOME-2 rule: setup done but something needs you, so the Needs you list shows instead", async () => {
    const draft = draftSources()
    const approvedList = { ...draft, employerList: { ...draft.employerList, status: "approved" as const, approvedAt: "2026-10-19T09:00:00.000Z" }, scheduledDiscoveryOn: true }
    server.use(
      ...createDiscoveryApi({ sources: approvedList }).handlers,
      existingApplicationsHandler({ completedAt: "2026-10-17T09:00:00.000Z" }),
      http.get(SUBMISSIONS_SUMMARY_PATH, () => HttpResponse.json({ samples: { awaitingReview: 0, approved: 0, rejected: 0 }, blocked: 0, held: 0, uncertain: 1 }))
    )
    openSignedIn("/dashboard", {
      ...approvedState(),
      versions: [version(1, "approved")],
      answers: [{ id: "11111111-1111-4111-8111-111111111111", group: "standard", topic: "notice_period", skill: null, value: "4 weeks", updatedAt: "2026-10-17T09:00:00.000Z" }],
      salary: { grossSalaryPolicy: { amount: 48000, currency: "USD", period: "year", display: "USD 48,000 per year" }, currentSalary: null, preferredNetPay: null },
    })
    // Needs you list row (the sidebar badge carries the same name).
    expect((await screen.findAllByRole("link", { name: "Uncertain Submissions, 1" })).length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.queryByRole("region", { name: "Set up Eve" })).not.toBeInTheDocument())
    expect(screen.queryByText("Setup is done. Nothing needs you right now.")).not.toBeInTheDocument()
  })

  it("C-HOME-2 rule: setup done and nothing counted, but an email failed (C-NOTIFY-1), so 'Setup is done' isn't shown", async () => {
    const draft = draftSources()
    const approvedList = { ...draft, employerList: { ...draft.employerList, status: "approved" as const, approvedAt: "2026-10-19T09:00:00.000Z" }, scheduledDiscoveryOn: true }
    server.use(...createDiscoveryApi({ sources: approvedList }).handlers, existingApplicationsHandler({ completedAt: "2026-10-17T09:00:00.000Z" }), notificationStatusHandler({ latestFailure: notificationFailure() }))
    openSignedIn("/dashboard", {
      ...approvedState(),
      versions: [version(1, "approved")],
      answers: [{ id: "11111111-1111-4111-8111-111111111111", group: "standard", topic: "notice_period", skill: null, value: "4 weeks", updatedAt: "2026-10-17T09:00:00.000Z" }],
      salary: { grossSalaryPolicy: { amount: 48000, currency: "USD", period: "year", display: "USD 48,000 per year" }, currentSalary: null, preferredNetPay: null },
    })
    expect(await screen.findByText("An email didn't send")).toBeVisible()
    await waitFor(() => expect(screen.queryByRole("region", { name: "Set up Eve" })).not.toBeInTheDocument())
    expect(screen.queryByText("Setup is done. Nothing needs you right now.")).not.toBeInTheDocument()
  })
})

describe("navigation", () => {
  // One screen per test: a six-page walk in one test outran the 5 s timeout under load.
  // EPIC-0011 R3: the six default items; the old Setup and Work items left the nav (navigation.feature NAV:74).
  it.each([
    ["Jobs", "/postings"],
    ["Find jobs", "/find-jobs"],
    ["Applications", "/applications"],
    ["Profile", "/profile"],
    ["Settings", "/settings"],
  ])("lists %s in the nav and opens it at %s", async (name, path) => {
    const { user, currentPath } = openSignedIn("/dashboard")

    await screen.findByRole("heading", { name: "Home" })
    await user.click(screen.getByRole("link", { name }))
    expect(await screen.findByRole("heading", { level: 1, name })).toBeVisible()
    expect(currentPath()).toBe(path)
    expect(document.title).toBe(`${name} · Eve`)
  })

  it("keeps Documents, Job Sources and Data and privacy off the nav; Settings links to Data and privacy", async () => {
    const { user, currentPath } = openSignedIn("/settings")

    await screen.findByRole("heading", { level: 1, name: "Settings" })
    const sidebar = document.querySelector('[data-slot="sidebar"]') as HTMLElement
    for (const name of ["Documents", "Job Sources", "Data and privacy", "Approved Answers"]) {
      expect(within(sidebar).queryByRole("link", { name })).not.toBeInTheDocument()
    }
    await user.click(await screen.findByRole("link", { name: "Data and privacy" }))
    expect(await screen.findByRole("heading", { level: 1, name: "Data and privacy" })).toBeVisible()
    expect(currentPath()).toBe("/privacy")
  })
})

describe("Home discovery (F3, C-SRC-8)", () => {
  it("while the employer list waits: C-SRC-8 with Review the list, checklist item 5 Start, and Add a job link", async () => {
    const { user, currentPath } = openSignedIn("/dashboard")

    expect(await screen.findByText(/^Daily discovery is off until you approve the employer list\./)).toBeVisible()
    expect(screen.queryByText("Next discovery: 08:00 WAT")).not.toBeInTheDocument()
    const sources = checklistRows()[4]
    expect(sources).toHaveTextContent("Choose and verify Job Sources, and approve the employer list")
    expect(within(sources).getByRole("link", { name: /^Start: Choose and verify Job Sources/ })).toHaveAttribute("href", "/find-jobs#job-sources")
    expect(screen.getByRole("region", { name: "Paste a job" })).toBeVisible()
    await user.click(screen.getByRole("link", { name: "Review the list" }))
    expect(currentPath()).toBe("/find-jobs#employer-list")
  })

  it("once approved: Next discovery: 08:00 WAT, and item 5 is done", async () => {
    const draft = draftSources()
    server.use(
      ...createDiscoveryApi({
        sources: { ...draft, employerList: { ...draft.employerList, status: "approved", approvedAt: "2026-10-19T09:00:00.000Z" }, scheduledDiscoveryOn: true },
      }).handlers
    )
    openSignedIn("/dashboard")

    expect(await screen.findByText("Next discovery: 08:00 WAT")).toBeVisible()
    expect(screen.queryByText(/Daily discovery is off/)).not.toBeInTheDocument()
    expect(checklistRows()[4]).toHaveTextContent("Done")
  })
})
