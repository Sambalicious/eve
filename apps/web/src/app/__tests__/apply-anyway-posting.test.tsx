import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { SUBMISSION_STATUS_PATH, type JobPostingDetail } from "@eve/contracts"
import { apiErrorResponse, rankedPosting, readyApplication, server, strongMatch, submission } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openDocuments } from "./documents-helpers"
import { entry, openSubmission } from "./submission-helpers"

/**
 * gherkin/apply-anyway.feature, frontend rows of gherkin-responsibility-apply-anyway.md:
 * the posting detail action, the consent dialog and every create outcome
 * (AA-1, AA-2.1, AA-4.1, AA-4.2, AA-6.4, AA-7.2). Mocked component checks with
 * the contract fakes (api-contract.md v1.24.0); the create handler decides from
 * the stored posting (AA-7.4).
 */

const NAME = "Prepare documents anyway for Senior Frontend Engineer at Acme Payments"
const GENERIC = "Couldn't prepare the Application. Nothing changed. Try again."
const C_AA_9 = "This posting's decision changed after you opened the dialog, so your override wasn't recorded. Review its new reason, then try again."
const C_AA_10 = "This posting's reason can't be overridden. Nothing changed."
const C_AA_11 = "The Application for this requisition is past the point where you can record an override. Nothing changed. Open it from Applications."
const C_AA_12 = "Confirm the override in its dialog first. Nothing changed. Reload the page and try again."
const HIDDEN = "This Job Posting is hidden from your board. Eve won't start a new Application or sample from it. Reload the page to see why."
const NOT_ELIGIBLE = "This Job Posting is still being checked or couldn't be checked, so it can't become an Application yet."

const rules = (violated: string[]) =>
  (["location", "sponsorship", "pay", "hours", "industry"] as const).map((rule) => ({
    rule,
    result: violated.includes(rule) ? ("violated" as const) : ("met" as const),
    quote: null,
  }))

function weakMatch(covered = 6, total = 10): NonNullable<JobPostingDetail["match"]> {
  return { ...strongMatch(), verdict: "weak", weakReason: "coverage_below_threshold", coveredCount: covered, totalCount: total, thresholdPercent: 70 }
}

const skipped = (skipReason: JobPostingDetail["skipReason"], skipDetail: string | null = null, o: Partial<JobPostingDetail> = {}) =>
  rankedPosting({ status: "skipped", rank: null, skipReason, skipDetail, match: skipReason === "weak_core_match" ? weakMatch() : null, ...o })

const excluded = (violated: string[], o: Partial<JobPostingDetail> = {}) => {
  const base = rankedPosting({ status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: violated[0] ?? null, ...o })
  return { ...base, eligibility: base.eligibility && { ...base.eligibility, rules: rules(violated) } }
}

const createRequests = (api: { requests: { method: string; path: string; body: unknown }[] }) =>
  api.requests.filter((r) => r.method === "POST" && r.path === "/v1/applications")

/** The refusal panel: the announced alert carrying one of the 409 messages (the reason line is a separate alert). */
async function findPanel() {
  const messages = [C_AA_9, C_AA_10, C_AA_11, C_AA_12, HIDDEN, NOT_ELIGIBLE]
  return waitFor(() => {
    const panel = screen.queryAllByRole("alert").find((a) => messages.includes(a.textContent ?? ""))
    if (!panel) throw new Error("no refusal panel")
    return panel
  })
}

/** Counts `GET /v1/job-postings/{id}` from now on: the posting's decision is reloaded. */
function detailReads(id: string) {
  const reads = { count: 0, stop: () => server.events.removeListener("request:start", listener) }
  const listener = ({ request }: { request: Request }) => {
    if (request.method === "GET" && new URL(request.url).pathname === `/v1/job-postings/${id}`) reads.count += 1
  }
  server.events.on("request:start", listener)
  return reads
}

async function openDialog(user: ReturnType<typeof openDocuments>["user"]) {
  await user.click(await screen.findByRole("button", { name: NAME }))
  return screen.findByRole("alertdialog", { name: "Apply to this posting anyway?" })
}

describe("AA-1.1 / AA-4.1: an overridable posting offers 'Prepare documents anyway'", () => {
  it.each([
    ["weak core Match", skipped("weak_core_match"), "Your profile backs only 60% of the core responsibilities. Your minimum is 70%."],
    ["uncovered prerequisite", skipped("uncovered_mandatory_prerequisite", "Professional Kotlin Android experience"), "Your profile doesn't show a required prerequisite for this job: \"Professional Kotlin Android experience\"."],
    ["no core responsibilities", skipped("no_core_responsibilities"), "Eve found no core responsibilities in this job, so it can't check the match."],
    ["industry-only exclusion", excluded(["industry"]), "This job doesn't fit your industry rule."],
  ])("%s: outline button, reason line shown", async (_label, posting, line) => {
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const button = await screen.findByRole("button", { name: NAME })
    expect(button).toHaveTextContent(/^Prepare documents anyway$/)
    expect(screen.getByText(line)).toBeVisible()
    expect(screen.queryByRole("button", { name: /^Prepare documents for/ })).not.toBeInTheDocument()
  })

  it("unverified rules alongside a violated industry rule keep it overridable, echoing violated rules 'industry'", async () => {
    const base = excluded(["industry"])
    const posting = {
      ...base,
      eligibility: base.eligibility && {
        ...base.eligibility,
        rules: [
          { rule: "industry" as const, result: "violated" as const, quote: null },
          { rule: "location" as const, result: "met" as const, quote: null },
          { rule: "sponsorship" as const, result: "not_applicable" as const, quote: null },
          { rule: "pay" as const, result: "unverified" as const, quote: null },
          { rule: "hours" as const, result: "unverified" as const, quote: null },
        ],
      },
    }
    const { user, api } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    await waitFor(() => expect(createRequests(api)).toHaveLength(1))
    expect(createRequests(api)[0].body).toMatchObject({ acknowledgement: { decision: { violatedRules: ["industry"] } } })
  })
})

describe("AA-1.2: no 'anyway' action when the server does not offer it", () => {
  it.each([
    ["location", ["location"]],
    ["sponsorship", ["sponsorship"]],
    ["pay", ["pay"]],
    ["hours", ["hours"]],
    ["industry and location", ["industry", "location"]],
    ["industry and sponsorship", ["industry", "sponsorship"]],
    ["industry and pay", ["industry", "pay"]],
    ["industry and hours", ["industry", "hours"]],
  ])("excluded with %s", async (_label, violated) => {
    const posting = excluded(violated)
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })

  it("skipped for technology_mismatch offers no prepare action", async () => {
    const posting = skipped("technology_mismatch", null)
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })

  it("v1.28.0 skipped for unsupported_application_system offers the manual prepare action", async () => {
    // The manual lane is not an override: Eve prepares the documents and the Candidate applies on the
    // employer's site, so the button says "Prepare documents" and the dialog explains the manual step.
    const posting = skipped("unsupported_application_system", "Workday")
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.getByRole("button", { name: /^Prepare documents/ })).toBeVisible()
  })

  it.each(["checking", "waiting_to_be_checked", "not_checked", "evaluation_failed"] as const)("status %s", async (status) => {
    const posting = rankedPosting({ status, rank: null, eligibility: null })
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })

  it("a hidden overridable posting", async () => {
    const posting = skipped("weak_core_match", null, { hiddenReason: "off_target" })
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })

  it.each([
    ["claimed for submission", submission({ state: "submit_claimed", kind: "automatic" })],
    ["a Confirmed Submission", submission({ state: "confirmed", kind: "automatic" })],
    ["a Blocked Application", submission({ state: "blocked", kind: "automatic", blockedReason: "login" })],
    ["an Activation Gate sample awaiting review", submission({ kind: "sample", sample: { state: "awaiting_review", rejectReason: null, counts: false } })],
  ])("AA-6.3: an existing Application that is %s", async (_label, sub) => {
    const posting = skipped("weak_core_match")
    openSubmission(`/postings/${posting.id}`, [entry(sub, { jobPostingId: posting.id })], {}, { postings: [posting] })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })

  it("AA-6.4: a ranked posting with an Application offers neither button", async () => {
    const posting = rankedPosting()
    const existing = readyApplication({ jobPostingId: posting.id })
    openDocuments(`/postings/${posting.id}`, { applications: [existing] }, { discovery: { postings: [posting] } })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })
})

describe("AA-1.6: ranked posting", () => {
  it("'Prepare documents' opens no dialog and sends no acknowledgement; the Application shows no Override badge", async () => {
    const posting = rankedPosting()
    const { user, api } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    await user.click(await screen.findByRole("button", { name: "Prepare documents for Senior Frontend Engineer at Acme Payments" }))
    expect(await screen.findByRole("button", { name: "Generate documents" })).toBeVisible()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(createRequests(api)[0].body).toEqual({ jobPostingId: posting.id })
    expect(screen.queryByText("Override")).not.toBeInTheDocument()
  })
})

describe("AA-4.1: the override dialog", () => {
  it.each([
    ["weak core Match 6 of 10, minimum 70%", skipped("weak_core_match"), "Your profile backs only 60% of the core responsibilities. Your minimum is 70%."],
    ["uncovered prerequisite", skipped("uncovered_mandatory_prerequisite", "Active security clearance"), "Your profile doesn't show a required prerequisite for this job: \"Active security clearance\"."],
    ["no core responsibilities", skipped("no_core_responsibilities"), "Eve found no core responsibilities in this job, so it can't check the match."],
    ["industry exclusion", excluded(["industry"]), "This job doesn't fit your industry rule."],
  ])("%s: names the reason, states automatic sending and its limit; sends nothing", async (_label, posting, line) => {
    const { user, api } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    expect(within(dialog).getByText("You're overriding this reason:")).toBeVisible()
    expect(within(dialog).getByText(line).tagName).toBe("BLOCKQUOTE")
    expect(await within(dialog).findByText("Eve may send this Application automatically. It counts toward the daily cap of 5 automatic submissions.")).toBeVisible()
    expect(within(dialog).getByText("This covers only the reason above. If the posting's decision changes, Eve won't send it automatically.")).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "Prepare anyway" })).toBeVisible()
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus())
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining(line))
    expect(createRequests(api)).toHaveLength(0)
  })

  it("uses the deck's no-cap form of C-AA-5 while the daily cap is unknown", async () => {
    const posting = skipped("weak_core_match")
    const { user } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    server.use(http.get(SUBMISSION_STATUS_PATH, () => apiErrorResponse("internal_error")))
    const dialog = await openDialog(user)
    expect(within(dialog).getByText("Eve may send this Application automatically. It counts toward the daily cap like any other.")).toBeVisible()
  })

  it("Cancel closes it, sends nothing and returns focus to the button", async () => {
    const posting = skipped("weak_core_match")
    const { user, api } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(createRequests(api)).toHaveLength(0)
    expect(api.state.applications).toHaveLength(0)
    await waitFor(() => expect(screen.getByRole("button", { name: NAME })).toHaveFocus())
  })

  it("Escape counts as Cancel", async () => {
    const posting = skipped("weak_core_match")
    const { user, api } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    await openDialog(user)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(createRequests(api)).toHaveLength(0)
  })
})

describe("AA-4.2 / AA-2.2: confirming", () => {
  it.each([
    ["weak core Match", skipped("weak_core_match"), { status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [] }],
    ["uncovered prerequisite", skipped("uncovered_mandatory_prerequisite", "Active security clearance"), { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance", violatedRules: [] }],
    ["industry", excluded(["industry"]), { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"] }],
  ])("%s: sends the acknowledgement shown, opens the Application with the Override badge, no toast", async (_label, posting, decision) => {
    const { user, api, currentPath } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    expect(await screen.findByRole("button", { name: "Generate documents" })).toBeVisible()
    expect(currentPath()).toBe(`/applications/${api.state.applications[0].id}`)
    expect(createRequests(api)).toEqual([{ method: "POST", path: "/v1/applications", body: { jobPostingId: posting.id, acknowledgement: { confirmed: true, decision } } }])
    expect(api.state.applications[0].override).toMatchObject({ ...decision, applies: true })
    expect(document.querySelector("[data-sonner-toast]")).toBeNull()
  })

  it("design B3: focus moves to the Application title once the record renders", async () => {
    const posting = skipped("weak_core_match")
    const { user, currentPath, api } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    await waitFor(() => expect(currentPath()).toBe(`/applications/${api.state.applications[0].id}`))
    // The Application view is up (the posting's own h1 can still be mounted for a moment before).
    await screen.findByRole("button", { name: "Generate documents" })
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus())
  }, 15_000)

  it("AA-6.1: marks an existing documents-ready Application instead of creating one", async () => {
    const posting = skipped("weak_core_match")
    const existing = readyApplication({ jobPostingId: posting.id })
    const { user, api, currentPath } = openDocuments(`/postings/${posting.id}`, { applications: [existing] }, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    await waitFor(() => expect(currentPath()).toBe(`/applications/${existing.id}`))
    expect(api.state.applications).toHaveLength(1)
    expect(api.state.applications[0].override).toMatchObject({ skipReason: "weak_core_match" })
  })

  it("Confirm reads 'Preparing…', keeps focus and ignores presses while pending (one request)", async () => {
    const posting = skipped("weak_core_match")
    let release: () => void = () => {}
    const { user, api } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    server.use(
      http.post("/v1/applications", async ({ request }) => {
        api.requests.push({ method: "POST", path: "/v1/applications", body: await request.json() })
        await new Promise<void>((resolve) => (release = resolve))
        return apiErrorResponse("internal_error")
      })
    )
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    const pending = await within(dialog).findByRole("button", { name: "Preparing…" })
    expect(pending).toHaveAttribute("aria-busy", "true")
    expect(pending).toHaveAttribute("aria-disabled", "true")
    await user.click(pending)
    await user.keyboard("{Escape}")
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    expect(createRequests(api)).toHaveLength(1)
    release()
    await within(dialog).findByRole("button", { name: "Prepare anyway" })
  })

  it("a network failure keeps the dialog open with C-ERR-2, focus on Confirm, and Confirm retries", async () => {
    const posting = skipped("weak_core_match")
    const { user, api } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    server.use(http.post("/v1/applications", () => HttpResponse.error(), { once: true }))
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    const alert = await within(dialog).findByRole("alert")
    expect(alert).toHaveTextContent(GENERIC)
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Prepare anyway" })).toHaveFocus())
    expect(api.state.applications).toHaveLength(0)
    expect(document.querySelector("[data-sonner-toast]")).toBeNull()
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    expect(await screen.findByRole("button", { name: "Generate documents" })).toBeVisible()
  })

  it("a 500 is handled like a network failure, inside the dialog", async () => {
    const posting = skipped("weak_core_match")
    const { user } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    server.use(http.post("/v1/applications", () => apiErrorResponse("internal_error")))
    const dialog = await openDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(GENERIC)
  })
})

describe("AA-2.1: the decision changes after the dialog opened", () => {
  it("decision changed: dialog closes, C-AA-9 panel, the posting reloads with its new reason, and a new dialog shows it", async () => {
    const posting = skipped("weak_core_match")
    const { user, api, discovery } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    expect(within(dialog).getByText("Your profile backs only 60% of the core responsibilities. Your minimum is 70%.")).toBeVisible()
    // Re-decided in the background; the open dialog keeps its snapshot.
    discovery.state.postings = [{ ...posting, skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance", match: null }]
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(await findPanel()).toHaveTextContent(C_AA_9)
    expect(await screen.findByText("Your profile doesn't show a required prerequisite for this job: \"Active security clearance\".")).toBeVisible()
    expect(api.state.applications).toHaveLength(0)
    expect(document.querySelector("[data-sonner-toast]")).toBeNull()
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus())
    // Confirm the new reason.
    const again = await openDialog(user)
    expect(within(again).getByText("Your profile doesn't show a required prerequisite for this job: \"Active security clearance\".")).toBeVisible()
    expect(screen.queryByText(C_AA_9)).not.toBeInTheDocument()
    await user.click(within(again).getByRole("button", { name: "Prepare anyway" }))
    await screen.findByRole("button", { name: "Generate documents" })
    expect(api.state.applications[0].override).toMatchObject({ skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance" })
  })

  it("became ranked: a normal Application opens with the toast C-AA-14 and no Override badge", async () => {
    const posting = skipped("weak_core_match")
    const { user, api, discovery } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    discovery.state.postings = [{ ...posting, status: "ranked", skipReason: null, rank: 1 }]
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    expect(await findToast("This posting is now ranked, so Eve prepared it normally. No override was recorded.")).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Generate documents" })).toBeVisible()
    expect(api.state.applications[0].override).toBeNull()
    expect(screen.queryByText("Override")).not.toBeInTheDocument()
  })
})

describe("AA-7.2: every refusal shows its own message, reloads the posting, no generic toast", () => {
  it("posting_hidden: hidden in another tab shows the hidden-posting message and the hidden notice", async () => {
    const posting = skipped("weak_core_match")
    const { user, discovery, currentPath } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    discovery.state.postings = [{ ...posting, hiddenReason: "off_target" }]
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    expect(await findPanel()).toHaveTextContent(HIDDEN)
    expect(await screen.findByText(/^Hidden from your board: off-target role/)).toBeVisible()
    expect(screen.queryByRole("button", { name: NAME })).not.toBeInTheDocument()
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument()
    expect(currentPath()).toBe(`/postings/${posting.id}`)
  })

  it.each([
    ["override_decision_changed", C_AA_9],
    ["override_not_allowed", C_AA_10],
    ["override_application_state", C_AA_11],
    ["override_acknowledgement_missing", C_AA_12],
    ["application_not_eligible", NOT_ELIGIBLE],
  ] as const)("%s", async (code, message) => {
    const posting = skipped("weak_core_match")
    const { user, discovery } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    server.use(http.post("/v1/applications", () => apiErrorResponse(code)))
    const dialog = await openDialog(user)
    const reads = detailReads(posting.id)
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(await findPanel()).toHaveTextContent(message)
    await waitFor(() => expect(reads.count).toBeGreaterThanOrEqual(1))
    reads.stop()
    expect(discovery.state.postings).toHaveLength(1)
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument()
  })

  it("not overridable after a refetch: the panel shows C-AA-10 and the button is gone", async () => {
    const posting = skipped("weak_core_match")
    const { user, discovery } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    const dialog = await openDialog(user)
    discovery.state.postings = [excluded(["location"], { id: posting.id })]
    await user.click(within(dialog).getByRole("button", { name: "Prepare anyway" }))
    expect(await findPanel()).toHaveTextContent(C_AA_10)
    await waitFor(() => expect(screen.queryByRole("button", { name: NAME })).not.toBeInTheDocument())
  })
})
