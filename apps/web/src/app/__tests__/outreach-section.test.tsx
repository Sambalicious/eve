import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { delay, http, HttpResponse } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  blockedItem,
  controls,
  costPause,
  createCareerSetupApi,
  createControlsApi,
  createDiscoveryApi,
  createDocumentsApi,
  createOutreachApi,
  linkFakes,
  notWritten,
  OUTREACH_BODIES,
  readyApplication,
  readyItem,
  server,
  signedInSession,
  TEST_CSRF_TOKEN,
  type ControlsApiState,
  type OutreachApiOptions,
} from "@/shared/testing"
import { advance } from "./career-setup-helpers"
import { renderApp } from "./test-app"

const PANEL = "Referral request for Senior Frontend Engineer at Acme Payments"
const KIND = "referral request"

interface OpenOptions {
  /** The `GET /v1/controls` body the pause tests need. */
  controls?: Partial<ControlsApiState>
  fakeTimers?: boolean
  /** Hold the outreach read this long, to see the loading state. */
  slowReadMs?: number
}

/** Opens the Application detail page with the Application, Outreach and controls fakes installed. */
function open(outreach: OutreachApiOptions = {}, options: OpenOptions = {}) {
  if (options.fakeTimers) {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
  }
  const app = readyApplication()
  const discovery = createDiscoveryApi()
  const documents = createDocumentsApi({ applications: [app] })
  const api = createOutreachApi(outreach)
  const controlsApi = createControlsApi(options.controls ?? {})
  linkFakes(discovery, documents)
  server.use(
    signedInSession,
    ...createCareerSetupApi().handlers,
    ...discovery.handlers,
    ...documents.handlers,
    ...api.handlers,
    ...controlsApi.handlers
  )
  if (options.slowReadMs !== undefined) {
    server.use(
      http.get("/v1/applications/:id/outreach", async () => {
        await delay(options.slowReadMs)
        return HttpResponse.json({ error: { code: "internal_error", message: "Something went wrong." } }, { status: 500 })
      })
    )
  }
  const user = userEvent.setup(options.fakeTimers ? { delay: null, advanceTimers: vi.advanceTimersByTime } : { delay: null })
  // userEvent's setup() installs its own clipboard stub; the tests spy on this one.
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true })
  return { ...renderApp(`/applications/${app.id}`), api, controls: controlsApi, documents, user, app }
}

async function panel(name = PANEL) {
  return screen.findByRole("tabpanel", { name })
}

async function openPanel(outreach: OutreachApiOptions = {}, options?: OpenOptions) {
  const view = open(outreach, options)
  const referral = await panel()
  return { ...view, referral }
}

function outreachGets(api: ReturnType<typeof createOutreachApi>) {
  return api.requests.filter((request) => request.method === "GET" && request.path.endsWith("/outreach"))
}

function writeCalls(api: ReturnType<typeof createOutreachApi>) {
  return api.requests.filter((request) => request.method === "POST")
}

function nameSaves(api: ReturnType<typeof createOutreachApi>) {
  return api.requests.filter((request) => request.method === "PUT")
}

let clipboardWrite: ReturnType<typeof vi.fn>

beforeEach(() => {
  clipboardWrite = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true })
})

afterEach(() => {
  // jsdom has no clipboard; drop the stub so no other file is affected.
  Reflect.deleteProperty(navigator, "clipboard")
})

describe("Outreach section: placement, tabs and contents (AC 1.1, 1.4, 1.5)", () => {
  it("renders one labelled region with three tabs in a fixed order, Referral request selected", async () => {
    await openPanel()

    const region = await screen.findByRole("region", { name: "Outreach" })
    expect(
      within(region).getByText(
        "Short texts for this Application, written from your approved Career Profile. You copy and send them yourself. Eve sends nothing."
      )
    ).toBeVisible()
    const tablist = within(region).getByRole("tablist", { name: "Kind of text" })
    expect(within(tablist).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Referral request",
      "Introduction",
      "Application note",
    ])
    expect(within(tablist).getByRole("tab", { name: "Referral request" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tabpanel", { name: PANEL })).toBeVisible()
    expect(
      screen.queryByRole("tabpanel", { name: "Introduction for Senior Frontend Engineer at Acme Payments" })
    ).not.toBeInTheDocument()
  })

  it("shows each kind's purpose line and keeps every panel mounted", async () => {
    const { user } = await openPanel()
    const referral = await panel()
    expect(
      within(referral).getByText("For an employee of the company. It asks if they would refer you, and is easy to decline.")
    ).toBeVisible()

    await user.click(screen.getByRole("tab", { name: /^Introduction/ }))
    const introduction = await panel("Introduction for Senior Frontend Engineer at Acme Payments")
    expect(
      within(introduction).getByText("For a hiring manager or decision maker. It says what you bring and asks for a short conversation.")
    ).toBeVisible()

    await user.click(screen.getByRole("tab", { name: /^Application note/ }))
    const note = await panel("Application note for Senior Frontend Engineer at Acme Payments")
    expect(within(note).getByText("For a form field, or the body of an email application. It says what you bring.")).toBeVisible()
  })

  it("not written: purpose, empty name field, the empty fill and Write, with no Copy or Open in email", async () => {
    const { referral } = await openPanel()

    expect(within(referral).getByRole("textbox", { name: "Their name" })).toHaveValue("")
    expect(within(referral).getByText("Optional. Used in the greeting. Eve never fills this in.")).toBeVisible()
    expect(within(referral).getByText("Nothing written yet.")).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Write, ${KIND}` })).toBeVisible()
    expect(within(referral).queryByRole("button", { name: `Write again, ${KIND}` })).not.toBeInTheDocument()
    expect(within(referral).queryByRole("button", { name: `Copy, ${KIND}` })).not.toBeInTheDocument()
    expect(within(referral).queryByRole("link", { name: `Open in email, ${KIND}` })).not.toBeInTheDocument()
    expect(within(referral).queryByText(/of 600 characters/)).not.toBeInTheDocument()
    expect(within(referral).queryByText("Profile version 1")).not.toBeInTheDocument()
  })

  it("ready: the read-only text, count, version, date, link note, Copy, Open in email and Write again", async () => {
    const body = "A".repeat(412)
    await openPanel({ items: { referral_request: readyItem("referral_request", { body }) } })
    const referral = await panel()

    const text = within(referral).getByRole("textbox", { name: "Text of the referral request" })
    expect(text).toHaveValue(`Hello,\n\n${body}`)
    expect(text).toHaveAttribute("readonly")
    expect(within(referral).getByText("420 of 600 characters")).toBeVisible()
    expect(within(referral).getByText("Profile version 1")).toBeVisible()
    expect(within(referral).getByText("9 Nov 2026").tagName).toBe("TIME")
    expect(within(referral).getByText("Written")).toBeVisible()
    expect(within(referral).getByText("This text has no links or sign-off. Add your own before sending it.")).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).toBeVisible()
    expect(within(referral).getByRole("link", { name: `Open in email, ${KIND}` })).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Write again, ${KIND}` })).toBeVisible()
    expect(within(referral).queryByRole("button", { name: `Write, ${KIND}` })).not.toBeInTheDocument()
  })

  it("loading: the heading, the description and one skeleton, with no tabs", async () => {
    open({}, { slowReadMs: 400 })

    const region = await screen.findByRole("region", { name: "Outreach" })
    expect(within(region).getByRole("heading", { level: 2, name: "Outreach" })).toBeVisible()
    const skeleton = region.querySelector('[data-slot="skeleton"]')
    expect(skeleton).not.toBeNull()
    expect(skeleton).toHaveAttribute("aria-hidden", "true")
    expect(within(region).queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("a failed first read shows LoadErrorAlert with Try again", async () => {
    open({ failure: { kind: "load-error" } })

    const region = await screen.findByRole("region", { name: "Outreach" })
    expect(await within(region).findByText("Couldn't load this page.")).toBeVisible()
    expect(within(region).getByRole("button", { name: "Try again" })).toBeVisible()
    expect(within(region).queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("details deleted: the 404 renders no section at all", async () => {
    open({ failure: { kind: "not-found" } })

    await screen.findByRole("heading", { level: 1, name: "Senior Frontend Engineer at Acme Payments" })
    await waitFor(() => expect(screen.queryByRole("region", { name: "Outreach" })).not.toBeInTheDocument())
    expect(screen.queryByRole("tablist", { name: "Kind of text" })).not.toBeInTheDocument()
  })
})

describe("Outreach section: Run states and notices (AC 7.3, 7.9, 7.10, 10.2, 11.3)", () => {
  it.each([
    ["provider_error", "The referral request wasn't written: Anthropic didn't answer. Try again in a few minutes."],
    ["timed_out", "The referral request wasn't written: Anthropic took too long. Try again in a few minutes."],
    [
      "interrupted",
      "The referral request wasn't written: the server restarted while it was being written. Nothing was lost.",
    ],
    [
      "not_configured",
      "The referral request wasn't written: the Anthropic API key is missing on the server, so no career data was sent. Add it to the server's environment, then try again.",
    ],
  ])("a %s ending shows its cause line with Write and no quote", async (cause, line) => {
    await openPanel({ items: { referral_request: { ...notWritten("referral_request"), lastFailure: cause } } })
    const referral = await panel()

    expect(within(referral).getByText(line)).toBeVisible()
    // No Ready text exists, so the button reads Write (design spec wireframe, Blocked without an earlier text).
    expect(within(referral).getByRole("button", { name: `Write, ${KIND}` })).toBeVisible()
    expect(within(referral).queryByRole("blockquote")).not.toBeInTheDocument()
  })

  it("keeps the earlier text and appends that it is unchanged", async () => {
    const item = { ...readyItem("referral_request"), lastFailure: "provider_error" }
    await openPanel({ items: { referral_request: item } })
    const referral = await panel()

    expect(within(referral).getByRole("textbox", { name: "Text of the referral request" })).toHaveValue(item.text)
    expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).toBeVisible()
    expect(within(referral).getByText("Your earlier referral request is unchanged.")).toBeVisible()
  })

  it("generating with an earlier text keeps it copyable and shows the earlier version and date", async () => {
    const item = { ...readyItem("referral_request", { readerName: "Amara Okafor" }), status: "running" as const }
    await openPanel({ items: { referral_request: item } })
    const referral = await panel()

    expect(within(referral).getByText("Writing your referral request. This usually takes under a minute.")).toBeVisible()
    expect(within(referral).getByRole("textbox", { name: "Text of the referral request" })).toHaveValue(item.text)
    expect(within(referral).getByText("Profile version 1")).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Writing…, ${KIND}` })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("tab", { name: "Referral request, Writing" })).toBeVisible()
  })

  it("not approved and no profile show their action link", async () => {
    const { user } = await openPanel({
      items: {
        referral_request: { ...notWritten("referral_request"), lastFailure: "not_approved" },
        introduction: { ...notWritten("introduction"), lastFailure: "no_career_profile" },
      },
    })
    const referral = await panel()
    expect(within(referral).getByRole("link", { name: "Review and approve" })).toHaveAttribute("href", "/privacy#ai-provider")

    await user.click(screen.getByRole("tab", { name: /^Introduction/ }))
    const introduction = await panel("Introduction for Senior Frontend Engineer at Acme Payments")
    expect(within(introduction).getByRole("link", { name: "Go to Career Profile" })).toHaveAttribute("href", "/profile")
  })

  it("blocked with a stored sentence shows the cause line, the C-OM-53 label and the sentence verbatim", async () => {
    const sentence = "I built <b>Angular</b> & React at Brightwave."
    await openPanel({ items: { referral_request: blockedItem("referral_request", sentence) } })
    const referral = await panel()

    expect(within(referral).getByText(/The referral request wasn't kept/)).toHaveTextContent(
      "it failed Eve's checks, so nothing was copied or sent."
    )
    expect(within(referral).getByText("The first sentence that failed Eve's checks:")).toBeVisible()
    const quote = within(referral).getByRole("blockquote", { name: "The first sentence that failed Eve's checks:" })
    expect(quote).toHaveTextContent(sentence)
    expect(quote.querySelector("b")).toBeNull()
    expect(quote).toHaveAttribute("dir", "auto")
    expect(within(referral).queryByText("Your earlier referral request is unchanged.")).not.toBeInTheDocument()
    expect(within(referral).getByRole("button", { name: `Write, ${KIND}` })).toBeVisible()
    expect(within(referral).queryByRole("button", { name: `Copy, ${KIND}` })).not.toBeInTheDocument()
  })

  it("blocked with an earlier text keeps it copyable and reads cause, label, quote, then C-OM-30", async () => {
    const item = {
      ...readyItem("referral_request"),
      lastFailure: "blocked",
      firstFailedSentence: "I built the merchant dashboard in Angular.",
    }
    await openPanel({ items: { referral_request: item } })
    const referral = await panel()

    expect(within(referral).getByRole("textbox", { name: "Text of the referral request" })).toHaveValue(item.text)
    expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).toBeVisible()
    expect(within(referral).getByRole("blockquote")).toHaveTextContent("I built the merchant dashboard in Angular.")
    expect(within(referral).getByText("Your earlier referral request is unchanged.")).toBeVisible()

    const alert = within(referral).getByText(/The referral request wasn't kept/).closest("[data-slot=alert]")
    const text = alert?.textContent ?? ""
    const order = [
      "wasn't kept",
      "The first sentence that failed Eve's checks:",
      "I built the merchant dashboard in Angular.",
      "Your earlier referral request is unchanged.",
    ].map((part) => text.indexOf(part))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("blocked with no sentence shows the cause line alone, with no label and no empty quote", async () => {
    await openPanel({ items: { referral_request: blockedItem("referral_request", null) } })
    const referral = await panel()

    expect(within(referral).getByText(/The referral request wasn't kept/)).toBeVisible()
    expect(within(referral).queryByRole("blockquote")).not.toBeInTheDocument()
    expect(within(referral).queryByText("The first sentence that failed Eve's checks:")).not.toBeInTheDocument()
  })

  it("withholds a sentence that still holds an unfilled token", async () => {
    await openPanel({ items: { referral_request: blockedItem("referral_request", "I would love to join {company_phrase}.") } })
    const referral = await panel()

    expect(within(referral).getByText(/The referral request wasn't kept/)).toBeVisible()
    expect(within(referral).queryByRole("blockquote")).not.toBeInTheDocument()
    expect(within(referral).queryByText("The first sentence that failed Eve's checks:")).not.toBeInTheDocument()
    expect(within(referral).queryByText(/company_phrase/)).not.toBeInTheDocument()
  })

  it("an unknown cause shows C-OM-29 and ignores any sentence in the response", async () => {
    await openPanel({
      items: {
        referral_request: {
          ...readyItem("referral_request"),
          lastFailure: "gremlins",
          firstFailedSentence: "I built the merchant dashboard in Angular.",
        },
      },
    })
    const referral = await panel()

    expect(within(referral).getByText("The referral request wasn't written. Write it again.")).toBeVisible()
    expect(within(referral).queryByRole("blockquote")).not.toBeInTheDocument()
    expect(within(referral).queryByText(/Angular/)).not.toBeInTheDocument()
  })

  it("over budget names the kind's own budget and never shows a sentence", async () => {
    await openPanel({
      items: { application_note: { ...notWritten("application_note"), lastFailure: "over_budget", firstFailedSentence: "Too long." } },
    })
    await userEvent.click(screen.getByRole("tab", { name: /^Application note/ }))
    const note = await panel("Application note for Senior Frontend Engineer at Acme Payments")

    expect(within(note).getByText(/it came out longer than 500 characters/)).toBeVisible()
    expect(within(note).queryByRole("blockquote")).not.toBeInTheDocument()
  })

  it("a stored running row older than 10 minutes reads as interrupted", async () => {
    await openPanel({
      items: { referral_request: { ...readyItem("referral_request"), status: "running" } },
      runningFor: { referral_request: 11 * 60_000 },
    })
    const referral = await panel()

    expect(
      within(referral).getByText(
        "The referral request wasn't written: the server restarted while it was being written. Nothing was lost."
      )
    ).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Write again, ${KIND}` })).toBeVisible()
  })

  it("the global pause shows C-OM-31, keeps Copy usable and disables Write again", async () => {
    await openPanel(
      { items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) } },
      { controls: { controls: controls({ globalPaused: true }) } }
    )
    const referral = await panel()

    expect(within(referral).getByText(/Eve is paused, so the referral request wasn't written/)).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Write again, ${KIND}` })).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(within(referral).getByRole("button", { name: `Copy, ${KIND}` }))
    expect(clipboardWrite).toHaveBeenCalledWith(`Hi Amara Okafor,\n\n${OUTREACH_BODIES.referral_request}`)
  })

  it("a pause keeps the stored blocked cause and its quote, shown with the pause note above them (CR-3)", async () => {
    const sentence = "I built the merchant dashboard in Angular."
    await openPanel(
      { items: { referral_request: blockedItem("referral_request", sentence) } },
      { controls: { controls: controls({ globalPaused: true }) } }
    )
    const referral = await panel()

    // outreach-pause-and-cost.feature: no Run starts, and the earlier blocked
    // cause and its quote are still shown, beside the pause line.
    expect(within(referral).getByText(/Eve is paused, so the referral request wasn't written/)).toBeVisible()
    expect(within(referral).getByText(/The referral request wasn't kept/)).toBeVisible()
    expect(within(referral).getByText("The first sentence that failed Eve's checks:")).toBeVisible()
    expect(within(referral).getByRole("blockquote")).toHaveTextContent(sentence)

    const pauseNote = within(referral).getByText(/Eve is paused, so the referral request wasn't written/).closest("[data-slot=alert]")
    const cause = within(referral).getByText(/The referral request wasn't kept/).closest("[data-slot=alert]")
    expect(pauseNote).not.toBe(cause)
    expect(pauseNote!.compareDocumentPosition(cause!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it("the cost pause shows C-OM-32 with its cost link", async () => {
    await openPanel(
      { items: { referral_request: readyItem("referral_request") } },
      { controls: { controls: { ...controls(), costPause: costPause() } } }
    )
    const referral = await panel()

    expect(within(referral).getByText(/Paid automation is paused for this month's cost ceiling/)).toBeVisible()
    expect(within(referral).getByRole("link", { name: "Review cost ceiling" })).toHaveAttribute("href", "/pause-and-cost#cost")
  })

  it("a newer approved profile version adds the stale line", async () => {
    await openPanel({ items: { referral_request: readyItem("referral_request") }, approvedProfileVersion: 2 })
    const referral = await panel()

    expect(
      within(referral).getByText("Written from Career Profile version 1. Your approved version is now 2. Write again to use it.")
    ).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).toBeVisible()
  })
})

describe("Outreach section: a partly salvaged Run (AC 2.11)", () => {
  it("leaves no trace: plain Ready, with no notice, label or quote", async () => {
    const { user, referral } = await openPanel(
      {
        items: {
          referral_request: { ...readyItem("referral_request"), lastFailure: "blocked", firstFailedSentence: "I built it in Angular." },
        },
        script: { referral_request: [{ outcome: { status: "ready-after-drop", body: "A new body." }, pollsUntilDone: 1 }] },
      },
      { fakeTimers: true }
    )

    await user.click(within(referral).getByRole("button", { name: `Write again, ${KIND}` }))
    await advance(2000)

    expect(await within(referral).findByRole("textbox", { name: "Text of the referral request" })).toHaveValue(
      "Hello,\n\nA new body."
    )
    expect(within(referral).queryByRole("blockquote")).not.toBeInTheDocument()
    expect(within(referral).queryByText(/wasn't kept/)).not.toBeInTheDocument()
    expect(within(referral).queryByText("The first sentence that failed Eve's checks:")).not.toBeInTheDocument()
  })
})

describe("Outreach section: the Reader name (AC 5.2 to 5.6, G3, G4)", () => {
  it("a typed, unsaved name shows C-OM-47 and holds Copy and Open in email", async () => {
    const { user, api } = await openPanel({
      items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
    })
    const referral = await panel()

    const input = within(referral).getByRole("textbox", { name: "Their name" })
    await user.clear(input)
    await user.type(input, "Dana Whitfield")

    expect(within(referral).getByText("Name not saved. Save it before you copy or email a text.")).toBeVisible()
    const copy = within(referral).getByRole("button", { name: `Copy, ${KIND}` })
    expect(copy).toHaveAttribute("aria-disabled", "true")
    const link = within(referral).getByRole("link", { name: `Open in email, ${KIND}` })
    expect(link).not.toHaveAttribute("href")
    expect(link).toHaveAttribute("aria-disabled", "true")
    await user.click(copy)
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(writeCalls(api)).toHaveLength(0)
  })

  it("saving the name ends the wait and announces it", async () => {
    const { user } = await openPanel({
      items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
    })
    const referral = await panel()

    const input = within(referral).getByRole("textbox", { name: "Their name" })
    await user.clear(input)
    await user.type(input, "Dana Whitfield")
    await user.click(within(referral).getByRole("button", { name: "Save name" }))

    expect(await screen.findByText("Name saved. The greeting uses it.")).toBeInTheDocument()
    expect(within(referral).queryByText("Name not saved. Save it before you copy or email a text.")).not.toBeInTheDocument()
    expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).toHaveAttribute("aria-disabled", "false")
    expect(within(referral).getByRole("textbox", { name: "Text of the referral request" })).toHaveValue(
      `Hi Dana Whitfield,\n\n${OUTREACH_BODIES.referral_request}`
    )
  })

  it("a refused name shows C-OM-37, keeps focus, saves nothing and starts nothing", async () => {
    const { user, api } = await openPanel({
      items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
    })
    const referral = await panel()
    const input = within(referral).getByRole("textbox", { name: "Their name" })

    await user.clear(input)
    await user.type(input, "Amara2")
    await user.click(within(referral).getByRole("button", { name: "Save name" }))

    expect(
      within(referral).getByText("Use letters, spaces, hyphens, apostrophes and full stops, up to 40 characters.")
    ).toBeVisible()
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveFocus()
    expect(nameSaves(api)).toHaveLength(0)

    await user.click(within(referral).getByRole("button", { name: `Write again, ${KIND}` }))
    expect(writeCalls(api)).toHaveLength(0)
  })

  it("a failed name save shows C-OM-48, not C-OM-37, and starts nothing", async () => {
    const { user, api } = await openPanel({
      items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
      failure: { kind: "name-server-error" },
    })
    const referral = await panel()
    const input = within(referral).getByRole("textbox", { name: "Their name" })

    await user.clear(input)
    await user.type(input, "Dana")
    await user.click(within(referral).getByRole("button", { name: "Save name" }))

    expect(await within(referral).findByText("The name wasn't saved. Try again.")).toBeVisible()
    expect(
      within(referral).queryByText("Use letters, spaces, hyphens, apostrophes and full stops, up to 40 characters.")
    ).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute("aria-invalid")
    expect(nameSaves(api)).toHaveLength(1)
    expect(writeCalls(api)).toHaveLength(0)
  })

  it("clearing a saved name saves null and announces C-OM-12", async () => {
    const { user, api } = await openPanel({
      items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
    })
    const referral = await panel()
    const input = within(referral).getByRole("textbox", { name: "Their name" })

    await user.clear(input)
    await user.click(within(referral).getByRole("button", { name: "Save name" }))

    expect(await screen.findByText("Name cleared.")).toBeInTheDocument()
    expect(nameSaves(api)[0]?.body).toEqual({ readerName: null })
    expect(within(referral).getByRole("textbox", { name: "Text of the referral request" })).toHaveValue(
      `Hello,\n\n${OUTREACH_BODIES.referral_request}`
    )
  })

  it("Write with a valid unsaved name saves it first, then starts the Run (G4)", async () => {
    const { user, api } = await openPanel({
      items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
      script: { referral_request: [{ outcome: { status: "ready" }, pollsUntilDone: 1 }] },
    })
    const referral = await panel()

    const input = within(referral).getByRole("textbox", { name: "Their name" })
    await user.clear(input)
    await user.type(input, "Dana")
    await user.click(within(referral).getByRole("button", { name: `Write again, ${KIND}` }))

    await waitFor(() => expect(writeCalls(api)).toHaveLength(1))
    const mutations = api.requests.filter((request) => request.method !== "GET")
    expect(mutations.map((request) => request.method)).toEqual(["PUT", "POST"])
    expect(mutations[0]?.path).toMatch(/\/referral-request\/reader-name$/)
    expect(mutations[1]?.path).toMatch(/\/referral-request\/write$/)
    expect(mutations[0]?.body).toEqual({ readerName: "Dana" })
  })
})

describe("Outreach section: Copy and Open in email (AC 6.1 to 6.4)", () => {
  it("Copy puts the stored text on the clipboard and confirms in the button and the live region", async () => {
    const { user } = await openPanel({
      items: { referral_request: readyItem("referral_request", { body: "First line.\nSecond line." }) },
    })
    const referral = await panel()

    await user.click(within(referral).getByRole("button", { name: `Copy, ${KIND}` }))

    expect(clipboardWrite).toHaveBeenCalledWith("Hello,\n\nFirst line.\nSecond line.")
    expect(within(referral).getByRole("button", { name: `Copied, ${KIND}` })).toBeVisible()
    expect(await screen.findByText("Referral request copied.")).toBeInTheDocument()
    await waitFor(() => expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).toBeVisible(), {
      timeout: 3000,
    })
  })

  it("a refused clipboard shows C-OM-34, focuses and selects the text, and never says Copied", async () => {
    clipboardWrite.mockRejectedValueOnce(new Error("denied"))
    const { user } = await openPanel({ items: { referral_request: readyItem("referral_request") } })
    const referral = await panel()
    const text = within(referral).getByRole("textbox", { name: "Text of the referral request" })

    await user.click(within(referral).getByRole("button", { name: `Copy, ${KIND}` }))

    expect(await within(referral).findByText("Couldn't copy. Select the text and copy it yourself.")).toBeVisible()
    expect(text).toHaveFocus()
    expect(within(referral).queryByRole("button", { name: `Copied, ${KIND}` })).not.toBeInTheDocument()
  })

  it("Open in email is a recipient-less mailto with the encoded subject and CRLF body, never the quote", async () => {
    const item = {
      ...readyItem("referral_request", { readerName: "Amara Okafor" }),
      lastFailure: "blocked",
      firstFailedSentence: "I built it in Angular.",
    }
    await openPanel({ items: { referral_request: item } })
    const referral = await panel()

    const anchor = within(referral).getByRole("link", { name: `Open in email, ${KIND}` })
    const href = anchor.getAttribute("href") ?? ""
    expect(href.startsWith("mailto:?subject=")).toBe(true)
    expect(href).not.toContain("?to=")
    expect(href).not.toContain("&cc=")
    expect(href).not.toContain("&bcc=")
    expect(href).toContain("%20")
    expect(anchor).not.toHaveAttribute("target")
    expect(anchor).not.toHaveAttribute("rel")

    const params = new URLSearchParams(href.slice("mailto:?".length))
    expect(params.get("subject")).toBe("Referral request for Senior Frontend Engineer at Acme Payments")
    expect(params.get("body")?.replace(/\r\n/g, "\n")).toBe(item.text)
    expect(href).toContain("%0D%0A")
    expect(href).not.toContain("Angular")
  })

  it("a mailto over 2,000 characters is not offered: C-OM-36 sits beside Copy", async () => {
    await openPanel({ items: { introduction: readyItem("introduction", { body: "é".repeat(400) }) } })
    await userEvent.click(screen.getByRole("tab", { name: /^Introduction/ }))
    const introduction = await panel("Introduction for Senior Frontend Engineer at Acme Payments")

    expect(within(introduction).queryByRole("link", { name: "Open in email, introduction" })).not.toBeInTheDocument()
    expect(within(introduction).getByText("This is too long to open in an email app. Copy it instead.")).toBeVisible()
    expect(within(introduction).getByRole("button", { name: "Copy, introduction" })).toBeVisible()
  })
})

describe("Outreach section: Copy and Open in email make no request (AC 6.5)", () => {
  it("sends no fetch, XHR or beacon when Copy is used and when the mailto link is followed", async () => {
    const { user } = await openPanel({
      items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
    })
    const referral = await panel()

    // Installed after the page's own read has settled, so only Copy and the link are under observation.
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, "send")
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true })
    try {
      await user.click(within(referral).getByRole("button", { name: `Copy, ${KIND}` }))
      expect(clipboardWrite).toHaveBeenCalledWith(`Hi Amara Okafor,\n\n${OUTREACH_BODIES.referral_request}`)

      const link = within(referral).getByRole("link", { name: `Open in email, ${KIND}` })
      expect(link.getAttribute("href")).toMatch(/^mailto:\?/)
      await user.click(link)

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(xhrSpy).not.toHaveBeenCalled()
      expect(beacon).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(navigator, "sendBeacon")
    }
  })
})

describe("Outreach section: writing, polling and outcomes (AC 7.1 to 7.7)", () => {
  it("Write shows the writing line and a busy button, then polls every 2,000 ms until the item is idle", async () => {
    const { user, api, referral } = await openPanel(
      { script: { referral_request: [{ outcome: { status: "ready", body: "Fresh body." }, pollsUntilDone: 2 }] } },
      { fakeTimers: true }
    )

    await user.click(within(referral).getByRole("button", { name: `Write, ${KIND}` }))

    expect(
      await within(referral).findByText("Writing your referral request. This usually takes under a minute.")
    ).toBeVisible()
    expect(within(referral).getByRole("button", { name: `Writing…, ${KIND}` })).toHaveAttribute("aria-disabled", "true")

    await advance(2000)
    expect(within(referral).getByText("Writing your referral request. This usually takes under a minute.")).toBeVisible()

    await advance(2000)
    expect(await within(referral).findByRole("textbox", { name: "Text of the referral request" })).toHaveValue(
      "Hello,\n\nFresh body."
    )
    expect(await screen.findByText("Your referral request is ready to copy.")).toBeInTheDocument()

    await advance(6000)
    const settled = outreachGets(api).length
    await advance(6000)
    expect(outreachGets(api)).toHaveLength(settled)
  })

  it("a blocked outcome quotes the sentence and announces the cause line only", async () => {
    const { user, referral } = await openPanel(
      {
        items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
        script: {
          referral_request: [
            { outcome: { status: "blocked", sentence: "I built the merchant dashboard in Angular." }, pollsUntilDone: 1 },
          ],
        },
      },
      { fakeTimers: true }
    )

    await user.click(within(referral).getByRole("button", { name: `Write again, ${KIND}` }))
    await advance(2000)

    expect(await within(referral).findByRole("blockquote")).toHaveTextContent("I built the merchant dashboard in Angular.")
    expect(within(referral).getByText("Your earlier referral request is unchanged.")).toBeVisible()
    const live = screen.getAllByRole("status").find((node) => node.textContent?.includes("it failed Eve's checks"))
    expect(live?.textContent).toContain("Your earlier referral request is unchanged.")
    expect(live?.textContent).not.toContain("The first sentence that failed Eve's checks")
    expect(live?.textContent).not.toContain("Angular")
  })

  it("a network failure on Write shows C-OM-29 inline, starts no retry and refetches the read", async () => {
    const { user, api, referral } = await openPanel({ failure: { kind: "write-network-error" } })

    await user.click(within(referral).getByRole("button", { name: `Write, ${KIND}` }))

    expect(await within(referral).findByText("The referral request wasn't written. Write it again.")).toBeVisible()
    expect(writeCalls(api)).toHaveLength(1)
    expect(outreachGets(api).length).toBeGreaterThanOrEqual(2)
  })

  it("a pause that stops a Run with no stored cause shows the pause note", async () => {
    const { user, referral } = await openPanel(
      { script: { referral_request: [{ outcome: { status: "paused" }, pollsUntilDone: 1 }] } },
      { controls: { controls: controls({ globalPaused: true }) }, fakeTimers: true }
    )

    await user.click(within(referral).getByRole("button", { name: `Write, ${KIND}` }))
    await advance(2000)

    expect(await within(referral).findByText(/Eve is paused, so the referral request wasn't written/)).toBeVisible()
  })
})

describe("Outreach section: conflict, a failed start and a failed poll (AC 7.6, 11.3)", () => {
  it("a second request while the kind is writing shows the writing state and no error", async () => {
    const { user, api } = await openPanel({
      items: { referral_request: { ...readyItem("referral_request"), status: "running" } },
    })
    const referral = await panel()
    await user.click(within(referral).getByRole("button", { name: `Writing…, ${KIND}` }))

    expect(within(referral).getByText("Writing your referral request. This usually takes under a minute.")).toBeVisible()
    expect(writeCalls(api)).toHaveLength(0)
    expect(within(referral).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("a 500 on Write shows C-OM-29 inline and is never retried automatically", async () => {
    const { user, api, referral } = await openPanel({ failure: { kind: "write-server-error" } }, { fakeTimers: true })
    await user.click(within(referral).getByRole("button", { name: `Write, ${KIND}` }))

    expect(await within(referral).findByText("The referral request wasn't written. Write it again.")).toBeVisible()
    expect(writeCalls(api)).toHaveLength(1)
    await advance(10_000)
    expect(writeCalls(api)).toHaveLength(1)
  })

  it("a failed background poll keeps the earlier text and the writing line", async () => {
    const { user, api, referral } = await openPanel(
      {
        items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
        script: { referral_request: [{ outcome: { status: "ready", body: "Fresh body." }, pollsUntilDone: 2 }] },
        failure: { kind: "poll-error", after: 1 },
      },
      { fakeTimers: true }
    )
    await user.click(within(referral).getByRole("button", { name: `Write again, ${KIND}` }))
    await advance(2000)

    expect(within(referral).getByRole("textbox", { name: "Text of the referral request" })).toHaveValue(
      `Hi Amara Okafor,\n\n${OUTREACH_BODIES.referral_request}`
    )
    expect(within(referral).getByText("Writing your referral request. This usually takes under a minute.")).toBeVisible()
    expect(within(referral).queryByText("Couldn't load this page.")).not.toBeInTheDocument()

    await advance(4000)
    expect(await within(referral).findByRole("textbox", { name: "Text of the referral request" })).toHaveValue(
      "Hi Amara Okafor,\n\nFresh body."
    )
    expect(outreachGets(api).length).toBeGreaterThanOrEqual(3)
  })

  it("details deleted while the page is open: the section goes and the minimal record view takes over", async () => {
    const { user, api, documents } = await openPanel({
      items: { referral_request: readyItem("referral_request") },
    })
    const referral = await panel()
    api.state.failure = { kind: "not-found" }
    const stored = documents.state.applications[0]!
    stored.detailsDeletedAt = "2026-11-10T10:00:00.000Z"

    await user.click(within(referral).getByRole("button", { name: `Write again, ${KIND}` }))

    await waitFor(() => expect(screen.queryByRole("region", { name: "Outreach" })).not.toBeInTheDocument())
    expect(screen.queryByRole("heading", { name: "Outreach" })).not.toBeInTheDocument()
    expect(await screen.findByRole("heading", { level: 1, name: "Acme Payments" })).toBeVisible()
  })
})

describe("Outreach MSW fake: the contract's failures", () => {
  const base = () => `/v1/applications/${readyApplication().id}/outreach`

  it("403 csrf_invalid without the token on POST and PUT", async () => {
    const write = await fetch(`${base()}/referral-request/write`, { method: "POST" })
    expect(write.status).toBe(403)
    expect(await write.json()).toMatchObject({ error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } })

    const name = await fetch(`${base()}/referral-request/reader-name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ readerName: "Amara" }),
    })
    expect(name.status).toBe(403)
  })

  it("422 outreach_reader_name_invalid with C-OM-37 byte for byte", async () => {
    server.use(...createOutreachApi().handlers)
    const response = await fetch(`${base()}/referral-request/reader-name`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-csrf-token": TEST_CSRF_TOKEN },
      body: JSON.stringify({ readerName: "Amara 123" }),
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: {
        code: "outreach_reader_name_invalid",
        message: "Use letters, spaces, hyphens, apostrophes and full stops, up to 40 characters.",
      },
    })
  })

  it("400 bad_request for a malformed body", async () => {
    server.use(...createOutreachApi().handlers)
    const response = await fetch(`${base()}/referral-request/reader-name`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-csrf-token": TEST_CSRF_TOKEN },
      body: JSON.stringify({ name: "Amara" }),
    })
    expect(response.status).toBe(400)
  })

  it("401 unauthenticated and 404 not_found with the standard bodies", async () => {
    const signedOut = createOutreachApi({ failure: { kind: "signed-out" } })
    server.use(...signedOut.handlers)
    const unauthorized = await fetch(base())
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({ error: { code: "unauthenticated", message: "Sign in to continue." } })

    const foreign = createOutreachApi({ failure: { kind: "not-found" } })
    server.use(...foreign.handlers)
    for (const url of [base(), `${base()}/referral-request/write`]) {
      const missing = await fetch(url, url.endsWith("/write") ? { method: "POST", headers: { "x-csrf-token": TEST_CSRF_TOKEN } } : undefined)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({ error: { code: "not_found", message: "Not found." } })
    }
  })

  it("500 internal_error and a network failure", async () => {
    const serverError = createOutreachApi({ failure: { kind: "load-error" } })
    server.use(...serverError.handlers)
    const failed = await fetch(base())
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ error: { code: "internal_error", message: "Something went wrong." } })

    const offline = createOutreachApi({ failure: { kind: "name-network-error" } })
    server.use(...offline.handlers)
    await expect(
      fetch(`${base()}/referral-request/reader-name`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-csrf-token": TEST_CSRF_TOKEN },
        body: JSON.stringify({ readerName: "Amara" }),
      })
    ).rejects.toThrow()
  })
})

describe("Outreach section: keyboard only (design spec section 12)", () => {
  it("arrow keys move and activate the tabs, Home and End reach the ends", async () => {
    const { user } = await openPanel()

    screen.getByRole("tab", { name: "Referral request" }).focus()
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: "Introduction" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "Introduction" })).toHaveFocus()

    await user.keyboard("{End}")
    expect(screen.getByRole("tab", { name: "Application note" })).toHaveAttribute("aria-selected", "true")

    await user.keyboard("{Home}")
    expect(screen.getByRole("tab", { name: "Referral request" })).toHaveAttribute("aria-selected", "true")
  })

  it("Tab passes the panel in the specified order with no stop on the quote", async () => {
    const { user } = await openPanel({
      items: {
        referral_request: {
          ...readyItem("referral_request", { readerName: "Amara Okafor" }),
          lastFailure: "blocked",
          firstFailedSentence: "I built it in Angular.",
        },
      },
    })
    const referral = await panel()

    within(referral).getByRole("textbox", { name: "Their name" }).focus()
    await user.tab()
    expect(within(referral).getByRole("button", { name: "Save name" })).toHaveFocus()
    await user.tab()
    expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).toHaveFocus()
    await user.tab()
    expect(within(referral).getByRole("link", { name: `Open in email, ${KIND}` })).toHaveFocus()
    await user.tab()
    expect(within(referral).getByRole("textbox", { name: "Text of the referral request" })).toHaveFocus()
    await user.tab()
    expect(within(referral).getByRole("button", { name: `Write again, ${KIND}` })).toHaveFocus()
  })
})

/**
 * Designer review r1, F1. jsdom lays nothing out, so the no-clipping rule is
 * asserted on the classes that decide it: three equal `1fr` cells (a column
 * cannot grow past its share, so the list cannot overflow and centre-clip the
 * ends), and triggers that may shrink, wrap their full label and drop the
 * status icon to a second line. The label text itself is asserted whole, so a
 * shortened or truncated label fails here too.
 */
describe("Outreach section: the kind tablist never clips a label (design review F1)", () => {
  const LABELS = ["Referral request", "Introduction", "Application note"]

  function atWidth(width: number) {
    const original = window.innerWidth
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
    window.dispatchEvent(new Event("resize"))
    return () => Object.defineProperty(window, "innerWidth", { configurable: true, value: original })
  }

  function expectNoClipping(iconCount: number) {
    const tablist = screen.getByRole("tablist", { name: "Kind of text" })
    // Three equal cells, full width: no `w-fit` row that can be wider than the gutter.
    expect(tablist).toHaveClass("grid", "grid-cols-3", "w-full")
    expect(tablist).not.toHaveClass("w-fit")

    const tabs = within(tablist).getAllByRole("tab")
    expect(tabs).toHaveLength(3)

    for (const tab of tabs) {
      expect(tab).toHaveClass("min-w-0", "flex-wrap", "whitespace-normal")
      expect(tab).not.toHaveClass("truncate")
      expect(tab).not.toHaveClass("overflow-hidden")
      // The label is its own wrapping, shrinkable cell, never a fixed width.
      const label = tab.querySelector("span:not(.sr-only)")
      expect(label).not.toBeNull()
      expect(label).toHaveClass("min-w-0")
      expect(label).not.toHaveClass("truncate")
    }

    // Every label is whole in the DOM, in the fixed order (AC 1.1).
    expect(tabs.map((tab) => (tab.textContent ?? "").replace(/, (Needs a look|Writing)$/, ""))).toEqual(LABELS)

    // The status icons are kept, `aria-hidden`, with their sr-only suffix.
    const statusTabs = tabs.filter((tab) => (tab.textContent ?? "").endsWith("Needs a look"))
    expect(statusTabs).toHaveLength(iconCount)
    for (const tab of statusTabs) {
      expect(tab.querySelector("svg")).not.toBeNull()
      expect(tab.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
    }

    // ARIA tablist semantics are untouched.
    expect(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(1)
    for (const tab of tabs) expect(tab).toHaveAttribute("aria-controls")
  }

  for (const width of [320, 375]) {
    it(`keeps all three labels whole with two status icons at ${width}px`, async () => {
      const restore = atWidth(width)
      try {
        await openPanel({
          items: {
            referral_request: { ...readyItem("referral_request"), lastFailure: "provider_error" },
            introduction: { ...readyItem("introduction"), lastFailure: "timed_out" },
          },
        })
        expectNoClipping(2)
      } finally {
        restore()
      }
    })

    it(`keeps all three labels whole with three status icons at ${width}px`, async () => {
      const restore = atWidth(width)
      try {
        await openPanel(
          { items: { referral_request: readyItem("referral_request") } },
          { controls: { controls: controls({ globalPaused: true }) } }
        )
        expectNoClipping(3)
      } finally {
        restore()
      }
    })
  }
})

/**
 * Designer review r1, F2. `aria-disabled` stays so focus survives; with the
 * Button's `focusableWhenDisabled` the control also carries `data-disabled`,
 * which is where the shared dim lives (`data-disabled:opacity-50`).
 */
describe("Outreach section: a control that cannot be used looks disabled (design review F2)", () => {
  function expectDimmed(control: HTMLElement) {
    expect(control).toHaveAttribute("aria-disabled", "true")
    expect(control).toHaveAttribute("data-disabled")
    // The same hook the shared Button styles the dim with (button.test.tsx).
    expect(control).toHaveClass("data-disabled:opacity-50", "data-disabled:pointer-events-none")
    expect(control).not.toBeDisabled()
    control.focus()
    expect(control).toHaveFocus()
  }

  it("Save name is dimmed and focusable while the name is unchanged", async () => {
    await openPanel()
    const referral = await panel()

    expectDimmed(within(referral).getByRole("button", { name: "Save name" }))
  })

  it("Copy is dimmed and focusable while the name is unsaved, and the dim lifts on save", async () => {
    const { user } = await openPanel({
      items: { referral_request: readyItem("referral_request", { readerName: "Amara Okafor" }) },
    })
    const referral = await panel()

    await user.type(within(referral).getByRole("textbox", { name: "Their name" }), "a")
    expectDimmed(within(referral).getByRole("button", { name: `Copy, ${KIND}` }))

    await user.click(within(referral).getByRole("button", { name: "Save name" }))
    const saved = await within(referral).findByRole("button", { name: `Copy, ${KIND}` })
    await waitFor(() => expect(saved).toHaveAttribute("aria-disabled", "false"))
    expect(saved).not.toHaveAttribute("data-disabled")
  })

  it("Write is dimmed and focusable under a pause, while Copy keeps working", async () => {
    await openPanel(
      { items: { referral_request: readyItem("referral_request") } },
      { controls: { controls: controls({ globalPaused: true }) } }
    )
    const referral = await panel()

    expectDimmed(within(referral).getByRole("button", { name: `Write again, ${KIND}` }))
    expect(within(referral).getByRole("button", { name: `Copy, ${KIND}` })).not.toHaveAttribute("data-disabled")
  })

  it("Write is dimmed and focusable while a Run is in flight", async () => {
    const { user } = await openPanel({
      items: { referral_request: notWritten("referral_request") },
      script: { referral_request: [{ outcome: { status: "ready", body: "A new body." }, pollsUntilDone: 99 }] },
    })
    const referral = await panel()

    await user.click(within(referral).getByRole("button", { name: `Write, ${KIND}` }))
    expectDimmed(await within(referral).findByRole("button", { name: `Writing…, ${KIND}` }))
  })
})

/**
 * Designer review r1, F3 and PRD AC 12.1: another tab deletes the details, the
 * next request answers 404, the page swaps to the minimal record view and focus
 * moves to its title instead of falling to `<body>`.
 */
describe("Outreach section: the details are deleted while the page is open (AC 12.1)", () => {
  it("swaps to the minimal record view and moves focus to its title", async () => {
    const view = await openPanel({ items: { referral_request: readyItem("referral_request") } })
    const referral = await panel()

    // The delete route the page itself uses, so the record read answers the real deleted shape.
    view.controls.state.applications.push(view.app)
    const deleted = await fetch("/v1/applications/delete-details", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": TEST_CSRF_TOKEN },
      body: JSON.stringify({ applicationIds: [view.app.id] }),
    })
    expect(deleted.status).toBe(200)
    server.use(
      http.post("/v1/applications/:id/outreach/:kind/write", () =>
        HttpResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })
      )
    )

    await view.user.click(within(referral).getByRole("button", { name: `Write again, ${KIND}` }))

    const title = await screen.findByRole("heading", { level: 1, name: "Acme Payments" })
    await waitFor(() => expect(title).toHaveFocus())
    expect(screen.queryByRole("region", { name: "Outreach" })).not.toBeInTheDocument()
  })
})

/** Designer review r1: F4 and the non-blocking gaps G1, G4, G5 and G6. */
describe("Outreach section: design review r1 wording and detail fixes", () => {
  it("F4: the blocked cause line ends with the approved reassurance, inside 36 words", async () => {
    await openPanel({
      items: {
        referral_request: { ...readyItem("referral_request"), lastFailure: "blocked", firstFailedSentence: "I built it in Angular." },
      },
    })
    const referral = await panel()

    const line = within(referral).getByText(/The referral request wasn't kept/)
    expect(line).toHaveTextContent("A new run can differ.")
    expect((line.textContent ?? "").trim().split(/\s+/).length).toBeLessThanOrEqual(36)
    // The label and the quote still follow the cause line.
    expect(within(referral).getByText("The first sentence that failed Eve's checks:")).toBeVisible()
  })

  it("G1: the name-unsaved hint waits for a Ready text to exist", async () => {
    const { user } = await openPanel({ items: { referral_request: notWritten("referral_request") } })
    const referral = await panel()

    const input = within(referral).getByRole("textbox", { name: "Their name" })
    await user.type(input, "Amara")
    expect(
      within(referral).queryByText("Name not saved. Save it before you copy or email a text.")
    ).not.toBeInTheDocument()
    expect(within(referral).queryByRole("button", { name: `Copy, ${KIND}` })).not.toBeInTheDocument()
  })

  it("G4: a notice link keeps a 40px target", async () => {
    await openPanel({
      items: { referral_request: { ...readyItem("referral_request"), lastFailure: "not_approved" } },
    })
    const referral = await panel()

    const link = within(referral).getByRole("link", { name: "Review and approve" })
    expect(link).toHaveClass("min-h-10")
    expect(link).toHaveAttribute("href", "/privacy#ai-provider")
  })

  it("G5: the meta line leaves no dangling separator when the version is missing", async () => {
    await openPanel({
      items: { referral_request: { ...readyItem("referral_request"), profileVersion: null } },
    })
    const referral = await panel()

    const meta = within(referral).getByText(/characters/).closest("p")
    expect(meta).not.toBeNull()
    expect(meta?.textContent?.startsWith("·")).toBe(false)
    expect(meta?.textContent?.match(/·/g)).toHaveLength(1)
  })

  it("G6: the quote's start rule meets non-text contrast", async () => {
    await openPanel({
      items: {
        referral_request: { ...readyItem("referral_request"), lastFailure: "blocked", firstFailedSentence: "I built it in Angular." },
      },
    })
    const referral = await panel()

    const quote = within(referral).getByRole("blockquote")
    expect(quote).toHaveClass("border-muted-foreground")
    expect(quote).not.toHaveClass("border-border")
  })
})
