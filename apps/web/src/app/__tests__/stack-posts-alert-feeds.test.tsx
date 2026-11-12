import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"
import { ALERT_FEED_VERIFICATION_PATH, ALERT_FEEDS_PATH, CSRF_HEADER, type ApiErrorResponse } from "@eve/contracts"

import { apiErrorResponse, FEED_A, FEED_B, server, storedFeed, storedPost, TEST_CSRF_TOKEN, verifiedOn20Oct } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { loadedFeeds, loadedPosts, openStackPosts, showTab } from "./stack-posts-helpers"

const FORMAT_ERR = "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/"
const BASIS_CHARS = "The basis has hidden characters Eve can't save. Type it again or paste it as plain text."
const LABEL_CHARS = "The label has a tab or hidden character. Type it again."
const FULL_URL_DIGITS = "01234567890123456789/9876543210987654321"

/** Today in WAT, as the dialog's default and `max`. */
const todayWat = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10)
const tomorrowWat = () => new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString().slice(0, 10)

async function openDialog(user: ReturnType<typeof openStackPosts>["user"], button: "Record permitted use" | "Update your confirmation for Alert feeds") {
  const feeds = await loadedFeeds()
  // "Record permitted use" is the first confirmation: the one "I confirm" step at the top of Set up alerts.
  if (button === "Record permitted use") await user.click(screen.getByRole("button", { name: "I confirm" }))
  else await user.click(within(feeds).getByRole("button", { name: button }))
  const dialog = await screen.findByRole("dialog", { name: "Confirm you may use these feeds" })
  return {
    dialog,
    date: within(dialog).getByLabelText(/Verification date/) as HTMLInputElement,
    basis: within(dialog).getByLabelText(/Basis for your confirmation/) as HTMLTextAreaElement,
    submit: () => user.click(within(dialog).getByRole("button", { name: "I confirm" })),
  }
}

function form(feeds: HTMLElement) {
  return {
    url: within(feeds).getByRole("textbox", { name: "Feed URL" }) as HTMLInputElement,
    label: within(feeds).getByRole("textbox", { name: "Label (optional)" }) as HTMLInputElement,
    add: () => within(feeds).getByRole("button", { name: /Add feed|Checking feed…/ }),
  }
}

async function register(user: ReturnType<typeof openStackPosts>["user"], feeds: HTMLElement, url: string, label = "") {
  const f = form(feeds)
  await user.clear(f.url)
  if (url) await user.type(f.url, url)
  await user.clear(f.label)
  if (label) await user.type(f.label, label)
  await user.click(f.add())
  return f
}

describe("Alert feed verification (alert-feed-verification.feature)", () => {
  // EPIC-0008 rewrite (stack-feed-copy-and-unchanged:81, design-spec S1 step 4): the EPIC-0005 badge and
  // C-SP-VERIFY-WHY are retired; the not-recorded panel and the changed Posts empty state replace them.
  it("@ac-3.1 @ac-3.3 not recorded: the one confirm step, no registration form; Posts points to Set up alerts", async () => {
    const { user } = openStackPosts()
    const feeds = await loadedFeeds()
    const step = screen.getByRole("group", { name: "Confirm you may use these feeds" })
    expect(within(step).getByText("Eve reads these feeds for you. Confirm that you are allowed to use them.")).toBeVisible()
    expect(within(step).getByRole("button", { name: "I confirm" })).toBeVisible()
    expect(within(feeds).queryByRole("button", { name: /I confirm|Record/ })).not.toBeInTheDocument()
    expect(within(feeds).getByText(/No alert feeds yet\. Add a Google Alerts feed to see posts from your field\./)).toBeVisible()
    expect(within(feeds).queryByRole("textbox", { name: "Feed URL" })).not.toBeInTheDocument()
    expect(within(feeds).queryByRole("button", { name: "Add feed" })).not.toBeInTheDocument()

    const posts = await loadedPosts()
    expect(within(posts).getByText("Posts from your field appear here once you set up job alerts.")).toBeVisible()
    await user.click(within(posts).getByRole("link", { name: "Set up alerts" }))
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Set up alerts" })).toHaveFocus())
  })

  it("@ac-3.1 the dialog has a date field (default today WAT, max today) and a basis field", async () => {
    const { user } = openStackPosts()
    const { date, basis, dialog } = await openDialog(user, "Record permitted use")
    expect(date).toHaveValue(todayWat())
    expect(date).toHaveAttribute("max", todayWat())
    expect(basis).toHaveValue("")
    expect(basis).not.toHaveAttribute("maxlength")
    expect(within(dialog).getByText("0 of 500")).toBeVisible()
  })

  it("@ac-3.1 @ac-3.4 @ac-1.2 records a verification: toast, record shown, CSRF sent, basis trimmed", async () => {
    const { user, stack } = openStackPosts()
    const { date, basis, submit } = await openDialog(user, "Record permitted use")
    await user.clear(date)
    await user.type(date, "2026-10-20")
    await user.type(basis, "   Reviewed Google Alerts terms; RSS delivery is offered for this use.   ")
    await submit()

    expect(await findToast("Confirmation saved.")).toBeInTheDocument()
    const feeds = await loadedFeeds()
    // EPIC-0008 rewrite (design-spec S1 step 6, S2 step 6): the recorded line shows the date only, and a
    // first record moves focus to Feed URL, the next step (was: "Verified {date}: {basis}" and focus to Update).
    expect(await within(feeds).findByText("Confirmed on 20 Oct 2026")).toBeVisible()
    expect(feeds).not.toHaveTextContent("RSS delivery is offered for this use.")
    await waitFor(() => expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toHaveFocus())
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)[0].body).toEqual({
      verifiedOn: "2026-10-20",
      verificationBasis: "Reviewed Google Alerts terms; RSS delivery is offered for this use.",
    })
    expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toBeVisible()
    expect(within(feeds).getByText("No alert feeds yet. Add a Google Alerts feed to see posts from your field.")).toBeVisible()
  })

  it.each(["Record permitted use", "Update your confirmation for Alert feeds"] as const)(
    "P3-B-1 EPIC-0005 F3 focus rule kept after the OverlayHeader swap: '%s' opens with focus on the date field",
    async (button) => {
      const { user } = openStackPosts(button === "Update your confirmation for Alert feeds" ? { stack: { verification: verifiedOn20Oct } } : {})
      const { dialog, date } = await openDialog(user, button)
      await waitFor(() => expect(date).toHaveFocus())
      expect(within(dialog).getByRole("button", { name: "Close" })).not.toHaveFocus()
    }
  )

  it("@ac-3.4 update pre-fills the stored date and basis; no remove action exists", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: { ...verifiedOn20Oct, verifiedOn: "2026-10-15" } } })
    const feeds = await loadedFeeds()
    // EPIC-0008 rewrite (design-spec S1 step 6): date only on the page; the basis is in the dialog.
    expect(within(feeds).getByText("Confirmed on 15 Oct 2026")).toBeVisible()
    expect(feeds).not.toHaveTextContent("Reviewed Google Alerts terms.")
    expect(within(feeds).queryByRole("button", { name: /remove verification/i })).not.toBeInTheDocument()
    const { date, basis, submit } = await openDialog(user, "Update your confirmation for Alert feeds")
    expect(date).toHaveValue("2026-10-15")
    expect(basis).toHaveValue("Reviewed Google Alerts terms.")
    await user.clear(date)
    await user.type(date, "2026-10-20")
    await user.clear(basis)
    await user.type(basis, "Re-read Google Alerts terms after their October update.")
    await submit()
    expect(await findToast("Confirmation saved.")).toBeInTheDocument()
    expect(stack.state.verification).toMatchObject({ verifiedOn: "2026-10-20", verificationBasis: "Re-read Google Alerts terms after their October update." })
  })

  it.each([
    ["2026-10-20", "", "basis", "Enter the basis for your confirmation."],
    ["2026-10-20", "   ", "basis", "Enter the basis for your confirmation."],
    ["", "Reviewed Google Alerts terms.", "date", "Enter the verification date."],
  ])("@ac-3.1 @ac-1.3 date %j and basis %j: the %s field shows %j, linked and announced, nothing sent", async (d, b, fieldName, error) => {
    const { user, stack } = openStackPosts()
    const { date, basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.clear(date)
    if (d) await user.type(date, d)
    if (b) await user.type(basis, b)
    await submit()
    const field = fieldName === "date" ? date : basis
    const message = within(dialog).getByText(error)
    expect(message).toHaveAttribute("role", "alert")
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(field).toHaveAccessibleDescription(expect.stringContaining(error))
    expect(field).toHaveFocus()
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
  })

  it("@ac-3.2 @ac-1.3 a date after today in WAT is refused on the date field", async () => {
    const { user, stack } = openStackPosts()
    const { date, basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.clear(date)
    await user.type(date, tomorrowWat())
    await user.type(basis, "Reviewed Google Alerts terms.")
    await submit()
    expect(within(dialog).getByText("Enter today or an earlier date.")).toBeVisible()
    expect(date).toHaveAccessibleDescription("Enter today or an earlier date.")
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
  })

  it("@ac-3.1 basis length is measured after trimming: 500 + spaces is accepted, 501 refused", async () => {
    const { user, stack } = openStackPosts()
    const { basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.click(basis)
    await user.paste("a".repeat(501))
    expect(within(dialog).getByText("501 of 500")).toBeVisible()
    await submit()
    expect(within(dialog).getByText("Use 500 characters or fewer.")).toBeVisible()
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
    await user.clear(basis)
    await user.paste(`     ${"a".repeat(500)}     `)
    await submit()
    expect(await findToast("Confirmation saved.")).toBeInTheDocument()
  })

  it("@ac-3.1 @ac-3.2 CR-E5-01 the date and basis errors show together after one submit", async () => {
    const { user, stack } = openStackPosts()
    const { date, basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.clear(date)
    await user.type(date, tomorrowWat())
    await user.type(basis, "   ")
    await submit()
    expect(within(dialog).getByText("Enter today or an earlier date.")).toBeVisible()
    expect(within(dialog).getByText("Enter the basis for your confirmation.")).toBeVisible()
    expect(date).toHaveAccessibleDescription("Enter today or an earlier date.")
    expect(basis).toHaveAccessibleDescription(expect.stringContaining("Enter the basis for your confirmation."))
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
  })

  it("@ac-3.1 @ac-3.2 CR-E5-01 a 400 listing both fields shows both errors at once and keeps the input", async () => {
    const { user } = openStackPosts()
    server.use(
      http.put(ALERT_FEED_VERIFICATION_PATH, () => {
        const body: ApiErrorResponse = {
          error: {
            code: "bad_request",
            message: "The request is not valid.",
            fieldErrors: [
              { field: "verifiedOn", position: null, problem: "future_date" },
              { field: "verificationBasis", position: null, problem: "invalid_characters" },
            ],
          },
        }
        return HttpResponse.json(body, { status: 400 })
      })
    )
    const { basis, submit, dialog, date } = await openDialog(user, "Record permitted use")
    await user.type(basis, "Reviewed Google Alerts terms.")
    await submit()
    expect(await within(dialog).findByText("Enter today or an earlier date.")).toBeVisible()
    expect(within(dialog).getByText(BASIS_CHARS)).toBeVisible()
    await waitFor(() => expect(date).toHaveFocus())
    expect(basis).toHaveValue("Reviewed Google Alerts terms.")
  })

  it("@ac-3.1 @ac-1.3 SEC-E5-06 a pasted basis with a hidden control character shows the hidden-characters error", async () => {
    const { user, stack } = openStackPosts()
    const { basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.click(basis)
    await user.paste("Reviewed\u0007 Google Alerts terms.")
    await submit()
    expect(within(dialog).getByText(BASIS_CHARS)).toBeVisible()
    expect(basis).toHaveAccessibleDescription(expect.stringContaining(BASIS_CHARS))
    expect(basis).toHaveValue("Reviewed\u0007 Google Alerts terms.")
    expect(basis).toHaveFocus()
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
  })

  it.each([
    ["U+0085 (C1)", "\u0085"],
    ["U+202E (bidi)", "\u202e"],
    ["U+200B (zero-width space)", "\u200b"],
  ])("@ac-3.1 @ac-1.3 SEC-E5F-02 a pasted basis with %s shows the hidden-characters error; nothing is sent", async (_, ch) => {
    const { user, stack } = openStackPosts()
    const { basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.click(basis)
    await user.paste(`Reviewed${ch} Google Alerts terms.`)
    await submit()
    expect(within(dialog).getByText(BASIS_CHARS)).toBeVisible()
    expect(basis).toHaveAccessibleDescription(expect.stringContaining(BASIS_CHARS))
    expect(basis).toHaveValue(`Reviewed${ch} Google Alerts terms.`)
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
  })

  it("@ac-3.1 SEC-E5F-02 a basis with ZWNJ, ZWJ and a no-break space is saved as typed", async () => {
    const { user, stack } = openStackPosts()
    const { basis, submit } = await openDialog(user, "Record permitted use")
    const typed = "Reviewed\u00a0terms \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 by \u{1f468}\u200d\u{1f469}\u200d\u{1f467}"
    await user.click(basis)
    await user.paste(typed)
    await submit()
    expect(await findToast("Confirmation saved.")).toBeInTheDocument()
    expect(stack.state.verification?.verificationBasis).toBe(typed)
  })

  it("@ac-3.1 SEC-E5-06 a basis with tabs and line breaks is saved as typed (trimmed)", async () => {
    const { user, stack } = openStackPosts()
    const { basis, submit } = await openDialog(user, "Record permitted use")
    await user.click(basis)
    await user.paste("\n\tReviewed\tGoogle\r\nAlerts terms.\r\n")
    await submit()
    expect(await findToast("Confirmation saved.")).toBeInTheDocument()
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)[0]?.body).toEqual({
      verifiedOn: todayWat(),
      // A textarea's value normalises CRLF to LF (HTML spec), in browsers as in jsdom.
      verificationBasis: "Reviewed\tGoogle\nAlerts terms.",
    })
  })

  it("@ac-3.1 CR-E5-04 the basis counter counts code points: 500 emoji is 500 of 500 and saves, 501 is refused", async () => {
    const { user, stack } = openStackPosts()
    const { basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.click(basis)
    await user.paste("😀".repeat(501))
    expect(within(dialog).getByText("501 of 500")).toBeVisible()
    await submit()
    expect(within(dialog).getByText("Use 500 characters or fewer.")).toBeVisible()
    expect(stack.requestsTo("PUT", ALERT_FEED_VERIFICATION_PATH)).toEqual([])
    await user.clear(basis)
    await user.paste("😀".repeat(500))
    expect(within(dialog).getByText("500 of 500")).toBeVisible()
    await submit()
    expect(await findToast("Confirmation saved.")).toBeInTheDocument()
  })

  it("@ac-1.2 a server field error on the date shows on the date field and keeps the typed date and basis", async () => {
    const { user } = openStackPosts()
    server.use(
      http.put(ALERT_FEED_VERIFICATION_PATH, () => {
        const body: ApiErrorResponse = {
          error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "verifiedOn", position: null, problem: "invalid" }] },
        }
        return HttpResponse.json(body, { status: 400 })
      })
    )
    const { date, basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.clear(date)
    await user.type(date, "2026-10-20")
    await user.type(basis, "Reviewed Google Alerts terms.")
    await submit()
    expect(await within(dialog).findByText("Enter the verification date.")).toBeVisible()
    expect(date).toHaveAccessibleDescription("Enter the verification date.")
    expect(date).toHaveValue("2026-10-20")
    expect(basis).toHaveValue("Reviewed Google Alerts terms.")
  })

  /**
   * N-7 (design-spec r2, Revision r2 item 1; @ac-3.1 @ac-1.3 "On a 375px phone the verification dialog keeps
   * its title and actions on screen"). jsdom has no layout, so this pins the structure and the Tailwind
   * classes that produce the cap; Designer review measures the rendered result with Playwright at 375px.
   */
  describe("N-7 the verification dialog fits a small viewport", () => {
    it("the panel is capped at the viewport height minus 32px and clips; title, body and actions are separate rows", async () => {
      const { user } = openStackPosts()
      const { dialog, date, basis } = await openDialog(user, "Record permitted use")
      expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-hidden", "flex", "flex-col", "sm:max-w-lg")

      const formEl = dialog.querySelector("form")!
      expect(formEl).toHaveClass("flex", "flex-1", "min-h-0", "flex-col")
      const rows = Array.from(formEl.children)
      // EPIC-0007 design-spec r2 OQ5: both lists use OverlayHeader (title and close on one row, divider).
      expect(rows.map((el) => el.getAttribute("data-slot"))).toEqual(["overlay-header", "verify-dialog-body", "dialog-footer"])
      const [header, body, footer] = rows as HTMLElement[]

      expect(header).toHaveClass("flex-none")
      expect(within(header).getByRole("heading", { name: "Confirm you may use these feeds" })).toBeInTheDocument()
      expect(within(header).getByRole("button", { name: "Close" })).toBeInTheDocument()
      expect(body).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain", "-mx-6", "px-6", "py-1")
      expect(body).not.toHaveAttribute("tabindex")
      expect(body).toContainElement(date)
      expect(body).toContainElement(basis)
      expect(footer).toHaveClass("flex-none")
    })

    it("Cancel and Save stay in the pinned footer, outside the scrolling body, and Save still submits the form", async () => {
      const { user } = openStackPosts()
      const { dialog, basis } = await openDialog(user, "Record permitted use")
      const footer = dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement
      const body = dialog.querySelector('[data-slot="verify-dialog-body"]') as HTMLElement
      const cancel = within(dialog).getByRole("button", { name: "Cancel" })
      const save = within(dialog).getByRole("button", { name: "I confirm" })
      expect(footer).toContainElement(cancel)
      expect(footer).toContainElement(save)
      expect(body).not.toContainElement(save)
      expect(save).toHaveAttribute("type", "submit")
      expect(save.closest("form")).toBe(dialog.querySelector("form"))

      await user.click(basis)
      await user.paste("x".repeat(501))
      await user.click(save)
      const error = within(dialog).getByText("Use 500 characters or fewer.")
      expect(body).toContainElement(error)
      expect(footer).toContainElement(within(dialog).getByRole("button", { name: "I confirm" }))
    })

    it("the basis textarea grows from 64px to 192px, then scrolls inside, and keeps wrapping unbroken text", async () => {
      const { user } = openStackPosts()
      const { basis } = await openDialog(user, "Record permitted use")
      expect(basis).toHaveClass("min-h-16", "max-h-48", "overflow-y-auto", "field-sizing-content", "[overflow-wrap:anywhere]")
      expect(basis).not.toHaveAttribute("maxlength")
    })

    it("focus on the first invalid field and on the dialog alert scrolls it into view inside the body (nearest, instant)", async () => {
      const calls: { el: Element; options: unknown }[] = []
      const original = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
        calls.push({ el: this, options })
      }
      try {
        const { user } = openStackPosts()
        server.use(http.put(ALERT_FEED_VERIFICATION_PATH, () => apiErrorResponse("internal_error")))
        const { dialog, basis, submit } = await openDialog(user, "Record permitted use")
        await submit()
        // The dialog moves focus in an effect after the failed submit settles; under load the assertion
        // can run one tick early, which is what made this test flaky on CI.
        await waitFor(() => expect(basis).toHaveFocus())
        expect(calls).toContainEqual({ el: basis, options: { block: "nearest" } })

        await user.type(basis, "Reviewed Google Alerts terms.")
        await submit()
        const alert = await within(dialog).findByRole("alert")
        await waitFor(() => expect(alert).toHaveFocus())
        expect(dialog.querySelector('[data-slot="verify-dialog-body"]')).toContainElement(alert)
        expect(calls).toContainEqual({ el: alert, options: { block: "nearest" } })
      } finally {
        Element.prototype.scrollIntoView = original
      }
    })

    it("the cap applies to the verification dialog only: the remove dialog keeps the shared defaults", async () => {
      const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed()] } })
      const feeds = await loadedFeeds()
      await user.click(within(feeds).getByRole("button", { name: /^Remove React posts/ }))
      const dialog = await screen.findByRole("alertdialog", { name: "Remove this Alert feed?" })
      expect(dialog).not.toHaveClass("max-h-[calc(100dvh-2rem)]")
      expect(dialog.querySelector('[data-slot="verify-dialog-body"]')).toBeNull()
    })
  })

  it.each([
    ["a 4xx with a message", () => apiErrorResponse("csrf_invalid"), "The request is missing a valid CSRF token."],
    ["a 500", () => apiErrorResponse("internal_error"), "Couldn't save your confirmation. Nothing changed. Try again."],
    ["a 503 service_unavailable (no busy slot on the verification save)", () => apiErrorResponse("service_unavailable"), "Couldn't save your confirmation. Nothing changed. Try again."],
    ["a network failure", () => HttpResponse.error(), "Couldn't save your confirmation. Nothing changed. Try again."],
  ])("@ac-1.2 %s shows an alert in the dialog and keeps the input", async (_, reply, shown) => {
    const { user } = openStackPosts()
    server.use(http.put(ALERT_FEED_VERIFICATION_PATH, reply))
    const { basis, submit, dialog } = await openDialog(user, "Record permitted use")
    await user.type(basis, "Reviewed Google Alerts terms.")
    await submit()
    const alert = await within(dialog).findByRole("alert")
    expect(alert).toHaveTextContent(shown)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(basis).toHaveValue("Reviewed Google Alerts terms.")
  })
})

describe("Alert feeds (alert-feeds.feature)", () => {
  it("@ac-4.1 @ac-4.4 @ac-1.2 registers a feed with a label: toast, row with mask and last read, form cleared, posts refetched", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct, registrationFetch: { storedPosts: 2 } } })
    const feeds = await loadedFeeds()
    const f = await register(user, feeds, FEED_A, "React posts")

    expect(await findToast("Alert feed added.")).toBeInTheDocument()
    const row = await within(feeds).findByRole("listitem", { name: "React posts, feed ending 6 5 4 3 2 1" })
    expect(row).toHaveTextContent("React posts")
    expect(row).toHaveTextContent("…654321")
    expect(row).toHaveTextContent("Last read 21 Oct 2026, 14:00 WAT")
    expect(within(row).queryByText("Failing")).not.toBeInTheDocument()
    expect(within(feeds).getByText("1 of 10")).toBeVisible()
    expect(f.url).toHaveValue("")
    expect(f.label).toHaveValue("")
    expect(f.url).toHaveFocus()
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toHaveLength(1)
    const posts = await loadedPosts()
    expect(await within(posts).findByRole("listitem", { name: /^Registration post 1/ })).toBeVisible()
    expect(within(posts).getAllByText("from React posts")).toHaveLength(2)
  })

  it("@ac-7.4 after registration the full URL is gone from the page, storage and a reload", async () => {
    const { user, unmount } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    await register(user, feeds, FEED_A, "React posts")
    await within(feeds).findByRole("listitem", { name: /^React posts/ })
    await waitFor(() => expect(document.documentElement.outerHTML).not.toContain(FULL_URL_DIGITS))
    expect(document.documentElement.outerHTML).not.toContain("/alerts/feeds/0")
    expect(JSON.stringify({ ...localStorage })).not.toContain(FULL_URL_DIGITS)
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(FULL_URL_DIGITS)
    expect(document.title).toBe("Find jobs · Eve")
    unmount()
  })

  it("@ac-4.1 a feed with no label (or a blank label) shows as Alert feed with its last 6 digits", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    await register(user, feeds, FEED_A, "    ")
    expect(await within(feeds).findByRole("listitem", { name: "Alert feed, feed ending 6 5 4 3 2 1" })).toHaveTextContent("Alert feed…654321")
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)[0].body).toEqual({ url: FEED_A, label: null })
  })

  it("@ac-4.2 spaces around the URL are trimmed before sending", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    await register(user, feeds, `   ${FEED_A}  `, "React posts")
    await findToast("Alert feed added.")
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)[0].body).toEqual({ url: FEED_A, label: "React posts" })
  })

  it.each([
    "http://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://www.google.co.uk/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://WWW.GOOGLE.COM/alerts/feeds/01234567890123456789/9876543210987654321",
    `${FEED_A}/`,
    `${FEED_A}?hl=en`,
    `${FEED_A}#top`,
    "https://user:pw@www.google.com/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://www.google.com:443/alerts/feeds/01234567890123456789/9876543210987654321",
    "https://www.google.com/alerts/feeds/01234567890123456789",
    "https://www.google.com/alerts/feeds/0123456789abcdef/9876543210987654321",
    "https://www.google.com/search?q=react",
    "https://www.linkedin.com/feed/",
    "www.google.com/alerts/feeds/01234567890123456789/9876543210987654321",
    "",
  ])("@ac-4.2 @ac-1.3 %j is refused on the URL field before any request", async (url) => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    const f = await register(user, feeds, url, "React posts")
    expect(within(feeds).getByText(FORMAT_ERR)).toHaveAttribute("role", "alert")
    expect(f.url).toHaveAttribute("aria-invalid", "true")
    expect(f.url).toHaveAccessibleDescription(expect.stringContaining(FORMAT_ERR))
    expect(f.url).toHaveFocus()
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toEqual([])
  })

  it("@ac-4.1 @ac-1.3 a 61-character label is refused on the label field; 60 + padding is accepted", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    const f = await register(user, feeds, FEED_A, "a".repeat(61))
    expect(within(feeds).getByText("Use 60 characters or fewer.")).toBeVisible()
    expect(f.label).toHaveAccessibleDescription(expect.stringContaining("Use 60 characters or fewer."))
    expect(f.label).toHaveFocus()
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toEqual([])
    // Errors re-check on change once shown.
    await user.clear(f.label)
    await user.type(f.label, `    ${"a".repeat(60)}    `)
    expect(within(feeds).queryByText("Use 60 characters or fewer.")).not.toBeInTheDocument()
    await user.click(f.add())
    expect(await findToast("Alert feed added.")).toBeInTheDocument()
  })

  it("@ac-4.1 @ac-1.3 SEC-E5-06 a pasted label with a tab shows the tab-or-hidden-character error; nothing is sent", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    const f = form(feeds)
    await user.type(f.url, FEED_A)
    await user.click(f.label)
    await user.paste("React\tposts")
    await user.click(f.add())
    expect(within(feeds).getByText(LABEL_CHARS)).toBeVisible()
    expect(f.label).toHaveAccessibleDescription(expect.stringContaining(LABEL_CHARS))
    expect(f.label).toHaveValue("React\tposts")
    expect(f.label).toHaveFocus()
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toEqual([])
  })

  it.each([
    ["U+0080 (C1)", "React\u0080posts"],
    ["U+202E at the start (bidi)", "\u202eReact posts"],
    ["U+2060 (word joiner)", "React\u2060posts"],
    ["U+FEFF inside", "React\ufeffposts"],
  ])("@ac-4.1 @ac-1.3 SEC-E5F-02 a pasted label with %s shows C-SP-FEED-LABEL-ERR-CHARS; nothing is sent", async (_, pasted) => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    const f = form(feeds)
    await user.type(f.url, FEED_A)
    await user.click(f.label)
    await user.paste(pasted)
    await user.click(f.add())
    expect(within(feeds).getByText(LABEL_CHARS)).toBeVisible()
    expect(f.label).toHaveValue(pasted)
    expect(f.label).toHaveFocus()
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toEqual([])
  })

  it("@ac-4.1 SEC-E5F-02 a label with ZWNJ and a ZWJ family emoji is registered as typed", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    const f = form(feeds)
    const label = "\u0645\u06cc\u200c\u062e \u{1f468}\u200d\u{1f469}\u200d\u{1f467}"
    await user.type(f.url, FEED_A)
    await user.click(f.label)
    await user.paste(label)
    await user.click(f.add())
    expect(await findToast("Alert feed added.")).toBeInTheDocument()
    expect(stack.state.feeds[0]?.label).toBe(label)
  })

  it("@ac-4.1 SEC-E5-06 a server invalid_characters on the label reads C-SP-FEED-LABEL-ERR-CHARS", async () => {
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    server.use(
      http.post(ALERT_FEEDS_PATH, () =>
        HttpResponse.json(
          { error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "label", position: null, problem: "invalid_characters" }] } },
          { status: 400 }
        )
      )
    )
    const feeds = await loadedFeeds()
    await register(user, feeds, FEED_A, "React posts")
    expect(await within(feeds).findByText(LABEL_CHARS)).toBeVisible()
  })

  it("@ac-4.1 CR-E5-04 label length counts code points: 60 emoji are accepted, 61 refused", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    const f = form(feeds)
    await user.type(f.url, FEED_A)
    await user.click(f.label)
    await user.paste("😀".repeat(61))
    await user.click(f.add())
    expect(within(feeds).getByText("Use 60 characters or fewer.")).toBeVisible()
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toEqual([])
    await user.clear(f.label)
    await user.paste("😀".repeat(60))
    await user.click(f.add())
    expect(await findToast("Alert feed added.")).toBeInTheDocument()
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)[0]?.body).toEqual({ url: FEED_A, label: "😀".repeat(60) })
  })

  it("@ac-4.3 @ac-1.2 a duplicate is refused with the API's error and keeps the typed URL and label", async () => {
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ url: FEED_A, label: "React posts" })] } })
    const feeds = await loadedFeeds()
    const f = await register(user, feeds, FEED_A, "React posts")
    expect(await within(feeds).findByText("This feed is already registered.")).toBeVisible()
    expect(f.url).toHaveValue(FEED_A)
    expect(f.label).toHaveValue("React posts")
    expect(within(feeds).getAllByRole("listitem")).toHaveLength(1)
  })

  it("@ac-4.3 the 10th feed is accepted; an 11th is refused before any request, with the form still enabled", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => storedFeed({ url: `https://www.google.com/alerts/feeds/1/${i}`, label: `Feed ${i}` }))
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: nine } })
    const feeds = await loadedFeeds()
    await register(user, feeds, FEED_A, "Tenth")
    await findToast("Alert feed added.")
    expect(await within(feeds).findByText("10 of 10")).toBeVisible()

    const f = await register(user, feeds, FEED_B, "Eleventh")
    expect(f.add()).toBeEnabled()
    expect(within(feeds).getByText("The limit is 10 Alert feeds. Remove one to add another.")).toBeVisible()
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toHaveLength(1)
  })

  it.each([
    ["not_reachable", "Not reachable. Eve couldn't connect to Google. Nothing was saved. Try again shortly."],
    ["unexpected_response", "Unexpected response. Google didn't send the feed. Nothing was saved. Check the alert's RSS link."],
    ["redirected", "Redirected (not followed). Google pointed Eve elsewhere. Nothing was saved. Copy the RSS link again from Google Alerts."],
    ["not_a_feed", "Not a feed. Google sent back a page, not a feed. Nothing was saved. Check the RSS link."],
    ["too_large", "Too large. The feed is over Eve's size limit. Nothing was saved."],
    ["timed_out", "Timed out. Google didn't answer in time. Nothing was saved. Try again."],
  ] as const)("@ac-4.4 a registration fetch refused with %s shows its line on the URL field and keeps the input", async (code, line) => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct, registrationFetch: code } })
    const feeds = await loadedFeeds()
    const f = await register(user, feeds, FEED_A, "React posts")
    expect(await within(feeds).findByText(line)).toBeVisible()
    await waitFor(() => expect(f.url).toHaveFocus())
    expect(f.url).toHaveAttribute("aria-invalid", "true")
    expect(f.url).toHaveValue(FEED_A)
    expect(f.label).toHaveValue("React posts")
    expect(stack.state.feeds).toEqual([])
    expect(within(feeds).getByText("No alert feeds yet. Add a Google Alerts feed to see posts from your field.")).toBeVisible()
  })

  it("@ac-3.3 a not-verified refusal (409) shows the API message verbatim above Add", async () => {
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    server.use(http.post(ALERT_FEEDS_PATH, () => apiErrorResponse("alert_feeds_not_verified")))
    const feeds = await loadedFeeds()
    await register(user, feeds, FEED_A, "React posts")
    const alert = await within(feeds).findByRole("alert")
    expect(alert).toHaveTextContent("Record the permitted-use verification for Google Alerts feeds before registering a feed.")
    await waitFor(() => expect(alert).toHaveFocus())
  })

  it.each([
    ["a 500", () => apiErrorResponse("internal_error")],
    ["a 502 with no JSON body", () => new HttpResponse("Bad gateway", { status: 502, headers: { "content-type": "text/html" } })],
    ["a network failure", () => HttpResponse.error()],
  ])("@ac-4.4 @ac-1.2 %s on registration shows C-SP-FEED-ERR-NET and keeps the input", async (_, reply) => {
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    server.use(http.post(ALERT_FEEDS_PATH, reply))
    const feeds = await loadedFeeds()
    const f = await register(user, feeds, FEED_A, "React posts")
    expect(await within(feeds).findByRole("alert")).toHaveTextContent("Couldn't add the Alert feed. Nothing was saved. Try again.")
    expect(f.url).toHaveValue(FEED_A)
  })

  it("@ac-4.4 @ac-1.2 SEC-E5F-04 a busy 503 shows C-SP-FEED-ERR-BUSY, focuses it, keeps the input and sends no second registration", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct, registrationBusy: 1 } })
    const feeds = await loadedFeeds()
    const f = await register(user, feeds, FEED_A, "React posts")
    const alert = await within(feeds).findByRole("alert")
    expect(alert).toHaveTextContent("Eve was busy for a moment. Nothing was saved. Try again in a few seconds.")
    expect(alert).not.toHaveTextContent("The service is unavailable")
    await waitFor(() => expect(alert).toHaveFocus())
    expect(f.url).toHaveValue(FEED_A)
    expect(f.label).toHaveValue("React posts")
    expect(within(feeds).queryByRole("listitem", { name: /^React posts/ })).not.toBeInTheDocument()
    expect(stack.state.feeds).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toHaveLength(1)
  })

  it("@ac-4.4 SEC-E5F-04 retrying a busy registration once the lock is free registers the feed once", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct, registrationBusy: 1 } })
    const feeds = await loadedFeeds()
    const f = await register(user, feeds, FEED_A, "React posts")
    await within(feeds).findByText("Eve was busy for a moment. Nothing was saved. Try again in a few seconds.")
    await user.click(f.add())
    expect(await findToast("Alert feed added.")).toBeInTheDocument()
    expect(stack.state.feeds.filter((feed) => feed.url === FEED_A)).toHaveLength(1)
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toHaveLength(2)
    expect(within(feeds).queryByText("Eve was busy for a moment. Nothing was saved. Try again in a few seconds.")).not.toBeInTheDocument()
  })

  it("@ac-4.4 double-submitting sends one registration (button busy while checking)", async () => {
    const { user, stack } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const real = stack.handlers.find((h) => h.info.method === "POST")!
    server.use(
      http.post(ALERT_FEEDS_PATH, async (info) => {
        await gate
        return (await real.run({ request: info.request, requestId: info.requestId }))?.response
      })
    )
    const feeds = await loadedFeeds()
    const f = form(feeds)
    await user.type(f.url, FEED_A)
    await user.click(f.add())
    expect(await within(feeds).findByRole("button", { name: "Checking feed…" })).toHaveAttribute("aria-busy", "true")
    expect(f.url).toHaveAttribute("readonly")
    await user.click(f.add())
    release()
    await findToast("Alert feed added.")
    expect(stack.requestsTo("POST", ALERT_FEEDS_PATH)).toHaveLength(1)
  })

  it("@ac-4.6 each feed shows label, mask and last read; a failing feed shows the badge, reason and time", async () => {
    openStackPosts({
      stack: {
        verification: verifiedOn20Oct,
        feeds: [
          storedFeed({ url: FEED_A, label: "React posts", lastReadAt: "2026-10-21T13:00:00.000Z" }),
          storedFeed({
            url: FEED_B,
            label: null,
            lastReadAt: "2026-10-21T07:00:00.000Z",
            failure: { reason: "redirected", at: "2026-10-21T13:00:00.000Z" },
          }),
        ],
      },
    })
    const feeds = await loadedFeeds()
    const healthy = within(feeds).getByRole("listitem", { name: "React posts, feed ending 6 5 4 3 2 1" })
    expect(healthy).toHaveTextContent("Last read 21 Oct 2026, 14:00 WAT")
    expect(within(healthy).queryByText("Failing")).not.toBeInTheDocument()
    const failing = within(feeds).getByRole("listitem", { name: "Alert feed, feed ending 2 2 2 3 3 3" })
    expect(within(failing).getByText("Failing")).toBeVisible()
    expect(failing).toHaveTextContent("Redirected (not followed) · 21 Oct 2026, 14:00 WAT")
    expect(failing).toHaveTextContent("Last read 21 Oct 2026, 08:00 WAT")
    expect(within(feeds).getByText("2 of 10")).toBeVisible()
    expect(within(feeds).getByText("Saved URLs stay hidden. To change one, remove the feed and add the new URL.")).toBeVisible()
  })

  it.each([
    ["not_reachable", "Not reachable"],
    ["unexpected_response", "Unexpected response"],
    ["not_a_feed", "Not a feed"],
    ["too_large", "Too large"],
    ["timed_out", "Timed out"],
  ] as const)("@ac-4.6 a feed failing with %s shows %s", async (reason, phrase) => {
    openStackPosts({
      stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ failure: { reason, at: "2026-10-21T13:00:00.000Z" } })] },
    })
    const row = within(await loadedFeeds()).getByRole("listitem", { name: /^React posts/ })
    expect(row).toHaveTextContent(`${phrase} · 21 Oct 2026, 14:00 WAT`)
  })

  it("@ac-7.4 rows offer no edit, reveal or copy-URL action and the page holds no full URL", async () => {
    openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ url: FEED_A, label: "React posts" })] } })
    const row = within(await loadedFeeds()).getByRole("listitem", { name: /^React posts/ })
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Remove"])
    expect(document.body.innerHTML).not.toContain(FULL_URL_DIGITS)
  })

  it("@ac-4.8 @ac-1.2 removing a feed: confirm names the feed, toast, row gone, posts show Removed feed, focus moves on", async () => {
    const a = storedFeed({ url: FEED_A, label: "React posts" })
    const b = storedFeed({ url: FEED_B, label: "TS posts" })
    const { user, stack } = openStackPosts({
      stack: { verification: verifiedOn20Oct, feeds: [a, b], posts: [storedPost({ feedId: a.id, title: "Hooks in practice" })] },
    })
    const feeds = await loadedFeeds()
    const posts = await loadedPosts()
    expect(within(posts).getByText("from React posts")).toBeVisible()
    // The feed row lives on the Set up alerts tab; the posts stay mounted while it is hidden.
    await showTab("Alert feeds")
    await user.click(within(feeds).getByRole("button", { name: "Remove React posts, feed ending 6 5 4 3 2 1" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Remove this Alert feed?" })
    expect(dialog).toHaveTextContent(
      "Eve stops reading React posts …654321 now. Its posts stay until they age out. Adding it back needs its RSS link from Google Alerts, because Eve can't show the URL again."
    )
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus())
    await user.click(within(dialog).getByRole("button", { name: "Remove feed" }))

    expect(await findToast("Alert feed removed.")).toBeInTheDocument()
    await waitFor(() => expect(within(feeds).queryByRole("listitem", { name: /^React posts/ })).not.toBeInTheDocument())
    await waitFor(() => expect(within(feeds).getByRole("button", { name: /^Remove TS posts/ })).toHaveFocus())
    expect(stack.requestsTo("DELETE", ALERT_FEEDS_PATH)).toEqual([{ method: "DELETE", path: `${ALERT_FEEDS_PATH}/${a.id}`, body: null }])
    expect(within(feeds).getByText("1 of 10")).toBeVisible()
    // Its posts stay, on the Posts from your field tab, marked with the removed feed.
    await showTab("Posts")
    expect(await within(posts).findByText("Removed feed")).toBeVisible()
  })

  it("@ac-1.3 N-1 a newly registered row fades in over 150ms; rows present at load do not animate", async () => {
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ url: FEED_A, label: "React posts" })] } })
    const feeds = await loadedFeeds()
    const existing = within(feeds).getByRole("listitem", { name: /^React posts/ })
    expect(existing).toHaveAttribute("data-motion", "present")
    expect(existing.className).not.toMatch(/animate-/)
    await register(user, feeds, FEED_B, "TS posts")
    const added = await within(feeds).findByRole("listitem", { name: /^TS posts/ })
    expect(added).toHaveAttribute("data-motion", "entering")
    expect(added).toHaveClass("animate-in", "fade-in", "duration-150", "motion-reduce:animate-none")
    expect(within(feeds).getByRole("listitem", { name: /^React posts/ })).toHaveAttribute("data-motion", "present")
  })

  it("@ac-1.3 N-1 a removed row fades out over 120ms, out of reach, then leaves; focus never lands on it", async () => {
    const a = storedFeed({ url: FEED_A, label: "React posts" })
    const b = storedFeed({ url: FEED_B, label: "TS posts" })
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [a, b] } })
    const feeds = await loadedFeeds()
    const row = within(feeds).getByRole("listitem", { name: /^React posts/ })
    const focusedInRow: string[] = []
    row.addEventListener("focusin", (event) => focusedInRow.push((event.target as HTMLElement).outerHTML))
    await user.keyboard("{Tab}")
    within(row).getByRole("button", { name: /^Remove React posts/ }).focus()
    await user.keyboard("{Enter}")
    const dialog = await screen.findByRole("alertdialog", { name: "Remove this Alert feed?" })
    focusedInRow.length = 0
    await user.click(within(dialog).getByRole("button", { name: "Remove feed" }))
    expect(await findToast("Alert feed removed.")).toBeInTheDocument()
    await waitFor(() => expect(row).toHaveAttribute("data-motion", "leaving"))
    expect(row).toHaveClass("animate-out", "fade-out", "duration-[120ms]", "fill-mode-forwards")
    expect(row).toHaveAttribute("inert")
    expect(within(feeds).queryByRole("listitem", { name: /^React posts/ })).not.toBeInTheDocument()
    await waitFor(() => expect(within(feeds).getByRole("button", { name: /^Remove TS posts/ })).toHaveFocus())
    await waitFor(() => expect(row).not.toBeInTheDocument())
    expect(focusedInRow).toEqual([])
    expect(within(feeds).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["TS posts, feed ending 2 2 2 3 3 3"])
  })

  it("@ac-1.3 N-1 under prefers-reduced-motion rows appear and leave at once, with no animation classes", async () => {
    const matchMedia = window.matchMedia
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      ...matchMedia(query),
      matches: query === "(prefers-reduced-motion: reduce)",
    }))
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ url: FEED_A, label: "React posts" })] } })
    const feeds = await loadedFeeds()
    await register(user, feeds, FEED_B, "TS posts")
    const added = await within(feeds).findByRole("listitem", { name: /^TS posts/ })
    expect(added).toHaveAttribute("data-motion", "present")
    expect(added.className).not.toMatch(/animate-|fade-/)
    const row = within(feeds).getByRole("listitem", { name: /^React posts/ })
    await user.click(within(row).getByRole("button", { name: /^Remove React posts/ }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove feed" }))
    await findToast("Alert feed removed.")
    await waitFor(() => expect(row).not.toBeInTheDocument())
    expect(within(feeds).getAllByRole("listitem", { hidden: true })).toHaveLength(1)
  })

  it("@ac-4.8 removing the last feed moves focus to the URL input and shows the no-feeds line", async () => {
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed()] } })
    const feeds = await loadedFeeds()
    await user.click(within(feeds).getByRole("button", { name: /^Remove React posts/ }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove feed" }))
    await findToast("Alert feed removed.")
    await waitFor(() => expect(within(feeds).getByRole("textbox", { name: "Feed URL" })).toHaveFocus())
    // N-1: the last row fades out for 120ms before the no-feeds line replaces it.
    expect(await within(feeds).findByText("No alert feeds yet. Add a Google Alerts feed to see posts from your field.")).toBeVisible()
  })

  it.each([
    ["a 4xx with a message", () => HttpResponse.json({ error: { code: "bad_request", message: "Stub removal refusal." } }, { status: 400 }), "Stub removal refusal."],
    ["a 500", () => HttpResponse.json({ error: { code: "internal_error", message: "Internal error" } }, { status: 500 }), "Couldn't remove the Alert feed. Eve still reads it. Try again."],
    ["a 503 service_unavailable (no busy slot on removal)", () => apiErrorResponse("service_unavailable"), "Couldn't remove the Alert feed. Eve still reads it. Try again."],
    ["a network failure", () => HttpResponse.error(), "Couldn't remove the Alert feed. Eve still reads it. Try again."],
  ])("@ac-1.2 a failed removal (%s) shows the alert in the dialog and keeps the feed listed", async (_, reply, shown) => {
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed()] } })
    server.use(http.delete(`${ALERT_FEEDS_PATH}/:id`, reply))
    const feeds = await loadedFeeds()
    await user.click(within(feeds).getByRole("button", { name: /^Remove React posts/ }))
    const dialog = await screen.findByRole("alertdialog", { name: "Remove this Alert feed?" })
    await user.click(within(dialog).getByRole("button", { name: "Remove feed" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(shown)
    expect(screen.getByRole("alertdialog")).toBeVisible()
    expect(within(feeds).getByRole("listitem", { name: /^React posts/, hidden: true })).toBeInTheDocument()
  })

  it("@ac-7.4 @ac-4.8 changes a URL by remove and re-add with the same label", async () => {
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct, feeds: [storedFeed({ url: FEED_A, label: "React posts" })] } })
    const feeds = await loadedFeeds()
    await user.click(within(feeds).getByRole("button", { name: /^Remove React posts/ }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove feed" }))
    await findToast("Alert feed removed.")
    await register(user, feeds, FEED_B, "React posts")
    expect(await within(feeds).findByRole("listitem", { name: "React posts, feed ending 2 2 2 3 3 3" })).toHaveTextContent("…222333")
  })

  it("@ac-6.6 global pause: the note shows and registration still works", async () => {
    const { user } = openStackPosts({ globalPaused: true, stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    expect(
      await within(feeds).findByText(
        "Scheduled reads are paused. Your changes here still save. Reads restart at the next scheduled time after automation resumes."
      )
    ).toBeVisible()
    await register(user, feeds, FEED_A, "React posts")
    expect(await findToast("Alert feed added.")).toBeInTheDocument()
  })

  it("no pause note without the global pause; the description names the read times", async () => {
    openStackPosts({ stack: { verification: verifiedOn20Oct } })
    const feeds = await loadedFeeds()
    expect(within(feeds).queryByText(/Scheduled reads are paused/)).not.toBeInTheDocument()
    expect(within(feeds).getByText("Eve reads your Google Alerts feeds at 02:00, 08:00, 14:00 and 20:00 WAT. It never opens LinkedIn.")).toBeVisible()
  })

  it("@ac-1.2 writes carry the session's CSRF token", async () => {
    const seen: (string | null)[] = []
    const { user } = openStackPosts({ stack: { verification: verifiedOn20Oct } })
    server.events.on("request:start", ({ request }) => {
      if (request.method !== "GET") seen.push(request.headers.get(CSRF_HEADER))
    })
    const feeds = await loadedFeeds()
    await register(user, feeds, FEED_A, "React posts")
    await findToast("Alert feed added.")
    server.events.removeAllListeners("request:start")
    expect(seen).toEqual([TEST_CSRF_TOKEN])
  })
})
