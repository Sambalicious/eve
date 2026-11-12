import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import type { Submission } from "@eve/contracts"
import { apiErrorResponse, blocked, server, storedOverride, submission, submissionStatus, TEST_CSRF_TOKEN, uncertain } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { entry, openSubmission } from "./submission-helpers"

/**
 * gherkin/apply-anyway.feature AA-5 (frontend rows): "Remove from queue" on the
 * Application detail, its dialog, toasts, refusal and focus (design F3, B4).
 * Mocked component checks with the contract fake's remove table (v1.24.0).
 */

const NAME = "Remove from queue for Senior Frontend Engineer at Acme Payments"
const TITLE = "Remove from the automatic queue?"
const BODY = "Eve won't send this Application automatically. Its documents, answers and any override are kept. You can't queue it again in Eve, but you can still apply on the employer's site."
const SUCCESS = "Removed from the queue. Nothing was sent, and its documents are kept."
const CONFLICT = "It already left the queue, so it can't be removed. Its status shows where it is now."
const NETWORK = "Couldn't remove it from the queue. Nothing changed. Try again."

const queued = (o: Partial<Submission> = {}) => submission({ state: "queued", kind: "automatic", ...o })

function open(sub: Submission, app: Parameters<typeof entry>[1] = {}, initial: Parameters<typeof openSubmission>[2] = {}) {
  const e = entry(sub, app)
  return { ...openSubmission(`/applications/${e.app.id}`, [e], initial), id: e.app.id }
}

const removeRequests = (api: ReturnType<typeof open>["api"], id: string) => api.requests.filter((r) => r.path === `/v1/applications/${id}/remove-from-queue`)

describe("AA-5.1: offered for every queued Application, override or not", () => {
  it.each([
    ["Queued, no override", queued(), null],
    ["Queued, with an override", queued(), storedOverride()],
    ["Queued for tomorrow", queued({ queuedForWatDay: "2026-10-21" }), null],
    ["Queued again", queued({ attemptNumber: 1, markedNotSubmittedAt: "2026-10-20T09:00:00.000Z" }), null],
  ] as const)("%s", async (_label, sub, override) => {
    open(sub, { override })
    const button = await screen.findByRole("button", { name: NAME })
    expect(button).toHaveTextContent(/^Remove from queue$/)
  })

  it("Queued until you resume (global pause)", async () => {
    open(queued(), {}, { status: submissionStatus({ globalPaused: true }) })
    expect(await screen.findByRole("button", { name: NAME })).toBeVisible()
  })
})

describe("AA-5.1: not offered outside the queued state", () => {
  it.each([
    ["documents ready, not queued", submission()],
    ["being submitted", submission({ state: "submitting", kind: "automatic" })],
    ["a Confirmed Submission", submission({ state: "confirmed", kind: "automatic" })],
    ["an Uncertain Submission", uncertain()],
    ["a Blocked Application", blocked("login", null)],
    ["a Manual Application", submission({ state: "manual", kind: "automatic" })],
  ])("%s", async (_label, sub) => {
    open(sub)
    await screen.findByRole("heading", { level: 1 })
    // Wait for the submission: its status badge replaces "Draft" when it has a state.
    if (sub.state !== null) await waitFor(() => expect(screen.queryByText("Draft")).not.toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Remove from queue/ })).not.toBeInTheDocument()
  })

  it("queued with its detailed records deleted", async () => {
    open(queued(), { detailsDeletedAt: "2026-10-20T09:00:00.000Z", documents: [] })
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /Remove from queue/ })).not.toBeInTheDocument()
  })
})

describe("AA-5.2: removing", () => {
  it("dialog C-AA-25 with C-AA-26, not destructive; confirm returns it to documents ready, shows C-AA-29 once, focus on the heading", async () => {
    const { user, api, id } = open(queued(), { override: storedOverride() })
    await user.click(await screen.findByRole("button", { name: NAME }))
    const dialog = await screen.findByRole("alertdialog", { name: TITLE })
    expect(dialog).toHaveAccessibleDescription(BODY)
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus())
    await user.click(within(dialog).getByRole("button", { name: "Remove from queue" }))
    expect(await findToast(SUCCESS)).toBeInTheDocument()
    expect(screen.getAllByText(SUCCESS)).toHaveLength(1)
    expect(await screen.findByText("Draft")).toBeVisible()
    expect(screen.queryByRole("button", { name: NAME })).not.toBeInTheDocument()
    expect(removeRequests(api, id)).toHaveLength(1)
    expect(api.state.submissions[id]).toMatchObject({ state: null, kind: null, queuedForWatDay: null })
    // The override record is kept.
    expect(screen.getAllByText("Override").length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus())
    // AA-5.5: no web control queues it again.
    expect(screen.queryByRole("button", { name: /queue/i })).not.toBeInTheDocument()
  })

  it("Cancel leaves it queued, sends nothing, and returns focus to the button", async () => {
    const { user, api, id } = open(queued())
    await user.click(await screen.findByRole("button", { name: NAME }))
    const dialog = await screen.findByRole("alertdialog", { name: TITLE })
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(removeRequests(api, id)).toHaveLength(0)
    expect(api.state.submissions[id].state).toBe("queued")
    await waitFor(() => expect(screen.getByRole("button", { name: NAME })).toHaveFocus())
  })

  it("reads 'Removing…' and ignores presses while pending", async () => {
    let release: () => void = () => {}
    const { user, id } = open(queued())
    let sent = 0
    server.use(
      http.post(`/v1/applications/${id}/remove-from-queue`, async () => {
        sent += 1
        await new Promise<void>((resolve) => (release = resolve))
        return apiErrorResponse("internal_error")
      })
    )
    await user.click(await screen.findByRole("button", { name: NAME }))
    const dialog = await screen.findByRole("alertdialog", { name: TITLE })
    await user.click(within(dialog).getByRole("button", { name: "Remove from queue" }))
    const pending = await within(dialog).findByRole("button", { name: "Removing…" })
    expect(pending).toHaveAttribute("aria-busy", "true")
    await user.click(pending)
    expect(sent).toBe(1)
    release()
    await within(dialog).findByRole("alert")
  })

  it.each(["global", "cost"] as const)("AA-5.4: works while the %s pause is on", async (pause) => {
    const { user, api, id } = open(queued(), {}, { status: submissionStatus({ globalPaused: pause === "global" }) })
    await user.click(await screen.findByRole("button", { name: NAME }))
    await user.click(within(await screen.findByRole("alertdialog", { name: TITLE })).getByRole("button", { name: "Remove from queue" }))
    expect(await findToast(SUCCESS)).toBeInTheDocument()
    expect(api.state.submissions[id].state).toBeNull()
  })
})

describe("AA-5.3: refused when the claim got there first", () => {
  it.each(["submit_claimed", "submitting"] as const)("%s: dialog closes, C-AA-30 toast, the current status shows", async (state) => {
    const { user, api, id } = open(queued())
    await user.click(await screen.findByRole("button", { name: NAME }))
    const dialog = await screen.findByRole("alertdialog", { name: TITLE })
    // The submission job moved it after the page loaded.
    api.state.submissions[id] = submission({ state, kind: "automatic" })
    await user.click(within(dialog).getByRole("button", { name: "Remove from queue" }))
    expect(await findToast(CONFLICT)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    await waitFor(() => expect(screen.queryByRole("button", { name: NAME })).not.toBeInTheDocument())
    expect(api.state.submissions[id].state).toBe(state)
    expect(screen.queryByText(NETWORK)).not.toBeInTheDocument()
  })
})

describe("F3 step 6: a network failure stays in the dialog", () => {
  it("inline C-ERR-2 with C-AA-31, focus on Confirm, which retries", async () => {
    const { user, api, id } = open(queued())
    server.use(http.post(`/v1/applications/${id}/remove-from-queue`, () => HttpResponse.error(), { once: true }))
    await user.click(await screen.findByRole("button", { name: NAME }))
    const dialog = await screen.findByRole("alertdialog", { name: TITLE })
    await user.click(within(dialog).getByRole("button", { name: "Remove from queue" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(NETWORK)
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Remove from queue" })).toHaveFocus())
    expect(api.state.submissions[id].state).toBe("queued")
    await user.click(within(dialog).getByRole("button", { name: "Remove from queue" }))
    expect(await findToast(SUCCESS)).toBeInTheDocument()
  })
})

describe("AA-5.2 / AA-5.3: the contract fake's remove table", () => {
  const post = (id: string) => fetch(new URL(`/v1/applications/${id}/remove-from-queue`, window.location.origin), { method: "POST", headers: { "x-csrf-token": TEST_CSRF_TOKEN } })

  it("a second removal answers 200 with the current state (idempotent)", async () => {
    const { id } = open(queued())
    await screen.findByRole("heading", { level: 1 })
    expect((await post(id)).status).toBe(200)
    const again = await post(id)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ state: null })
  })

  it.each([
    ["confirmed", submission({ state: "confirmed", kind: "automatic" })],
    ["uncertain", uncertain()],
    ["blocked", blocked("login", null)],
    ["manual", submission({ state: "manual", kind: "automatic" })],
    ["not_submitted", submission({ state: "not_submitted", kind: "automatic" })],
    ["declined", submission({ state: "declined", kind: "automatic" })],
  ])("%s is refused with 409 application_state_conflict", async (_label, sub) => {
    const { id } = open(sub)
    await screen.findByRole("heading", { level: 1 })
    const response = await post(id)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "application_state_conflict" } })
  })
})
