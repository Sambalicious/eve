import { act, screen, waitFor, within } from "@testing-library/react"
import { focusManager } from "@tanstack/react-query"
import { delay, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JOB_POSTINGS_PATH, type JobPostingDetail } from "@eve/contracts"

import { apiErrorResponse, awaitingSample, formAnswer, rankedPosting, server, submission, submissionStatus } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { entry, openSubmission } from "./submission-helpers"

/**
 * g9 (O6, AC 5.8): the criteria note on the sample review page
 * (g9-design-spec.md, acceptance checks 1 to 15).
 */
const TITLE = "This posting no longer meets your job criteria."
const BODY = "You can still approve or reject this sample."
const WEAK_LINE = "Your profile backs only 70% of the core responsibilities. Your minimum is 80%."
const WEAK_FALLBACK = "Your profile doesn't back enough of the core responsibilities."
const TECH_LINE = "This job doesn't mention the technologies you told Eve to look for."
const C_SAMPLE_8 = 'This form has a required question with no Approved Answer: "Years of Vue.js?". Approving will block the Application instead of submitting it.'
const SUBMITTING = "Submitting…"
const CONFIRMED = "Submitted to Acme Payments. Confirmed by Confirmation page. 3 of 5 samples approved."
const C_SAMPLE_13 =
  "The assistant can't submit right now, so nothing went to Acme Payments. This sample is still waiting for your review and doesn't count toward the 5. Try again later."

type Match = NonNullable<JobPostingDetail["match"]>
const weakMatch = (covered: number, total: number, thresholdPercent: number): Match => ({
  verdict: "weak",
  weakReason: total === 0 ? "no_core_responsibilities" : "coverage_below_threshold",
  coveredCount: covered,
  totalCount: total,
  thresholdPercent,
  careerProfileVersion: 1,
  coreResponsibilities: [],
  mandatoryPrerequisites: [],
  niceToHave: [],
})
const skippedWeak = (o: Partial<JobPostingDetail> = {}) =>
  rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match", match: weakMatch(7, 10, 80), ...o })
const skippedTech = () => rankedPosting({ status: "skipped", rank: null, skipReason: "technology_mismatch" })

function open(
  posting: JobPostingDetail,
  options: { sample?: ReturnType<typeof awaitingSample>; formAnswers?: boolean; fakeTimers?: boolean; status?: ReturnType<typeof submissionStatus> } = {}
) {
  const app = entry(options.sample ?? awaitingSample(), { jobPostingId: posting.id, company: "Acme Payments", requisitionId: "R-1042" })
  const formAnswers = options.formAnswers
    ? {
        [app.app.id]: {
          available: true,
          readAt: "2026-10-20T08:00:00.000Z",
          answers: [formAnswer({ question: "Years of Vue.js?", source: "missing", value: null, blockedReason: "missing_approved_answer" })],
        },
      }
    : {}
  const opened = openSubmission(
    `/activation/${app.app.id}`,
    [app],
    { status: options.status ?? submissionStatus({ countingSamples: 2 }), formAnswers, workerFinishesAtOnce: !options.fakeTimers },
    { postings: [posting] },
    { fakeTimers: options.fakeTimers }
  )
  return { ...opened, id: app.app.id, posting }
}

/** The posting has loaded once its Application System shows in the header. */
const postingLoaded = async () => screen.findByText("Application System")
const queryNote = () => screen.queryByRole("note", { name: TITLE })
const findNote = () => screen.findByRole("note", { name: TITLE })
const approveButton = () => screen.findByRole("button", { name: "Approve and submit" })
/** Advances fake timers; with `fakeTimers: true` the worker finishes only on `api.finishSample(id)`, then the 2 s settle poll reads it. */
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
async function approve(user: ReturnType<typeof openSubmission>["user"]) {
  await user.click(await approveButton())
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve and submit" }))
}

describe("Sample review: Generate again", () => {
  it("a sample awaiting review offers Generate again for its documents", async () => {
    open(rankedPosting())
    await postingLoaded()
    expect(await screen.findByRole("button", { name: "Generate again" })).toBeVisible()
  })

  it("an approved, submitted sample offers no Generate again", async () => {
    const { user } = open(rankedPosting())
    await postingLoaded()
    await approve(user)
    expect(await screen.findByText(CONFIRMED)).toBeVisible()
    await waitFor(() => expect(screen.queryByRole("button", { name: "Generate again" })).not.toBeInTheDocument())
  })
})

describe("Sample review: criteria note shows (checks 2 to 4, 12, 15)", () => {
  it("check 1: a ranked posting shows no criteria note", async () => {
    open(rankedPosting())
    await postingLoaded()
    expect(await approveButton()).toBeVisible()
    expect(queryNote()).not.toBeInTheDocument()
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it("check 2: weak_core_match 7 of 10 at 80% shows title, skip line, body and the link, in that order", async () => {
    open(skippedWeak())
    const note = await findNote()
    const parts = [TITLE, WEAK_LINE, BODY, "Change job criteria"]
    const text = note.textContent ?? ""
    expect(parts.map((p) => text.indexOf(p))).toEqual([...parts.map((p) => text.indexOf(p))].sort((a, b) => a - b))
    parts.forEach((p) => expect(text).toContain(p))
    expect(within(note).getByRole("link", { name: "Change job criteria" })).toHaveAttribute("href", "/settings#job-criteria")
    // Check 15: exact strings and nothing else; no "Filters".
    expect(text).toBe(`${TITLE}${WEAK_LINE}${BODY}Change job criteria`)
    expect(text).not.toMatch(/filters/i)
  })

  it.each([
    ["match is null", { match: null }],
    ["totalCount is 0", { match: weakMatch(0, 0, 80) }],
  ])("check 3: weak_core_match when %s falls back to C-SKIP-4", async (_label, overrides) => {
    open(skippedWeak(overrides))
    const note = await findNote()
    expect(note).toHaveTextContent(WEAK_FALLBACK)
    expect(note.textContent).not.toMatch(/NaN|%/)
  })

  it("check 4: technology_mismatch shows C-JC-SKIP-TECH", async () => {
    open(skippedTech())
    expect(await findNote()).toHaveTextContent(TECH_LINE)
  })

  it("worst case: 99 of 100 at 100% reads 99%, not 100%", async () => {
    open(skippedWeak({ match: weakMatch(99, 100, 100) }))
    expect(await findNote()).toHaveTextContent("Your profile backs only 99% of the core responsibilities. Your minimum is 100%.")
  })

  it("check 12: role note, not a live region, icon hidden, text wraps", async () => {
    open(skippedWeak())
    const note = await findNote()
    expect(note).toHaveAttribute("role", "note")
    expect(note).not.toHaveAttribute("aria-live")
    expect(note.querySelector("[aria-live]")).toBeNull()
    const icon = note.querySelector("svg")
    expect(icon).toHaveAttribute("aria-hidden", "true")
    // Check 14 (jsdom part): the lines wrap anywhere instead of overflowing at 375px.
    for (const line of [TITLE, WEAK_LINE, BODY]) expect(within(note).getByText(line).className).toMatch(/overflow-wrap:anywhere/)
    // Below 768px the sticky action bar must not cover the focused link: a bottom scroll margin, removed at md.
    expect(within(note).getByRole("link", { name: "Change job criteria" }).className).toMatch(/(^| )scroll-mb-20( |$).*md:scroll-mb-0/)
  })
})

describe("Sample review: criteria note hidden (checks 5, 6, 11)", () => {
  it.each<[string, Partial<JobPostingDetail>]>([
    ["excluded", { status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: "location" }],
    ["skipped, uncovered prerequisite", { status: "skipped", rank: null, skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Go" }],
    ["skipped, no core responsibilities", { status: "skipped", rank: null, skipReason: "no_core_responsibilities" }],
    ["skipped, not a software role", { status: "skipped", rank: null, skipReason: "not_software_role" }],
    ["skipped, unsupported system", { status: "skipped", rank: null, skipReason: "unsupported_application_system", skipDetail: "Workday" }],
    ["checking", { status: "checking", rank: null }],
    ["waiting to be checked", { status: "waiting_to_be_checked", rank: null }],
    ["evaluation failed", { status: "evaluation_failed", rank: null, evaluationFailure: "provider_error" }],
  ])("check 5: %s shows no note", async (_label, overrides) => {
    open(rankedPosting(overrides))
    await postingLoaded()
    expect(await approveButton()).toBeVisible()
    expect(queryNote()).not.toBeInTheDocument()
  })

  it("check 6: posting failed to load: no note, the action bar renders and approval works", async () => {
    const { user, api, id, app, posting } = open(skippedWeak(), { fakeTimers: true })
    server.use(http.get(`${JOB_POSTINGS_PATH}/:id`, () => apiErrorResponse("not_found")))
    // CR-02 (.runs/g9/reports/review.md): check the note while the sample is still under review and the posting
    // request has failed. After an outcome the note is hidden whatever the posting is, so that is no evidence.
    await waitFor(() => expect(app.queryClient.getQueryState(["job-postings", "detail", posting.id])?.status).toBe("error"))
    expect(await approveButton()).toBeEnabled()
    expect(queryNote()).not.toBeInTheDocument()
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
    await approve(user)
    await screen.findByText(SUBMITTING)
    api.finishSample(id)
    await tick(2_000)
    expect(await screen.findByText(CONFIRMED)).toBeVisible()
    expect(api.requests.filter((r) => r.path.endsWith("/sample/approve"))).toHaveLength(1)
  })

  it("check 6: posting still loading: no note, the action bar renders and approval works", async () => {
    const { user, api, id } = open(skippedWeak(), { fakeTimers: true })
    server.use(
      http.get(`${JOB_POSTINGS_PATH}/:id`, async () => {
        await delay("infinite")
        return apiErrorResponse("not_found")
      })
    )
    expect(await approveButton()).toBeEnabled()
    expect(queryNote()).not.toBeInTheDocument()
    await approve(user)
    await screen.findByText(SUBMITTING)
    api.finishSample(id)
    await tick(2_000)
    expect(await screen.findByText(CONFIRMED)).toBeVisible()
    expect(api.requests.filter((r) => r.path.endsWith("/sample/approve"))).toHaveLength(1)
  })

  it.each([
    ["approved and confirmed", submission({ kind: "sample", state: "confirmed", sample: { state: "approved", rejectReason: null, counts: true } })],
    ["approved and blocked", submission({ kind: "sample", state: "blocked", blockedReason: "login", sample: { state: "approved", rejectReason: null, counts: false } })],
    ["rejected", submission({ kind: "sample", sample: { state: "rejected", rejectReason: "Cover letter overstates team size", counts: false } })],
  ])("check 11: a sample %s shows no note", async (_label, sample) => {
    open(skippedWeak(), { sample })
    await postingLoaded()
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: "Approve and submit" })).not.toBeInTheDocument()
    expect(queryNote()).not.toBeInTheDocument()
  })
})

describe("Sample review: approving and rejecting with the note (checks 7 to 9)", () => {
  it("check 7: Approve and submit is enabled, C-CONFIRM-3 is unchanged and the approval is sent", async () => {
    const { user, api, id } = open(skippedWeak(), { fakeTimers: true })
    await findNote()
    expect(await approveButton()).toBeEnabled()
    await user.click(await approveButton())
    const dialog = await screen.findByRole("alertdialog", { name: "Approve and submit this Application?" })
    expect(dialog).toHaveTextContent("This sends the Application to Acme Payments now, with the documents and answers shown. It doesn't count toward the daily cap.")
    await user.click(within(dialog).getByRole("button", { name: "Approve and submit" }))
    await screen.findByText(SUBMITTING)
    api.finishSample(id)
    await tick(2_000)
    expect(await screen.findByText(CONFIRMED)).toBeVisible()
    expect(api.requests.filter((r) => r.path === `/v1/applications/${id}/sample/approve`)).toHaveLength(1)
  })

  it("check 7: Reject works as before", async () => {
    const { user, api, id } = open(skippedWeak())
    await findNote()
    await user.click(await screen.findByRole("button", { name: "Reject" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Reject this sample?" })
    await user.type(within(dialog).getByRole("textbox", { name: /Why are you rejecting this sample\?/ }), "Not a fit any more")
    await user.click(within(dialog).getByRole("button", { name: "Reject sample" }))
    expect(await findToast("Sample rejected. It wasn't submitted and doesn't count toward the 5.")).toBeVisible()
    expect(api.state.submissions[id].sample).toMatchObject({ state: "rejected", rejectReason: "Not a fit any more" })
    await waitFor(() => expect(queryNote()).not.toBeInTheDocument())
  })

  it("check 8: Approve and submit is described by the note; without a note it has no aria-describedby", async () => {
    open(skippedWeak())
    const note = await findNote()
    const button = await approveButton()
    expect(note.id).not.toBe("")
    expect(button).toHaveAttribute("aria-describedby", note.id)
    expect(button).toHaveAccessibleDescription(`${TITLE} ${WEAK_LINE} ${BODY} Change job criteria`)
  })

  it("check 8: with a ranked posting the button has no aria-describedby", async () => {
    open(rankedPosting())
    await postingLoaded()
    expect(await approveButton()).not.toHaveAttribute("aria-describedby")
  })

  it("check 9: the note precedes C-SAMPLE-8, and both precede the action bar", async () => {
    open(skippedWeak(), { formAnswers: true })
    const note = await findNote()
    const warning = (await screen.findByText(C_SAMPLE_8)).closest('[role="note"]') as HTMLElement
    const button = await approveButton()
    expect(warning).not.toBe(note)
    expect(note.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(warning.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("Sample review: the note through an approval (check 10)", () => {
  it("stays while Submitting… shows, and is gone after the outcome", async () => {
    const { user, api, id } = open(skippedWeak(), { fakeTimers: true })
    await findNote()
    await approve(user)
    expect(await screen.findByRole("status")).toHaveTextContent(SUBMITTING)
    expect(queryNote()).toBeInTheDocument()
    await tick(2_000)
    expect(queryNote()).toBeInTheDocument()
    api.finishSample(id)
    await tick(3_000)
    expect(await screen.findByText(CONFIRMED)).toBeVisible()
    expect(queryNote()).not.toBeInTheDocument()
  })

  it("shows for a sample found submitting on load", async () => {
    open(skippedWeak(), { sample: submission({ kind: "sample", state: "submitting", sample: { state: "approved", rejectReason: null, counts: false } }), fakeTimers: true })
    expect(await screen.findByRole("status")).toHaveTextContent(SUBMITTING)
    expect(await findNote()).toBeInTheDocument()
  })

  it("is back after C-SAMPLE-13 when the worker returns the sample to review", async () => {
    const { user, api, id } = open(skippedWeak(), { fakeTimers: true })
    await findNote()
    await approve(user)
    await screen.findByText(SUBMITTING)
    api.returnSampleToReview(id)
    await tick(2_000)
    expect(await screen.findByText(C_SAMPLE_13)).toBeVisible()
    expect(await approveButton()).toBeEnabled()
    const note = await findNote()
    expect(await approveButton()).toHaveAttribute("aria-describedby", note.id)
  })

  it("is back after C-SAMPLE-13 when the approval itself sent nothing", async () => {
    const { user, api } = open(skippedWeak())
    api.state.nextSampleResult = () => ({ result: "not_submitted", submission: {} })
    await approve(user)
    expect(await screen.findByText(C_SAMPLE_13)).toBeVisible()
    expect(await findNote()).toBeInTheDocument()
  })

  it.each([
    ["uncertain", { state: "uncertain" }, "The form was submitted but no confirmation was seen. It's now an Uncertain Submission and won't be retried."],
    ["blocked", { state: "blocked", blockedReason: "login", blockedAt: "2026-10-20T09:15:00.000Z" }, "Not submitted. It's now a Blocked Application: Login."],
    ["duplicate", { state: "not_submitted" }, "Not submitted. You already have an Application or existing application for requisition R-1042."],
  ] as const)("is gone after a %s outcome from the worker", async (result, after, line) => {
    const { user, api, id } = open(skippedWeak(), { fakeTimers: true })
    api.state.nextSampleResult = () => ({ result, submission: after })
    await approve(user)
    await screen.findByText(SUBMITTING)
    api.finishSample(id)
    await tick(2_000)
    expect(await screen.findByText(line)).toBeVisible()
    expect(queryNote()).not.toBeInTheDocument()
  })

  // The approval itself answers "excluded", so no settle poll runs and real timers cost nothing.
  it("is gone after an excluded outcome", async () => {
    const { user, api } = open(skippedWeak())
    api.state.nextSampleResult = () => ({ result: "excluded", submission: { state: "not_submitted" } })
    await approve(user)
    expect(await screen.findByText("Not submitted. This Job Posting breaks one of your Eligibility rules. Open its Eligibility panel to see which.")).toBeVisible()
    expect(queryNote()).not.toBeInTheDocument()
  })
})

describe("Sample review: the note follows the posting (checks 12, 13)", () => {
  // CR-04: check 12 forces the module-level focusManager; release it even when an assertion fails mid-test.
  afterEach(() => {
    act(() => focusManager.setFocused(undefined))
  })

  it("check 12: a refetch on focus from ranked to skipped shows the note in place; focus does not move", async () => {
    const { discovery, posting } = open(rankedPosting())
    await postingLoaded()
    const button = await approveButton()
    act(() => button.focus())
    expect(button).toHaveFocus()
    discovery.state.postings = [{ ...posting, status: "skipped", rank: null, skipReason: "weak_core_match", match: weakMatch(7, 10, 80) }]
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    const note = await findNote()
    expect(note).toHaveTextContent(WEAK_LINE)
    expect(button).toHaveFocus()
    expect(button).toHaveAttribute("aria-describedby", note.id)

    // Criteria changed back: ranked again, the note goes.
    discovery.state.postings = [posting]
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect(queryNote()).not.toBeInTheDocument())
    expect(button).not.toHaveAttribute("aria-describedby")
  })

  it("check 13: a Job criteria save that skips the posting shows the note on return, without a reload", async () => {
    const { user, career, discovery, posting, id, app } = open(rankedPosting())
    await postingLoaded()
    expect(queryNote()).not.toBeInTheDocument()
    career.onJobCriteriaSaved(() => {
      discovery.state.postings = [{ ...posting, status: "skipped", rank: null, skipReason: "weak_core_match", match: weakMatch(7, 10, 80) }]
    })
    await user.click(screen.getByRole("link", { name: "Settings" }))
    const region = await screen.findByRole("region", { name: "Job criteria" })
    const field = within(region).getByLabelText("Minimum core Match")
    await user.clear(field)
    await user.type(field, "80")
    await user.click(within(region).getByRole("button", { name: "Save job criteria" }))
    expect(await findToast("Job criteria saved.")).toBeInTheDocument()
    expect(app.queryClient.getQueryState(["job-postings", "detail", posting.id])?.isInvalidated).toBe(true)

    await act(() => app.router.navigate(`/activation/${id}`))
    expect(await findNote()).toHaveTextContent(WEAK_LINE)
  })
})
