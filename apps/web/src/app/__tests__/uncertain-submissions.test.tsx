import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, server, submissionStatus, uncertain } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { entry, openSubmission } from "./submission-helpers"

const C_UNC_1 =
  "The form was submitted on 20 Oct 2026, 10:15 WAT, but no confirmation page or application ID was seen. The assistant won't retry it. Check your email or the employer site, then mark it."
const card = async (name: string) => (await screen.findByRole("link", { name })).closest('[role="article"]') as HTMLElement

async function openDialog(user: ReturnType<typeof openSubmission>["user"], name: string, button: string) {
  await user.click(within(await card(name)).getByRole("button", { name: button }))
  return screen.findByRole("alertdialog")
}

describe("Uncertain Submissions (/uncertain)", () => {
  it("shows the submitted time, C-UNC-1, the employer link and both actions", async () => {
    const app = entry(uncertain(), { roleTitle: "Unsure role" })
    openSubmission("/uncertain", [app])

    const c = await card("Unsure role at Acme Payments")
    expect(within(c).getByText("Uncertain Submission")).toBeVisible()
    expect(c).toHaveTextContent("Submitted 20 Oct 2026, 10:15 WAT")
    expect(c).toHaveTextContent(C_UNC_1)
    expect(within(c).getByRole("link", { name: "Open employer page(opens in a new tab)" })).toHaveAttribute("href", app.app.applicationUrl)
    expect(within(c).getByRole("button", { name: "Mark confirmed" })).toBeVisible()
    expect(within(c).getByRole("button", { name: "Mark not submitted" })).toBeVisible()
  })

  it("a CAPTCHA after submit shows its badge and C-UNC-5", async () => {
    openSubmission("/uncertain", [entry(uncertain({ captchaAfterSubmit: true }), { roleTitle: "Captcha role" })])
    const c = await card("Captcha role at Acme Payments")
    expect(within(c).getByText("CAPTCHA after submit")).toBeVisible()
    expect(c).toHaveTextContent(
      "The form was submitted on 20 Oct 2026, 10:15 WAT, then a CAPTCHA appeared. The assistant doesn't solve CAPTCHAs, so it couldn't see a confirmation page. It won't retry. Check your email or the employer site, then mark it."
    )
  })

  it("Mark confirmed: C-CONFIRM-7 names the submission day, then C-UNC-2 and the card leaves", async () => {
    const app = entry(uncertain(), { roleTitle: "Unsure role" })
    const { user, api } = openSubmission("/uncertain", [app])

    const dialog = await openDialog(user, "Unsure role at Acme Payments", "Mark confirmed")
    expect(dialog).toHaveAccessibleName("Mark as confirmed?")
    expect(dialog).toHaveTextContent("Do this only if you've seen proof the employer received it. It will count toward 20 Oct 2026, even if that day goes over 5.")
    await user.click(within(dialog).getByRole("button", { name: "Mark confirmed" }))

    expect(await findToast("Marked as a Confirmed Submission. It counts toward 20 Oct 2026.")).toBeVisible()
    expect(await screen.findByText("No Uncertain Submissions")).toBeVisible()
    expect(api.state.submissions[app.app.id]).toMatchObject({ state: "confirmed", evidence: { kind: "marked_confirmed" } })
  })

  it("Mark not submitted on a first attempt: C-CONFIRM-8 (default variant), C-UNC-3, back in the queue", async () => {
    const app = entry(uncertain(), { roleTitle: "Unsure role" })
    const { user, api } = openSubmission("/uncertain", [app])

    const dialog = await openDialog(user, "Unsure role at Acme Payments", "Mark not submitted")
    expect(dialog).toHaveAccessibleName("Mark as not submitted?")
    expect(dialog).toHaveTextContent(
      "Do this only if you're sure the employer didn't receive it. It goes back to the automatic queue for one more attempt, which still follows the daily cap, duplicate, same-company, closed-posting and pause rules. If that attempt also gets no confirmation, it becomes an Uncertain Submission again and won't be retried."
    )
    await user.click(within(dialog).getByRole("button", { name: "Mark not submitted" }))
    expect(await findToast("Marked as not submitted. It doesn't count toward the cap. It's back in the queue for one more attempt.")).toBeVisible()
    expect(api.state.submissions[app.app.id].state).toBe("queued")
  })

  it("the one more attempt: C-UNC-8 on the card, C-CONFIRM-8a, then the final C-UNC-3a", async () => {
    const app = entry(uncertain({ attemptNumber: 2 }), { roleTitle: "Again role" })
    const { user, api } = openSubmission("/uncertain", [app])

    expect(await card("Again role at Acme Payments")).toHaveTextContent(
      "This was the one more attempt after you marked it not submitted. The form was submitted on 20 Oct 2026, 10:15 WAT, but again no confirmation was seen. The assistant won't retry it. Check your email or the employer site, then mark it."
    )
    const dialog = await openDialog(user, "Again role at Acme Payments", "Mark not submitted")
    expect(dialog).toHaveTextContent("This was already the one more attempt. If you mark it not submitted, the assistant won't try it again. You can still apply on the employer site yourself.")
    await user.click(within(dialog).getByRole("button", { name: "Mark not submitted" }))
    expect(await findToast("Marked as not submitted. The assistant won't try it again.")).toBeVisible()
    expect(api.state.submissions[app.app.id].state).toBe("not_submitted")
  })

  it("a sample before the gate: 'Sample' label, C-CONFIRM-8s with the count, C-SAMPLE-11", async () => {
    const app = entry(uncertain({ kind: "sample", sample: { state: "approved", rejectReason: null, counts: true } }), { company: "Initech", roleTitle: "Sample role", requisitionId: "R-2004" })
    const { user, api } = openSubmission("/uncertain", [app], { status: submissionStatus({ countingSamples: 4 }) })

    const c = await card("Sample role at Initech")
    expect(within(c).getByText("Sample")).toBeVisible()
    await screen.findByRole("link", { name: "Unsure sends, 1" })
    const dialog = await openDialog(user, "Sample role at Initech", "Mark not submitted")
    expect(dialog).toHaveAccessibleName("Mark this sample as not submitted?")
    expect(dialog).toHaveTextContent(
      "Do this only if you're sure Initech didn't receive it. It will stop counting toward the 5, so you'll need 2 more sample Applications to pass the Activation Gate."
    )
    await user.click(within(dialog).getByRole("button", { name: "Mark not submitted" }))
    expect(await findToast("Marked as not submitted. This sample no longer counts toward the 5. 3 of 5 samples approved.")).toBeVisible()
    expect(api.state.status.countingSamples).toBe(3)
  })

  it("a sample after the gate passed: the after-gate dialog and toast", async () => {
    const app = entry(uncertain({ kind: "sample", sample: { state: "approved", rejectReason: null, counts: true } }), { company: "Initech", roleTitle: "Sample role" })
    const { user } = openSubmission("/uncertain", [app], { status: submissionStatus({ countingSamples: 5, gatePassedAt: "2026-10-21T13:30:00.000Z" }) })

    await screen.findByRole("link", { name: "Unsure sends, 1" })
    await waitFor(() => expect(screen.getByRole("link", { name: "Sample role at Initech" })).toBeVisible())
    const dialog = await openDialog(user, "Sample role at Initech", "Mark not submitted")
    expect(dialog).toHaveTextContent("Do this only if you're sure Initech didn't receive it. It stops counting as a sample. The Activation Gate stays passed.")
    await user.click(within(dialog).getByRole("button", { name: "Mark not submitted" }))
    expect(await findToast("Marked as not submitted. It no longer counts as a sample, but the Activation Gate stays passed.")).toBeVisible()
  })

  it("a confirmation that arrived first wins: C-UNC-4 with Confirmed Submission", async () => {
    const app = entry(uncertain(), { roleTitle: "Raced role" })
    const { user, api } = openSubmission("/uncertain", [app])
    const dialog = await openDialog(user, "Raced role at Acme Payments", "Mark not submitted")
    api.state.submissions[app.app.id] = { ...api.state.submissions[app.app.id], state: "confirmed" }
    await user.click(within(dialog).getByRole("button", { name: "Mark not submitted" }))
    expect(await findToast("This was already resolved: Confirmed Submission.")).toBeVisible()
    expect(api.state.submissions[app.app.id].state).toBe("confirmed")
  })

  it("a 409 without the current status shows C-UNC-4a and the card leaves on refetch", async () => {
    const app = entry(uncertain(), { roleTitle: "Gone role" })
    const { user, api } = openSubmission("/uncertain", [app])
    const dialog = await openDialog(user, "Gone role at Acme Payments", "Mark confirmed")
    // Marked manually in another tab: the backend refuses with application_state_conflict.
    api.state.submissions[app.app.id] = { ...api.state.submissions[app.app.id], state: "manual" }
    await user.click(within(dialog).getByRole("button", { name: "Mark confirmed" }))
    expect(await findToast("This was already resolved somewhere else. The page now shows its current status.")).toBeVisible()
    expect(await screen.findByText("No Uncertain Submissions")).toBeVisible()
  })

  it("a network failure shows C-ERR-2 and the card stays", async () => {
    const app = entry(uncertain(), { roleTitle: "Fail role" })
    const { user } = openSubmission("/uncertain", [app])
    server.use(http.post(`/v1/applications/${app.app.id}/mark-confirmed`, () => apiErrorResponse("internal_error")))
    const dialog = await openDialog(user, "Fail role at Acme Payments", "Mark confirmed")
    await user.click(within(dialog).getByRole("button", { name: "Mark confirmed" }))
    expect(await findToast("Couldn't mark this confirmed. Nothing changed. Try again.")).toBeVisible()
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }))
    expect(await screen.findByRole("link", { name: "Fail role at Acme Payments" })).toBeVisible()
  })

  it("empty: C-EMPTY-4", async () => {
    openSubmission("/uncertain")
    expect(await screen.findByText("No Uncertain Submissions")).toBeVisible()
    expect(screen.getByText("If a form is submitted without confirmation, it waits here for you to check.")).toBeVisible()
  })
})
