import { screen, waitFor, within } from "@testing-library/react"
import { defaultScheduler, notifyManager } from "@tanstack/react-query"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import { ALERT_FEED_VERIFICATION_PATH, ALERT_FEEDS_PATH, CONTROLS_PATH, STACK_POSTS_PATH, type ApiErrorResponse } from "@eve/contracts"

import { stackPostsCopy } from "@/entities/stack-post"
import { HIRING_FEED_VERIFICATION_PATH } from "@/shared/lib/hiring-contracts"
import {
  apiErrorResponse,
  controls,
  costPause,
  FEED_A,
  FEED_B,
  ownRecord21Oct,
  server,
  storedFeed,
  storedPost,
} from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openHiringFeeds as openHiring } from "./hiring-view-helpers"
import { loadedFeeds, loadedPosts, openStackPosts, region, toggleHeaderPause } from "./stack-posts-helpers"

/**
 * EPIC-0008 web: Stack posts Alert feeds per Candidate (design-spec S1 to S3,
 * copy deck). Test names start with the r1 Gherkin `file:line`:
 * SFOR stack-feed-own-record, SFRG stack-feed-registration-gate, SFM
 * stack-feed-migration, SFCU stack-feed-copy-and-unchanged. Deck strings are
 * quoted so a copy change fails here.
 */
// R5: one "Confirm you may use these feeds" step at the top of Set up alerts replaces the per-list panels.
const MISSING_TITLE = "Confirm you may use these feeds"
const MISSING_BODY = "Eve reads these feeds for you. Confirm that you are allowed to use them."
const HASFEEDS_1 =
  "Your 1 saved feed is kept, but Eve doesn't read it until you confirm you may use these feeds. Search links still work."
const hasFeedsN = (n: number) =>
  `Your ${n} saved feeds are kept, but Eve doesn't read them until you confirm you may use these feeds. Search links still work.`
const RECORD = "Record permitted use"
const UPDATE_SR = "Update your confirmation for Alert feeds"
const DIALOG_TITLE = "Confirm you may use these feeds"
const DIALOG_HELP =
  "Eve reads these feeds for you. Confirm that you are allowed to use them. Only you see the basis."
const SAVE = "I confirm"
const SAVED = "Confirmation saved."
const ERR_NET = "Couldn't save your confirmation. Nothing changed. Try again."
const PAUSED =
  "Scheduled reads are paused. Your changes here still save. Reads restart at the next scheduled time after automation resumes."
const POSTS_NOTE = "No new posts until you confirm you may use these feeds. These posts stay until they age out."
const POSTS_EMPTY_TITLE = "Posts from your field appear here once you set up job alerts."
const POSTS_EMPTY_BODY = "Set up alerts"
const CHANGE_HELP = "Saved URLs stay hidden. To change one, remove the feed and add the new URL."
const NOT_VERIFIED_MSG = "Record the permitted-use verification for Google Alerts feeds before registering a feed."
/** The six retired EPIC-0005 slots, as built (C-SP-VERIFY-SOURCE, -NONE, -DONE, -WHY, -RECORD, -ACTION). */
const RETIRED_EXACT = ["Google Alerts feeds", "Not verified", "Verified", "Record verification"]
const RETIRED_PATTERN = /the same rule as every Job Source|Verified \d/

/**
 * GH-2 banned wording (stack-feed-copy-and-unchanged.feature header), case-insensitive. "Job Source" is in it
 * (OD-D8). "confirm/approve/validate/enable" are banned only with another person as the subject; no Stack posts
 * string uses those verbs at all, so they are matched outright.
 */
const BANNED =
  /operator|the person who runs (your )?eve|\badmin(istrator)?\b|shared record|shared verification|shared with hiring|on behalf of|\bowner\b|\bteam\b|installation|job source|confirms|approves|validates|enables/i

const bola21Oct = { verifiedOn: "2026-10-21", verificationBasis: "Read Google's terms on 21 Oct.", updatedAt: "2026-10-21T09:00:00.000Z" }
const todayWat = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10)
const tomorrowWat = () => new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().slice(0, 10)

type User = ReturnType<typeof openStackPosts>["user"]

async function openDialog(user: User, button: typeof RECORD | typeof UPDATE_SR) {
  const feeds = await loadedFeeds()
  // The first confirmation is the one "I confirm" step at the top of Set up alerts.
  if (button === RECORD) await user.click(screen.getByRole("button", { name: SAVE }))
  else await user.click(within(feeds).getByRole("button", { name: button }))
  const dialog = await screen.findByRole("dialog", { name: DIALOG_TITLE })
  return {
    feeds,
    dialog,
    date: within(dialog).getByLabelText(/Verification date/) as HTMLInputElement,
    basis: within(dialog).getByLabelText(/Basis for your confirmation/) as HTMLTextAreaElement,
    save: () => user.click(within(dialog).getByRole("button", { name: SAVE })),
  }
}

/** Visible text plus every accessible name and description in `root`, for the banned-wording check. */
function surfaceText(root: HTMLElement) {
  const names = [...root.querySelectorAll("[aria-label],[aria-describedby]")].flatMap((el) => [
    el.getAttribute("aria-label") ?? "",
    ...(el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? ""),
  ])
  return [root.textContent ?? "", ...names].join("\n")
}

function legacyFeeds(n: number) {
  return Array.from({ length: n }, (_, i) =>
    storedFeed({ url: `https://www.google.com/alerts/feeds/01234567890123456789/40000000000000${String(i).padStart(5, "0")}`, label: `Saved ${i + 1}` })
  )
}

describe("The not-recorded state: one confirm step (SFOR:129, SFRG:68, SFCU:81, SFCU:110)", () => {
  it.each([
    ["no other record exists", {}],
    ["she has her own Hiring record", { hiringVerification: ownRecord21Oct }],
  ])(
    "SFOR:129 / SFRG:68 / SFCU:81 with no own record (%s): the confirm step, no panel, no list and no form",
    async (_, extra) => {
      openStackPosts({ stack: extra })
      const feeds = await loadedFeeds()
      expect(screen.getByRole("heading", { level: 3, name: MISSING_TITLE })).toBeVisible()
      expect(screen.getByText(MISSING_BODY)).toBeVisible()
      const record = screen.getByRole("button", { name: SAVE })
      expect(record).toBeEnabled()
      expect(record).not.toHaveAttribute("aria-disabled")
      expect(record).toHaveClass("bg-primary")
      expect(within(feeds).queryByRole("button", { name: SAVE })).not.toBeInTheDocument()
      expect(within(feeds).queryByRole("textbox", { name: "Feed URL" })).not.toBeInTheDocument()
      expect(within(feeds).queryByRole("button", { name: "Add feed" })).not.toBeInTheDocument()
      expect(within(feeds).queryByText("Your feeds")).not.toBeInTheDocument()
      for (const retired of RETIRED_EXACT) expect(within(feeds).queryByText(retired)).not.toBeInTheDocument()
      expect(within(feeds).queryByRole("button", { name: "Record verification" })).not.toBeInTheDocument()
      expect(feeds).not.toHaveTextContent(RETIRED_PATTERN)
    }
  )

  it("SFCU:110 the Operator and an invitee without a record see identical section text and controls (no role input exists)", async () => {
    const first = openStackPosts()
    const a = await loadedFeeds()
    const textA = a.textContent
    const buttonsA = within(a).queryAllByRole("button").map((b) => b.textContent)
    const stepA = screen.getByRole("group", { name: MISSING_TITLE }).textContent
    first.unmount()
    openStackPosts()
    const b = await loadedFeeds()
    expect(b.textContent).toBe(textA)
    expect(within(b).queryAllByRole("button").map((x) => x.textContent)).toEqual(buttonsA)
    expect(screen.getByRole("group", { name: MISSING_TITLE }).textContent).toBe(stepA)
    expect(buttonsA).toEqual([])
  })

  it("SFCU:72 no control in the section or the step links to the Hiring view or offers to ask anyone", async () => {
    openStackPosts()
    const feeds = await loadedFeeds()
    expect(within(feeds).queryAllByRole("link")).toEqual([])
    const step = screen.getByRole("group", { name: MISSING_TITLE })
    for (const button of within(step).getAllByRole("button")) expect(button).not.toHaveTextContent(/ask|notify|request|hiring/i)
  })
})

describe("Record and update her own Stack posts check (SFOR)", () => {
  it("SFOR:52 'Record permitted use' opens the dialog: title, help as description, today's date, empty basis, no delete action", async () => {
    const { user } = openStackPosts()
    const { dialog, date, basis } = await openDialog(user, RECORD)
    expect(within(dialog).getByRole("heading", { name: DIALOG_TITLE })).toBeInTheDocument()
    expect(dialog).toHaveAccessibleDescription(DIALOG_HELP)
    expect(date).toHaveValue(todayWat())
    expect(basis).toHaveValue("")
    expect(within(dialog).getByText("0 of 500")).toBeVisible()
    expect(within(dialog).getByRole("button", { name: SAVE })).toHaveAttribute("type", "submit")
    expect(within(dialog).queryByRole("button", { name: /delete|clear|remove/i })).not.toBeInTheDocument()
    await waitFor(() => expect(date).toHaveFocus())
  })

  it.each(["ada@example.com", "bola@example.com"])(
    "SFOR:35 / SFRG:50 / SFOR:169 %s records her own check: PUT, toast, recorded line + Update, form, focus to Feed URL, no not-found text",
    async () => {
      const { user, stack } = openStackPosts()
      const { feeds, dialog, date, basis, save } = await openDialog(user, RECORD)
      await user.clear(date)
      await user.type(date, "2026-10-27")
      await user.type(basis, "Read Google's Alerts RSS terms on 27 Oct.")
      await save()

      expect(await findToast(SAVED)).toBeInTheDocument()
      expect(dialog).not.toBeInTheDocument()
      expect(document.body).not.toHaveTextContent(/not found/i)
      expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH).map((r) => r.body)).toEqual([
        { verifiedOn: "2026-10-27", verificationBasis: "Read Google's Alerts RSS terms on 27 Oct." },
      ])
      expect(await within(feeds).findByText("Confirmed on 27 Oct 2026")).toBeVisible()
      expect(within(feeds).getByRole("button", { name: UPDATE_SR })).toHaveTextContent(/^Update$/)
      await waitFor(() => expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toHaveFocus())
      expect(within(feeds).queryByText(MISSING_TITLE)).not.toBeInTheDocument()
      expect(feeds).not.toHaveTextContent("Read Google's Alerts RSS terms on 27 Oct.")
      // R5: one confirmation records both lists, with the same two requests as before.
      expect(stack.requestsTo("PUT", HIRING_FEED_VERIFICATION_PATH).map((r) => r.body)).toEqual([
        { verifiedOn: "2026-10-27", verificationBasis: "Read Google's Alerts RSS terms on 27 Oct." },
      ])
      expect(stack.state.hiringVerification).not.toBeNull()
    }
  )

  it("P3-G-06 / SFRG:50 focus reaches Feed URL even when the recorded branch renders after the next animation frame", async () => {
    const { user } = openStackPosts()
    const { feeds, basis, save } = await openDialog(user, RECORD)
    await user.type(basis, "Read terms.")
    notifyManager.setScheduler((callback) => setTimeout(callback, 40))
    try {
      await save()
      expect(await within(feeds).findByText(/^Confirmed on/)).toBeVisible()
      await waitFor(() => expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toHaveFocus())
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toHaveFocus()
    } finally {
      notifyManager.setScheduler(defaultScheduler)
    }
  }, 20_000)

  it("SFOR:73 with her own record: the date line, Update with its accessible name, the form; the basis is not on the page", async () => {
    openStackPosts({ stack: { verification: bola21Oct } })
    const feeds = await loadedFeeds()
    expect(within(feeds).getByText("Confirmed on 21 Oct 2026")).toBeVisible()
    const update = within(feeds).getByRole("button", { name: UPDATE_SR })
    expect(update).toHaveTextContent(/^Update$/)
    expect(update).toHaveClass("border-border", "bg-background")
    expect(document.body).not.toHaveTextContent("Read Google's terms on 21 Oct.")
    expect(within(feeds).queryByRole("button", { name: RECORD })).not.toBeInTheDocument()
    expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toBeVisible()
    expect(within(feeds).getByRole("button", { name: "Add feed" })).toHaveClass("bg-primary")
  })

  it("SFOR:82 'Update' opens the dialog pre-filled with her own record", async () => {
    const { user } = openStackPosts({ stack: { verification: bola21Oct } })
    const { date, basis } = await openDialog(user, UPDATE_SR)
    expect(date).toHaveValue("2026-10-21")
    expect(basis).toHaveValue("Read Google's terms on 21 Oct.")
  })

  it.each(["ada@example.com", "bola@example.com"])(
    "SFOR:90 %s updates her record: one PUT, toast, new date line, focus back to Update, feeds kept",
    async () => {
      const { user, stack } = openStackPosts({
        stack: { verification: { ...bola21Oct, verifiedOn: "2026-10-15", verificationBasis: "Basis one." }, feeds: [storedFeed({ label: "React posts" })] },
      })
      const { feeds, date, basis, save } = await openDialog(user, UPDATE_SR)
      await user.clear(date)
      await user.type(date, todayWat())
      await user.clear(basis)
      await user.type(basis, "Re-read the Alerts terms on 28 Oct.")
      await save()
      expect(await findToast(SAVED)).toBeInTheDocument()
      expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toHaveLength(1)
      expect(stack.state.verification).toMatchObject({ verifiedOn: todayWat(), verificationBasis: "Re-read the Alerts terms on 28 Oct." })
      await waitFor(() => expect(within(feeds).getByRole("button", { name: UPDATE_SR })).toHaveFocus())
      expect(within(feeds).getByRole("listitem", { name: /^React posts/ })).toBeVisible()
    }
  )

  it("SFOR:113 Cancel discards edits: the dialog closes, no save is sent, focus returns to Update", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: { ...bola21Oct, verificationBasis: "Read terms." } } })
    const { feeds, dialog, basis } = await openDialog(user, UPDATE_SR)
    await user.clear(basis)
    await user.type(basis, "Something else")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
    expect(stack.state.verification?.verificationBasis).toBe("Read terms.")
    await waitFor(() => expect(within(feeds).getByRole("button", { name: UPDATE_SR })).toHaveFocus())
  })

  it("SFOR:113 Escape on a first record returns focus to 'Record permitted use'", async () => {
    const { user } = openStackPosts()
    const { dialog } = await openDialog(user, RECORD)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole("button", { name: SAVE })).toHaveFocus())
  })

  it("SFOR:342 neither the page nor the Update dialog offers to delete or clear the record", async () => {
    const { user } = openStackPosts({ stack: { verification: bola21Oct } })
    const { feeds, dialog } = await openDialog(user, UPDATE_SR)
    expect(within(dialog).queryByRole("button", { name: /delete|clear/i })).not.toBeInTheDocument()
    expect(within(feeds).queryByRole("button", { name: /delete|clear|remove (permitted|record|verification)/i })).not.toBeInTheDocument()
  })
})

describe("Dialog validation and failures for every Candidate (SFOR:201, :220, :229, :287)", () => {
  it.each([
    ["(empty)", "Read Google's terms.", "date", "Enter the verification date."],
    ["tomorrow", "Read Google's terms.", "date", "Enter today or an earlier date."],
    ["2026-10-21", "", "basis", "Enter the basis for your confirmation."],
    ["2026-10-21", "   ", "basis", "Enter the basis for your confirmation."],
    ["2026-10-21", "a".repeat(501), "basis", "Use 500 characters or fewer."],
    ["2026-10-21", "Read\u202Eterms", "basis", "The basis has hidden characters Eve can't save. Type it again or paste it as plain text."],
  ])("SFOR:201 date %s, basis %j: the %s field shows %j, input kept, nothing saved", async (d, b, field, message) => {
    const { user, stack } = openStackPosts()
    const { dialog, date, basis, save } = await openDialog(user, RECORD)
    const typedDate = d === "tomorrow" ? tomorrowWat() : d === "(empty)" ? "" : d
    await user.clear(date)
    if (typedDate) await user.type(date, typedDate)
    if (b) {
      await user.click(basis)
      await user.paste(b)
    }
    await save()
    expect(within(dialog).getByText(message)).toHaveAttribute("role", "alert")
    expect(field === "date" ? date : basis).toHaveFocus()
    expect(date).toHaveValue(typedDate)
    expect(basis).toHaveValue(b)
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
    expect(stack.state.verification).toBeNull()
  })

  it("SFOR:220 a future date and a blank basis show both errors after one submit", async () => {
    const { user } = openStackPosts()
    const { dialog, date, basis, save } = await openDialog(user, RECORD)
    await user.clear(date)
    await user.type(date, tomorrowWat())
    await user.type(basis, "   ")
    await save()
    expect(within(dialog).getByText("Enter today or an earlier date.")).toBeVisible()
    expect(within(dialog).getByText("Enter the basis for your confirmation.")).toBeVisible()
  })

  it("SFOR:229 a server verifiedOn/invalid on an update keeps the typed input and her earlier record", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: { ...bola21Oct, verifiedOn: "2026-10-15", verificationBasis: "Read terms." } } })
    server.use(
      http.put(ALERT_FEED_VERIFICATION_PATH, () => {
        const body: ApiErrorResponse = {
          error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "verifiedOn", position: null, problem: "invalid" }] },
        }
        return HttpResponse.json(body, { status: 400 })
      })
    )
    const { dialog, date, basis, save } = await openDialog(user, UPDATE_SR)
    await user.clear(date)
    await user.type(date, "2026-10-20")
    await save()
    expect(await within(dialog).findByText("Enter the verification date.")).toBeVisible()
    expect(date).toHaveValue("2026-10-20")
    expect(basis).toHaveValue("Read terms.")
    expect(stack.state.verification).toMatchObject({ verifiedOn: "2026-10-15", verificationBasis: "Read terms." })
  })

  it.each([
    ["the network is unavailable", () => HttpResponse.error(), ERR_NET],
    ["a 500 internal_error", () => apiErrorResponse("internal_error"), ERR_NET],
    ["a 4xx with a message", () => HttpResponse.json({ error: { code: "bad_request", message: "Something is wrong." } }, { status: 400 }), "Something is wrong."],
    ["a 4xx without a message", () => HttpResponse.json({ error: { code: "bad_request", message: "" } }, { status: 400 }), ERR_NET],
    ["a stale 404 not_found", () => apiErrorResponse("not_found"), "Not found."],
  ])("SFOR:287 a save that fails with %s shows its message, keeps the input and changes nothing", async (_, reply, shown) => {
    const { user, stack } = openStackPosts({ stack: { verification: { ...bola21Oct, verificationBasis: "Read terms." } } })
    server.use(http.put(ALERT_FEED_VERIFICATION_PATH, reply))
    const { dialog, basis, save } = await openDialog(user, UPDATE_SR)
    await user.clear(basis)
    await user.type(basis, "Read the terms again.")
    await save()
    const alert = await within(dialog).findByRole("alert")
    expect(alert).toHaveTextContent(shown)
    expect(alert).not.toHaveTextContent(/operator|role/i)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(basis).toHaveValue("Read the terms again.")
    expect(stack.state.verification?.verificationBasis).toBe("Read terms.")
  })

  it.each([
    ["the global pause", { globalPaused: true }],
    ["the cost-ceiling pause", { controls: { controls: controls({ costPause: costPause() }) } }],
  ] as const)("SFOR:352 the save works during %s and the dialog shows no pause note", async (_, opts) => {
    const { user } = openStackPosts(opts)
    const { dialog, basis, save } = await openDialog(user, RECORD)
    expect(dialog).not.toHaveTextContent(/paused/i)
    await user.type(basis, "Read terms.")
    await save()
    expect(await findToast(SAVED)).toBeInTheDocument()
  })

  it("SFOR:393 the toast reads 'Confirmation saved.' and never contains the basis", async () => {
    const { user } = openStackPosts()
    const { basis, save } = await openDialog(user, RECORD)
    await user.type(basis, "Toast-marker-55e0")
    await save()
    const toast = await findToast(SAVED)
    expect(toast).toHaveTextContent(SAVED)
    expect(toast).not.toHaveTextContent("Toast-marker-55e0")
  })

  it("SFOR:453 double-activating Save sends one PUT and shows at most one toast", async () => {
    const { user, stack } = openStackPosts()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const real = stack.handlers.find((h) => h.info.method === "PUT" && String(h.info.path) === ALERT_FEED_VERIFICATION_PATH)!
    server.use(
      http.put(ALERT_FEED_VERIFICATION_PATH, async (info) => {
        await gate
        return (await real.run({ request: info.request, requestId: info.requestId }))?.response
      })
    )
    const { dialog, basis } = await openDialog(user, RECORD)
    await user.type(basis, "Read terms.")
    const submit = within(dialog).getByRole("button", { name: SAVE })
    await user.click(submit)
    expect(await within(dialog).findByRole("button", { name: "Saving…" })).toBeDisabled()
    await user.click(within(dialog).getByRole("button", { name: "Saving…" }))
    release()
    await findToast(SAVED)
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toHaveLength(1)
    expect(screen.getAllByText(SAVED)).toHaveLength(1)
  })

  it("SFOR:463 two saves in a row both succeed with no conflict prompt; the last one wins", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: bola21Oct } })
    for (const text of ["From tab A", "From tab B"]) {
      const { basis, save } = await openDialog(user, UPDATE_SR)
      await user.clear(basis)
      await user.type(basis, text)
      await save()
      await findToast(SAVED)
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    }
    expect(stack.state.verification?.verificationBasis).toBe("From tab B")
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })
})

describe("Saved feeds without a record (SFM:133 to SFM:177)", () => {
  it("SFM:133 an invitee with legacy feeds sees the panel with the saved-feeds body and a read-only list with Remove only", async () => {
    openStackPosts({
      stack: {
        feeds: [storedFeed({ url: FEED_B, label: "Bola React" }), storedFeed({ url: "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111444555", label: "Bola Go" })],
      },
    })
    const feeds = await loadedFeeds()
    expect(screen.getByRole("heading", { level: 3, name: MISSING_TITLE })).toBeVisible()
    expect(within(feeds).getByText(hasFeedsN(2))).toBeVisible()
    expect(screen.getByRole("button", { name: SAVE })).toHaveClass("bg-primary")
    expect(within(feeds).getByText("Your feeds")).toBeVisible()
    expect(within(feeds).getByText("2 of 10")).toBeVisible()
    const react = within(feeds).getByRole("listitem", { name: /^Bola React/ })
    const go = within(feeds).getByRole("listitem", { name: /^Bola Go/ })
    expect(react).toHaveTextContent("…222333")
    expect(go).toHaveTextContent("…444555")
    for (const row of [react, go]) {
      expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Remove"])
      expect(within(row).queryByText("Failing")).not.toBeInTheDocument()
    }
    expect(within(feeds).queryByRole("textbox", { name: "Feed URL" })).not.toBeInTheDocument()
    expect(within(feeds).queryByRole("button", { name: "Add feed" })).not.toBeInTheDocument()
    expect(within(feeds).queryByText(CHANGE_HELP)).not.toBeInTheDocument()
  })

  it.each([
    [1, HASFEEDS_1],
    [2, hasFeedsN(2)],
    [10, hasFeedsN(10)],
  ])("SFM:143 with %i saved feeds the panel body is worded for that count", async (n, body) => {
    openStackPosts({ stack: { feeds: legacyFeeds(n) } })
    const feeds = await loadedFeeds()
    expect(within(feeds).getByText(body)).toBeVisible()
    expect(within(feeds).getByText(`${n} of 10`)).toBeVisible()
  })

  it("SFM:155 removing the last legacy feed without a record: toast, list gone, body switches, focus to Record", async () => {
    const { user, stack } = openStackPosts({ stack: { feeds: [storedFeed({ url: FEED_A, label: "Bola React" })] } })
    const feeds = await loadedFeeds()
    await user.click(within(feeds).getByRole("button", { name: /^Remove Bola React/ }))
    const dialog = await screen.findByRole("alertdialog", { name: "Remove this Alert feed?" })
    await user.click(within(dialog).getByRole("button", { name: "Remove feed" }))
    expect(await findToast("Alert feed removed.")).toBeInTheDocument()
    expect(stack.requestsTo("DELETE", ALERT_FEEDS_PATH)).toHaveLength(1)
    await waitFor(() => expect(within(feeds).queryByText("Your feeds")).not.toBeInTheDocument())
    expect(screen.getByText(MISSING_BODY)).toBeVisible()
    await waitFor(() => expect(screen.getByRole("button", { name: SAVE })).toHaveFocus())
  })

  it("SFM:155 removing one of two legacy feeds keeps the read-only list and moves focus to the other Remove", async () => {
    const { user } = openStackPosts({ stack: { feeds: legacyFeeds(2) } })
    const feeds = await loadedFeeds()
    await user.click(within(feeds).getByRole("button", { name: /^Remove Saved 1/ }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove feed" }))
    await findToast("Alert feed removed.")
    await waitFor(() => expect(within(feeds).getByRole("button", { name: /^Remove Saved 2/ })).toHaveFocus())
    expect(await within(feeds).findByText(HASFEEDS_1)).toBeVisible()
  })

  it("SFM:163 after she records her check the read-only list gains the change help and the form; focus to Feed URL", async () => {
    const { user } = openStackPosts({ stack: { feeds: [storedFeed({ url: FEED_A, label: "Bola React" })] } })
    const { feeds, basis, save } = await openDialog(user, RECORD)
    await user.type(basis, "Read terms.")
    await save()
    await findToast(SAVED)
    expect(await within(feeds).findByText(/^Confirmed on/)).toBeVisible()
    expect(within(feeds).getByRole("button", { name: UPDATE_SR })).toBeVisible()
    expect(within(feeds).getByRole("listitem", { name: /^Bola React/ })).toBeVisible()
    expect(within(feeds).getByText(CHANGE_HELP)).toBeVisible()
    await waitFor(() => expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toHaveFocus())
  })

  it("SFM:170 legacy posts without a record: the note and link above the rows on every page; the link focuses Set up alerts", async () => {
    const posts = Array.from({ length: 60 }, (_, i) =>
      storedPost({ title: `Post ${i}`, canonicalUrl: `https://www.linkedin.com/posts/p-${i}`, date: new Date(Date.UTC(2026, 9, 1, i)).toISOString() })
    )
    const { user } = openStackPosts({ stack: { feeds: [storedFeed()], posts } })
    await loadedFeeds()
    for (const page of [1, 2]) {
      const list = await loadedPosts()
      await within(list).findByText(`Page ${page} of 2`)
      const note = within(list).getByText(POSTS_NOTE)
      const firstRow = within(list).getAllByRole("listitem")[0]
      expect(note.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(within(list).getAllByText(POSTS_NOTE)).toHaveLength(1)
      if (page === 1) await user.click(within(list).getByRole("link", { name: "Next" }))
      else {
        await user.click(within(list).getByRole("link", { name: "Set up alerts" }))
        await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Set up alerts" })).toHaveFocus())
      }
    }
  })

  it("SFM:177 with her own record the Posts note is not shown", async () => {
    openStackPosts({ stack: { verification: bola21Oct, feeds: [storedFeed()], posts: [storedPost(), storedPost(), storedPost()] } })
    const posts = await loadedPosts()
    expect(within(posts).getAllByRole("listitem")).toHaveLength(3)
    expect(within(posts).queryByText(POSTS_NOTE)).not.toBeInTheDocument()
  })
})

describe("Registration gate on the page (SFRG:27, SFRG:76)", () => {
  it("SFRG:27 with her own record she registers a feed: toast and row", async () => {
    const { user } = openStackPosts({ stack: { verification: bola21Oct } })
    const feeds = await loadedFeeds()
    await user.type(within(feeds).getByRole("textbox", { name: "Feed URL" }), FEED_A)
    await user.type(within(feeds).getByRole("textbox", { name: "Label (optional)" }), "React posts")
    await user.click(within(feeds).getByRole("button", { name: "Add feed" }))
    expect(await findToast("Alert feed added.")).toBeInTheDocument()
    expect(await within(feeds).findByRole("listitem", { name: /^React posts/ })).toHaveTextContent("…654321")
  })

  it("SFRG:76 a stale page: the 409 shows the API message, keeps the URL, re-reads the list, then shows the panel", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: bola21Oct } })
    const feeds = await loadedFeeds()
    stack.state.verification = null
    const url = within(feeds).getByRole("textbox", { name: "Feed URL" }) as HTMLInputElement
    await user.type(url, FEED_A)
    await user.click(within(feeds).getByRole("button", { name: "Add feed" }))
    expect(await within(feeds).findByText(NOT_VERIFIED_MSG)).toBeVisible()
    expect(url).toHaveValue(FEED_A)
    expect(await screen.findByRole("heading", { name: MISSING_TITLE })).toBeVisible()
    expect(within(feeds).queryByRole("textbox", { name: "Feed URL" })).not.toBeInTheDocument()
    expect(stack.requestsTo("GET", ALERT_FEEDS_PATH).length).toBeGreaterThanOrEqual(2)
  })
})

describe("Wording and empty states (SFCU)", () => {
  it("SFCU:91 Posts empty before her own record: title, body without 'then add a feed', link to Set up alerts, one confirm control", async () => {
    const { user } = openStackPosts()
    await loadedFeeds()
    const posts = await loadedPosts()
    expect(within(posts).getByRole("heading", { level: 3, name: POSTS_EMPTY_TITLE })).toBeVisible()
    expect(posts).not.toHaveTextContent("then add a feed")
    expect(within(posts).queryByText(POSTS_NOTE)).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: SAVE })).toHaveLength(1)
    await user.click(within(posts).getByRole("link", { name: POSTS_EMPTY_BODY }))
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Set up alerts" })).toHaveFocus())
  })

  it("SFOR:129 the not-recorded empty state shows with saved feeds too (it comes before the waiting state)", async () => {
    openStackPosts({ stack: { feeds: legacyFeeds(1) } })
    const posts = await loadedPosts()
    expect(within(posts).getByText(POSTS_EMPTY_TITLE)).toBeVisible()
    expect(within(posts).queryByText("No posts yet")).not.toBeInTheDocument()
  })

  it("SFCU:101 the global pause note says reads restart after automation resumes, never 'after you resume automation'", async () => {
    openStackPosts({ globalPaused: true, stack: { verification: bola21Oct } })
    const feeds = await loadedFeeds()
    expect(await within(feeds).findByText(PAUSED)).toBeVisible()
    expect(feeds).not.toHaveTextContent("after you resume automation")
  })

  it("SFCU:101 the pause note shows in the not-recorded state as well", async () => {
    openStackPosts({ globalPaused: true })
    const feeds = await loadedFeeds()
    expect(await within(feeds).findByText(PAUSED)).toBeVisible()
  })

  it("SFCU:28 no surface names another person or a shared record: page, dialog, field errors, toast, recorded page and Update dialog, Posts note", async () => {
    const { user } = openStackPosts({ stack: { feeds: legacyFeeds(2), posts: [storedPost()] } })
    const main = await screen.findByRole("main")
    await loadedFeeds()
    await loadedPosts()
    expect(surfaceText(main)).not.toMatch(BANNED)
    expect(within(main).getByText(POSTS_NOTE)).toBeVisible()

    const { dialog, date, basis, save } = await openDialog(user, RECORD)
    expect(surfaceText(dialog)).not.toMatch(BANNED)
    await user.clear(date)
    await user.type(date, tomorrowWat())
    await save()
    expect(within(dialog).getAllByRole("alert").length).toBeGreaterThan(0)
    expect(surfaceText(dialog)).not.toMatch(BANNED)

    await user.clear(date)
    await user.type(date, todayWat())
    await user.type(basis, "Read terms.")
    await save()
    const toast = await findToast(SAVED)
    expect(toast?.textContent ?? "").not.toMatch(BANNED)
    expect((await within(main).findAllByText(/^Confirmed on/)).length).toBeGreaterThan(0)
    expect(surfaceText(main)).not.toMatch(BANNED)

    const update = await openDialog(user, UPDATE_SR)
    expect(surfaceText(update.dialog)).not.toMatch(BANNED)
  })

  it("SFCU:28 a stale registration refusal names no other person", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: bola21Oct } })
    const feeds = await loadedFeeds()
    stack.state.verification = null
    await user.type(within(feeds).getByRole("textbox", { name: "Feed URL" }), FEED_A)
    await user.click(within(feeds).getByRole("button", { name: "Add feed" }))
    const refusal = await within(feeds).findByText(NOT_VERIFIED_MSG)
    expect(refusal.textContent).not.toMatch(BANNED)
  })

  it("SFCU:66 every Stack posts copy string holds no banned wording, and the retired keys are gone", () => {
    const strings: string[] = []
    const walk = (value: unknown) => {
      if (typeof value === "string") strings.push(value)
      else if (typeof value === "function") {
        // Fill each template with values its parameters accept: a date, a date-time, or a count and a mask.
        const fn = value as (...a: unknown[]) => unknown
        for (const args of [["2026-10-21T13:00:00.000Z", "…123456"], [3, 10], ["not_a_feed", "2026-10-21T13:00:00.000Z"]]) {
          try {
            strings.push(String(fn(...args)))
          } catch {
            // This argument shape doesn't fit this template; another one does.
          }
        }
      }
      else if (value && typeof value === "object") Object.values(value).forEach(walk)
    }
    walk(stackPostsCopy)
    walk({ hasFeeds: [2, 10].map((n) => stackPostsCopy.verifyMissingBodyHasFeeds(n)) })
    // C-SP-FEED-ERR-OTHER-LIST names the Hiring view for a URL clash (design-spec S1 step 7); the
    // banned "shared with Hiring" / Hiring-record wording is about the record, which it doesn't mention.
    for (const s of strings) expect(s).not.toMatch(BANNED)
    for (const key of ["verifySource", "notVerified", "verifiedBadge", "verifyWhy", "verifyRecord", "verifyAction"])
      expect(stackPostsCopy).not.toHaveProperty(key)
  })
})

describe("Each section follows its own record; one confirmation covers both (SFOR:401, :409, :416, :430)", () => {
  it.each([
    [bola21Oct, ownRecord21Oct, true, true],
    [bola21Oct, null, true, false],
    [null, ownRecord21Oct, false, true],
    [null, null, false, false],
  ] as const)("SFOR:430 stack %j / hiring %j: each section's state follows its own record, the step shows while any is missing", async (stackRecord, hiringRecord, stackRecorded, hiringRecorded) => {
    openHiring({ path: "/find-jobs#set-up-alerts", stack: { verification: stackRecord, hiringVerification: hiringRecord } })
    const feeds = await loadedFeeds()
    expect(within(feeds).queryByText(/^Confirmed on/) !== null).toBe(stackRecorded)
    expect(within(feeds).queryByText(/Confirm above to add feeds\./) !== null).toBe(!stackRecorded)
    expect(within(feeds).queryByRole("textbox", { name: "Feed URL" }) !== null).toBe(stackRecorded)

    const hiring = await screen.findByRole("region", { name: "Hiring alert feeds" })
    await waitFor(() =>
      expect(within(hiring).queryByText(/Confirm above to add feeds\./) ?? within(hiring).queryByText(/^Confirmed on/)).not.toBeNull()
    )
    expect(within(hiring).queryByText(/^Confirmed on/) !== null).toBe(hiringRecorded)
    expect(within(hiring).queryByRole("textbox", { name: "Feed URL" }) !== null).toBe(hiringRecorded)
    expect(screen.queryByRole("group", { name: MISSING_TITLE }) !== null).toBe(!(stackRecorded && hiringRecorded))
  })

  it("SFOR:401 / SFOR:409 one confirmation records both lists: the same two PUTs, both sections recorded, the step gone", async () => {
    const { user, stack } = openHiring({ path: "/find-jobs#set-up-alerts" })
    const { basis, save } = await openDialog(user, RECORD)
    await user.type(basis, "One basis")
    await save()
    await findToast(SAVED)
    expect(stack.state.hiringVerification).not.toBeNull()
    expect(stack.state.verification).not.toBeNull()
    const hiring = await screen.findByRole("region", { name: "Hiring alert feeds" })
    expect(await within(hiring).findByText(/^Confirmed on/)).toBeVisible()
    await waitFor(() => expect(screen.queryByRole("group", { name: MISSING_TITLE })).not.toBeInTheDocument())
  })

  it("SFOR:416 with only the Hiring list confirmed, the step still asks, and confirming adds the Alert feeds one", async () => {
    const { user, stack } = openHiring({ path: "/find-jobs#set-up-alerts", stack: { hiringVerification: ownRecord21Oct } })
    const feeds = await region("Alert feeds")
    expect(await within(feeds).findByText(/Confirm above to add feeds\./)).toBeVisible()
    const { basis, save } = await openDialog(user, RECORD)
    await user.type(basis, "Stack basis")
    await save()
    await findToast(SAVED)
    expect(stack.state.verification).not.toBeNull()
    expect(await within(feeds).findByText(/^Confirmed on/)).toBeVisible()
  })

  it("SFOR:416 R5: the page requests the Stack posts endpoints for its sections", async () => {
    const { stack } = openStackPosts()
    await loadedFeeds()
    await loadedPosts()
    expect(stack.requestsTo("GET", STACK_POSTS_PATH).length).toBeGreaterThan(0)
  })
})

/**
 * OWN-1 (contract v1.22.0): both pause notes read `globalPaused` from their own
 * feeds response. `GET /v1/controls` sits behind the `spend` feature, so an
 * invitee gets 409 `feature_not_yet_available` from it until slice D.
 */
describe("OWN-1: the pause notes read globalPaused from the feeds responses", () => {
  const HIRING_PAUSED =
    "Scheduled reads are paused. You can still add feeds. Reads restart at the next scheduled time after automation resumes."
  const inviteeControls = () =>
    http.get(CONTROLS_PATH, () => {
      const body: ApiErrorResponse = { error: { code: "feature_not_yet_available", message: "This feature isn't available for your account yet.", feature: "spend" } }
      return HttpResponse.json(body, { status: 409 })
    })
  const hiringRegion = async () => {
    const region = await screen.findByRole("region", { name: "Hiring alert feeds" })
    await waitFor(() => expect(within(region).queryByText(/^Confirmed on/) ?? within(region).queryByText(/Confirm above to add feeds\./)).not.toBeNull())
    return region
  }

  it.each([
    ["the Operator (GET /v1/controls 200, paused)", false],
    ["an invitee (GET /v1/controls 409)", true],
  ])("Alert feeds: %s sees the pause note", async (_, invitee) => {
    openStackPosts({ globalPaused: true, stack: { verification: bola21Oct } })
    if (invitee) server.use(inviteeControls())
    const feeds = await loadedFeeds()
    expect(await within(feeds).findByText(PAUSED)).toBeVisible()
  })

  it.each([
    ["the Operator (GET /v1/controls 200, paused)", false],
    ["an invitee (GET /v1/controls 409)", true],
  ])("Hiring alert feeds: %s sees the pause note", async (_, invitee) => {
    openHiring({ controls: { globalPaused: true }, stack: { hiringVerification: ownRecord21Oct } })
    if (invitee) server.use(inviteeControls())
    const region = await hiringRegion()
    expect(await within(region).findByText(HIRING_PAUSED)).toBeVisible()
  })

  it("an invitee sees the Alert feeds note in the not-recorded state too", async () => {
    openStackPosts({ globalPaused: true })
    server.use(inviteeControls())
    expect(await within(await loadedFeeds()).findByText(PAUSED)).toBeVisible()
  })

  it("the note follows the feeds response, not GET /v1/controls", async () => {
    openStackPosts({ globalPaused: true, stack: { verification: bola21Oct, globalPaused: false } })
    const feeds = await loadedFeeds()
    expect(within(feeds).queryByText(PAUSED)).not.toBeInTheDocument()
  })

  it("an invitee sees no note when the feeds response says not paused", async () => {
    openHiring({ stack: { hiringVerification: ownRecord21Oct } })
    server.use(inviteeControls())
    const region = await hiringRegion()
    expect(within(region).queryByText(HIRING_PAUSED)).not.toBeInTheDocument()
  })

  it("the verification PUT response carries the flag: an invitee recording during the pause keeps the note", async () => {
    const { user } = openStackPosts({ globalPaused: true })
    server.use(inviteeControls())
    const { basis, save } = await openDialog(user, RECORD)
    await user.type(basis, "Read terms.")
    await save()
    expect(await findToast(SAVED)).toBeInTheDocument()
    const feeds = await loadedFeeds()
    await within(feeds).findByText(/^Confirmed on/)
    expect(within(feeds).getByText(PAUSED)).toBeVisible()
  })
})

/**
 * CR-F1 / QG-F2 (stack-feed-copy-and-unchanged.feature r2 line 110 @r2, hiring-alert-feeds.feature r7 line 979):
 * the pause notes follow the header pause control without a reload. The fakes share one control state, as
 * the API does, so only a refetch of the feeds lists can bring the new flag to the page.
 */
describe("SFCU:110 r2 the pause notes follow the header pause control without a reload (CR-F1)", () => {
  const HIRING_PAUSED =
    "Scheduled reads are paused. You can still add feeds. Reads restart at the next scheduled time after automation resumes."
  const hiringRegion = async () => {
    const region = await screen.findByRole("region", { name: "Hiring alert feeds" })
    await waitFor(() => expect(within(region).queryByText(/^Confirmed on/)).not.toBeNull())
    return region
  }
  const headerControl = () => screen.getByRole("banner").querySelector("button[aria-label$='automation']")

  it.each([
    ["Stack posts view", "pause", "Alert feeds", PAUSED],
    ["Stack posts view", "resume", "Alert feeds", PAUSED],
    ["Hiring view", "pause", "Hiring alert feeds", HIRING_PAUSED],
    ["Hiring view", "resume", "Hiring alert feeds", HIRING_PAUSED],
  ] as const)("on the %s, she %ss from the header: the %s note follows", async (view, action, _section, note) => {
    const startPaused = action === "resume"
    const stack = { verification: bola21Oct, hiringVerification: ownRecord21Oct }
    const opened =
      view === "Hiring view" ? openHiring({ controls: { globalPaused: startPaused }, stack }) : openStackPosts({ globalPaused: startPaused, stack })
    const section = view === "Hiring view" ? await hiringRegion() : await loadedFeeds()
    if (startPaused) expect(await within(section).findByText(note)).toBeVisible()
    else expect(within(section).queryByText(note)).not.toBeInTheDocument()
    const path = opened.currentPath()

    await toggleHeaderPause(opened.user, action)

    if (action === "pause") expect(await within(section).findByText(note)).toBeVisible()
    else await waitFor(() => expect(within(section).queryByText(note)).not.toBeInTheDocument())
    // No reload or navigation: the same section node, the same path; focus stays on the header control.
    expect(section).toBeInTheDocument()
    expect(opened.currentPath()).toBe(path)
    await waitFor(() => expect(headerControl()).toHaveFocus())
    // The note agrees with the header pause control.
    expect(headerControl()).toHaveAccessibleName(action === "pause" ? "Resume automation" : "Pause automation")
  })

  it.each(["Stack posts view", "Hiring view"] as const)(
    "SFOR:154 / HAF:966 r2 cost-ceiling pause only (globalPaused false): the %s shows the cost banner but no pause note",
    async (view) => {
      const stack = { verification: bola21Oct, hiringVerification: ownRecord21Oct }
      if (view === "Hiring view") openHiring({ controls: { costPause: costPause() }, stack })
      else openStackPosts({ controls: { controls: controls({ costPause: costPause() }) }, stack })
      const section = view === "Hiring view" ? await hiringRegion() : await loadedFeeds()
      expect(await screen.findByText(/^Paid automation is paused because/)).toBeVisible()
      expect(section).not.toHaveTextContent(/Scheduled reads are paused/)
      expect(screen.getByRole("banner").querySelector('button[aria-label="Pause automation"]')).not.toBeNull()
    }
  )
})
