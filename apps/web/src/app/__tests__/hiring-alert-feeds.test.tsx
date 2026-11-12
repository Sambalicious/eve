import { screen, waitFor, within } from "@testing-library/react"
import { defaultScheduler, notifyManager } from "@tanstack/react-query"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import { ALERT_FEED_VERIFICATION_PATH, ALERT_FEEDS_PATH, CSRF_HEADER } from "@eve/contracts"

import {
  HIRING_ALERT_FEEDS_PATH,
  HIRING_FEED_VERIFICATION_PATH,
} from "@/shared/lib/hiring-contracts"
import {
  apiErrorResponse,
  costPause,
  FEED_A,
  HFEED_A,
  HFEED_B,
  ownRecord21Oct,
  server,
  SFEED_A,
  storedFeed,
  storedPost,
  TEST_CSRF_TOKEN,
  verifiedOn20Oct,
} from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openHiringFeeds as openHiring, showTab } from "./hiring-view-helpers"

/**
 * EPIC-0007 Phase 3 web: Hiring alert feeds (design-spec r2 B3, H6, H6b)
 * against the contract fakes. Test names start with the r4 Gherkin
 * `hiring-alert-feeds.feature` line (HAF:n) or `hiring-view.feature` (HV:n).
 * Deck strings (copy-deck.r2.md) are quoted so a copy change fails here.
 */
const MISSING_TITLE = /Confirm above to add feeds\./
const DIALOG_TITLE = "Confirm you may use these feeds"
const DIALOG_HELP =
  "Eve reads these feeds for you. Confirm that you are allowed to use them. Only you see the basis."
const VERIFY_ERR_NET = "Couldn't save your confirmation. Nothing changed. Try again."
const OTHER_LIST_HP = "This feed is already one of your other alert feeds. Remove it there to add it here."
const OTHER_LIST_SP = "This feed is already a hiring alert feed. Remove it there to add it here."
const LIMIT_HP = "The limit is 10 Hiring alert feeds. Remove one to add another."
const FEED_ERR_NET = "Couldn't add the Hiring alert feed. Nothing was saved. Try again."
const REMOVE_ERR_NET = "Couldn't remove the Hiring alert feed. Eve still reads it. Try again."
const FORMAT_ERR = "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/"
const DUP_ERR = "This feed is already registered."
const NOT_VERIFIED_MSG = "Record the permitted-use verification for Google Alerts feeds before registering a feed."
const BASIS = "Read Google's terms for Alerts RSS on 21 Oct."
const FULL_HFEED_DIGITS = "01234567890123456789/5555555555555123456"

const todayWat = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10)
const tomorrowWat = () => new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().slice(0, 10)

type User = ReturnType<typeof openHiring>["user"]

const recorded = (extra: Parameters<typeof openHiring>[0] = {}) =>
  openHiring({ ...extra, stack: { hiringVerification: ownRecord21Oct, ...extra.stack } })

/** The Hiring alert feeds region once its data has loaded (the panel or the recorded line). */
async function hiringFeeds() {
  const region = await screen.findByRole("region", { name: "Hiring alert feeds" })
  await waitFor(() =>
    expect(within(region).queryByText(MISSING_TITLE) ?? within(region).queryByText(/^Confirmed on/)).not.toBeNull()
  )
  return region
}

async function openDialog(user: User, button: "Record permitted use" | RegExp) {
  const region = await hiringFeeds()
  // "Record permitted use" is the first confirmation: the one "I confirm" step at the top of Set up alerts.
  if (button === "Record permitted use") await user.click(screen.getByRole("button", { name: "I confirm" }))
  else await user.click(within(region).getByRole("button", { name: button }))
  const dialog = await screen.findByRole("dialog", { name: DIALOG_TITLE })
  return {
    region,
    dialog,
    date: within(dialog).getByLabelText(/Verification date/) as HTMLInputElement,
    basis: within(dialog).getByLabelText(/Basis for your confirmation/) as HTMLTextAreaElement,
    save: () => user.click(within(dialog).getByRole("button", { name: "I confirm" })),
  }
}

function hiringForm(region: HTMLElement) {
  return {
    url: within(region).getByRole("textbox", { name: "Feed URL" }) as HTMLInputElement,
    label: within(region).getByRole("textbox", { name: "Label (optional)" }) as HTMLInputElement,
    add: () => within(region).getByRole("button", { name: /Add feed|Checking feed…/ }),
  }
}

async function registerHiring(user: User, region: HTMLElement, url: string, label = "") {
  const f = hiringForm(region)
  await user.clear(f.url)
  if (url) await user.type(f.url, url)
  await user.clear(f.label)
  if (label) await user.type(f.label, label)
  await user.click(f.add())
  return f
}

describe("Hiring alert feeds: the not-recorded panel (HAF, AC 6.3, 6.6)", () => {
  it.each([
    ["the shared EPIC-0005 record is recorded", verifiedOn20Oct],
    ["the shared EPIC-0005 record is not recorded", null],
  ])(
    "HAF:319 @ac-6.3 @ac-6.6 with no own record (%s): the confirm step and a plain line, no panel and no form",
    async (_, shared) => {
      const { stack } = openHiring({ stack: { verification: shared } })
      const region = await hiringFeeds()
      expect(within(region).getByText(MISSING_TITLE)).toBeVisible()
      expect(screen.getByText("Eve reads these feeds for you. Confirm that you are allowed to use them.")).toBeVisible()
      const record = screen.getByRole("button", { name: "I confirm" })
      expect(record).toHaveClass("bg-primary")
      expect(within(region).queryByRole("button", { name: "I confirm" })).not.toBeInTheDocument()
      expect(within(region).queryByRole("textbox", { name: "Feed URL" })).not.toBeInTheDocument()
      expect(within(region).queryByText("Your feeds")).not.toBeInTheDocument()
      expect(stack.requestsTo("GET", HIRING_ALERT_FEEDS_PATH)).toHaveLength(1)
    }
  )

  it("HAF:338 @ac-6.3 the section and dialog name no other person and no shared record, and link nowhere in Stack posts", async () => {
    const { user } = openHiring()
    const { region, dialog, basis, save } = await openDialog(user, "Record permitted use")
    const banned = /the person who runs your Eve|Operator|shared with Stack posts|Record it under Stack posts/
    expect(region).not.toHaveTextContent(banned)
    expect(dialog).not.toHaveTextContent(banned)
    await user.type(basis, BASIS)
    await save()
    await findToast("Confirmation saved.")
    await user.click(within(region).getByRole("button", { name: "Update your confirmation for hiring alert feeds" }))
    const update = await screen.findByRole("dialog", { name: DIALOG_TITLE })
    expect(update).not.toHaveTextContent(banned)
    expect(region).not.toHaveTextContent(banned)
    for (const link of within(region).queryAllByRole("link")) expect(link.getAttribute("href") ?? "").not.toMatch(/alert-feeds|^\/stack-posts(#|$)/)
  })

  it("HAF:357 @ac-6.3 the response has exactly verification, feeds, limit and (r2 OWN-1) globalPaused; the panel has no role variant", async () => {
    const { stack } = openHiring()
    await hiringFeeds()
    expect(screen.getByRole("button", { name: "I confirm" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "I confirm" })).not.toHaveAttribute("aria-disabled")
    expect(stack.state.hiringVerification).toBeNull()
    const res = await fetch(new URL(HIRING_ALERT_FEEDS_PATH, window.location.origin))
    expect(Object.keys((await res.json()) as object).sort()).toEqual(["feeds", "globalPaused", "limit", "verification"]) // r2 OWN-1
  })

  it("HAF:722 @ac-6.3 the Operator's shared EPIC-0005 record is not copied: she still sees the not-recorded panel", async () => {
    openHiring({ stack: { verification: verifiedOn20Oct } })
    const region = await hiringFeeds()
    expect(within(region).getByText(MISSING_TITLE)).toBeVisible()
  })
})

describe("Hiring alert feeds: record and update her own permitted use (HAF, AC 6.6)", () => {
  it("HAF:367 'Record permitted use' opens the dialog empty: title, help, today's date, empty basis, no delete action", async () => {
    const { user } = openHiring()
    const { dialog, date, basis } = await openDialog(user, "Record permitted use")
    expect(within(dialog).getByRole("heading", { name: DIALOG_TITLE })).toBeInTheDocument()
    expect(within(dialog).getByText(DIALOG_HELP)).toBeVisible()
    expect(date).toHaveValue(todayWat())
    expect(date).toHaveAttribute("max", todayWat())
    expect(basis).toHaveValue("")
    expect(within(dialog).getByRole("button", { name: "I confirm" })).toHaveAttribute("type", "submit")
    expect(within(dialog).queryByRole("button", { name: /delete|clear|remove/i })).not.toBeInTheDocument()
    // OverlayHeader (design-spec r2 OQ5): title and close in one header row.
    const header = dialog.querySelector('[data-slot="overlay-header"]') as HTMLElement
    expect(within(header).getByRole("heading", { name: DIALOG_TITLE })).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument()
  })

  it("HAF:379 / HP:381 any Candidate records her own permitted use: PUT with CSRF, toast, recorded line, form, focus to Feed URL", async () => {
    const { user, stack } = openHiring()
    await showTab("Hiring posts")
    const posts = await screen.findByRole("region", { name: "Hiring posts" })
    expect(await within(posts).findByText("Hiring posts appear here once you set up job alerts. You can also use the Search tab.")).toBeVisible()
    await showTab("Set up alerts")
    const { region, date, basis, save } = await openDialog(user, "Record permitted use")
    await user.clear(date)
    await user.type(date, "2026-10-21")
    await user.type(basis, BASIS)
    await save()

    const toast = await findToast("Confirmation saved.")
    expect(toast).not.toHaveTextContent(BASIS)
    const [put] = stack.requestsTo("PUT", HIRING_FEED_VERIFICATION_PATH)
    expect(put.body).toEqual({ verifiedOn: "2026-10-21", verificationBasis: BASIS })
    expect(await within(region).findByText("Confirmed on 21 Oct 2026")).toBeVisible()
    expect(within(region).getByText("Your feeds")).toBeVisible()
    expect(within(region).getByText("0 of 10")).toBeVisible()
    // R5: after the one confirmation, focus goes to the first Feed URL field on the page (the Alert feeds one).
    await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Feed URL" })[0]).toHaveFocus())
    // R5: one confirmation covers both lists.
    expect(stack.state.verification).not.toBeNull()
  })

  it("P3-G-06 HAF:379 focus reaches Feed URL even when the recorded branch renders after the next animation frame", async () => {
    // In Chromium the React Query cache notification (setTimeout 0) can land after
    // the next animation frame (qa-gate.r1 B). Delay it past a frame to pin that order.
    const { user } = openHiring()
    const { region, basis, save } = await openDialog(user, "Record permitted use")
    await user.type(basis, BASIS)
    notifyManager.setScheduler((callback) => setTimeout(callback, 40))
    try {
      await save()
      expect(await within(region).findByText(/^Confirmed on/)).toBeVisible()
      // R5: after the one confirmation, focus goes to the first Feed URL field on the page (the Alert feeds one).
    await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Feed URL" })[0]).toHaveFocus())
      // Focus stays there once the dialog's exit and every refetch have settled.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(screen.getAllByRole("textbox", { name: "Feed URL" })[0]).toHaveFocus()
    } finally {
      notifyManager.setScheduler(defaultScheduler)
    }
  }, 20_000)

  it("HAF:346 with her own record: the date line, an outline Update with its accessible name, the form; the basis is not on the page", async () => {
    recorded()
    const region = await hiringFeeds()
    expect(within(region).getByText("Confirmed on 21 Oct 2026")).toBeVisible()
    const update = within(region).getByRole("button", { name: "Update your confirmation for hiring alert feeds" })
    expect(update).toHaveTextContent(/^Update$/)
    expect(update).toHaveClass("border-border", "bg-background")
    expect(document.body).not.toHaveTextContent(BASIS)
    expect(within(region).getByRole("textbox", { name: "Feed URL" })).toBeVisible()
    expect(within(region).queryByText(MISSING_TITLE)).not.toBeInTheDocument()
  })

  it("HAF:391 'Update' opens the dialog pre-filled with her own record", async () => {
    const { user } = recorded()
    const { dialog, date, basis } = await openDialog(user, /^Update your confirmation/)
    expect(date).toHaveValue("2026-10-21")
    expect(basis).toHaveValue(BASIS)
    expect(within(dialog).getByRole("button", { name: "I confirm" })).toBeVisible()
  })

  it.each([
    ["Record permitted use", undefined],
    ["Update", ownRecord21Oct],
  ] as const)(
    "P3-B-1 design-spec r2 H6b step 1 / (r2) a11y: '%s' opens the dialog with focus on the date field, not Close",
    async (_, own) => {
      const { user } = openHiring({ stack: own ? { hiringVerification: own } : {} })
      const { dialog, date } = await openDialog(user, own ? /^Update your confirmation/ : "Record permitted use")
      await waitFor(() => expect(date).toHaveFocus())
      expect(within(dialog).getByRole("button", { name: "Close" })).not.toHaveFocus()
    }
  )

  it("HAF:400 / HAF:411 a save from Update replaces her record, keeps her feeds and returns focus to Update", async () => {
    const { user, stack } = recorded({
      stack: { hiringFeeds: [storedFeed({ url: HFEED_A, label: "Frontend hiring" }), storedFeed({ url: HFEED_B, label: "Backend hiring" })] },
    })
    const { region, date, basis, save } = await openDialog(user, /^Update your confirmation/)
    await user.clear(date)
    await user.type(date, todayWat())
    await user.clear(basis)
    await user.type(basis, "Re-read the Alerts terms on 24 Oct.")
    await save()
    await findToast("Confirmation saved.")
    expect(stack.requestsTo("PUT", HIRING_FEED_VERIFICATION_PATH)).toHaveLength(1)
    expect(stack.state.hiringVerification?.verificationBasis).toBe("Re-read the Alerts terms on 24 Oct.")
    await waitFor(() =>
      expect(within(region).getByRole("button", { name: "Update your confirmation for hiring alert feeds" })).toHaveFocus()
    )
    expect(within(region).getByText("2 of 10")).toBeVisible()
    expect(within(region).getByRole("listitem", { name: /^Frontend hiring/ })).toBeVisible()
  })

  it("HAF:418 Cancel discards edits, sends nothing and returns focus to Update", async () => {
    const { user, stack } = recorded()
    const { region, dialog, basis } = await openDialog(user, /^Update your confirmation/)
    await user.clear(basis)
    await user.type(basis, "Something else")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(stack.requestsTo("PUT", HIRING_FEED_VERIFICATION_PATH)).toEqual([])
    await waitFor(() =>
      expect(within(region).getByRole("button", { name: "Update your confirmation for hiring alert feeds" })).toHaveFocus()
    )
    await user.click(within(region).getByRole("button", { name: /^Update your confirmation/ }))
    expect(within(await screen.findByRole("dialog")).getByLabelText(/Basis for your confirmation/)).toHaveValue(BASIS)
  })

  it("Escape closes the record dialog without saving and returns focus to 'I confirm'", async () => {
    const { user, stack } = openHiring()
    await openDialog(user, "Record permitted use")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole("button", { name: "I confirm" })).toHaveFocus())
    expect(stack.requestsTo("PUT", HIRING_FEED_VERIFICATION_PATH)).toEqual([])
  })

  it.each([
    ["(empty)", "", "Read Google's terms.", "Enter the verification date.", /Verification date/],
    ["tomorrow", "tomorrow", "Read Google's terms.", "Enter today or an earlier date.", /Verification date/],
    ["empty basis", "2026-10-21", "", "Enter the basis for your confirmation.", /Basis for your confirmation/],
    ["spaces only", "2026-10-21", "   ", "Enter the basis for your confirmation.", /Basis for your confirmation/],
    ["501 characters", "2026-10-21", "a".repeat(501), "Use 500 characters or fewer.", /Basis for your confirmation/],
    [
      "a bidi control",
      "2026-10-21",
      "Read\u202Eterms",
      "The basis has hidden characters Eve can't save. Type it again or paste it as plain text.",
      /Basis for your confirmation/,
    ],
  ])("HAF:427 a refused field (%s) shows its error, focuses it, keeps the input and saves nothing", async (_, dateIn, basisIn, message, field) => {
    const { user, stack } = openHiring()
    const { dialog, date, basis, save } = await openDialog(user, "Record permitted use")
    const dateValue = dateIn === "tomorrow" ? tomorrowWat() : dateIn
    await user.clear(date)
    if (dateValue) await user.type(date, dateValue)
    if (basisIn) {
      await user.click(basis)
      await user.paste(basisIn)
    }
    await save()
    expect(await within(dialog).findByText(message)).toBeVisible()
    await waitFor(() => expect(within(dialog).getByLabelText(field)).toHaveFocus())
    expect(date).toHaveValue(dateValue)
    expect(basis).toHaveValue(basisIn)
    expect(stack.requestsTo("PUT", HIRING_FEED_VERIFICATION_PATH)).toEqual([])
    expect(stack.state.hiringVerification).toBeNull()
  })

  it("HAF:472 every field error from the API is shown at once and focus goes to the date", async () => {
    const { user } = openHiring()
    server.use(
      http.put(HIRING_FEED_VERIFICATION_PATH, () =>
        HttpResponse.json(
          {
            error: {
              code: "bad_request",
              message: "The request is not valid.",
              fieldErrors: [
                { field: "verifiedOn", position: null, problem: "future_date" },
                { field: "verificationBasis", position: null, problem: "missing" },
              ],
            },
          },
          { status: 400 }
        )
      )
    )
    const { dialog, basis, save } = await openDialog(user, "Record permitted use")
    await user.type(basis, "Read terms.")
    await save()
    expect(await within(dialog).findByText("Enter today or an earlier date.")).toBeVisible()
    expect(within(dialog).getByText("Enter the basis for your confirmation.")).toBeVisible()
    await waitFor(() => expect(within(dialog).getByLabelText(/Verification date/)).toHaveFocus())
  })

  it("HAF:525 a network failure shows C-HP-VERIFY-ERR-NET, focuses it, keeps the input and the panel", async () => {
    const { user } = openHiring()
    server.use(http.put(HIRING_FEED_VERIFICATION_PATH, () => HttpResponse.error()))
    const { region, dialog, date, basis, save } = await openDialog(user, "Record permitted use")
    await user.clear(date)
    await user.type(date, "2026-10-21")
    await user.type(basis, "Read terms.")
    await save()
    const alert = await within(dialog).findByRole("alert")
    expect(alert).toHaveTextContent(VERIFY_ERR_NET)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(date).toHaveValue("2026-10-21")
    expect(basis).toHaveValue("Read terms.")
    expect(within(region).getByText(MISSING_TITLE)).toBeVisible()
  })

  it.each([
    ["500 internal_error", () => apiErrorResponse("internal_error"), VERIFY_ERR_NET],
    [
      "a 4xx with a message",
      () => HttpResponse.json({ error: { code: "bad_request", message: "Something is wrong." } }, { status: 400 }),
      "Something is wrong.",
    ],
    ["a 4xx without a message", () => HttpResponse.json({ error: { code: "bad_request", message: "" } }, { status: 400 }), VERIFY_ERR_NET],
  ])("HAF:535 a failed save (%s) shows the right message and keeps the input", async (_, reply, message) => {
    const { user, stack } = recorded()
    server.use(http.put(HIRING_FEED_VERIFICATION_PATH, reply))
    const { dialog, basis, save } = await openDialog(user, /^Update your confirmation/)
    await user.clear(basis)
    await user.type(basis, "Read the terms again.")
    await save()
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message)
    expect(basis).toHaveValue("Read the terms again.")
    expect(stack.state.hiringVerification?.verificationBasis).toBe(BASIS)
  })

  it("HV:135 / HAF:550 the save sends the session's CSRF token; a csrf_invalid refusal shows the API message", async () => {
    const { user, stack } = openHiring()
    const headers: (string | null)[] = []
    server.use(
      http.put(HIRING_FEED_VERIFICATION_PATH, ({ request }) => {
        headers.push(request.headers.get(CSRF_HEADER))
        return apiErrorResponse("csrf_invalid")
      })
    )
    const { dialog, basis, save } = await openDialog(user, "Record permitted use")
    await user.type(basis, "Read terms.")
    await save()
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The request is missing a valid CSRF token.")
    expect(headers).toEqual([TEST_CSRF_TOKEN])
    expect(stack.state.hiringVerification).toBeNull()
  })

  it.each([
    ["the global pause", { globalPaused: true }],
    ["the cost-ceiling pause", { costPause: costPause() }],
  ])("HAF:593 the save works during %s and the dialog shows no pause note", async (_, controls) => {
    const { user } = openHiring({ controls })
    const { dialog, basis, save } = await openDialog(user, "Record permitted use")
    expect(dialog).not.toHaveTextContent(/paused/i)
    await user.type(basis, "Read terms.")
    await save()
    expect(await findToast("Confirmation saved.")).toBeInTheDocument()
  })

  it("HAF:606 recording then updating sends only the two PUTs to the Eve API and nothing else outbound", async () => {
    const { user, stack } = openHiring()
    const { basis, save } = await openDialog(user, "Record permitted use")
    await user.type(basis, "Read terms.")
    await save()
    await findToast("Confirmation saved.")
    const update = await openDialog(user, /^Update your confirmation/)
    await update.save()
    await waitFor(() => expect(stack.requestsTo("PUT", HIRING_FEED_VERIFICATION_PATH)).toHaveLength(2))
    // The first confirmation records both lists (two PUTs), the update only the Hiring list (one more).
    expect(stack.requests.filter((r) => r.method !== "GET").map((r) => r.path).sort()).toEqual(
      [ALERT_FEED_VERIFICATION_PATH, HIRING_FEED_VERIFICATION_PATH, HIRING_FEED_VERIFICATION_PATH].sort()
    )
  })
})

describe("Hiring alert feeds: registration (HAF, AC 6.1, 6.2, 6.4)", () => {
  it("HAF:52 / HV:159 registers with a label: outline Add feed, POST with CSRF, toast C-HP-FEED-ADDED, row listed", async () => {
    const { user, stack } = recorded()
    const region = await hiringFeeds()
    expect(hiringForm(region).add()).toHaveClass("border-border", "bg-background")
    expect(within(region).getByText("The feed link from your Google Alert. The search behind it is in Hiring search links.")).toBeVisible()
    expect(within(region).getByText("No hiring alert feeds yet. Add one to see hiring posts.")).toBeVisible()
    await registerHiring(user, region, HFEED_A, "Frontend hiring")
    expect(await findToast("Hiring alert feed added.")).toBeInTheDocument()
    expect(await within(region).findByRole("listitem", { name: "Frontend hiring, feed ending 1 2 3 4 5 6" })).toBeVisible()
    expect(stack.requestsTo("POST", HIRING_ALERT_FEEDS_PATH)).toEqual([
      { method: "POST", path: HIRING_ALERT_FEEDS_PATH, body: { url: HFEED_A, label: "Frontend hiring" } },
    ])
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toEqual([])
    expect(within(region).getByText("1 of 10")).toBeVisible()
  })

  it("HAF:79 a feed with no label is listed as 'Hiring alert feed' followed by …123456", async () => {
    const { user } = recorded()
    const region = await hiringFeeds()
    await registerHiring(user, region, HFEED_A)
    const row = await within(region).findByRole("listitem", { name: "Hiring alert feed, feed ending 1 2 3 4 5 6" })
    expect(row).toHaveTextContent("Hiring alert feed")
    expect(row).toHaveTextContent("…123456")
  })

  it("HAF:62 / HAF:71 each list shows only its own feeds", async () => {
    recorded({
      path: "/find-jobs#set-up-alerts",
      stack: {
        verification: verifiedOn20Oct,
        feeds: [storedFeed({ url: SFEED_A, label: "React posts" })],
        hiringFeeds: [storedFeed({ url: HFEED_A, label: "Frontend hiring" })],
      },
    })
    const stackFeeds = await screen.findByRole("region", { name: "Alert feeds" })
    expect(await within(stackFeeds).findByRole("listitem", { name: /^React posts/ })).toBeVisible()
    expect(within(stackFeeds).queryByText("Frontend hiring")).not.toBeInTheDocument()
    expect(within(stackFeeds).getByText("1 of 10")).toBeVisible()
    const region = await hiringFeeds()
    expect(within(region).getByRole("listitem", { name: /^Frontend hiring/ })).toBeVisible()
    expect(within(region).queryByText("React posts")).not.toBeInTheDocument()
  })

  it("HAF:99 / HAF:152 a URL in the Stack posts list (typed with spaces) is refused with C-HP-FEED-ERR-OTHER-LIST; input kept, focus on URL", async () => {
    const { user, stack } = recorded({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ url: SFEED_A })] } })
    const region = await hiringFeeds()
    const f = await registerHiring(user, region, `  ${SFEED_A}  `, "Hiring")
    const message = await within(region).findByText(OTHER_LIST_HP)
    expect(f.url).toHaveAttribute("aria-invalid", "true")
    expect(f.url.getAttribute("aria-describedby")).toContain(message.id)
    await waitFor(() => expect(f.url).toHaveFocus())
    // jsdom sanitises a type=url value (strips surrounding spaces); the sent body below proves the trim.
    expect(f.url.value.trim()).toBe(SFEED_A)
    expect(f.label).toHaveValue("Hiring")
    expect(screen.queryByText(OTHER_LIST_SP)).not.toBeInTheDocument()
    expect(stack.state.hiringFeeds).toEqual([])
    expect(stack.requestsTo("POST", HIRING_ALERT_FEEDS_PATH)[0].body).toEqual({ url: SFEED_A, label: "Hiring" })
  })

  it("HAF:160 after removing a Stack posts Alert feed its URL can be registered as a Hiring alert feed", async () => {
    const { user } = recorded({ stack: { verification: verifiedOn20Oct, feeds: [] } })
    const region = await hiringFeeds()
    await registerHiring(user, region, SFEED_A, "Was a Stack feed")
    expect(await within(region).findByRole("listitem", { name: /^Was a Stack feed/ })).toBeVisible()
  })

  it.each([
    [
      "her own record, 10 feeds, one HFEED_A",
      { hiringFeeds: Array.from({ length: 10 }, (_, i) => storedFeed({ url: i === 0 ? HFEED_A : `${HFEED_B.slice(0, -1)}${i}` })) },
      HFEED_A,
      LIMIT_HP,
    ],
    [
      "her own record, 10 feeds and SFEED_A in Stack posts",
      {
        hiringFeeds: Array.from({ length: 10 }, (_, i) => storedFeed({ url: `${HFEED_B.slice(0, -1)}${i}` })),
        feeds: [storedFeed({ url: SFEED_A })],
      },
      SFEED_A,
      LIMIT_HP,
    ],
    [
      "HFEED_A in both lists",
      { hiringFeeds: [storedFeed({ url: HFEED_A })], feeds: [storedFeed({ url: HFEED_A })] },
      HFEED_A,
      DUP_ERR,
    ],
    ["SFEED_A in Stack posts", { feeds: [storedFeed({ url: SFEED_A })] }, SFEED_A, OTHER_LIST_HP],
  ])("HAF:203 the first refusal in check order wins (%s)", async (_, state, url, message) => {
    const { user, stack } = recorded({ stack: { verification: verifiedOn20Oct, ...state } })
    const region = await hiringFeeds()
    const before = stack.state.hiringFeeds.length
    // At 10 the client check refuses before sending, with the same line (HAF:266).
    await registerHiring(user, region, url)
    expect(await within(region).findByText(message)).toBeVisible()
    expect(stack.state.hiringFeeds).toHaveLength(before)
  })

  it("HAF:266 an 11th feed shows C-HP-FEED-ERR-LIMIT before anything is sent; the form stays usable", async () => {
    const feeds = Array.from({ length: 10 }, (_, i) => storedFeed({ url: `${HFEED_B.slice(0, -1)}${i}`, label: `Feed ${i}` }))
    const { user, stack } = recorded({ stack: { hiringFeeds: feeds } })
    const region = await hiringFeeds()
    expect(within(region).getByText("10 of 10")).toBeVisible()
    const f = await registerHiring(user, region, HFEED_A)
    expect(await within(region).findByText(LIMIT_HP)).toBeVisible()
    expect(stack.requestsTo("POST", HIRING_ALERT_FEEDS_PATH)).toEqual([])
    expect(f.add()).toBeEnabled()
    expect(stack.state.hiringFeeds).toHaveLength(10)
  })

  it("HAF:307 a server limit_reached shows C-HP-FEED-ERR-LIMIT", async () => {
    const { user } = recorded({ stack: { hiringFeeds: Array.from({ length: 9 }, (_, i) => storedFeed({ url: `${HFEED_B.slice(0, -1)}${i}` })) } })
    server.use(
      http.post(HIRING_ALERT_FEEDS_PATH, () =>
        HttpResponse.json(
          { error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "url", position: null, problem: "limit_reached" }] } },
          { status: 400 }
        )
      )
    )
    const region = await hiringFeeds()
    await registerHiring(user, region, HFEED_A)
    expect(await within(region).findByText(LIMIT_HP)).toBeVisible()
  })

  it("HAF:259 / HAF:275 the 10th Hiring feed is accepted while 10 Stack posts feeds exist", async () => {
    const { user } = recorded({
      stack: {
        verification: verifiedOn20Oct,
        feeds: Array.from({ length: 10 }, (_, i) => storedFeed({ url: `${FEED_A.slice(0, -1)}${i}` })),
        hiringFeeds: Array.from({ length: 9 }, (_, i) => storedFeed({ url: `${HFEED_B.slice(0, -1)}${i}`, label: `Feed ${i}` })),
      },
    })
    const region = await hiringFeeds()
    await registerHiring(user, region, HFEED_A, "Tenth")
    await findToast("Hiring alert feed added.")
    expect(await within(region).findByText("10 of 10")).toBeVisible()
  })

  it.each([
    "http://www.google.com/alerts/feeds/0123/4567",
    "https://google.com/alerts/feeds/0123/4567",
    "https://www.google.com/alerts/feeds/0123",
    "https://www.google.com/alerts/feeds/0123/4567/extra",
    "https://www.google.com/alerts/feeds/0123/45a7",
    "https://www.google.com/search?q=site:linkedin.com/posts",
    "https://www.google.com/search?q=hiring",
    "https://www.linkedin.com/search/results/content/?keywords=hiring",
    "https://www.google.com/alerts/feeds/0123/4567?x=1",
  ])("HAF:811 %s is refused with the EPIC-0005 format error before any request", async (url) => {
    const { user, stack } = recorded()
    const region = await hiringFeeds()
    await registerHiring(user, region, url)
    expect(await within(region).findByText(FORMAT_ERR)).toBeVisible()
    expect(stack.requestsTo("POST", HIRING_ALERT_FEEDS_PATH)).toEqual([])
  })

  it.each([
    ["60 characters", "a".repeat(60), { label: "a".repeat(60) }],
    ["61 characters", "a".repeat(61), "Use 60 characters or fewer."],
    ["spaces only", "   ", { label: null }],
    ["surrounding spaces", "  Frontend hiring  ", { label: "Frontend hiring" }],
    ["a tab", "Hiring\tposts", "The label has a tab or hidden character. Type it again."],
  ] as const)("HAF:831 the label follows the EPIC-0005 rules (%s)", async (_, label, result) => {
    const { user, stack } = recorded()
    const region = await hiringFeeds()
    const f = hiringForm(region)
    await user.type(f.url, HFEED_A)
    await user.click(f.label)
    await user.paste(label)
    await user.click(f.add())
    if (typeof result === "string") {
      expect(await within(region).findByText(result)).toBeVisible()
      expect(stack.requestsTo("POST", HIRING_ALERT_FEEDS_PATH)).toEqual([])
    } else {
      await findToast("Hiring alert feed added.")
      expect(stack.requestsTo("POST", HIRING_ALERT_FEEDS_PATH)[0].body).toEqual({ url: HFEED_A, ...result })
    }
  })

  it("HAF:847 a URL already in her Hiring list is refused with the EPIC-0005 duplicate message", async () => {
    const { user } = recorded({ stack: { hiringFeeds: [storedFeed({ url: HFEED_A })] } })
    const region = await hiringFeeds()
    await registerHiring(user, region, HFEED_A)
    expect(await within(region).findByText(DUP_ERR)).toBeVisible()
  })

  it("HAF:855 double-submitting sends one registration", async () => {
    const { user, stack } = recorded()
    const region = await hiringFeeds()
    const f = hiringForm(region)
    await user.type(f.url, HFEED_A)
    await user.dblClick(f.add())
    await findToast("Hiring alert feed added.")
    expect(stack.requestsTo("POST", HIRING_ALERT_FEEDS_PATH)).toHaveLength(1)
    expect(stack.state.hiringFeeds).toHaveLength(1)
  })

  it.each([
    ["not_reachable", "Not reachable. Eve couldn't connect to Google. Nothing was saved. Try again shortly."],
    ["timed_out", "Timed out. Google didn't answer in time. Nothing was saved. Try again."],
  ] as const)("HAF:863 a failing fetch (%s) shows the EPIC-0005 reason and stores nothing", async (reason, message) => {
    const { user, stack } = recorded({ stack: { hiringRegistrationFetch: reason } })
    const region = await hiringFeeds()
    await registerHiring(user, region, HFEED_A)
    expect(await within(region).findByText(message, { exact: false })).toBeVisible()
    expect(stack.state.hiringFeeds).toEqual([])
    expect(stack.state.hiringPosts).toEqual([])
  })

  it("HV:185 a network failure shows C-HP-FEED-ERR-NET in the form alert, focuses it and keeps the input", async () => {
    const { user } = recorded()
    server.use(http.post(HIRING_ALERT_FEEDS_PATH, () => HttpResponse.error()))
    const region = await hiringFeeds()
    const f = await registerHiring(user, region, HFEED_A, "Hiring")
    const alert = await within(region).findByRole("alert")
    expect(alert).toHaveTextContent(FEED_ERR_NET)
    expect(alert).not.toHaveTextContent(/^Couldn't add the Alert feed/)
    expect(f.url).toHaveValue(HFEED_A)
    expect(f.label).toHaveValue("Hiring")
  })

  it("HV:172 a refused registration shows the API's message and keeps the input", async () => {
    const { user } = recorded()
    server.use(
      http.post(HIRING_ALERT_FEEDS_PATH, () =>
        HttpResponse.json({ error: { code: "bad_request", message: "Something is wrong." } }, { status: 403 })
      )
    )
    const region = await hiringFeeds()
    const f = await registerHiring(user, region, "https://www.google.com/alerts/feeds/123/456", "Hiring")
    expect(await within(region).findByText("Something is wrong.")).toBeVisible()
    expect(f.url).toHaveValue("https://www.google.com/alerts/feeds/123/456")
    expect(f.label).toHaveValue("Hiring")
  })

  it("HAF:643 a stale page: the 409 shows the API message, keeps HFEED_A, re-reads the list, then shows the panel", async () => {
    const { user, stack } = recorded()
    const region = await hiringFeeds()
    stack.state.hiringVerification = null
    const f = await registerHiring(user, region, HFEED_A)
    expect(await within(region).findByText(NOT_VERIFIED_MSG)).toBeVisible()
    expect(f.url).toHaveValue(HFEED_A)
    expect(await within(region).findByText(MISSING_TITLE)).toBeVisible()
    expect(within(region).queryByRole("textbox", { name: "Feed URL" })).not.toBeInTheDocument()
    expect(stack.requestsTo("GET", HIRING_ALERT_FEEDS_PATH).length).toBeGreaterThanOrEqual(2)
  })

  it("HAF:979 / HAF:987 the full URL never appears on the page after registration", async () => {
    const { user } = recorded()
    const region = await hiringFeeds()
    await registerHiring(user, region, HFEED_A, "Frontend hiring")
    await within(region).findByRole("listitem", { name: /^Frontend hiring/ })
    expect(hiringForm(region).url).toHaveValue("")
    expect(document.body.innerHTML).not.toContain(FULL_HFEED_DIGITS)
  })

  it("HAF:961 during the global pause the section shows C-HP-PAUSED and still allows registration", async () => {
    const { user } = recorded({ controls: { globalPaused: true } })
    const region = await hiringFeeds()
    expect(
      within(region).getByText(
        "Scheduled reads are paused. You can still add feeds. Reads restart at the next scheduled time after automation resumes."
      )
    ).toBeVisible()
    await registerHiring(user, region, HFEED_A)
    expect(await findToast("Hiring alert feed added.")).toBeInTheDocument()
  })
})

describe("Hiring alert feeds: removal (HAF:916, AC 6.4)", () => {
  it("HAF:916 / HV:159 remove: confirm names the feed, toast C-HP-REMOVE-DONE, its posts show 'Removed feed'", async () => {
    const feed = storedFeed({ url: HFEED_A, label: "Frontend hiring" })
    const { user, stack } = recorded({
      stack: { hiringFeeds: [feed], hiringPosts: [1, 2, 3].map((n) => storedPost({ feedId: feed.id, title: `Hiring ${n}` })) },
    })
    const region = await hiringFeeds()
    await showTab("Hiring posts")
    const posts = await screen.findByRole("region", { name: "Hiring posts" })
    expect(await within(posts).findAllByText("from Frontend hiring")).toHaveLength(3)
    await showTab("Set up alerts")
    await user.click(within(region).getByRole("button", { name: "Remove Frontend hiring, feed ending 1 2 3 4 5 6" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Remove this Hiring alert feed?" })
    expect(dialog).toHaveTextContent(
      "Eve stops reading Frontend hiring …123456 now. Its posts stay until they age out. Adding it back needs its RSS link from Google Alerts."
    )
    await user.click(within(dialog).getByRole("button", { name: "Remove feed" }))
    expect(await findToast("Hiring alert feed removed.")).toBeInTheDocument()
    expect(stack.requestsTo("DELETE", HIRING_ALERT_FEEDS_PATH)).toEqual([
      { method: "DELETE", path: `${HIRING_ALERT_FEEDS_PATH}/${feed.id}`, body: null },
    ])
    await waitFor(() => expect(within(posts).getAllByText("Removed feed")).toHaveLength(3))
    // R5: after the one confirmation, focus goes to the first Feed URL field on the page (the Alert feeds one).
    await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Feed URL" })[0]).toHaveFocus())
  })

  it("HAF:925 removing a feed already removed in another tab (204) removes nothing else", async () => {
    const a = storedFeed({ url: HFEED_A, label: "Frontend hiring" })
    const b = storedFeed({ url: HFEED_B, label: "Backend hiring" })
    const { user, stack } = recorded({ stack: { hiringFeeds: [a, b] } })
    const region = await hiringFeeds()
    stack.state.hiringFeeds = [b]
    await user.click(within(region).getByRole("button", { name: /^Remove Frontend hiring/ }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove feed" }))
    await findToast("Hiring alert feed removed.")
    await waitFor(() => expect(within(region).queryByRole("listitem", { name: /^Frontend hiring/ })).not.toBeInTheDocument())
    expect(within(region).getByRole("listitem", { name: /^Backend hiring/ })).toBeVisible()
  })

  it("C-HP-REMOVE-ERR-NET: a network failure keeps the dialog and the row and shows the Hiring line", async () => {
    const feed = storedFeed({ url: HFEED_A, label: "Frontend hiring" })
    const { user } = recorded({ stack: { hiringFeeds: [feed] } })
    server.use(http.delete(`${HIRING_ALERT_FEEDS_PATH}/:id`, () => HttpResponse.error()))
    const region = await hiringFeeds()
    await user.click(within(region).getByRole("button", { name: /^Remove Frontend hiring/ }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Remove feed" }))
    expect(await within(dialog).findByText(REMOVE_ERR_NET)).toBeVisible()
    // The modal hides the page from the accessibility tree while open.
    expect(within(region).getByRole("listitem", { name: /^Frontend hiring/, hidden: true })).toBeInTheDocument()
  })
})

describe("Stack posts form: in_other_list (HAF:110, HAF:121, HAF:133, HAF:142)", () => {
  it("HAF:110 / HAF:121 a URL in the Hiring list shows C-SP-FEED-ERR-OTHER-LIST where the duplicate error goes; input kept, focus on URL", async () => {
    const { user, stack } = recorded({
      path: "/find-jobs#set-up-alerts",
      stack: { verification: verifiedOn20Oct, hiringFeeds: [storedFeed({ url: HFEED_A })] },
    })
    const feeds = await screen.findByRole("region", { name: "Alert feeds" })
    const url = (await within(feeds).findByRole("textbox", { name: "Feed URL" })) as HTMLInputElement
    const label = within(feeds).getByRole("textbox", { name: "Label (optional)" }) as HTMLInputElement
    await user.type(url, HFEED_A)
    await user.type(label, "React posts")
    await user.click(within(feeds).getByRole("button", { name: "Add feed" }))
    const message = await within(feeds).findByText(OTHER_LIST_SP)
    expect(url.getAttribute("aria-describedby")).toContain(message.id)
    expect(url).toHaveAttribute("aria-invalid", "true")
    await waitFor(() => expect(url).toHaveFocus())
    expect(url).toHaveValue(HFEED_A)
    expect(label).toHaveValue("React posts")
    expect(screen.queryByText(OTHER_LIST_HP)).not.toBeInTheDocument()
    expect(stack.state.feeds).toEqual([])
  })

  it("HAF:133 the Stack posts cross-list check uses the trimmed URL", async () => {
    const { user } = recorded({
      path: "/find-jobs#set-up-alerts",
      stack: { verification: verifiedOn20Oct, hiringFeeds: [storedFeed({ url: HFEED_A })] },
    })
    const feeds = await screen.findByRole("region", { name: "Alert feeds" })
    await user.type(await within(feeds).findByRole("textbox", { name: "Feed URL" }), `  ${HFEED_A}  `)
    await user.click(within(feeds).getByRole("button", { name: "Add feed" }))
    expect(await within(feeds).findByText(OTHER_LIST_SP)).toBeVisible()
  })

  it("HAF:142 a Stack posts registration in no other list behaves as EPIC-0005 (filled Add feed, toast), with no other-list line", async () => {
    const { user } = recorded({ path: "/find-jobs#set-up-alerts", stack: { verification: verifiedOn20Oct } })
    const feeds = await screen.findByRole("region", { name: "Alert feeds" })
    await user.type(await within(feeds).findByRole("textbox", { name: "Feed URL" }), SFEED_A)
    const add = within(feeds).getByRole("button", { name: "Add feed" })
    expect(add).toHaveClass("bg-primary")
    await user.click(add)
    expect(await findToast("Alert feed added.")).toBeInTheDocument()
    expect(screen.queryByText(OTHER_LIST_SP)).not.toBeInTheDocument()
  })

  // EPIC-0008 rewrite (stack-feed-own-record:416): the Stack posts not-recorded state is now the EPIC-0008
  // panel; the EPIC-0005 "Not verified" badge and "Record verification" button are retired.
  it("HAF:697 / SFOR:416 one confirmation records the Alert feeds list too, so its form appears", async () => {
    const { user } = openHiring()
    const { basis, save } = await openDialog(user, "Record permitted use")
    await user.type(basis, "Read terms.")
    await save()
    await findToast("Confirmation saved.")
    const feeds = await screen.findByRole("region", { name: "Alert feeds" })
    expect(await within(feeds).findByText(/^Confirmed on/)).toBeVisible()
    expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toBeVisible()
  })
})
