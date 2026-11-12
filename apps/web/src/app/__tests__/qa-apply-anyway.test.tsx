import { APPLY_ANYWAY_ERROR_MESSAGES, type ApiErrorCode, type ApplicationDetail, type JobPostingDetail, type OverrideDecision } from "@eve/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, rankedPosting, readyApplication, server } from "@/shared/testing"
import { openDocuments } from "./documents-helpers"

/**
 * QA (apply anyway). First written for the PR #55 gate (v1.23.0); updated in QA
 * test authoring for api-contract.md v1.24.0 and design-spec-apply-anyway.md r1.
 * Mocked component checks, not integration evidence. The create handler here
 * is test-local (server.use) so it follows the contract's order of checks
 * independently of the shared fakes Frontend is changing in parallel; it is
 * installed after openDocuments, because openDocuments prepends the shared
 * fake's handlers and MSW answers with the most recently prepended one. Strings
 * are copy-deck-apply-anyway.md byte for byte; the five refusal messages come
 * from @eve/contracts APPLY_ANYWAY_ERROR_MESSAGES (the deck's api.error.* rows).
 */
const ROLE = "Senior Frontend Engineer at Acme Payments"
const GENERIC_TOAST = "Couldn't prepare the Application. Nothing changed. Try again."
const NOT_ELIGIBLE = "This Job Posting is still being checked or couldn't be checked, so it can't become an Application yet."
const HIDDEN = "This Job Posting is hidden from your board. Eve won't start a new Application or sample from it. Reload the page to see why."
const DIALOG = "Apply to this posting anyway?" // C-AA-3
const CONFIRM = "Prepare anyway" // C-AA-7
const BUTTON = "Prepare documents anyway" // C-AA-1
const KOTLIN: OverrideDecision = { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance", violatedRules: [] }
const INDUSTRY: OverrideDecision = { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"] }

/**
 * A visible posting whose server-decided applyAnyway is `decision` (or null).
 * The shared fake recomputes the decision from the stored posting (AA-7.4), so
 * an exclusion also carries its violated rules in `eligibility`.
 */
function decidedPosting(decision: OverrideDecision | null, extra: Partial<JobPostingDetail> = {}): JobPostingDetail {
  const base = decision ?? { status: "ranked" as const, skipReason: null, skipDetail: null, violatedRules: [] }
  const posting = rankedPosting({
    status: base.status,
    skipReason: base.skipReason,
    skipDetail: base.skipDetail,
    rank: base.status === "ranked" ? 1 : null,
    applyAnyway: decision ? { offered: true, decision } : null,
    applicationId: null,
    ...extra,
  })
  if (base.violatedRules.length === 0 || !posting.eligibility) return posting
  const rules = (["location", "sponsorship", "pay", "hours", "industry"] as const).map((rule) => ({
    rule,
    result: (base.violatedRules as readonly string[]).includes(rule) ? ("violated" as const) : ("met" as const),
    quote: null,
  }))
  return { ...posting, eligibility: { ...posting.eligibility, rules } }
}

/** An Application fixture with the v1.24.0 keys. */
function application(postingId: string, override: ApplicationDetail["override"]): ApplicationDetail {
  return readyApplication({ jobPostingId: postingId, state: "prepared", careerProfileVersion: null, documents: [], override, posting: null, latestDrop: null })
}

type CreateBody = { jobPostingId: string; acknowledgement?: { confirmed: true; decision: OverrideDecision } | null }

function recordCreates(answer: (body: CreateBody) => Response | Promise<Response>) {
  const bodies: CreateBody[] = []
  server.use(
    http.post("/v1/applications", async ({ request }) => {
      const body = (await request.json()) as CreateBody
      bodies.push(body)
      return answer(body)
    })
  )
  return bodies
}

/**
 * The refusal panel: the alert whose text is exactly one 409 message. The
 * posting's reason line is also an Alert (role=alert), so the first alert on
 * the page is not necessarily the panel.
 */
function findPanel(message: string) {
  return waitFor(() => {
    const panel = screen.queryAllByRole("alert").find((a) => a.textContent === message)
    if (!panel) throw new Error(`no refusal panel with: ${message}`)
    return panel
  })
}

const openButton = () => screen.findByRole("button", { name: `${BUTTON} for ${ROLE}` })

describe("QA: the button follows applyAnyway, never status (AA-1.4)", () => {
  it("apply-anyway:194 a ranked posting keeps 'Prepare documents' and offers no 'anyway' button", async () => {
    const posting = decidedPosting(null)
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const button = await screen.findByRole("button", { name: `Prepare documents for ${ROLE}` })
    expect(button).toHaveTextContent(/^Prepare documents$/)
    expect(screen.queryByRole("button", { name: /Prepare documents anyway/ })).not.toBeInTheDocument()
  })

  it.each([
    ["excluded location", { status: "excluded", skipReason: "violated_rule", skipDetail: "location" }],
    ["skipped technology_mismatch", { status: "skipped", skipReason: "technology_mismatch", skipDetail: null }],
    ["skipped weak_core_match but hidden", { status: "skipped", skipReason: "weak_core_match", skipDetail: null, hiddenReason: "off_target" }],
  ] as const)("apply-anyway:88/:120/:159 %s with applyAnyway null: no 'anyway' button and no 'Prepare documents'", async (_label, extra) => {
    const posting = rankedPosting({ ...extra, rank: null, applyAnyway: null, applicationId: null })
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })

  it("apply-anyway:1097 a ranked posting with an existing Application (applicationId set) offers neither button", async () => {
    // The fake derives applicationId from the documents store, as the contract does, so the Application is stored.
    const posting = rankedPosting({ applyAnyway: null })
    const existing = readyApplication({ jobPostingId: posting.id })
    openDocuments(`/postings/${posting.id}`, { applications: [existing] }, { discovery: { postings: [posting] } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })
})

describe("QA: the override dialog (AA-4.1, AA-4.2)", () => {
  it.each([
    ["uncovered prerequisite", KOTLIN, "Your profile doesn't show a required prerequisite for this job: \"Active security clearance\"."],
    ["Industry-only exclusion", INDUSTRY, "This job doesn't fit your industry rule."],
  ] as const)("apply-anyway:652 + :670 %s: the dialog quotes the reason; Cancel closes it and sends nothing", async (_label, decision, reasonLine) => {
    const posting = decidedPosting(decision)
    const { user } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const bodies = recordCreates(() => apiErrorResponse("internal_error"))
    await user.click(await openButton())
    const dialog = await screen.findByRole("alertdialog", { name: DIALOG })
    expect(within(dialog).getByText("You're overriding this reason:")).toBeInTheDocument()
    expect(within(dialog).getByText(reasonLine)).toBeInTheDocument()
    expect(within(dialog).getByText(/^Eve may send this Application automatically\./)).toBeInTheDocument()
    expect(within(dialog).getByText("This covers only the reason above. If the posting's decision changes, Eve won't send it automatically.")).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("alertdialog", { name: DIALOG })).not.toBeInTheDocument()
    expect(bodies).toEqual([])
  })

  it("apply-anyway:679 + :59 Confirm sends the acknowledgement of the decision shown and opens the Application with the Override badge", async () => {
    const posting = decidedPosting(KOTLIN)
    const created = application(posting.id, { createdAt: "2026-10-29T09:00:00.000Z", ...KOTLIN, status: "skipped", applies: true, notAppliesReason: null })
    const { user, api, currentPath } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const bodies = recordCreates(() => {
      api.state.applications.unshift(created)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { documents, posting: _p, latestDrop: _l, ...summary } = created
      return HttpResponse.json({ created: true, application: summary }, { status: 201 })
    })
    await user.click(await openButton())
    await user.click(within(await screen.findByRole("alertdialog", { name: DIALOG })).getByRole("button", { name: CONFIRM }))
    expect(bodies).toEqual([{ jobPostingId: posting.id, acknowledgement: { confirmed: true, decision: KOTLIN } }])
    expect((await screen.findAllByText("Override", { exact: true })).length).toBeGreaterThan(0)
    expect(currentPath()).toBe(`/applications/${created.id}`)
  })

  it("apply-anyway:695 a network failure keeps the dialog open with the inline C-ERR-2 error", async () => {
    const posting = decidedPosting(KOTLIN)
    const { user } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    recordCreates(() => HttpResponse.error())
    await user.click(await openButton())
    const dialog = await screen.findByRole("alertdialog", { name: DIALOG })
    await user.click(within(dialog).getByRole("button", { name: CONFIRM }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(GENERIC_TOAST)
    expect(screen.getByRole("alertdialog", { name: DIALOG })).toBeInTheDocument()
  })
})

describe("QA: every 409 closes the dialog and shows its own panel, never the generic toast (AA-7.2)", () => {
  const REFUSALS: readonly (readonly [string, ApiErrorCode, string])[] = [
    ["apply-anyway:1137 decision changed", "override_decision_changed", APPLY_ANYWAY_ERROR_MESSAGES.override_decision_changed],
    ["apply-anyway:1137 not overridable", "override_not_allowed", APPLY_ANYWAY_ERROR_MESSAGES.override_not_allowed],
    ["apply-anyway:1137 existing Application state", "override_application_state", APPLY_ANYWAY_ERROR_MESSAGES.override_application_state],
    ["apply-anyway:1137 acknowledgement missing", "override_acknowledgement_missing", APPLY_ANYWAY_ERROR_MESSAGES.override_acknowledgement_missing],
    ["apply-anyway:1137 application_not_eligible", "application_not_eligible", NOT_ELIGIBLE],
    ["apply-anyway:1128 posting_hidden", "posting_hidden", HIDDEN],
  ]

  it.each(REFUSALS)("%s: the panel (role=alert) shows the exact message", async (_label, code, message) => {
    const posting = decidedPosting(KOTLIN)
    const { user, currentPath } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    recordCreates(() => apiErrorResponse(code))
    await user.click(await openButton())
    await user.click(within(await screen.findByRole("alertdialog", { name: DIALOG })).getByRole("button", { name: CONFIRM }))
    const panel = await findPanel(message)
    expect(panel).toHaveTextContent(message)
    expect(screen.queryByRole("alertdialog", { name: DIALOG })).not.toBeInTheDocument()
    expect(screen.queryByText(GENERIC_TOAST)).not.toBeInTheDocument()
    expect(currentPath()).toBe(`/postings/${posting.id}`)
  })
})
