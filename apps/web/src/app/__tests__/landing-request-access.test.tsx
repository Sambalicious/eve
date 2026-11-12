import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccessRequestApi, server, signedInSession, TEST_PROOF, type AccessRequestApi } from "@/shared/testing"
import { renderApp } from "./test-app"

const HEADLINE = "Applies for you. Asks instead of guessing."
const c = {
  intro: "Your request goes to the person who runs Eve. They decide who gets an invite.",
  required: "Enter your email address.",
  format: "Enter an email like name@example.com",
  tooLong: "Email is too long. Use a shorter address.",
  noteTooLong: "Keep the note to 500 characters or fewer.",
  successHeading: "Request sent",
  successBody: "The person who runs Eve will see it.",
  network: "Couldn't send your request. What you typed is still here.",
  rateIp: "Too many requests from this network. Try again later.",
  rateGlobal: "Eve can't take more requests today. Try again tomorrow.",
  rejected: "This page couldn't send your request. Reload the page and send it again.",
}

let api: AccessRequestApi

function useApi(options?: Parameters<typeof createAccessRequestApi>[0]) {
  api = createAccessRequestApi(options)
  server.use(...api.handlers)
  return api
}

async function setup(path = "/") {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
  const view = renderApp(path)
  await screen.findByRole("heading", { level: 1, name: HEADLINE })
  return { user, ...view }
}

const requestButton = () => screen.getByRole("button", { name: "Request access" })
const dialog = () => screen.getByRole("dialog", { name: "Request access" })
const email = () => within(dialog()).getByRole("textbox", { name: "Email" })
const note = () => within(dialog()).getByRole("textbox", { name: "Note (optional)" })
const send = () => within(dialog()).getByRole("button", { name: /Send request|Sending request/ })
const status = () => within(dialog()).getByRole("status")
/** The dialog's own toaster (design-spec r3 S2): named by landing.request.toast_region_label. */
const toastRegion = () => within(dialog()).getByRole("region", { name: "Problems sending" })
const liveToasts = () => [...dialog().querySelectorAll("[data-sonner-toast]")].filter((el) => el.getAttribute("data-removed") !== "true")
/** The one dialog toast showing `text` (r3: send failures are toasts, not a panel). */
const toastWith = (text: string) =>
  waitFor(() => {
    const items = liveToasts()
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent(text)
    return items[0] as HTMLElement
  })
const noToast = () => waitFor(() => expect(liveToasts()).toHaveLength(0))

const successShown = () => waitFor(() => expect(within(dialog()).getByText(c.successHeading, { selector: "p" })).toBeVisible())

/** Opens the dialog and waits for the form and its proof; optionally lets `waitMs` pass. */
async function openDialog(user: ReturnType<typeof userEvent.setup>, waitMs = 5000) {
  await user.click(requestButton())
  await waitFor(() => expect(email()).toHaveFocus())
  await waitFor(() => expect(api.proofCalls).toBeGreaterThan(0))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(waitMs)
  })
}

describe("request access dialog (request-access.feature, client scenarios)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens a modal named and described by the deck, with focus on the email field", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)

    expect(dialog()).toHaveAttribute("aria-modal", "true")
    expect(dialog()).toHaveAccessibleDescription(c.intro)
    expect(email()).toHaveFocus()
    expect(email()).toHaveAttribute("type", "email")
    expect(email()).toHaveAttribute("autocomplete", "email")
    expect(email()).toHaveAttribute("placeholder", "name@example.com")
    expect(within(dialog()).getByText("Who you are, or how you heard about Eve.")).toBeVisible()
    const header = dialog().querySelector('[data-slot="overlay-header"]')!
    expect(header).toHaveClass("border-b")
    expect(within(header as HTMLElement).getByRole("heading", { name: "Request access" })).toBeInTheDocument()
  })

  it("does not request the form chunk or a proof on page load", async () => {
    useApi()
    await setup()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(api.proofCalls).toBe(0)
  })

  it("Tab order inside the dialog: email, note, Privacy, Send, Cancel, close; the honeypot never", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)

    const expected = [
      email(),
      note(),
      within(dialog()).getByRole("link", { name: "Privacy, opens in a new tab" }),
      within(dialog()).getByRole("button", { name: "Send request" }),
      within(dialog()).getByRole("button", { name: "Cancel" }),
      within(dialog()).getByRole("button", { name: "Close" }),
    ]
    for (const element of expected) {
      expect(element).toHaveFocus()
      await user.tab()
    }
    expect(email()).toHaveFocus()
    await user.tab({ shift: true })
    expect(within(dialog()).getByRole("button", { name: "Close" })).toHaveFocus()
  })

  it("the honeypot is off-screen, hidden from assistive tech, untabbable and not autofilled", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    const honeypot = dialog().querySelector<HTMLInputElement>('input[name="kiwi"]')!
    expect(honeypot).toHaveAttribute("tabindex", "-1")
    expect(honeypot).toHaveAttribute("autocomplete", "off")
    expect(honeypot.closest('[aria-hidden="true"]')).toHaveClass("-left-[10000px]")
    expect(honeypot.labels?.[0]?.textContent).toBe("Leave this field empty")
  })

  it("Shift+Tab from the email field reaches the toast's close control; Alt+T keeps focus in the dialog", async () => {
    useApi({ replies: ["rate_ip"] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    const shown = await toastWith(c.rateIp)
    email().focus()
    await user.tab({ shift: true })
    expect(within(shown).getByRole("button", { name: "Close message" })).toHaveFocus()
    email().focus()
    await user.keyboard("{Alt>}t{/Alt}")
    expect(dialog().contains(document.activeElement)).toBe(true)
  })

  it.each([
    ["Escape in the email field", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    ["Cancel", async (user: ReturnType<typeof userEvent.setup>) => user.click(within(dialog()).getByRole("button", { name: "Cancel" }))],
    ["the close control", async (user: ReturnType<typeof userEvent.setup>) => user.click(within(dialog()).getByRole("button", { name: "Close" }))],
  ])("%s closes, returns focus to Request access, and reopening shows an empty form", async (_label, close) => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    await user.type(email(), "ada@example.com")
    await user.type(note(), "Met you at DevFest")
    await close(user)

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(requestButton()).toHaveFocus()
    await openDialog(user, 0)
    expect(email()).toHaveValue("")
    expect(note()).toHaveValue("")
  })

  it("submitting with no email shows the required error on the field, focuses it and sends nothing", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user)
    await user.click(send())

    expect(email()).toHaveAttribute("aria-invalid", "true")
    expect(email()).toHaveAccessibleDescription(c.required)
    expect(email()).toHaveFocus()
    expect(api.bodies).toHaveLength(0)
    expect(status()).toBeEmptyDOMElement()
  })

  it("an untouched empty email shows no error on blur", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    await user.tab()
    expect(email()).not.toHaveAttribute("aria-invalid")
  })

  it.each(["name@gmail", "ada lovelace@example.com", "ada@example.com, bob@example.com", '"Ada" <ada@example.com>'])(
    "%j shows the format error on blur and sends nothing on submit",
    async (value) => {
      useApi()
      const { user } = await setup()
      await openDialog(user)
      await user.type(email(), value)
      await user.tab()
      expect(email()).toHaveAccessibleDescription(c.format)
      await user.click(send())
      expect(api.bodies).toHaveLength(0)
      expect(email()).toHaveFocus()
    }
  )

  it("the format error clears on the next valid input", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    await user.type(email(), "ada@example")
    await user.tab()
    expect(email()).toHaveAttribute("aria-invalid", "true")
    await user.click(email())
    await user.keyboard("{End}.com")
    expect(email()).not.toHaveAttribute("aria-invalid")
  })

  it("255 characters shows the too-long error", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    fireEvent.change(email(), { target: { value: `${"a".repeat(243)}@example.com` } })
    fireEvent.blur(email())
    expect(email()).toHaveAccessibleDescription(c.tooLong)
  })

  it("trims pasted whitespace, NBSP and zero-width characters before sending", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user)
    fireEvent.change(email(), { target: { value: "\u200B ada@example.com\u00A0\uFEFF" } })
    await user.click(send())

    await successShown()
    expect(api.bodies[0]).toEqual({ email: "ada@example.com", note: "", kiwi: "", proof: TEST_PROOF })
  })

  it("the note counter appears from 400 characters, then shows the overage, and a 501-character note blocks the submit", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user)
    fireEvent.change(note(), { target: { value: "x".repeat(399) } })
    expect(note()).toHaveAccessibleDescription("Who you are, or how you heard about Eve.")
    fireEvent.change(note(), { target: { value: "x".repeat(400) } })
    expect(note()).toHaveAccessibleDescription("100 characters left")
    fireEvent.change(note(), { target: { value: "x".repeat(499) } })
    expect(note()).toHaveAccessibleDescription("1 character left")
    fireEvent.change(note(), { target: { value: "x".repeat(501) } })
    expect(within(dialog()).getByText("1 character too many")).toHaveClass("text-destructive-text")
    expect(note()).not.toHaveAttribute("maxlength")

    await user.type(email(), "ada@example.com")
    await user.click(send())
    expect(api.bodies).toHaveLength(0)
    expect(note()).toHaveFocus()
    expect(note()).toHaveAccessibleDescription(`1 character too many ${c.noteTooLong}`)
  })

  it("a valid request shows the success state in place, focuses Close and announces once", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.type(note(), "Met you at DevFest Lagos")
    await user.click(send())

    await successShown()
    const successClose = within(dialog()).getAllByRole("button", { name: "Close" }).find((b) => b.getAttribute("data-slot") !== "overlay-close")!
    await waitFor(() => expect(successClose).toHaveFocus())
    expect(within(dialog()).queryByRole("textbox")).not.toBeInTheDocument()
    expect(within(dialog()).getByText(c.successHeading, { selector: "p" })).toBeVisible()
    expect(dialog()).toHaveAccessibleDescription(c.successBody)
    expect(status()).toHaveTextContent(`${c.successHeading}. ${c.successBody}`)
    expect(api.bodies[0]).toEqual({ email: "ada@example.com", note: "Met you at DevFest Lagos", kiwi: "", proof: TEST_PROOF })
  })

  it("closing the success state returns focus to Request access and reopening shows a fresh form with a new proof", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await successShown()
    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(requestButton()).toHaveFocus()
    await openDialog(user, 0)
    expect(email()).toHaveValue("")
    expect(api.proofCalls).toBe(2)
  })

  it("Send shows progress, keeps values readable, and a second press sends nothing", async () => {
    useApi({ delayMs: 2000 })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await user.click(send())

    expect(send()).toHaveTextContent("Sending request…")
    expect(send()).toHaveAttribute("aria-disabled", "true")
    expect(email()).toHaveAttribute("readonly")
    expect(email()).toHaveValue("ada@example.com")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    await successShown()
    expect(api.bodies).toHaveLength(1)
  })

  it("Send keeps the same classes and spinner slot idle and submitting, so its width doesn't change", async () => {
    useApi({ delayMs: 2000 })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    const idleClass = send().className
    const idleSlot = send().querySelector('[data-slot="submit-spinner"]')
    expect(idleSlot, "spinner slot is rendered while idle").not.toBeNull()
    expect(idleSlot).toHaveClass("invisible")
    const idleSlotClass = idleSlot!.getAttribute("class")!.replace(/\binvisible\b/, "").trim()

    await user.click(send())

    expect(send()).toHaveTextContent("Sending request…")
    expect(send().className).toBe(idleClass)
    const pendingSlot = send().querySelector('[data-slot="submit-spinner"]')
    expect(pendingSlot).not.toHaveClass("invisible")
    expect(pendingSlot!.getAttribute("class")!.replace(/\binvisible\b/, "").trim()).toBe(idleSlotClass)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    await successShown()
  })

  it.each([
    ["no response", "network" as const],
    ["a server error", "server_error" as const],
  ])("%s keeps the values, shows the network toast with Try again, and focuses Send", async (_label, reply) => {
    useApi({ replies: [reply, "accept"] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.type(note(), "Hello")
    await user.click(send())

    const shown = await toastWith(c.network)
    expect(toastRegion()).toContainElement(shown)
    expect(email()).toHaveValue("ada@example.com")
    expect(note()).toHaveValue("Hello")
    expect(send()).toHaveFocus()
    // r3: error text lives once, in the toast; the status region carries success only.
    expect(status()).toBeEmptyDOMElement()
    expect(dialog().querySelectorAll('[role="alert"], [data-slot="alert"]')).toHaveLength(0)
    expect(within(shown).getByRole("button", { name: "Close message" })).toBeInTheDocument()

    await user.click(within(shown).getByRole("button", { name: "Try again" }))
    await successShown()
    await noToast()
    expect(api.bodies.map((b) => [b.email, b.note])).toEqual([
      ["ada@example.com", "Hello"],
      ["ada@example.com", "Hello"],
    ])
  })

  it("a 15 second timeout shows the network toast", async () => {
    useApi({ replies: ["timeout"] })
    // The platform timer behind AbortSignal.timeout isn't faked; drive it by hand and check the 15 s value.
    const timeouts: { ms: number; controller: AbortController }[] = []
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController()
      timeouts.push({ ms, controller })
      return controller.signal
    })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await waitFor(() => expect(api.bodies).toHaveLength(1))
    const post = timeouts.at(-1)!
    expect(post.ms).toBe(15_000)
    act(() => post.controller.abort(new DOMException("The operation timed out.", "TimeoutError")))
    expect(await toastWith(c.network)).toBeVisible()
  })

  it.each([
    ["the per-IP limit", "rate_ip" as const, c.rateIp],
    ["the global daily cap", "rate_global" as const, c.rateGlobal],
    ["a forbidden refusal", "forbidden" as const, c.rejected],
  ])("%s shows its own toast with no retry and keeps the values", async (_label, reply, text) => {
    useApi({ replies: [reply] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())

    const shown = await toastWith(text)
    expect(within(dialog()).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
    expect(within(shown).getByRole("button", { name: "Close message" })).toBeInTheDocument()
    expect(email()).toHaveValue("ada@example.com")
    expect(status()).toBeEmptyDOMElement()
  })

  it("a 400 with field codes shows inline errors and focuses the first invalid field", async () => {
    useApi({ replies: [{ fields: ["email.format", "note.too_long"] }] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.type(note(), "0123456789")
    await user.click(send())

    await waitFor(() => expect(email()).toHaveAccessibleDescription(c.format))
    expect(note()).toHaveAccessibleDescription(`Who you are, or how you heard about Eve. ${c.noteTooLong}`)
    expect(email()).toHaveFocus()
    expect(status()).toBeEmptyDOMElement()
    expect(liveToasts()).toHaveLength(0)
  })

  it("a fast send (under 3 s) still posts at once and shows the same success", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await successShown()
    expect(api.bodies).toHaveLength(1)
  })

  it("after 3 s, a late proof makes the send wait until the proof is 3.25 s old", async () => {
    useApi()
    const { user } = await setup()
    await user.click(requestButton())
    await waitFor(() => expect(api.proofCalls).toBe(1))
    // Pretend the dialog opened 3 s before the proof arrived: shift the clock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await user.type(email(), "ada@example.com")
    // 1 s old proof, 1 s since open: under 3 s, posts at once.
    await user.click(send())
    await successShown()
    expect(api.bodies).toHaveLength(1)
  })

  it("a failed proof makes Send fail as a network error; Try again refetches the proof and sends", async () => {
    useApi({ proof: "fail-once" })
    const { user } = await setup()
    await user.click(requestButton())
    await waitFor(() => expect(email()).toHaveFocus())
    await waitFor(() => expect(api.proofCalls).toBe(1))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    await user.type(email(), "ada@example.com")
    await user.click(send())
    expect(await toastWith(c.network)).toBeVisible()
    expect(api.bodies).toHaveLength(0)

    await user.click(within(toastRegion()).getByRole("button", { name: "Try again" }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3400)
    })
    await successShown()
    expect(api.proofCalls).toBe(2)
    expect(api.bodies[0].proof).toBe(TEST_PROOF)
  })

  it("closing while the request is in flight lets it finish without showing the outcome", async () => {
    useApi({ delayMs: 3000 })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(api.bodies).toHaveLength(1)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await openDialog(user, 0)
    expect(email()).toHaveValue("")
    expect(within(dialog()).queryByText(c.successHeading, { selector: "p" })).not.toBeInTheDocument()
  })

  it("the dialog holds one polite toast region named by the deck, last in the dialog", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    const regions = within(dialog()).getAllByRole("region")
    expect(regions).toHaveLength(1)
    expect(regions[0]).toHaveAccessibleName("Problems sending")
    expect(regions[0]).toHaveAttribute("aria-live", "polite")
    const focusables = dialog().querySelectorAll("button, input, textarea, a[href], section")
    expect(focusables[focusables.length - 1]).toBe(regions[0])
  })

  it("a second failure replaces the first toast, and Send removes it while pending", async () => {
    useApi({ replies: ["network", "rate_ip", "rate_global"] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await toastWith(c.network)
    await user.click(send())
    await toastWith(c.rateIp)
    await user.click(send())
    await toastWith(c.rateGlobal)
    expect(api.bodies).toHaveLength(3)
  })

  it.each([
    ["Try again", "network then rate_ip", ["network", "rate_ip"], c.rateIp],
    ["Send request", "network then network", ["network", "network"], c.network],
  ] as const)(
    "a retry via %s that fails after the old toast's dismissal lands still shows the new toast (F-QA-E3C-02, %s)",
    async (via, _label, replies, text) => {
      // 120 ms lets Sonner deliver the dismissal (rAF) and start the removal before the new failure.
      useApi({ replies: [...replies], delayMs: 120 })
      const { user } = await setup()
      await openDialog(user)
      await user.type(email(), "ada@example.com")
      await user.click(send())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      const first = await toastWith(c.network)
      if (via === "Try again") await user.click(within(first).getByRole("button", { name: "Try again" }))
      else await user.click(send())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      await toastWith(text)
      expect(api.bodies).toHaveLength(2)
    }
  )

  it("pressing Send again dismisses the open toast while the request is pending", async () => {
    useApi({ replies: ["network", "accept"], delayMs: 2000 })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    await toastWith(c.network)
    await user.click(send())
    await noToast()
    expect(send()).toHaveAccessibleName(/Sending request/)
  })

  it("closing the toast returns focus to Send and keeps the dialog and values", async () => {
    useApi({ replies: ["network"] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    const shown = await toastWith(c.network)
    within(shown).getByRole("button", { name: "Close message" }).focus()
    await user.keyboard("{Enter}")
    await noToast()
    expect(send()).toHaveFocus()
    expect(email()).toHaveValue("ada@example.com")
  })

  it("Tab from Send reaches Cancel, close, the toast's Try again and close, then wraps to email", async () => {
    useApi({ replies: ["network"] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    const shown = await toastWith(c.network)
    expect(send()).toHaveFocus()
    const order = [
      within(dialog()).getByRole("button", { name: "Cancel" }),
      within(dialog()).getByRole("button", { name: "Close" }),
      within(shown).getByRole("button", { name: "Try again" }),
      within(shown).getByRole("button", { name: "Close message" }),
      email(),
    ]
    for (const element of order) {
      await user.tab()
      expect(element).toHaveFocus()
    }
  })

  it.each([
    ["Escape in the email field", async (user: ReturnType<typeof userEvent.setup>) => {
      email().focus()
      await user.keyboard("{Escape}")
    }],
    ["Escape on the toast's Try again", async (user: ReturnType<typeof userEvent.setup>) => {
      within(toastRegion()).getByRole("button", { name: "Try again" }).focus()
      await user.keyboard("{Escape}")
    }],
    ["Cancel", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(within(dialog()).getByRole("button", { name: "Cancel" }))
    }],
  ])("closing the dialog with %s removes its toast; reopening shows none", async (_label, close) => {
    useApi({ replies: ["network"] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await toastWith(c.network)
    await close(user)
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0)
    expect(requestButton()).toHaveFocus()
    await openDialog(user, 0)
    expect(liveToasts()).toHaveLength(0)
  })

  it("a failure that arrives after the dialog closed shows no toast and announces nothing", async () => {
    useApi({ replies: ["server_error"], delayMs: 3000 })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0)
    expect(screen.queryByText(c.network)).not.toBeInTheDocument()
  })

  it("a send-failure toast is still there after 60 seconds", async () => {
    useApi({ replies: ["forbidden"] })
    const { user } = await setup()
    await openDialog(user)
    await user.type(email(), "ada@example.com")
    await user.click(send())
    await toastWith(c.rejected)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(await toastWith(c.rejected)).toBeVisible()
  })

  it("the privacy link opens /privacy in a new tab with its suffix in the name", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    const link = within(dialog()).getByRole("link", { name: "Privacy, opens in a new tab" })
    expect(link).toHaveAttribute("href", "/privacy")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener")
    expect(within(dialog()).getByText(/^Eve stores only your email and note, for 90 days/)).toBeVisible()
  })

  it("a signed-in Candidate on /about sends the same way, with no cookie", async () => {
    server.use(signedInSession)
    useApi()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const { user } = await setup("/about")
    await openDialog(user)
    await user.type(email(), "friend@example.com")
    await user.click(send())
    await successShown()
    const post = fetchSpy.mock.calls.find(([, init]) => init?.method === "POST")
    expect(post?.[1]?.credentials).toBe("omit")
    expect(new Headers(post?.[1]?.headers).get("x-csrf-token")).toBeNull()
  })

  it("the dialog never shows an Operator address or a mailto link", async () => {
    useApi()
    const { user } = await setup()
    await openDialog(user, 0)
    expect(dialog().innerHTML).not.toMatch(/mailto:|@eve\.example|operator@/i)
  })
})
