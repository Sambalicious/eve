import { act, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { awaitingSample, formAnswer, rankedPosting, server, submission, submissionStatus } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { entry, openSubmission } from "./submission-helpers"

const C_GATE_1 =
  "Automatic submission stays off until you approve your Career Profile, mark existing applications complete, and approve 5 sample Applications."

const approvedSample = (counts: boolean, o = {}) =>
  submission({ kind: "sample", state: counts ? "confirmed" : "blocked", blockedReason: counts ? null : "login", sample: { state: "approved", rejectReason: null, counts }, ...o })

describe("Activation Gate (/activation)", () => {
  it("opens from the nav: gate card with the count, C-GATE-1, C-GATE-5 and the requirement rows", async () => {
    const { user, currentPath } = openSubmission("/dashboard", [entry(awaitingSample(), { roleTitle: "Sample one" })], {
      status: submissionStatus({ countingSamples: 2 }),
    })
    await user.click(await screen.findByRole("link", { name: "Check first sends" }))
    expect(currentPath()).toBe("/activation")
    expect(await screen.findByRole("heading", { level: 2, name: "2 of 5 samples approved" })).toBeVisible()
    expect(screen.getByText(C_GATE_1)).toBeVisible()
    expect(
      screen.getByText("Only approved samples that reach a Confirmed or Uncertain Submission count. A sample that ends ineligible, duplicate or blocked doesn't count toward the 5.")
    ).toBeVisible()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2")
    expect(screen.getByText("Career Profile approved")).toBeVisible()
    expect(screen.getByText("5 samples approved")).toBeVisible()
  })

  it("lists samples in three tabs with counts; approved rows that didn't count show the badge and C-SAMPLE-10", async () => {
    const { user } = openSubmission(
      "/activation",
      [
        entry(awaitingSample(), { roleTitle: "Awaiting one", requisitionId: "R-1042" }),
        entry(approvedSample(true), { roleTitle: "Counted one" }),
        entry(approvedSample(false), { roleTitle: "Blocked one" }),
        entry(submission({ kind: "sample", sample: { state: "rejected", rejectReason: "Cover letter overstates team size", counts: false } }), { roleTitle: "Rejected one" }),
      ],
      { status: submissionStatus({ countingSamples: 1 }) }
    )

    expect(await screen.findByRole("tab", { name: "Awaiting review (1)" })).toBeVisible()
    expect(screen.getByRole("link", { name: "Review sample, Awaiting one at Acme Payments" })).toHaveAttribute("href", expect.stringMatching(/^\/activation\//))
    await user.click(screen.getByRole("tab", { name: "Approved (2)" }))
    const panel = screen.getByRole("tabpanel")
    expect(within(panel).getAllByText("Doesn't count")).toHaveLength(1)
    expect(panel).toHaveTextContent("This sample doesn't count toward the 5 because it wasn't submitted. 1 of 5 samples approved.")
    await user.click(screen.getByRole("tab", { name: "Rejected (1)" }))
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Reason: Cover letter overstates team size")
  })

  it("a sample marked not submitted shows 'Doesn't count' with C-SAMPLE-12", async () => {
    const { user } = openSubmission("/activation?tab=approved", [
      entry(
        submission({
          kind: "sample",
          state: "not_submitted",
          markedNotSubmittedAt: "2026-10-18T09:00:00.000Z",
          sample: { state: "approved", rejectReason: null, counts: false },
        }),
        // The row's last change is later; the line uses the mark date (FE5-B3).
        { roleTitle: "Marked one", updatedAt: "2026-10-20T09:00:00.000Z" }
      ),
    ])
    void user
    const panel = await screen.findByRole("tabpanel")
    await waitFor(() => expect(panel).toHaveTextContent("You marked this sample not submitted on 18 Oct 2026, so it no longer counts toward the 5."))
    expect(within(panel).getByText("Not submitted")).toBeVisible()
  })

  it.each([
    [{ countingSamples: 4 }, "Automatic submission can't be turned on yet. Still needed: approve 1 more sample Application."],
    [{ countingSamples: 3 }, "Automatic submission can't be turned on yet. Still needed: approve 2 more sample Applications."],
    [{ countingSamples: 5, existingApplicationsCompletedAt: null }, "Automatic submission can't be turned on yet. Still needed: mark existing applications complete."],
    [{ countingSamples: 5, careerProfileApproved: false }, "Automatic submission can't be turned on yet. Still needed: approve your Career Profile."],
    [
      { countingSamples: 0, careerProfileApproved: false, existingApplicationsCompletedAt: null },
      "Automatic submission can't be turned on yet. Still needed: approve your Career Profile, mark existing applications complete and approve 5 more sample Applications.",
    ],
  ])("turning on with requirements unmet shows C-GATE-3 (%o), focused, and sends nothing", async (status, message) => {
    const { user, api } = openSubmission("/activation", [], { status: submissionStatus(status) })
    const button = await screen.findByRole("button", { name: "Turn on automatic submission" })
    expect(button).toHaveAttribute("aria-disabled", "true")
    await user.click(button)
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(message)
    expect(alert).toHaveFocus()
    expect(api.requests.some((r) => r.path === "/v1/submission/automatic")).toBe(false)
  })

  it("after the gate passed: C-GATE-2 with the WAT time, then C-CONFIRM-4 turns automatic submission on", async () => {
    const { user, api } = openSubmission("/activation", [], { status: submissionStatus({ countingSamples: 5, gatePassedAt: "2026-10-21T13:30:00.000Z" }) })
    expect(await screen.findByText("Activation Gate passed on 21 Oct 2026, 14:30 WAT. You can turn on automatic submission.")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Turn on automatic submission" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Turn on automatic submission?" })
    expect(dialog).toHaveTextContent(
      "The assistant will submit up to 5 Applications a day to eligible, strong-Match Job Postings without asking you first. You can pause it any time."
    )
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }))
    expect(await screen.findByText("Automatic submission is on")).toBeVisible()
    expect(api.state.status.automaticEnabled).toBe(true)
  })

  it("empty: C-EMPTY-1, with Go to Career Profile only while unapproved", async () => {
    openSubmission("/activation", [], { status: submissionStatus({ countingSamples: 0, careerProfileApproved: false }) })
    expect(await screen.findByText("No samples yet")).toBeVisible()
    expect(screen.getByRole("link", { name: "Go to Career Profile" })).toHaveAttribute("href", "/profile")
  })
})

describe("Activation Gate: sample lists from the v1.7.0 endpoints", () => {
  it("each tab is one GET /v1/samples request; no per-Application Submission reads (FE5-B1)", async () => {
    const paths: string[] = []
    server.events.on("request:start", ({ request }) => void paths.push(new URL(request.url).pathname + new URL(request.url).search))
    const a = entry(awaitingSample(), { roleTitle: "Awaiting one" })
    openSubmission("/activation", [a, entry(awaitingSample(), { roleTitle: "Awaiting two" })])
    expect(await screen.findByRole("tab", { name: "Awaiting review (2)" })).toBeVisible()
    server.events.removeAllListeners()
    for (const state of ["awaiting_review", "approved", "rejected"]) expect(paths).toContain(`/v1/samples?state=${state}`)
    expect(paths.filter((p) => p.endsWith("/submission"))).toEqual([])
    expect(paths.some((p) => p.startsWith("/v1/applications?") || p === "/v1/applications")).toBe(false)
  })

  it("a row shows the Application System, the Match summary and Unverified labels from the samples row", async () => {
    const a = entry(awaitingSample(), { roleTitle: "Rich row" })
    openSubmission("/activation", [a], { sampleRows: { [a.app.id]: { applicationSystem: "Lever", match: { coveredCount: 4, totalCount: 5 }, unverifiedLabels: ["pay"] } } })
    const panel = await screen.findByRole("tabpanel")
    expect(await within(panel).findByText("Lever")).toBeVisible()
    expect(within(panel).getByText("4 of 5 core responsibilities backed by a fact (80%).")).toBeVisible()
    expect(within(panel).getByText("Unverified: pay")).toBeVisible()
  })

  it.each([
    ["approved", "No approved samples", "Samples you approve and submit show up here, with whether each one counts toward the 5."],
    ["rejected", "No rejected samples", "If you reject a sample, it shows up here with your reason. Nothing is sent for a rejected sample."],
  ])("an empty %s tab shows its empty state (C-EMPTY-7, C-EMPTY-8)", async (tab, title, text) => {
    openSubmission(`/activation?tab=${tab}`, [entry(awaitingSample(), { roleTitle: "Only awaiting" })])
    const panel = await screen.findByRole("tabpanel")
    expect(await within(panel).findByText(title)).toBeVisible()
    expect(within(panel).getByText(text)).toBeVisible()
  })

  it("C-GATE-6: while incomplete, the row label is the link to /existing-applications, with no C-GATE-7 line", async () => {
    const { user, currentPath } = openSubmission("/activation", [], { status: submissionStatus({ existingApplicationsCompletedAt: null }) })
    const link = await screen.findByRole("link", { name: "Jobs you've already applied to" })
    expect(link).toHaveAttribute("href", "/existing-applications")
    expect(screen.getByText("Mark this either way. If you haven't applied anywhere yet, mark it complete.")).toBeVisible()
    expect(screen.queryByText(/coming in a later update/)).not.toBeInTheDocument()
    await user.click(link)
    expect(await screen.findByRole("heading", { level: 1, name: "Existing applications" })).toBeVisible()
    expect(currentPath()).toBe("/existing-applications")
  })

  it("C-GATE-6: once complete, the row label is plain text with its check, no link and no hint", async () => {
    openSubmission("/activation", [], { status: submissionStatus() })
    const label = await screen.findByText("Jobs you've already applied to")
    expect(label.closest("a")).toBeNull()
    expect(label.closest("li")?.querySelector('[aria-label="Done"]')).not.toBeNull()
    expect(screen.queryByText("Mark this either way. If you haven't applied anywhere yet, mark it complete.")).not.toBeInTheDocument()
    expect(screen.queryByText(/coming in a later update/)).not.toBeInTheDocument()
  })

  it("C-GATE-helper: before the gate passes, three steps explain what a sample is and what approving does", async () => {
    openSubmission("/activation", [], { status: submissionStatus({ gatePassedAt: null }) })
    expect(await screen.findByRole("heading", { level: 2, name: "How this works" })).toBeVisible()
    expect(screen.getByText("Eve picks a few of your strongest matches and writes their documents. She does not send them.")).toBeVisible()
    expect(screen.getByText(/then choose Approve and submit\. That sends it to the employer/)).toBeVisible()
  })

  it("an empty Awaiting tab offers Prepare samples; the new samples appear with a toast", async () => {
    const a = entry(submission(), { roleTitle: "Fresh posting" })
    const { user, api } = openSubmission("/activation", [a], { nextPrepare: () => ({ result: { created: 1, stoppedBy: null }, sampleIds: [a.app.id] }) })
    expect(await screen.findByText("No samples yet")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Prepare samples" }))
    expect(await findToast("Prepared 1 sample for your review.")).toBeVisible()
    expect(await screen.findByRole("tab", { name: "Awaiting review (1)" })).toBeVisible()
    expect(screen.getByRole("link", { name: "Review sample, Fresh posting at Acme Payments" })).toBeVisible()
    expect(api.requests.filter((r) => r.path === "/v1/samples/prepare")).toHaveLength(1)
  })

  it.each([
    ["no_candidates", "No more samples right now. The assistant needs eligible, strong-Match Job Postings with documents ready."],
    ["paused", "Automation is paused, so no samples were prepared. Resume automation, then try again."],
  ] as const)("Prepare samples that adds none (%s) says why", async (stoppedBy, message) => {
    const { user } = openSubmission("/activation", [], { nextPrepare: () => ({ result: { created: 0, stoppedBy }, sampleIds: [] }) })
    await user.click(await screen.findByRole("button", { name: "Prepare samples" }))
    expect(await findToast(message)).toBeVisible()
  })

  it("no Prepare samples before the Career Profile is approved, or after the gate passed", async () => {
    openSubmission("/activation", [], { status: submissionStatus({ careerProfileApproved: false }) })
    expect(await screen.findByRole("link", { name: "Go to Career Profile" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Prepare samples" })).not.toBeInTheDocument()
  })

  it("no Prepare samples after the gate passed", async () => {
    openSubmission("/activation", [], { status: submissionStatus({ countingSamples: 5, gatePassedAt: "2026-10-21T13:30:00.000Z" }) })
    expect(await screen.findByText("No samples yet")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Prepare samples" })).not.toBeInTheDocument()
  })
})

describe("Sample review (/activation/:applicationId)", () => {
  function openSample(sample = awaitingSample(), status = submissionStatus({ countingSamples: 2 })) {
    const posting = rankedPosting()
    const app = entry(sample, { jobPostingId: posting.id, company: "Acme Payments", requisitionId: "R-1042" })
    const opened = openSubmission(`/activation/${app.app.id}`, [app], { status }, { postings: [posting] })
    return { ...opened, app }
  }

  it("shows the Job Posting header, Eligibility, Match, both documents and the form answers section", async () => {
    openSample()
    expect(await screen.findByRole("heading", { level: 1, name: "Senior Frontend Engineer at Acme Payments" })).toBeVisible()
    expect(screen.getByText("R-1042")).toBeVisible()
    expect(screen.getByText("Profile version 1")).toBeVisible()
    expect(await screen.findByText("Application System")).toBeVisible()
    expect(screen.getByRole("tab", { name: "Resume" })).toBeVisible()
    expect(screen.getByRole("tab", { name: "Cover letter" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Form answers" })).toBeVisible()
    expect(await screen.findByRole("heading", { name: /Eligibility/ })).toBeVisible()
    expect(screen.getByRole("button", { name: "Approve and submit" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Reject" })).toBeVisible()
  })

  it("approve: C-CONFIRM-3, then C-SAMPLE-1 replaces the action bar and the count rises", async () => {
    const { user, api } = openSample()
    await user.click(await screen.findByRole("button", { name: "Approve and submit" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Approve and submit this Application?" })
    expect(dialog).toHaveTextContent("This sends the Application to Acme Payments now, with the documents and answers shown. It doesn't count toward the daily cap.")
    await user.click(within(dialog).getByRole("button", { name: "Approve and submit" }))
    expect(await screen.findByText("Submitted to Acme Payments. Confirmed by Confirmation page. 3 of 5 samples approved.")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Approve and submit" })).not.toBeInTheDocument()
    expect(api.requests.filter((r) => r.path.endsWith("/sample/approve"))).toHaveLength(1)
  })

  it.each([
    ["uncertain", { state: "uncertain", submittedAt: "2026-10-20T09:15:00.000Z" }, "The form was submitted but no confirmation was seen. It's now an Uncertain Submission and won't be retried.", "This counts toward the 5. 3 of 5 samples approved.", "Resolve it"],
    ["uncertain", { state: "uncertain", captchaAfterSubmit: true, submittedAt: "2026-10-20T09:15:00.000Z" }, "The form was submitted, then a CAPTCHA appeared, so no confirmation was seen. It's now an Uncertain Submission and won't be retried.", "This counts toward the 5. 3 of 5 samples approved.", "Resolve it"],
    ["duplicate", { state: "not_submitted" }, "Not submitted. You already have an Application or existing application for requisition R-1042.", "This sample doesn't count toward the 5 because it wasn't submitted. 2 of 5 samples approved.", null],
    ["blocked", { state: "blocked", blockedReason: "missing_approved_answer", blockedDetail: "x" }, "Not submitted. It's now a Blocked Application: Missing Approved Answer.", "This sample doesn't count toward the 5 because it wasn't submitted. 2 of 5 samples approved.", "Open Blocked Application"],
    ["blocked", { state: "blocked", blockedReason: "automation_incomplete" }, "Not submitted. It's now a Blocked Application: Automation couldn't complete the form.", "This sample doesn't count toward the 5 because it wasn't submitted. 2 of 5 samples approved.", "Open Blocked Application"],
  ] as const)("result %s shows its line, count line and link", async (result, after, line, countLine, link) => {
    const { user, api } = openSample()
    api.state.nextSampleResult = () => ({ result, submission: after })
    await user.click(await screen.findByRole("button", { name: "Approve and submit" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve and submit" }))
    expect(await screen.findByText(line)).toBeVisible()
    expect(screen.getByText(countLine)).toBeVisible()
    if (link) expect(screen.getByRole("link", { name: link })).toBeVisible()
  })

  it("a second approval shows C-SAMPLE-6 and submits nothing more", async () => {
    const { user, api, app } = openSample()
    await user.click(await screen.findByRole("button", { name: "Approve and submit" }))
    // A second tab approved it first.
    api.state.submissions[app.app.id] = { ...api.state.submissions[app.app.id], state: "confirmed", sample: { state: "approved", rejectReason: null, counts: true } }
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve and submit" }))
    expect(await screen.findByText("This sample was already approved. It was submitted once.")).toBeVisible()
  })

  it("reject needs a reason (C-VAL-SAMPLE-1), then rejects with C-SAMPLE-7 and stores the reason", async () => {
    const { user, api, app } = openSample()
    await user.click(await screen.findByRole("button", { name: "Reject" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Reject this sample?" })
    await user.click(within(dialog).getByRole("button", { name: "Reject sample" }))
    expect(within(dialog).getByText("Enter a reason for rejecting this sample.")).toBeVisible()
    expect(api.state.submissions[app.app.id].sample?.state).toBe("awaiting_review")

    await user.type(within(dialog).getByRole("textbox", { name: /Why are you rejecting this sample\?/ }), "Cover letter overstates team size")
    await user.click(within(dialog).getByRole("button", { name: "Reject sample" }))
    expect(await findToast("Sample rejected. It wasn't submitted and doesn't count toward the 5.")).toBeVisible()
    expect(api.state.submissions[app.app.id].sample).toMatchObject({ state: "rejected", rejectReason: "Cover letter overstates team size" })
    expect(await screen.findByText("Cover letter overstates team size")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Approve and submit" })).not.toBeInTheDocument()
  })
})

describe("Sample review: form answers panel (C-SAMPLE-14 to 17)", () => {
  function open(answers: Parameters<typeof formAnswer>[0][] | null) {
    const posting = rankedPosting()
    const app = entry(awaitingSample(), { jobPostingId: posting.id, company: "Acme Payments" })
    const formAnswers = answers ? { [app.app.id]: { available: true, readAt: "2026-10-20T08:00:00.000Z", answers: answers.map(formAnswer) } } : {}
    return openSubmission(`/activation/${app.app.id}`, [app], { formAnswers }, { postings: [posting] })
  }
  const panel = async () => (await screen.findByRole("heading", { name: "Form answers" })).closest('[data-slot="card"]') as HTMLElement

  it("lists each planned answer in form order with its source, under C-SAMPLE-15", async () => {
    open([
      { question: "Email", source: "settings_contact", value: "ada@example.test" },
      { question: "Will you need sponsorship?", source: "rule_sponsorship", value: "Yes" },
      { question: "Where are you based?", source: "settings_location", value: "Lagos, Nigeria" },
      { question: "Resume", source: "document_resume", value: null },
    ])
    const p = await panel()
    expect(p).toHaveTextContent("What the assistant will type into each field of Acme Payments's form. It fills nothing that isn't listed here.")
    const rows = await within(p).findAllByRole("row")
    expect(rows.slice(1).map((r) => r.querySelector("td")?.textContent)).toEqual([
      "Question:Email",
      "Question:Will you need sponsorship?",
      "Question:Where are you based?",
      "Question:Resume",
    ])
    expect(rows[2]).toHaveTextContent("Rule: sponsorship is always Yes")
    expect(rows[3]).toHaveTextContent("Settings: location")
    expect(rows[4]).toHaveTextContent("Resume (PDF)")
  })

  it("a redacted sensitive answer shows C-SAMPLE-16 with no reveal control and no value", async () => {
    open([{ question: "Gender", source: "approved_answer_sensitive", value: null, redacted: true }])
    const p = await panel()
    expect(await within(p).findByText("Answer hidden because it's sensitive.")).toBeInTheDocument()
    expect(within(p).getByText("Hidden. Sensitive answers aren't shown here.")).toBeVisible()
    expect(within(p).queryByRole("button")).not.toBeInTheDocument()
  })

  it("a required question with no Approved Answer shows 'No Approved Answer' and C-SAMPLE-8 above the action bar", async () => {
    open([{ question: "Years of Vue.js?", source: "missing", value: null, blockedReason: "missing_approved_answer" }])
    expect(await within(await panel()).findByText("No Approved Answer")).toBeVisible()
    expect(
      await screen.findByText('This form has a required question with no Approved Answer: "Years of Vue.js?". Approving will block the Application instead of submitting it.')
    ).toBeVisible()
    expect(screen.getByRole("link", { name: "Add Approved Answer" })).toHaveAttribute("href", "/answers")
  })

  it("CR5E-01: a manual-only question keeps C-SAMPLE-8 but offers no Add Approved Answer", async () => {
    open([{ question: "Will you require sponsorship?", source: "missing", value: null, blockedReason: "missing_approved_answer", manualOnly: true }])
    expect(
      await screen.findByText('This form has a required question with no Approved Answer: "Will you require sponsorship?". Approving will block the Application instead of submitting it.')
    ).toBeVisible()
    expect(screen.queryByRole("link", { name: "Add Approved Answer" })).not.toBeInTheDocument()
  })

  it("no planned answers: C-SAMPLE-17", async () => {
    open([])
    expect(await within(await panel()).findByText("This form asks nothing beyond your documents.")).toBeVisible()
  })

  it("a form not read yet (available: false) says when it will be read", async () => {
    open(null)
    expect(await within(await panel()).findByText("The form hasn't been read yet; it's read at the next 09:00 run.")).toBeVisible()
  })
})

describe("Sample review: results with new copy", () => {
  async function approve(user: ReturnType<typeof openSubmission>["user"]) {
    await user.click(await screen.findByRole("button", { name: "Approve and submit" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve and submit" }))
  }
  function open(status = submissionStatus(), posting = rankedPosting()) {
    const app = entry(awaitingSample(), { jobPostingId: posting.id, company: "Acme Payments" })
    return openSubmission(`/activation/${app.app.id}`, [app], { status }, { postings: [posting] })
  }

  it("not_submitted: C-SAMPLE-13, the action bar comes back and the sample can be approved again", async () => {
    const { user, api } = open()
    api.state.nextSampleResult = () => ({ result: "not_submitted", submission: {} })
    await approve(user)
    expect(await screen.findByText("Not sent yet.")).toBeVisible()
    expect(
      screen.getByText("The assistant can't submit right now, so nothing went to Acme Payments. This sample is still waiting for your review and doesn't count toward the 5. Try again later.")
    ).toBeVisible()
    // The confirm dialog closes after the result arrives; the page is inert until it has gone.
    expect(await screen.findByRole("button", { name: "Approve and submit" })).toBeVisible()
  })

  it("not_submitted while paused: C-SAMPLE-13's paused text", async () => {
    const { user, api } = open(submissionStatus({ globalPaused: true }))
    api.state.nextSampleResult = () => ({ result: "not_submitted", submission: {} })
    await approve(user)
    expect(
      await screen.findByText("Automation is paused, so nothing went to Acme Payments. This sample is still waiting for your review. Approve it again after you resume automation.")
    ).toBeVisible()
  })

  it("excluded with no violated rule on the posting: C-SAMPLE-3a with See Eligibility, never a generic {rule}", async () => {
    const posting = rankedPosting()
    const { user, api } = open(submissionStatus(), posting)
    api.state.nextSampleResult = () => ({ result: "excluded", submission: { state: "not_submitted" } })
    await approve(user)
    expect(await screen.findByText("Not submitted. This Job Posting breaks one of your Eligibility rules. Open its Eligibility panel to see which.")).toBeVisible()
    expect(await screen.findByRole("link", { name: "See Eligibility" })).toHaveAttribute("href", `/postings/${posting.id}`)
    expect(screen.queryByText(/violated Eligibility rule: Eligibility/)).not.toBeInTheDocument()
  })
})

describe("Sample review: approval answered pending (v1.8.0, F-QA5-01)", () => {
  const SUBMITTING = "Submitting…"
  const CONFIRMED = "Submitted to Acme Payments. Confirmed by Confirmation page. 3 of 5 samples approved."
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

  function open(sample = awaitingSample(), status = submissionStatus({ countingSamples: 2 })) {
    const posting = rankedPosting()
    const app = entry(sample, { jobPostingId: posting.id, company: "Acme Payments", requisitionId: "R-1042" })
    const opened = openSubmission(`/activation/${app.app.id}`, [app], { status, workerFinishesAtOnce: false }, { postings: [posting] }, { fakeTimers: true })
    return { ...opened, id: app.app.id }
  }
  async function approve(user: ReturnType<typeof openSubmission>["user"]) {
    await user.click(await screen.findByRole("button", { name: "Approve and submit" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve and submit" }))
  }

  it("shows Submitting… with no action bar while the worker runs, then C-SAMPLE-1 once it confirms", async () => {
    const { user, api, id } = open()
    await approve(user)
    expect(await screen.findByRole("status")).toHaveTextContent(SUBMITTING)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Approve and submit" })).not.toBeInTheDocument()
    expect(screen.getByText("Submitting")).toBeVisible()
    await tick(2_000)
    expect(screen.getByRole("status")).toHaveTextContent(SUBMITTING)
    api.finishSample(id)
    await tick(3_000)
    expect(await screen.findByText(CONFIRMED)).toBeVisible()
    expect(screen.queryByText(SUBMITTING)).not.toBeInTheDocument()
  })

  it("keeps polling through submit_claimed and submitting", async () => {
    const { user, api, id } = open()
    await approve(user)
    await screen.findByText(SUBMITTING)
    api.state.submissions[id] = { ...api.state.submissions[id], state: "submit_claimed" }
    await tick(2_000)
    api.state.submissions[id] = { ...api.state.submissions[id], state: "submitting" }
    await tick(3_000)
    expect(screen.getByRole("status")).toHaveTextContent(SUBMITTING)
    api.finishSample(id)
    await tick(4_500)
    expect(await screen.findByText(CONFIRMED)).toBeVisible()
  })

  it.each([
    [false, "The assistant can't submit right now, so nothing went to Acme Payments. This sample is still waiting for your review and doesn't count toward the 5. Try again later."],
    [true, "Automation is paused, so nothing went to Acme Payments. This sample is still waiting for your review. Approve it again after you resume automation."],
  ])("back in awaiting review (paused %s): C-SAMPLE-13, and the sample can be approved again", async (paused, text) => {
    const { user, api, id } = open()
    await approve(user)
    await screen.findByText(SUBMITTING)
    api.returnSampleToReview(id)
    if (paused) api.state.status = { ...api.state.status, globalPaused: true }
    await tick(2_000)
    expect(await screen.findByText("Not sent yet.")).toBeVisible()
    expect(screen.getByText(text)).toBeVisible()
    expect(await screen.findByRole("button", { name: "Approve and submit" })).toBeEnabled()
  })

  it.each([
    ["uncertain", { state: "uncertain" }, "The form was submitted but no confirmation was seen. It's now an Uncertain Submission and won't be retried."],
    ["blocked", { state: "blocked", blockedReason: "login", blockedAt: "2026-10-20T09:15:00.000Z" }, "Not submitted. It's now a Blocked Application: Login."],
    ["duplicate", { state: "not_submitted" }, "Not submitted. You already have an Application or existing application for requisition R-1042."],
  ] as const)("a %s outcome from the worker shows its C-SAMPLE line", async (result, after, line) => {
    const { user, api, id } = open()
    api.state.nextSampleResult = () => ({ result, submission: after })
    await approve(user)
    await screen.findByText(SUBMITTING)
    api.finishSample(id)
    await tick(2_000)
    expect(await screen.findByText(line)).toBeVisible()
  })

  it("stops after 5 minutes with a 'still submitting' line, and asks no more", async () => {
    const { user, id } = open()
    await approve(user)
    await screen.findByText(SUBMITTING)
    let gets = 0
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === `/v1/applications/${id}/submission`) gets++
    })
    await tick(5 * 60_000)
    expect(await screen.findByText("Still submitting. Reload this page in a few minutes to see the result.")).toBeVisible()
    const after = gets
    await tick(60_000)
    server.events.removeAllListeners()
    expect(after).toBeGreaterThan(20)
    expect(gets).toBe(after)
    expect(screen.queryByRole("button", { name: "Approve and submit" })).not.toBeInTheDocument()
  })

  it("stops polling when the page closes", async () => {
    const { user, id } = open()
    await approve(user)
    await screen.findByText(SUBMITTING)
    let gets = 0
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === `/v1/applications/${id}/submission`) gets++
    })
    await user.click(within(screen.getByRole("navigation", { name: /breadcrumb/i })).getByRole("link", { name: "Check first sends" }))
    expect(await screen.findByRole("heading", { level: 1, name: "Check first sends" })).toBeVisible()
    await tick(60_000)
    server.events.removeAllListeners()
    expect(gets).toBe(0)
  })

  it("opening a sample the worker hasn't finished shows Submitting… and follows it", async () => {
    const { api, id } = open(submission({ kind: "sample", sample: { state: "approved", rejectReason: null, counts: false } }))
    expect(await screen.findByRole("status")).toHaveTextContent(SUBMITTING)
    expect(screen.queryByRole("button", { name: "Approve and submit" })).not.toBeInTheDocument()
    api.state.submissions[id] = { ...api.state.submissions[id], state: "confirmed", evidence: { kind: "confirmation_page", text: null, observedAt: "2026-10-20T09:15:00.000Z" }, sample: { state: "approved", rejectReason: null, counts: true } }
    api.state.status = { ...api.state.status, countingSamples: 3 }
    await tick(2_000)
    expect(await screen.findByText(CONFIRMED)).toBeVisible()
  })
})

describe("Activation Gate: Approved tab while the worker submits (v1.8.0)", () => {
  it("an unfinished sample reads Submitting with no 'Doesn't count', and updates on the next poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    const pending = entry(submission({ kind: "sample", sample: { state: "approved", rejectReason: null, counts: false } }), { roleTitle: "Pending one" })
    const { api } = openSubmission("/activation?tab=approved", [pending])
    const panel = await screen.findByRole("tabpanel")
    expect(await within(panel).findByText("Submitting")).toBeVisible()
    expect(within(panel).queryByText("Doesn't count")).not.toBeInTheDocument()
    api.state.submissions[pending.app.id] = { ...api.state.submissions[pending.app.id], state: "confirmed", sample: { state: "approved", rejectReason: null, counts: true } }
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(await within(panel).findByText("Confirmed Submission")).toBeVisible()
  })
})
