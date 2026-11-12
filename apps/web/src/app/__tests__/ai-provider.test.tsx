import { ANTHROPIC_TERMS, CSRF_HEADER } from "@eve/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import {
  apiErrorResponse,
  approvedState,
  server,
  TEST_CSRF_TOKEN,
} from "@/shared/testing"
import {
  confirmDialog,
  findDialog,
  findToast,
  openSignedIn,
} from "./career-setup-helpers"

const HEADING = "AI provider: Anthropic (paid API)"
const HOME_ALERT =
  "Anthropic isn't approved yet, so no career data is processed. Resume drafting, documents and matching wait until you approve it."

describe("AI provider approval (data-retention-and-privacy.feature, @ac-1.2)", () => {
  it("@r2 The AI provider card before approval shows the terms summary", async () => {
    openSignedIn("/privacy#ai-provider")

    const card = await screen.findByRole("region", { name: HEADING })
    expect(within(card).getByText(ANTHROPIC_TERMS.trainingLine)).toBeVisible()
    expect(within(card).getByText(ANTHROPIC_TERMS.retentionLine)).toBeVisible()
    expect(within(card).getByText(ANTHROPIC_TERMS.whatsSentLine)).toBeVisible()
    expect(
      within(card).getByText(
        /Summary of Anthropic's published terms, checked 16 Oct 2026\./
      )
    ).toBeVisible()
    const training = within(card).getByRole("link", { name: /Training terms/ })
    expect(training).toHaveAttribute("href", ANTHROPIC_TERMS.trainingTermsUrl)
    expect(training).toHaveAttribute("target", "_blank")
    expect(
      within(card).getByRole("link", { name: /Retention terms/ })
    ).toHaveAttribute("href", ANTHROPIC_TERMS.retentionTermsUrl)
  })

  it("@r2 EPIC-0011 AC-1.7: Home replaces the paste box with one link to Upload while Anthropic isn't approved (C-AI-1 moved to Upload)", async () => {
    openSignedIn("/dashboard")

    expect(await screen.findByText("Eve needs your resume and approval before it can check a job.")).toBeVisible()
    expect(screen.queryByText(HOME_ALERT)).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Go to upload" })).toHaveAttribute("href", "/welcome")
  })

  it("The Candidate approves Anthropic and its terms are recorded and shown", async () => {
    const { user, api } = openSignedIn("/privacy")

    await user.click(
      await screen.findByRole("button", { name: "Approve Anthropic" })
    )
    const dialog = await findDialog("Approve Anthropic?")
    expect(dialog).toHaveTextContent(
      "Your resume, Career Profile, Approved Answers and Job Posting analysis will be sent to Anthropic under the terms shown. These terms are recorded with your approval."
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" })
      ).toHaveFocus()
    )
    await confirmDialog(user, "Approve Anthropic?", "Approve Anthropic")

    // C-AI-5 (r3): the date line, then each recorded line as stored, with no added labels.
    const approvedLine = await screen.findByText(
      "Anthropic approved on 18 Oct 2026."
    )
    const lines = [...approvedLine.parentElement!.children].map(
      (line) => line.textContent
    )
    expect(lines).toEqual([
      "Anthropic approved on 18 Oct 2026.",
      ANTHROPIC_TERMS.trainingLine,
      ANTHROPIC_TERMS.retentionLine,
    ])
    expect(document.body.textContent).not.toMatch(
      /Training: Training:|Retention: Retention:/
    )
    expect(
      screen.queryByRole("button", { name: "Approve Anthropic" })
    ).not.toBeInTheDocument()
    expect(api.requestsTo("POST", "/v1/ai-provider/approval")).toEqual([
      {
        method: "POST",
        path: "/v1/ai-provider/approval",
        body: { termsCheckedOn: "2026-10-16" },
      },
    ])
    expect(api.state.approval).toMatchObject({
      trainingLine: ANTHROPIC_TERMS.trainingLine,
      retentionLine: ANTHROPIC_TERMS.retentionLine,
    })
  })

  it("@r2 Cancelling the approval dialog leaves Anthropic unapproved and records nothing", async () => {
    const { user, api } = openSignedIn("/privacy")

    await user.click(
      await screen.findByRole("button", { name: "Approve Anthropic" })
    )
    await confirmDialog(user, "Approve Anthropic?", "Cancel")

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    expect(
      screen.getByRole("button", { name: "Approve Anthropic" })
    ).toBeVisible()
    expect(api.requests).toEqual([])
    expect(api.state.approval).toBeNull()
  })

  it("Escape also cancels without recording anything", async () => {
    const { user, api } = openSignedIn("/privacy")

    await user.click(
      await screen.findByRole("button", { name: "Approve Anthropic" })
    )
    await findDialog("Approve Anthropic?")
    await user.keyboard("{Escape}")

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    expect(api.state.approval).toBeNull()
  })

  it("sends the CSRF token with the approval", async () => {
    let csrf: string | null = null
    const { user } = openSignedIn("/privacy")
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST") csrf = request.headers.get(CSRF_HEADER)
    })

    await user.click(
      await screen.findByRole("button", { name: "Approve Anthropic" })
    )
    await confirmDialog(user, "Approve Anthropic?", "Approve Anthropic")

    await screen.findByText(/^Anthropic approved on/)
    expect(csrf).toBe(TEST_CSRF_TOKEN)
    server.events.removeAllListeners()
  })

  it("a failed approval shows C-ERR-2, keeps the dialog open, and leaves Anthropic unapproved", async () => {
    const { user, api } = openSignedIn("/privacy")
    server.use(
      http.post("/v1/ai-provider/approval", () =>
        apiErrorResponse("internal_error")
      )
    )

    await user.click(
      await screen.findByRole("button", { name: "Approve Anthropic" })
    )
    await confirmDialog(user, "Approve Anthropic?", "Approve Anthropic")

    expect(
      await findToast("Couldn't approve Anthropic. Nothing changed. Try again.")
    ).toBeVisible()
    const dialog = await findDialog("Approve Anthropic?")
    expect(
      within(dialog).getByRole("button", { name: "Approve Anthropic" })
    ).toBeEnabled()
    expect(screen.queryByText(/^Anthropic approved on/)).not.toBeInTheDocument()
    expect(api.state.approval).toBeNull()
  })

  it("@permission An unauthenticated request cannot approve an AI provider: the dashboard goes to sign-in", async () => {
    const { user, api, currentPath } = openSignedIn("/privacy")
    server.use(
      http.post("/v1/ai-provider/approval", () =>
        apiErrorResponse("session_expired")
      )
    )

    await user.click(
      await screen.findByRole("button", { name: "Approve Anthropic" })
    )
    server.use(
      http.get("/v1/session", () => apiErrorResponse("session_expired"))
    )
    await confirmDialog(user, "Approve Anthropic?", "Approve Anthropic")

    await waitFor(() =>
      expect(currentPath()).toMatch(
        /^\/sign-in\?next=%2Fprivacy&reason=expired$/
      )
    )
    expect(api.state.approval).toBeNull()
  })

  it("an approved card is shown on revisit with no approve button", async () => {
    openSignedIn("/privacy", approvedState())

    expect(
      await screen.findByText("Anthropic approved on 16 Oct 2026.")
    ).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "Approve Anthropic" })
    ).not.toBeInTheDocument()
  })
})
