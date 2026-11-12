import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { ApplicationOverride, Submission } from "@eve/contracts"
import { blocked, rankedPosting, storedOverride, submission, uncertain } from "@/shared/testing"
import { entry, openSubmission } from "./submission-helpers"

/**
 * gherkin/apply-anyway.feature AA-2.7, AA-4.4, AA-4.5, AA-4.7, AA-7.1 and the
 * r-AA drop amendment (design B3a, F2a): Override badge and fact, the "no longer
 * applies" alert, the drop line, and the badge on Applications, Blocked and
 * Uncertain rows. Mocked component checks; `override`, `posting` and
 * `latestDrop` are the API's computed fields (api-contract v1.24.0).
 */

const C_AA_20 = "This override no longer applies"
const BODY = {
  decision_changed: "The posting's decision changed after you chose this, so Eve won't send it automatically. Decide again from the posting.",
  hidden: "The posting is now hidden from your board, so Eve won't send this Application automatically.",
  legacy_no_decision: "You chose this before Eve recorded reasons, so Eve won't send it automatically. Decide again from the posting to confirm the current reason.",
} as const

const inactive = (reason: ApplicationOverride["notAppliesReason"], o: Partial<ApplicationOverride> = {}) =>
  storedOverride({ applies: false, notAppliesReason: reason, ...o })

function openDetail(
  sub: Submission,
  app: Parameters<typeof entry>[1]
) {
  const posting = rankedPosting()
  const e = entry(sub, { ...app, jobPostingId: posting.id })
  const opened = openSubmission(`/applications/${e.app.id}`, [e], {}, { postings: [posting] })
  return { ...opened, app: e.app, posting }
}

const queued = (o: Partial<Submission> = {}) => submission({ state: "queued", kind: "automatic", ...o })

describe("AA-4.4: Application detail names the overridden reason and the date", () => {
  it("badge after the status badge and the Override fact C-AA-17 with C-AA-19", async () => {
    const override = storedOverride({ createdAt: "2026-10-29T10:00:00+01:00", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance" })
    openDetail(submission(), { override, posting: { status: "skipped", hidden: false } })
    await screen.findByRole("heading", { level: 1 })
    const badges = screen.getByText("Draft").parentElement!
    expect(within(badges).getByText("Override")).toBeVisible()
    const term = screen.getByText("Override", { selector: "dt" })
    expect(term.nextElementSibling).toHaveTextContent('Chosen on 29 Oct 2026 despite your profile not showing a required prerequisite "Active security clearance"')
    // Only the date is inside <time> (deck a11y, C-AA-17).
    const time = term.nextElementSibling!.querySelector("time")!
    expect(time).toHaveTextContent(/^29 Oct 2026$/)
    expect(time).toHaveAttribute("datetime", "2026-10-29T10:00:00+01:00")
    expect(screen.queryByText(C_AA_20)).not.toBeInTheDocument()
  })

  it("AA-2.7: a legacy override shows C-AA-18 and the alert with C-AA-39", async () => {
    const override = inactive("legacy_no_decision", { createdAt: "2026-10-28T12:00:00+01:00", status: null, skipReason: null, skipDetail: null, violatedRules: null })
    const { posting } = openDetail(submission(), { override, posting: { status: "skipped", hidden: false } })
    await screen.findByRole("heading", { level: 1 })
    const value = screen.getByText("Override", { selector: "dt" }).nextElementSibling!
    expect(value).toHaveTextContent("Chosen on 28 Oct 2026. The reason wasn't recorded.")
    expect(value.querySelector("time")).toHaveTextContent(/^28 Oct 2026$/)
    expect(await screen.findByText(C_AA_20)).toBeVisible()
    expect(screen.getByText(BODY.legacy_no_decision, { exact: false })).toBeVisible()
    expect(screen.getByRole("link", { name: "Open the posting" })).toHaveAttribute("href", `/postings/${posting.id}`)
  })

  it("AA-4.7: no override shows no badge, no fact and no alert", async () => {
    openDetail(submission(), { override: null, posting: { status: "ranked", hidden: false } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByText("Override")).not.toBeInTheDocument()
    expect(screen.queryByText(C_AA_20)).not.toBeInTheDocument()
  })

  it("AA-7.1: a minimal record view shows no override marks", async () => {
    openDetail(submission(), { override: null, posting: null, detailsDeletedAt: "2026-10-29T09:00:00.000Z", documents: [] })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByText("Override")).not.toBeInTheDocument()
  })
})

describe("AA-4.5: the detail says when an override no longer applies", () => {
  it.each([
    ["none", "excluded", false, "decision_changed", submission()],
    ["none", "skipped", false, "decision_changed", submission()],
    ["none", "checking", false, "decision_changed", submission()],
    ["none", "evaluation_failed", false, "decision_changed", submission()],
    ["none", "skipped", true, "hidden", submission()],
    ["queued", "excluded", false, "decision_changed", queued()],
    ["queued", "checking", false, "decision_changed", queued()],
    ["queued", "skipped", true, "hidden", queued()],
  ] as const)("state %s, posting status %s, hidden %s: alert with the %s body and link", async (_s, status, hidden, reason, sub) => {
    const { posting } = openDetail(sub, { override: inactive(reason), posting: { status, hidden } })
    await screen.findByRole("heading", { level: 1 })
    expect(await screen.findByText(C_AA_20)).toBeVisible()
    expect(screen.getByText(BODY[reason], { exact: false })).toBeVisible()
    expect(screen.getByRole("link", { name: "Open the posting" })).toHaveAttribute("href", `/postings/${posting.id}`)
    // Static: not announced on load.
    expect(screen.getByText(C_AA_20).closest("[data-slot=alert]")).not.toHaveAttribute("role")
  })

  it("no alert while the override applies", async () => {
    openDetail(submission(), { override: storedOverride(), posting: { status: "skipped", hidden: false } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByText(C_AA_20)).not.toBeInTheDocument()
  })

  it.each([["none", submission()], ["queued", queued()]] as const)("visible ranked posting, state %s: applies, no alert, badge and fact shown", async (_s, sub) => {
    openDetail(sub, { override: storedOverride(), posting: { status: "ranked", hidden: false } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByText(C_AA_20)).not.toBeInTheDocument()
    expect(screen.getByText("Override", { selector: "dt" })).toBeVisible()
    expect(screen.getAllByText("Override").length).toBe(2)
  })

  it.each([
    ["a Confirmed Submission", submission({ state: "confirmed", kind: "automatic" })],
    ["an Uncertain Submission", uncertain()],
    ["a Blocked Application", blocked("login", null)],
    ["a Manual Application", submission({ state: "manual", kind: "automatic" })],
    ["declined at same-company review", submission({ state: "declined", kind: "automatic", declinedReason: "No", declinedAt: "2026-10-29T09:00:00.000Z" })],
  ])("no alert past the queue: %s; badge and fact still show", async (_label, sub) => {
    openDetail(sub, { override: inactive("decision_changed"), posting: { status: "excluded", hidden: false } })
    await screen.findByRole("heading", { level: 1 })
    // Wait for the submission, whose state decides the rule: its status badge replaces "Draft".
    await waitFor(() => expect(screen.queryByText("Draft")).not.toBeInTheDocument())
    expect(screen.queryByText(C_AA_20)).not.toBeInTheDocument()
    expect(screen.getByText("Override", { selector: "dt" })).toBeVisible()
  })
})

describe("B3a / r-AA: a dropped queued Application returns to documents ready with the drop line", () => {
  it("posting closed: 'Draft' and C-AA-40, no 'Not submitted'", async () => {
    openDetail(submission(), { override: null, posting: { status: "evaluation_failed", hidden: false }, latestDrop: { at: "2026-10-29T09:00:00.000Z", reason: "closed" } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.getByText("Draft")).toBeVisible()
    const line = await screen.findByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Left the automatic queue on 29 Oct 2026 because the posting closed. Nothing was sent, and its documents are kept.")
    expect(line).toBeVisible()
    // Only the date is inside <time> (deck a11y, drop line).
    const time = line.querySelector("time")!
    expect(time).toHaveTextContent(/^29 Oct 2026$/)
    expect(time).toHaveAttribute("datetime", "2026-10-29T09:00:00.000Z")
    expect(screen.queryByText(/Not submitted/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Remove from queue/ })).not.toBeInTheDocument()
  })

  it("any other drop: C-AA-41", async () => {
    openDetail(submission(), { override: null, posting: { status: "skipped", hidden: false }, latestDrop: { at: "2026-10-29T09:00:00.000Z", reason: "not_submittable" } })
    const line = await screen.findByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Left the automatic queue on 29 Oct 2026 because the posting no longer qualifies. Nothing was sent, and its documents are kept.")
    expect(line).toBeVisible()
    expect(line.querySelector("time")).toHaveTextContent(/^29 Oct 2026$/)
  })

  it("an override whose alert shows gets the alert alone, never both", async () => {
    openDetail(submission(), { override: inactive("decision_changed"), posting: { status: "excluded", hidden: false }, latestDrop: { at: "2026-10-29T09:00:00.000Z", reason: "not_submittable" } })
    await screen.findByRole("heading", { level: 1 })
    expect(await screen.findByText(C_AA_20)).toBeVisible()
    expect(screen.queryByText(/Left the automatic queue/)).not.toBeInTheDocument()
  })
})

describe("AA-4.4: every list that shows Applications marks an override after its status badge", () => {
  const override = inactive("decision_changed")

  it("Applications: queued and Confirmed rows, badge kept when the override no longer applies (table and card list)", async () => {
    const a = entry(queued(), { roleTitle: "Queued role", override })
    const b = entry(submission({ state: "confirmed", kind: "automatic" }), { roleTitle: "Confirmed role", override: storedOverride() })
    const c = entry(submission(), { roleTitle: "Plain role", override: null })
    openSubmission("/applications?view=list", [a, b, c])
    const table = await screen.findByRole("table")
    const row = (name: string) => within(table).getByRole("link", { name: new RegExp(name) }).closest("tr")!
    expect(within(row("Queued role")).getByText("Override")).toBeVisible()
    expect(within(row("Confirmed role")).getByText("Override")).toBeVisible()
    expect(within(row("Plain role")).queryByText("Override")).not.toBeInTheDocument()
    const cards = screen.getByRole("list", { name: "Applications" })
    expect(within(cards).getAllByText("Override")).toHaveLength(2)
    // Design B5: in the table (md and up) the badges never wrap and the box fits both (≥207px); the card list (below md) may wrap.
    const tableBadges = within(row("Queued role")).getByText("Override").parentElement!
    expect(tableBadges).toHaveClass("flex-nowrap", "min-w-[13.5rem]")
    expect(tableBadges).not.toHaveClass("flex-wrap")
    expect(within(cards).getAllByText("Override")[0].parentElement).toHaveClass("flex-wrap")
  })

  it("Blocked Applications: after the reason badge", async () => {
    openSubmission("/blocked", [entry(blocked("missing_approved_answer", null, { blockedQuestion: "Why us?" }), { override })])
    const card = await screen.findByRole("article")
    const badge = within(card).getByText("Override")
    expect(badge.previousElementSibling).toHaveTextContent("Missing Approved Answer")
  })

  it("Uncertain Submissions", async () => {
    openSubmission("/uncertain", [entry(uncertain(), { override })])
    const card = await screen.findByRole("article")
    expect(within(card).getByText("Override")).toBeVisible()
  })
})
