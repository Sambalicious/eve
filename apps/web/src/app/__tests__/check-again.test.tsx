import { screen, waitFor, within } from "@testing-library/react"
import { CSRF_HEADER, JOB_POSTINGS_CHECK_AGAIN_PATH, JOB_POSTINGS_PATH } from "@eve/contracts"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { rankedPosting, server, TEST_CSRF_TOKEN } from "@/shared/testing"
import { findDialog } from "./career-setup-helpers"
import { openDiscovery } from "./discovery-helpers"

/** check-again-and-worker-key.feature and per-candidate-tenancy.feature, against the v1.18.0 fake. */

const failed = (kind: "provider_error" | "not_configured" = "provider_error", overrides = {}) =>
  rankedPosting({ status: "evaluation_failed", rank: null, evaluationFailure: kind, ...overrides })
const notChecked = (overrides = {}) => rankedPosting({ status: "not_checked", rank: null, ...overrides })

/** The Sonner toast holding `text` (the page status region may hold the same words). */
async function findToast(text: string) {
  return waitFor(() => {
    const toast = screen.getAllByText(text).map((node) => node.closest("[data-sonner-toast]")).find(Boolean)
    expect(toast).toBeTruthy()
    return toast
  })
}

const panelButton = () => screen.findByRole("button", { name: "Check again" })

describe("Check again panel (AC-7.3)", () => {
  it("shows one combined count of visible failed and not-checked postings, above the tabs", async () => {
    openDiscovery("/postings?tab=good", {
      postings: [
        failed("not_configured"),
        failed("provider_error"),
        failed("provider_error"),
        notChecked(),
        rankedPosting({ status: "checking", rank: null }),
        failed("not_configured", { hiddenReason: "off_target" }),
        notChecked({ hiddenReason: "off_target" }),
        rankedPosting(),
      ],
    })
    const button = await panelButton()
    expect(button).toHaveAccessibleDescription("4 postings on your board haven't been checked.")
    // Page level: before the tab list in document order, outside the tab section.
    const tablist = screen.getByRole("tablist")
    expect(button.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("region", { name: "Good matches" })).not.toContainElement(button)
    // A standing fact, not a live region.
    const panel = button.closest("[data-slot=alert]")!
    expect(panel).not.toHaveAttribute("role")
  })

  it.each(["/postings?tab=good", "/postings?tab=all&families=mobile", "/postings?tab=all&keyword=zzz"])(
    "the count ignores the tab and filter at %s",
    async (path) => {
      openDiscovery(path, { postings: [failed(), failed(), notChecked({ roleFamily: "backend" })] })
      expect(await panelButton()).toHaveAccessibleDescription("3 postings on your board haven't been checked.")
    }
  )

  it("uses the singular for a count of 1", async () => {
    openDiscovery("/postings", { postings: [failed()] })
    expect(await panelButton()).toHaveAccessibleDescription("1 posting on your board hasn't been checked.")
  })

  it("is absent when nothing visible is failed or not checked", async () => {
    openDiscovery("/postings?tab=all", {
      postings: [rankedPosting(), rankedPosting({ status: "checking", rank: null }), failed("provider_error", { hiddenReason: "undated" })],
      waitingToBeCheckedCount: 2,
    })
    await screen.findByRole("region", { name: "Job Postings, scrolls horizontally" })
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument()
  })
})

describe("Check again confirmation (AC-7.3, AC-7.5)", () => {
  it("names the count and the AI spend; Cancel has focus and queues nothing", async () => {
    const { user, api } = openDiscovery("/postings", { postings: Array.from({ length: 3 }, () => failed()) })
    await user.click(await panelButton())
    const dialog = await findDialog("Check 3 postings again?")
    expect(dialog).toHaveAccessibleDescription(
      "Each check uses AI spend and counts toward this month's cost ceiling. If the ceiling is reached, the rest wait until the cost pause ends."
    )
    const cancel = within(dialog).getByRole("button", { name: "Cancel" })
    await waitFor(() => expect(cancel).toHaveFocus())
    expect(within(dialog).getByRole("button", { name: "Check 3 postings" })).toBeVisible()
    await user.click(cancel)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(api.requests.filter((r) => r.path === JOB_POSTINGS_CHECK_AGAIN_PATH)).toHaveLength(0)
    expect(await panelButton()).toHaveAccessibleDescription("3 postings on your board haven't been checked.")
  })

  it("confirming as the Operator queues every counted posting, toasts the count and the panel goes", async () => {
    let csrf: string | null = null
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === JOB_POSTINGS_CHECK_AGAIN_PATH) csrf = request.headers.get(CSRF_HEADER)
    })
    const { user, api } = openDiscovery("/postings?tab=all&families=senior_frontend", {
      postings: [failed(), failed(), failed("provider_error", { roleFamily: "backend" }), notChecked()],
    })
    await user.click(await panelButton())
    const dialog = await findDialog("Check 4 postings again?")
    await user.click(within(dialog).getByRole("button", { name: "Check 4 postings" }))

    expect(await findToast("4 postings queued for a check.")).toBeInTheDocument()
    server.events.removeAllListeners()
    expect(csrf).toBe(TEST_CSRF_TOKEN)
    expect(api.requests.filter((r) => r.path === JOB_POSTINGS_CHECK_AGAIN_PATH).map((r) => r.body)).toEqual([{}])
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument())
    expect(api.state.postings.every((p) => p.status === "checking")).toBe(true)
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((region) => region.textContent === "4 postings queued for a check.")).toBe(true)
    )
    // Focus falls back to the active tab when the panel leaves (design-spec.r1 J6 step 4).
    await waitFor(() => expect(screen.getByRole("tab", { name: "All" })).toHaveFocus())
  })

  it("a non-Operator's confirm shows the waiting toast, not the queued one, and the invitee notice", async () => {
    const { user } = openDiscovery("/postings?tab=good", {
      postings: [failed(), failed(), notChecked(), rankedPosting()],
      checkAgainMovesTo: "waiting_to_be_checked",
      waitingReason: "checks_not_enabled",
    })
    await user.click(await panelButton())
    await user.click(within(await findDialog("Check 3 postings again?")).getByRole("button", { name: "Check 3 postings" }))
    const waiting =
      "3 postings moved to waiting. They aren't checked until the person who runs your Eve turns on checks for you."
    expect(await findToast(waiting)).toBeInTheDocument()
    expect(screen.queryByText("3 postings queued for a check.")).not.toBeInTheDocument()
    expect(
      await screen.findByText(
        "3 postings are waiting to be checked. They aren't checked until the person who runs your Eve turns on checks for you.",
        { exact: false }
      )
    ).toBeVisible()
  })

  it("a non-Operator's single posting reads the singular waiting toast", async () => {
    const { user } = openDiscovery("/postings", { postings: [failed()], checkAgainMovesTo: "waiting_to_be_checked", waitingReason: "checks_not_enabled" })
    await user.click(await panelButton())
    await user.click(within(await findDialog("Check 1 posting again?")).getByRole("button", { name: "Check 1 posting" }))
    expect(
      await findToast("1 posting moved to waiting. It isn't checked until the person who runs your Eve turns on checks for you.")
    ).toBeInTheDocument()
  })

  it("nothing left to claim shows the nothing-new info toast", async () => {
    const { user, api } = openDiscovery("/postings", { postings: [failed()] })
    await user.click(await panelButton())
    const dialog = await findDialog("Check 1 posting again?")
    // Another tab claimed it first: the server finds nothing to claim.
    api.state.postings = api.state.postings.map((p) => ({ ...p, status: "checking" }))
    await user.click(within(dialog).getByRole("button", { name: "Check 1 posting" }))
    expect(await findToast("Nothing new to check. Those postings are already queued.")).toBeInTheDocument()
    expect(screen.queryByText(/queued for a check/)).not.toBeInTheDocument()
  })

  it.each([
    ["internal_error", "Couldn't queue the checks. Nothing changed. Try again."],
    ["network", "Couldn't queue the checks. Nothing changed. Try again."],
    ["malformed", "Couldn't queue the checks. Nothing changed. Try again."],
    ["csrf_invalid", "The request is missing a valid CSRF token."],
  ] as const)("a %s answer keeps the dialog open with its alert and no toast; confirm retries", async (outcome, message) => {
    const { user, api } = openDiscovery("/postings", { postings: [failed(), failed(), failed()], nextCheckAgain: outcome })
    await user.click(await panelButton())
    const dialog = await findDialog("Check 3 postings again?")
    await user.click(within(dialog).getByRole("button", { name: "Check 3 postings" }))
    const alert = await within(dialog).findByRole("alert")
    expect(alert).toHaveTextContent(message)
    expect(screen.queryByText(/queued for a check/)).not.toBeInTheDocument()
    expect(api.state.postings.every((p) => p.status === "evaluation_failed")).toBe(true)

    await user.click(within(dialog).getByRole("button", { name: "Check 3 postings" }))
    expect(await findToast("3 postings queued for a check.")).toBeInTheDocument()
  })

  it("DP-1 while queuing, focus stays on the confirm button: aria-disabled and aria-busy, never disabled, and a second press sends nothing", async () => {
    let release: () => void = () => undefined
    let calls = 0
    const { user } = openDiscovery("/postings", { postings: [failed(), failed()] })
    server.use(
      http.post(JOB_POSTINGS_CHECK_AGAIN_PATH, async () => {
        calls += 1
        await new Promise<void>((resolve) => (release = resolve))
        return HttpResponse.json({ queued: 2, movedTo: "checking" })
      })
    )
    await user.click(await panelButton())
    const dialog = await findDialog("Check 2 postings again?")
    const confirm = within(dialog).getByRole("button", { name: "Check 2 postings" })
    confirm.focus()
    await user.keyboard("{Enter}")

    const pending = await within(dialog).findByRole("button", { name: "Queuing…" })
    expect(pending).toBe(confirm)
    expect(pending).toHaveFocus()
    expect(pending).not.toHaveAttribute("disabled")
    expect(pending).toHaveAttribute("aria-disabled", "true")
    expect(pending).toHaveAttribute("aria-busy", "true")
    const cancel = within(dialog).getByRole("button", { name: "Cancel" })
    expect(cancel).not.toHaveAttribute("disabled")
    expect(cancel).toHaveAttribute("aria-disabled", "true")

    await user.keyboard("{Enter}")
    await user.click(pending)
    await user.click(cancel)
    await user.keyboard("{Escape}")
    expect(calls).toBe(1)
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    release()
    expect(await findToast("2 postings queued for a check.")).toBeInTheDocument()
  })

  it("DP-1 after a refusal the dialog keeps focus on the confirm button (the retry)", async () => {
    const { user } = openDiscovery("/postings", { postings: [failed()], nextCheckAgain: "internal_error" })
    await user.click(await panelButton())
    const dialog = await findDialog("Check 1 posting again?")
    await user.click(within(dialog).getByRole("button", { name: "Check 1 posting" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't queue the checks. Nothing changed. Try again.")
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Check 1 posting" })).toHaveFocus())
    expect(document.activeElement).not.toBe(document.body)
  })

  it("DP-2 after a successful queue, focus goes to the active tab even while the panel is still on screen", async () => {
    const { user } = openDiscovery("/postings?tab=not_a_match", { postings: [failed(), failed()] })
    await user.click(await panelButton())
    const dialog = await findDialog("Check 2 postings again?")
    // Hold the list refetch so the panel is still mounted when the dialog closes.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    // Wait, then fall through to the fake's own handler (an undefined return tries the next handler).
    server.use(http.get(JOB_POSTINGS_PATH, async () => { await held }))
    await user.click(within(dialog).getByRole("button", { name: "Check 2 postings" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("tab", { name: "Not a match" })).toHaveFocus())
    release()
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument())
    expect(screen.getByRole("tab", { name: "Not a match" })).toHaveFocus()
  })

  it("DP-2 nothing new keeps the panel, and focus returns to Check again", async () => {
    const { user } = openDiscovery("/postings", { postings: [failed()], nextCheckAgain: "nothing_left" })
    await user.click(await panelButton())
    await user.click(within(await findDialog("Check 1 posting again?")).getByRole("button", { name: "Check 1 posting" }))
    expect(await findToast("Nothing new to check. Those postings are already queued.")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toHaveFocus())
  })
})
