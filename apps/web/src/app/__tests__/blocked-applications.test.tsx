import { screen, waitFor, within } from "@testing-library/react"
import { delay, http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, blocked, server, submission } from "@/shared/testing"
import { SUBMISSIONS_PATH } from "@eve/contracts"
import { findToast } from "./career-setup-helpers"
import { entry, openSubmission } from "./submission-helpers"

const VUE_QUESTION = "How many years of Vue.js experience do you have?"
const VUE = `The form asks "${VUE_QUESTION}" and you have no Approved Answer for it. Nothing was guessed.`
const C_BLOCK_10 =
  "The assistant stopped before the submit button, so the employer received nothing. Apply yourself with the prepared documents, then mark it completed manually. The assistant won't try this form again."

const card = async (name: string) => (await screen.findByRole("link", { name })).closest('[role="article"]') as HTMLElement

describe("Blocked Applications (/blocked)", () => {
  it("opens from the nav with a count, groups cards by reason and shows each detail line", async () => {
    const { user, currentPath } = openSubmission("/dashboard", [
      entry(blocked("missing_approved_answer", VUE), { roleTitle: "Frontend Engineer", requisitionId: "R-1" }),
      entry(blocked("login", "The form needs you to sign in to an account. The assistant doesn't sign in or create accounts."), { roleTitle: "Login role", requisitionId: "R-2" }),
      entry(submission({ state: "uncertain", kind: "automatic", attemptNumber: 1, submittedAt: "2026-10-20T09:15:00.000Z", submittedWatDay: "2026-10-20" }), { roleTitle: "Unsure role" }),
    ])

    const nav = (await screen.findByRole("link", { name: "Home" })).closest('[data-slot="sidebar"]') as HTMLElement
    await user.click(await within(nav).findByRole("link", { name: "Blocked, 2" }))
    expect(currentPath()).toBe("/blocked")
    expect(await screen.findByRole("heading", { level: 1, name: "Blocked" })).toBeVisible()
    expect(await screen.findByRole("heading", { level: 2, name: "Missing Approved Answer (1)" })).toBeVisible()
    expect(screen.getByRole("heading", { level: 2, name: "Login (1)" })).toBeVisible()
    expect(await card("Frontend Engineer at Acme Payments")).toHaveTextContent(VUE)
    expect(screen.queryByText("Unsure role at Acme Payments")).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Unsure sends, 1" })).toBeVisible()
  })

  it("login, CAPTCHA and similar blocks offer the Manual Application path: employer form, downloads, mark completed", async () => {
    const app = entry(blocked("captcha", "The form shows a CAPTCHA. The assistant doesn't solve CAPTCHAs."), { roleTitle: "Captcha role" })
    openSubmission("/blocked", [app])

    const c = await card("Captcha role at Acme Payments")
    expect(within(c).getByRole("link", { name: "Open employer form(opens in a new tab)" })).toHaveAttribute("href", app.app.applicationUrl)
    expect(within(c).getByRole("link", { name: "Download resume" })).toHaveAttribute("href", `/v1/applications/${app.app.id}/documents/resume.pdf`)
    expect(within(c).getByRole("link", { name: "Download cover letter" })).toHaveAttribute("href", `/v1/applications/${app.app.id}/documents/cover-letter.pdf`)
    expect(within(c).getByRole("button", { name: "Mark completed manually" })).toBeVisible()
    expect(within(c).queryByRole("button", { name: "Add Approved Answer" })).not.toBeInTheDocument()
  })

  it("marks a Blocked Application completed manually after C-CONFIRM-5; it leaves the list with the toast", async () => {
    const app = entry(blocked("assessment", 'The form includes an assessment: "Coding test". Only you can take it.'), { roleTitle: "Assessed role" })
    const { user, api } = openSubmission("/blocked", [app])

    await user.click(within(await card("Assessed role at Acme Payments")).getByRole("button", { name: "Mark completed manually" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Mark as completed manually?" })
    expect(dialog).toHaveTextContent("Use this after you've applied on the employer site yourself. It becomes a Manual Application and doesn't count toward the daily cap.")
    await user.click(within(dialog).getByRole("button", { name: "Mark completed" }))

    expect(await findToast("Recorded as a Manual Application.")).toBeVisible()
    expect(await screen.findByText("No Blocked Applications")).toBeVisible()
    expect(api.state.submissions[app.app.id].state).toBe("manual")
    expect(api.requests.filter((r) => r.path.endsWith("/manual-complete"))).toHaveLength(1)
  })

  it("an Application held below the ATS minimum explains how it gets back to the queue, with links to the profile and the setting", async () => {
    openSubmission("/blocked", [entry(blocked("ats_below_minimum", "ATS match 35% is below your minimum of 40%."), { roleTitle: "ATS role" })])
    const c = await card("ATS role at Acme Payments")
    expect(screen.getByRole("heading", { level: 2, name: "ATS match below your minimum (1)" })).toBeVisible()
    expect(c).toHaveTextContent("ATS match 35% is below your minimum of 40%.")
    expect(c).toHaveTextContent("It goes back to the queue on its own once its ATS match reaches your minimum.")
    expect(within(c).getByRole("link", { name: "Career Profile" })).toHaveAttribute("href", "/profile")
    expect(within(c).getByRole("link", { name: "ATS minimum" })).toHaveAttribute("href", "/settings#ats")
    expect(within(c).getByRole("button", { name: "Mark completed manually" })).toBeVisible()
  })

  it("the seventh reason shows the sub-reason line and C-BLOCK-10, and only the Manual Application path", async () => {
    const detail = "The form sent the browser to apply.thirdparty-forms.example, which isn't the employer's application site."
    openSubmission("/blocked", [entry(blocked("automation_incomplete", detail, { blockedSubReason: "redirect" }), { roleTitle: "Seventh role" })])

    const c = await card("Seventh role at Acme Payments")
    expect(screen.getByRole("heading", { level: 2, name: "Automation couldn't complete the form (1)" })).toBeVisible()
    expect(c).toHaveTextContent(detail)
    expect(c).toHaveTextContent(C_BLOCK_10)
    expect(within(c).queryByRole("button", { name: /try again|approve/i })).not.toBeInTheDocument()
    expect(within(c).getByRole("button", { name: "Mark completed manually" })).toBeVisible()
  })

  it.each([
    ["budget", "It used up its time or effort limit for this form before every field was filled."],
    ["redirect", "The form sent the browser away from the employer's application site."],
    ["submit_attempt", "Something on the page tried to submit the form early. The assistant stopped it."],
    ["value_mismatch", "A field didn't hold the value the assistant set, so it didn't submit."],
  ] as const)("seventh reason without a detail line uses the %s fallback", async (subReason, line) => {
    openSubmission("/blocked", [entry(blocked("automation_incomplete", null, { blockedSubReason: subReason }), { roleTitle: "Fallback role" })])
    expect(await card("Fallback role at Acme Payments")).toHaveTextContent(line)
  })

  it("Missing Approved Answer: Add Approved Answer opens the sheet pre-filled from blockedQuestion; saving shows C-BLOCK-9 and queues it", async () => {
    const app = entry(blocked("missing_approved_answer", VUE, { blockedQuestion: VUE_QUESTION }), { roleTitle: "Vue role" })
    const { user, api } = openSubmission("/blocked", [app])

    await user.click(within(await card("Vue role at Acme Payments")).getByRole("button", { name: "Add Approved Answer" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByLabelText(/Question/)).toHaveValue(VUE_QUESTION)
    await user.type(within(sheet).getByLabelText(/Answer/), "3")
    await user.click(within(sheet).getByRole("button", { name: "Save answer" }))

    expect(
      await screen.findByText("Answer saved. This Application goes back to automatic submission and counts toward the cap on the day it's sent.")
    ).toBeVisible()
    await waitFor(() => expect(api.state.submissions[app.app.id].state).toBe("queued"))
  })

  it("the question comes from blockedQuestion, not from parsing the detail line (FE5-B5)", async () => {
    // A detail line in no known sentence form still pre-fills the Custom question.
    const app = entry(blocked("missing_approved_answer", "Some other wording", { blockedQuestion: "Notice period in weeks?" }), { roleTitle: "Wording role" })
    const { user } = openSubmission("/blocked", [app])
    await user.click(within(await card("Wording role at Acme Payments")).getByRole("button", { name: "Add Approved Answer" }))
    expect(within(await screen.findByRole("dialog")).getByLabelText(/Question/)).toHaveValue("Notice period in weeks?")
  })

  it.each([
    ["sensitive (C-BLOCK-1a)", 'The form asks a sensitive question, "Gender", and you have no Approved Answer for it. Nothing was inferred.', "Gender", "/answers#sensitive"],
    ["current salary (C-BLOCK-1b)", "The form asks for your current salary and you haven't approved a current-salary answer.", "Current salary", "/answers#salary"],
    ["gross-salary policy (C-BLOCK-1c)", 'The form asks "Expected salary in EUR", which your gross-salary policy doesn\'t cover.', "Expected salary in EUR", "/answers#salary"],
  ])("%s: Add Approved Answer opens that section of /answers; the Manual path is there too (FE5-4)", async (_name, line, question, target) => {
    const { user, currentPath } = openSubmission("/blocked", [entry(blocked("missing_approved_answer", line, { blockedQuestion: question }), { roleTitle: "Answer role" })])
    const c = await card("Answer role at Acme Payments")
    expect(c).toHaveTextContent(line)
    expect(within(c).getByRole("button", { name: "Mark completed manually" })).toBeVisible()
    expect(within(c).getByRole("link", { name: "Open employer form(opens in a new tab)" })).toBeVisible()
    expect(within(c).getByRole("link", { name: "Download resume" })).toBeVisible()
    await user.click(within(c).getByRole("button", { name: "Add Approved Answer" }))
    await waitFor(() => expect(currentPath()).toBe(target))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("a plain Missing Approved Answer card offers the Manual path beside Add Approved Answer (FE5-4)", async () => {
    openSubmission("/blocked", [entry(blocked("missing_approved_answer", VUE, { blockedQuestion: VUE_QUESTION }), { roleTitle: "Plain role" })])
    const c = await card("Plain role at Acme Payments")
    expect(within(c).getByRole("button", { name: "Add Approved Answer" })).toBeVisible()
    expect(within(c).getByRole("button", { name: "Mark completed manually" })).toBeVisible()
    expect(within(c).getByRole("link", { name: "Download cover letter" })).toBeVisible()
  })

  it("CR5D-01: a page-read work question (no blockedQuestion) is manual-only; a non-work missing answer still offers Add Approved Answer", async () => {
    const work =
      'The form asks "Will you now or in the future require visa sponsorship?" (as shown on the page). Work-authorization answers are used only on questions read from the employer\'s Greenhouse API, so complete this one manually. Nothing was entered.'
    openSubmission("/blocked", [
      entry(blocked("missing_approved_answer", work, { blockedQuestion: null }), { roleTitle: "Lever role" }),
      entry(blocked("missing_approved_answer", VUE, { blockedQuestion: VUE_QUESTION }), { roleTitle: "Vue role" }),
    ])
    const manual = await card("Lever role at Acme Payments")
    expect(manual).toHaveTextContent(work)
    expect(within(manual).queryByRole("button", { name: "Add Approved Answer" })).not.toBeInTheDocument()
    expect(within(manual).getByRole("button", { name: "Mark completed manually" })).toBeVisible()
    expect(within(manual).getByRole("link", { name: "Open employer form(opens in a new tab)" })).toBeVisible()
    const other = await card("Vue role at Acme Payments")
    expect(within(other).getByRole("button", { name: "Add Approved Answer" })).toBeVisible()
  })

  it("same-company review: C-BLOCK-6 detail, approve (C-CONFIRM-6) queues it", async () => {
    const detail = "You have an active Application at Northwind Health for Senior Frontend Engineer. Approve this one to submit it under the normal rules."
    const app = entry(blocked("same_company_review", detail), { company: "Northwind Health", roleTitle: "Staff Engineer", requisitionId: "NW-55" })
    const { user, api } = openSubmission("/blocked", [app])

    const c = await card("Staff Engineer at Northwind Health")
    expect(screen.getByRole("heading", { level: 2, name: "Same-company review (1)" })).toBeVisible()
    expect(c).toHaveTextContent(detail)
    expect(within(c).getByRole("button", { name: "Decline posting" })).toBeVisible()
    expect(within(c).getByRole("button", { name: "Mark completed manually" })).toBeVisible()
    await user.click(within(c).getByRole("button", { name: "Approve submission" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Submit to Northwind Health again?" })
    await user.click(within(dialog).getByRole("button", { name: "Approve submission" }))
    await waitFor(() => expect(api.state.submissions[app.app.id].state).toBe("queued"))
    expect(await screen.findByText("No Blocked Applications")).toBeVisible()
  })

  it("decline needs a reason (C-VAL-DECLINE-1, focus on the field), then declines with C-BLOCK-11", async () => {
    const app = entry(blocked("same_company_review", "x"), { company: "Northwind Health", roleTitle: "Staff Engineer" })
    const { user, api } = openSubmission("/blocked", [app])

    await user.click(within(await card("Staff Engineer at Northwind Health")).getByRole("button", { name: "Decline posting" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Decline Staff Engineer at Northwind Health?" })
    const field = within(dialog).getByRole("textbox", { name: /Why are you declining it\?/ })
    await waitFor(() => expect(field).toHaveFocus())
    expect(field).toHaveAccessibleDescription(/Saved with the posting so you can see it later\./)
    await user.type(field, "   ")
    await user.click(within(dialog).getByRole("button", { name: "Decline posting" }))
    expect(within(dialog).getByText("Enter a reason for declining this posting.")).toBeVisible()
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(api.requests.some((r) => r.path.endsWith("/decline"))).toBe(false)

    await user.clear(field)
    await user.type(field, "Already in process with Northwind Health")
    await user.click(within(dialog).getByRole("button", { name: "Decline posting" }))
    expect(await findToast("Declined Staff Engineer at Northwind Health. It won't be submitted.")).toBeVisible()
    expect(api.state.submissions[app.app.id]).toMatchObject({ state: "declined", declinedReason: "Already in process with Northwind Health" })
  })

  it("decline: a reason over 500 characters shows C-VAL-DECLINE-2", async () => {
    const { user } = openSubmission("/blocked", [entry(blocked("same_company_review", "x"), { roleTitle: "Long role" })])
    await user.click(within(await card("Long role at Acme Payments")).getByRole("button", { name: "Decline posting" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("textbox"))
    await user.paste("a".repeat(501))
    await user.click(within(dialog).getByRole("button", { name: "Decline posting" }))
    expect(within(dialog).getByText("Keep the reason under 500 characters.")).toBeVisible()
  })

  it("approve after a decline elsewhere is refused inline with the decline date (C-BLOCK-12d)", async () => {
    const app = entry(blocked("same_company_review", "x"), { roleTitle: "Stale role" })
    const { user, api } = openSubmission("/blocked", [app])
    const c = await card("Stale role at Acme Payments")
    api.state.submissions[app.app.id] = { ...api.state.submissions[app.app.id], state: "declined", declinedReason: "first", declinedAt: "2026-10-18T10:00:00.000Z" }
    await user.click(within(c).getByRole("button", { name: "Approve submission" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve submission" }))
    await waitFor(() => expect(within(c).getByRole("alert")).toHaveTextContent("You declined this posting on 18 Oct 2026, so it can't be approved."))
  })

  it("C-BLOCK-12d stays on its card after the refusal, also when the decline date arrives late (QA-R1-01)", async () => {
    const app = entry(blocked("same_company_review", "x"), { roleTitle: "Slow role" })
    const { user, api } = openSubmission("/blocked", [app])
    const c = await card("Slow role at Acme Payments")
    // The current Submission (with the decline date) answers after any list refetch would.
    server.use(
      http.get(`/v1/applications/${app.app.id}/submission`, async () => {
        await delay(200)
      })
    )
    api.state.submissions[app.app.id] = { ...api.state.submissions[app.app.id], state: "declined", declinedReason: "first", declinedAt: "2026-10-18T10:00:00.000Z" }
    await user.click(within(c).getByRole("button", { name: "Approve submission" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve submission" }))
    expect(await within(c).findByText("You declined this posting on 18 Oct 2026, so it can't be approved.")).toBeVisible()
  })

  it("a second decline keeps the first reason: C-BLOCK-12a with the first decline date", async () => {
    const app = entry(blocked("same_company_review", "x"), { company: "Northwind Health", roleTitle: "Twice role" })
    const { user, api } = openSubmission("/blocked", [app])
    const c = await card("Twice role at Northwind Health")
    await user.click(within(c).getByRole("button", { name: "Decline posting" }))
    // Another tab declined it first.
    api.state.submissions[app.app.id] = { ...api.state.submissions[app.app.id], state: "declined", declinedReason: "first reason", declinedAt: "2026-10-18T10:00:00.000Z" }
    const dialog = await screen.findByRole("alertdialog")
    await user.type(within(dialog).getByRole("textbox"), "second reason")
    await user.click(within(dialog).getByRole("button", { name: "Decline posting" }))
    expect(await findToast("This posting was already declined on 18 Oct 2026. The first reason is kept.")).toBeVisible()
  })

  it("a network failure shows C-ERR-2 and the card stays", async () => {
    const app = entry(blocked("login", "x"), { roleTitle: "Fail role" })
    const { user } = openSubmission("/blocked", [app])
    server.use(http.post(`/v1/applications/${app.app.id}/manual-complete`, () => apiErrorResponse("internal_error")))
    await user.click(within(await card("Fail role at Acme Payments")).getByRole("button", { name: "Mark completed manually" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Mark completed" }))
    expect(await findToast("Couldn't mark this completed manually. Nothing changed. Try again.")).toBeVisible()
    // The dialog stays open after a failure (design: Confirmation for consequential actions); Cancel shows the card again.
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }))
    expect(await screen.findByRole("link", { name: "Fail role at Acme Payments" })).toBeVisible()
  })

  it("empty: C-EMPTY-3", async () => {
    openSubmission("/blocked")
    expect(await screen.findByText("No Blocked Applications")).toBeVisible()
    expect(
      screen.getByText("When a form needs an answer, sign-in, CAPTCHA or assessment from you, or the assistant can't finish it, it shows up here and you get an email.")
    ).toBeVisible()
  })

  it("load failure: C-ERR-1 with Try again", async () => {
    openSubmission("/blocked")
    server.use(http.get(SUBMISSIONS_PATH, () => apiErrorResponse("internal_error")))
    expect(await screen.findByText("Couldn't load this page.")).toBeVisible()
  })
})

describe("Blocked Applications: worst-case data (break-ui)", () => {
  it("a card with no role or company is named by its requisition ID once", async () => {
    openSubmission("/blocked", [entry(blocked("login", "x"), { roleTitle: null, company: null, requisitionId: "R-NO-TITLE-5" })])
    const c = await card("R-NO-TITLE-5")
    expect(within(c).getAllByText("R-NO-TITLE-5")).toHaveLength(1)
  })
})
