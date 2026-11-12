import { CONTROLS_PATH, type RaiseCeilingResponse } from "@eve/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, controls, costPause, createControlsApi, server, submissionStatus, type ControlsApiState } from "@/shared/testing"
import { openSubmission } from "./submission-helpers"

const PAUSE_BANNER = "Automation is paused. No discovery, document generation or submission runs until you resume."
const COST_BANNER =
  "Paid automation is paused because the next paid action would have taken this month's spend over USD 50.00. It resumes on its own at 00:00 WAT on 1 Nov 2026. Your other pause setting is unchanged."

function open(path: string, initial: Partial<ControlsApiState> = {}, status = submissionStatus()) {
  const api = createControlsApi(initial)
  const view = openSubmission(path, [], { status })
  // After openSubmission's server.use, so these take precedence.
  server.use(...api.handlers)
  return { ...view, controlsApi: api }
}

const banner = (text: string) => screen.findByText(text)
// An error toast is also announced in a live region, so the text can appear twice.
const toast = async (text: string) => (await screen.findAllByText(text))[0]

describe("Global pause (global-pause.feature, F10)", () => {
  it("Pause automation pauses at once: toast C-PAUSE-1 and banner C-PAUSE-2 on every page; the control becomes Resume", async () => {
    const { user, controlsApi } = open("/applications")
    await user.click(await screen.findByRole("button", { name: "Pause automation" }))
    expect(await toast("Automation paused. Running work stops within a minute.")).toBeInTheDocument()
    expect((await banner(PAUSE_BANNER)).closest('[role="status"]')).not.toBeNull()
    expect(controlsApi.requests).toContainEqual({ method: "PUT", path: "/v1/controls/global-pause", body: { paused: true } })
    expect(screen.getAllByRole("button", { name: "Resume automation" }).length).toBeGreaterThan(0)
    // No confirmation for pausing.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    await user.click(screen.getByRole("link", { name: "Settings" }))
    await screen.findByRole("heading", { level: 1, name: "Settings" })
    await waitFor(() => expect(screen.getByText(PAUSE_BANNER)).toBeVisible())
  })

  it("Resume confirms with C-CONFIRM-10; on confirm the banner goes and C-PAUSE-3 shows", async () => {
    const { user, controlsApi } = open("/applications", { controls: controls({ globalPaused: true, globalPausedAt: "2026-10-20T08:00:00.000Z" }) })
    await banner(PAUSE_BANNER)
    await user.click(screen.getByRole("banner").querySelector('button[aria-label="Resume automation"]') as HTMLElement)
    const dialog = await screen.findByRole("alertdialog", { name: "Resume automation?" })
    expect(dialog).toHaveTextContent("Discovery, document generation and submission start again under your current rules and today's cap.")
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus())
    await user.click(within(dialog).getByRole("button", { name: "Resume automation" }))
    expect(await toast("Automation resumed.")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(PAUSE_BANNER)).not.toBeInTheDocument())
    expect(controlsApi.requests).toContainEqual({ method: "PUT", path: "/v1/controls/global-pause", body: { paused: false } })
  })

  it("Cancelling the resume confirmation keeps automation paused (nothing is sent)", async () => {
    const { user, controlsApi } = open("/applications", { controls: controls({ globalPaused: true }) })
    const row = (await banner(PAUSE_BANNER)).closest("div") as HTMLElement
    await user.click(within(row.parentElement as HTMLElement).getByRole("button", { name: "Resume automation" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.getByText(PAUSE_BANNER)).toBeVisible()
    expect(controlsApi.requests.filter((r) => r.method === "PUT")).toHaveLength(0)
  })

  it("Resuming the global pause leaves the cost pause and its banner in place", async () => {
    const { user } = open("/applications", { controls: controls({ globalPaused: true, costPause: costPause() }) })
    await banner(PAUSE_BANNER)
    expect(screen.getByText(COST_BANNER)).toBeVisible()
    // Both show, global pause first.
    expect(screen.getByText(PAUSE_BANNER).compareDocumentPosition(screen.getByText(COST_BANNER)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(screen.getByRole("banner").querySelector('button[aria-label="Resume automation"]') as HTMLElement)
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Resume automation" }))
    await waitFor(() => expect(screen.queryByText(PAUSE_BANNER)).not.toBeInTheDocument())
    expect(screen.getByText(COST_BANNER)).toBeVisible()
  })

  it("QG-FU2-01: the header control keeps focus while the pause is pending and after it becomes Resume, and can't be activated twice", async () => {
    const { user, controlsApi } = open("/dashboard")
    // Hold the PUT so the pending state is observable, as on a slow network,
    // then fall through to the controls fake, which answers and records it.
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.use(
      http.put("/v1/controls/global-pause", async () => {
        await gate
      })
    )
    const puts = () => controlsApi.requests.filter((r) => r.method === "PUT").length
    const header = await screen.findByRole("banner")
    const control = await within(header).findByRole("button", { name: "Pause automation" })
    control.focus()
    await user.keyboard("{Enter}")

    await waitFor(() => expect(control).toHaveAttribute("aria-busy", "true"))
    // jsdom keeps focus on a natively disabled button; browsers drop it to
    // <body> and don't restore it. The native attribute must be absent.
    expect(control).not.toHaveAttribute("disabled")
    expect(control).toHaveAttribute("aria-disabled", "true")
    expect(control).toHaveFocus()

    await user.keyboard("{Enter}")
    await user.click(control)
    release()

    expect(await toast("Automation paused. Running work stops within a minute.")).toBeInTheDocument()
    await waitFor(() => expect(control).toHaveAccessibleName("Resume automation"))
    expect(within(header).getByRole("button", { name: "Resume automation" })).toBe(control)
    expect(control).toHaveFocus()
    expect(document.activeElement).toBe(control)
    expect(control).not.toHaveAttribute("aria-disabled", "true")
    expect(control).not.toHaveAttribute("aria-busy", "true")
    expect(puts()).toBe(1)
  })

  it("a failed pause request is C-ERR-2 and nothing changes", async () => {
    const { user } = open("/dashboard")
    server.use(http.put("/v1/controls/global-pause", () => apiErrorResponse("internal_error")))
    await user.click(await screen.findByRole("button", { name: "Pause automation" }))
    expect(await toast("Couldn't pause automation. Nothing changed. Try again.")).toBeInTheDocument()
    expect(screen.queryByText(PAUSE_BANNER)).not.toBeInTheDocument()
  })

  it("a failed controls read shows no pause control and no banner, and Home still works", async () => {
    open("/dashboard")
    server.use(http.get(CONTROLS_PATH, () => apiErrorResponse("internal_error")))
    expect(await screen.findByRole("heading", { name: "Today's cap" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Pause automation" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Spend" })).not.toBeInTheDocument()
  })
})

describe("Cost pause and spend (cost-ceiling.feature, dashboard.feature, F10)", () => {
  it("cost-paused: banner C-COST-1 on every page, and Home's status card reads Paused for cost with C-COST-4", async () => {
    const { user } = open("/dashboard", { controls: controls({ costPause: costPause() }) })
    // Home carries its own banner (AC-1.6); the shell banner shows on every other page.
    expect(await screen.findByText("Eve has paused checks until 1 Nov 2026. Your pasted job is saved.")).toBeVisible()
    const card = (await screen.findByRole("heading", { name: "Paused for cost" })).closest('[data-slot="card"]') as HTMLElement
    expect(card).toHaveTextContent("Resumes 00:00 WAT on 1 Nov 2026, or when you raise this month's ceiling.")
    await user.click(screen.getByRole("link", { name: "Applications" }))
    await screen.findByRole("heading", { level: 1, name: "Applications" })
    await waitFor(() => expect(screen.getByText(COST_BANNER)).toBeVisible())
    expect(screen.getByRole("link", { name: "See spend" })).toHaveAttribute("href", "/pause-and-cost#cost")
  })

  it("the banner names this month's raised ceiling", async () => {
    open("/applications", { controls: controls({ costPause: costPause(), spend: { ceiling: "50.05", raised: true, spent: "49.80", percentUsed: 99 } }) })
    expect(await screen.findByText(/would have taken this month's spend over USD 50\.05\./)).toBeVisible()
  })

  it("Home's Spend card: USD 23.40 of USD 50.00 this month, a labelled bar and See breakdown", async () => {
    open("/dashboard")
    const card = (await screen.findByRole("heading", { name: "Spend" })).closest('[data-slot="card"]') as HTMLElement
    expect(card).toHaveTextContent("USD 23.40")
    expect(card).toHaveTextContent("of USD 50.00 this month")
    expect(within(card).getByRole("progressbar", { name: "USD 23.40 of USD 50.00 spent this month" })).toBeInTheDocument()
    expect(within(card).getByRole("link", { name: "See breakdown" })).toHaveAttribute("href", "/pause-and-cost#cost")
    expect(card).not.toHaveTextContent("You've used")
  })

  it("at 80% or more the Spend card adds C-COST-3 with this month's ceiling", async () => {
    open("/dashboard", { controls: controls({ spend: { spent: "56.00", ceiling: "70.00", raised: true, percentUsed: 80 } }) })
    const card = (await screen.findByRole("heading", { name: "Spend" })).closest('[data-slot="card"]') as HTMLElement
    expect(card).toHaveTextContent("You've used 80% of this month's ceiling. Paid automation pauses before it goes over USD 70.00.")
  })

  it("Settings #cost: C-COST-2, the category breakdown and the ceiling row with C-COST-5 (default)", async () => {
    open("/pause-and-cost#cost", { controls: controls({ spend: { spent: "31.25", byCategory: { hosting: "24.00", ai: "6.80", browser: "0.40", discovery: "0.05", email: "0.00" } } }) })
    const section = await screen.findByRole("region", { name: "Monthly cost" })
    expect(await within(section).findByText("USD 31.25 of USD 50.00 this month")).toBeVisible()
    const rows = within(section).getAllByRole("row")
    expect(rows.map((r) => r.textContent)).toEqual(expect.arrayContaining(["HostingUSD 24.00", "AIUSD 6.80", "BrowserUSD 0.40", "DiscoveryUSD 0.05", "EmailUSD 0.00"]))
    expect(section).toHaveTextContent("USD 50.00 this month")
    expect(section).toHaveTextContent("USD 50.00 is the monthly ceiling. Raising it applies to October 2026 only.")
    expect(within(section).getByRole("button", { name: "Raise this month's ceiling" })).toBeVisible()
  })

  it("Settings: a raised ceiling says when it returns to the default", async () => {
    open("/pause-and-cost", { controls: controls({ spend: { ceiling: "70.00", raised: true } }) })
    const section = await screen.findByRole("region", { name: "Monthly cost" })
    expect(await within(section).findByText("Raised for October 2026. It returns to USD 50.00 on 1 Nov 2026.")).toBeVisible()
  })
})

describe("Raise this month's ceiling (cost-ceiling.feature, F10)", () => {
  async function openDialog(initial: Partial<ControlsApiState> = {}) {
    const view = open("/pause-and-cost#cost", initial)
    const section = await screen.findByRole("region", { name: "Monthly cost" })
    await view.user.click(await within(section).findByRole("button", { name: "Raise this month's ceiling" }))
    const dialog = await screen.findByRole("dialog", { name: "Raise this month's ceiling" })
    return { ...view, dialog }
  }
  const field = (dialog: HTMLElement) => within(dialog).getByRole("textbox", { name: "New ceiling for October 2026, in US dollars" })

  it("shows spend, the current ceiling, the field and C-COST-7", async () => {
    const { dialog } = await openDialog()
    expect(dialog).toHaveTextContent("Spent this month: USD 23.40")
    expect(dialog).toHaveTextContent("Current ceiling: USD 50.00")
    expect(field(dialog)).toHaveValue("")
    expect(dialog).toHaveTextContent(
      "You can raise it to at most USD 100.00. It applies until the end of October 2026, and on 1 Nov 2026 the ceiling returns to USD 50.00. If the new ceiling leaves room for the next paid action, paid automation resumes now."
    )
  })

  it.each([
    ["", "Enter the new ceiling in USD."],
    ["sixty", "Enter an amount like 60 or 62.50."],
    ["60.505", "Enter an amount like 60 or 62.50."],
    ["50.00", "Enter more than USD 50.00, this month's current ceiling."],
    ["100.01", "Enter USD 100.00 or less. That's the most this month's ceiling can be."],
  ])("Continue with %j shows %j under the field, no confirm, nothing sent", async (input, message) => {
    const { user, dialog, controlsApi } = await openDialog()
    if (input) await user.type(field(dialog), input)
    await user.click(within(dialog).getByRole("button", { name: "Continue" }))
    expect(await within(dialog).findByText(message)).toBeVisible()
    expect(field(dialog)).toHaveAttribute("aria-invalid", "true")
    expect(field(dialog)).toHaveFocus()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(controlsApi.requests.filter((r) => r.path === "/v1/controls/ceiling")).toHaveLength(0)
  })

  it("spend above the ceiling (52.40 over 50.00): 51.00 gets C-VAL-COST-5", async () => {
    const { user, dialog } = await openDialog({ controls: controls({ spend: { spent: "52.40", percentUsed: 104 } }) })
    await user.type(field(dialog), "51.00")
    await user.click(within(dialog).getByRole("button", { name: "Continue" }))
    expect(
      await within(dialog).findByText(
        "This month's spend is already USD 52.40, above the current ceiling of USD 50.00. Enter more than USD 52.40 so there's room for the next paid action."
      )
    ).toBeVisible()
  })

  it("60.00 opens C-CONFIRM-18 with the amount, the difference and the return date; confirm raises it and toasts C-COST-8", async () => {
    const { user, dialog, controlsApi } = await openDialog({ controls: controls({ costPause: costPause(), spend: { spent: "49.80", percentUsed: 99 } }) })
    expect(await banner(COST_BANNER)).toBeVisible()
    await user.type(field(dialog), "60")
    await user.click(within(dialog).getByRole("button", { name: "Continue" }))
    const confirm = await screen.findByRole("alertdialog", { name: "Raise this month's ceiling to USD 60.00?" })
    expect(confirm).toHaveTextContent("Paid automation can spend up to USD 60.00 in October 2026, USD 10.00 more than now. On 1 Nov 2026 the ceiling returns to USD 50.00.")
    await user.click(within(confirm).getByRole("button", { name: "Raise ceiling" }))
    expect(await toast("This month's ceiling is now USD 60.00.")).toBeInTheDocument()
    expect(controlsApi.requests).toContainEqual({ method: "PUT", path: "/v1/controls/ceiling", body: { month: "2026-10-01", ceiling: "60" } })
    await waitFor(() => expect(screen.queryByText(/Paid automation is paused because/)).not.toBeInTheDocument())
    const section = screen.getByRole("region", { name: "Monthly cost" })
    expect(await within(section).findByText("Raised for October 2026. It returns to USD 50.00 on 1 Nov 2026.")).toBeVisible()
  })

  it("the backend's refusal is the source of truth: its message shows under the field with the value kept", async () => {
    const refused: RaiseCeilingResponse = {
      result: "refused",
      refusal: "ceiling_not_above_current",
      message: "Enter more than USD 70.00, this month's current ceiling.",
    }
    const { user, dialog } = await openDialog({ raise: () => refused })
    await user.type(field(dialog), "65.00")
    await user.click(within(dialog).getByRole("button", { name: "Continue" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Raise ceiling" }))
    const reopened = await screen.findByRole("dialog", { name: "Raise this month's ceiling" })
    expect(await within(reopened).findByText("Enter more than USD 70.00, this month's current ceiling.")).toBeVisible()
    expect(field(reopened)).toHaveValue("65.00")
  })

  it("raising without enough room keeps the cost banner, naming the new ceiling", async () => {
    const stillPaused = (ceiling: string, current: ControlsApiState["controls"]): RaiseCeilingResponse => ({
      result: "raised",
      costPauseCleared: false,
      controls: { ...current, spend: { ...current.spend, ceiling: Number(ceiling).toFixed(2), raised: true } },
    })
    const { user, dialog } = await openDialog({ controls: controls({ costPause: costPause(), spend: { spent: "49.80", percentUsed: 99 } }), raise: stillPaused })
    await user.type(field(dialog), "50.05")
    await user.click(within(dialog).getByRole("button", { name: "Continue" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Raise ceiling" }))
    expect(await toast("This month's ceiling is now USD 50.05.")).toBeInTheDocument()
    expect(await screen.findByText(/would have taken this month's spend over USD 50\.05\./)).toBeVisible()
  })

  it("a failed save is C-ERR-2 and the dialog stays open with its value", async () => {
    const { user, dialog } = await openDialog()
    server.use(http.put("/v1/controls/ceiling", () => apiErrorResponse("internal_error")))
    await user.type(field(dialog), "60")
    await user.click(within(dialog).getByRole("button", { name: "Continue" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Raise ceiling" }))
    expect(await toast("Couldn't raise this month's ceiling. Nothing changed. Try again.")).toBeInTheDocument()
    expect(field(await screen.findByRole("dialog", { name: "Raise this month's ceiling" }))).toHaveValue("60")
  })

  it.each([
    ["ceiling at the limit", { ceiling: "100.00", raised: true, spent: "60.00", canRaise: false, percentUsed: 60 }, "This month's ceiling is already USD 100.00, the most it can be. Paid automation resumes at 00:00 WAT on 1 Nov 2026."],
    [
      "spend at the limit",
      { ceiling: "80.00", raised: true, spent: "100.00", canRaise: false, percentUsed: 125 },
      "This month's spend is USD 100.00, which is at or above the USD 100.00 limit, so the ceiling can't be raised. Paid automation resumes at 00:00 WAT on 1 Nov 2026.",
    ],
  ])("no raise possible (%s): C-COST-9 and Close replace the field", async (_name, spend, line) => {
    const { user, dialog } = await openDialog({ controls: controls({ spend }) })
    expect(dialog).toHaveTextContent(line)
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: "Continue" })).not.toBeInTheDocument()
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("the cost banner's Raise this month's ceiling opens the same dialog", async () => {
    const { user } = open("/applications", { controls: controls({ costPause: costPause() }) })
    await banner(COST_BANNER)
    await user.click(screen.getByRole("button", { name: "Raise this month's ceiling" }))
    expect(await screen.findByRole("dialog", { name: "Raise this month's ceiling" })).toBeVisible()
  })
})
