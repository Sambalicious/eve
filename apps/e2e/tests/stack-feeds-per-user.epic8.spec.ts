import { type Browser, type Locator, type Page, type Request, expect, test } from "@playwright/test"

import { CSRF_HEADER, outboundRequests, signIn } from "../support/db.ts"
import { HFEED_A, SFEED_A, atomFeed, feedRequests, onFeed, resetFeeds, stackFeedUrl, twoPostFeed } from "../support/feed-stand-in.ts"
import { setHiringVerification } from "../support/hiring-feeds-db.ts"
import { isForbiddenHost, recordRequests } from "../support/hiring-page.ts"
import { HIRING_FEEDS_PATH, HIRING_VERIFICATION_PATH, HiringPhase3Page } from "../support/hiring-phase3-page.ts"
import { setAdvanced } from "../support/epic-0011-db.ts"
import { ADA, BOLA } from "../support/stack.ts"
import { SP8, bannedIn, retiredIn } from "../support/stack-feed-copy.ts"
import {
  hiringRecord,
  insertStackFeed,
  insertStackPosts,
  legacyRecord,
  ownStackRecord,
  ownStackRecordCount,
  resetEpic8,
  setLegacyRecord,
  setOwnStackRecord,
  setPaused,
  stackFeedUrls,
} from "../support/stack-feed-db.ts"
import { ALERT_FEEDS_PATH, ALERT_FEED_VERIFICATION_PATH, StackFeedPage } from "../support/stack-feed-page.ts"
import { watDay } from "../support/wat.ts"

/**
 * EPIC-0008 (run epic-0008, QA test authoring). Browser journeys for
 * stack-feed-own-record, stack-feed-registration-gate, stack-feed-migration
 * (read-only state), stack-feed-isolation and stack-feed-copy-and-unchanged r1.
 * Real web, real api, real Postgres; Stack posts Alert feed URLs are served by
 * support/feed-stand-in.mjs behind the EPIC-0005 ALERT_FEED_TEST_ORIGIN seam.
 * Ada is the Operator, Bola an invited Candidate; each records her own Stack
 * posts permitted use. No first-party response is stubbed; the failed-save row aborts
 * exactly one PUT at the network layer (QG-2). The e2e stack runs no
 * worker: scheduled reads are proved in apps/api/test/qa-stack-feed-scheduled-read.
 */
const BASIS = "Read Google's Alerts RSS terms on 27 Oct."

let browserRequests: Request[] = []

test.beforeEach(async ({ page }) => {
  await resetEpic8()
  await resetFeeds()
  browserRequests = recordRequests(page)
})

test.afterEach(() => {
  // AC 8.1: no request from the browser to linkedin.com or any google.com host; the api's only outbound host is the stand-in.
  expect(browserRequests.filter((r) => isForbiddenHost(r.url())).map((r) => r.url())).toEqual([])
  expect(outboundRequests().filter((r) => isForbiddenHost(r.url)).map((r) => r.url)).toEqual([])
})

async function openAs(page: Page, email: string): Promise<StackFeedPage> {
  await signIn(page.context(), email)
  const stack = new StackFeedPage(page)
  await stack.openAndWait()
  return stack
}

async function openInNewContext(browser: Browser, email: string): Promise<{ stack: StackFeedPage; close: () => Promise<void> }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const stack = await openAs(page, email)
  return { stack, close: () => context.close() }
}

const formatDate = (day: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`))

test.describe("Record and update her own Stack posts permitted use (own-record:35 to :120; AC 1.1, 1.3, 1.4)", () => {
  for (const who of [ADA, BOLA]) {
    test(`E8-01 ${who.email} (${who.role}) records her own record: toast, recorded line, Update, form appears; no 404 text`, async ({ page }) => {
      const stack = await openAs(page, who.email)
      // TD-RW1: the not-recorded panel is now the shared "Confirm you may use these feeds" step plus a hint in the section.
      await expect(stack.confirmStep()).toBeVisible()
      await expect(stack.feedsSection().getByText(SP8.feedsEmpty, { exact: true })).toBeVisible()
      await expect(stack.feedUrlField()).toHaveCount(0)
      await stack.recordButton().click()
      const day = watDay(-1)
      const response = await stack.saveVerification(day, BASIS)
      expect(response.status()).toBe(200)
      expect(response.request().headers()[CSRF_HEADER]).toBeTruthy()
      expect(await response.json()).toMatchObject({ verification: { verifiedOn: day, verificationBasis: BASIS }, limit: 10 })
      await expect(stack.toasts().getByText(SP8.verifySaved, { exact: true })).toBeVisible()
      await expect(stack.dialog()).toHaveCount(0)
      await expect(stack.recordedLine(formatDate(day))).toBeVisible()
      await expect(stack.updateButton()).toBeVisible()
      await expect(stack.recordButton()).toHaveCount(0)
      await expect(stack.feedUrlField()).toBeVisible()
      await expect(page.getByText(/not found/i)).toHaveCount(0)
      await expect(stack.feedsSection()).not.toContainText(BASIS)
      expect(await ownStackRecord(who.email)).toMatchObject({ verifiedOn: day, verificationBasis: BASIS })
    })
  }

  test("E8-02 'Record permitted use' opens the dialog: title, help as description, today's WAT date, empty basis, 0 of 500, submit, no delete", async ({ page }) => {
    const stack = await openAs(page, BOLA.email)
    await stack.recordButton().click()
    const dialog = stack.dialog()
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAccessibleDescription(SP8.dialogHelp)
    await expect(stack.dateField()).toHaveValue(watDay())
    await expect(stack.dateField()).toBeFocused()
    await expect(stack.basisField()).toHaveValue("")
    await expect(dialog.getByText(SP8.basisCount(0), { exact: true })).toBeVisible()
    await expect(stack.saveButton()).toBeVisible()
    await expect(dialog.getByRole("button", { name: /delete|clear/i })).toHaveCount(0)
  })

  test("E8-03 with her record: recorded line and Update (accessible name C-SP-VERIFY-UPDATE-SR); the basis is not on the page", async ({ page }) => {
    await setOwnStackRecord(BOLA.email, "2026-10-21", "Read Google's terms on 21 Oct.")
    const stack = await openAs(page, BOLA.email)
    await expect(stack.recordedLine("21 Oct 2026")).toBeVisible()
    await expect(stack.updateButton()).toHaveText(SP8.verifyUpdate)
    await expect(page.locator("body")).not.toContainText("Read Google's terms on 21 Oct.")
    // Her Stack posts list is confirmed, so its section has no confirm control (the shared step still asks for Hiring).
    await expect(stack.feedsSection().getByRole("button", { name: SP8.confirmButton, exact: true })).toHaveCount(0)
  })

  for (const who of [ADA, BOLA]) {
    test(`E8-04 ${who.email} updates: dialog pre-filled; save replaces her one record; focus returns to Update`, async ({ page }) => {
      await setOwnStackRecord(who.email, "2026-10-15", "Basis one.")
      const stack = await openAs(page, who.email)
      await stack.updateButton().click()
      await expect(stack.dateField()).toHaveValue("2026-10-15")
      await expect(stack.basisField()).toHaveValue("Basis one.")
      const day = watDay()
      expect((await stack.saveVerification(day, "Re-read the Alerts terms.")).status()).toBe(200)
      await expect(stack.toasts().getByText(SP8.verifySaved, { exact: true })).toBeVisible()
      await expect(stack.recordedLine(formatDate(day))).toBeVisible()
      await expect(stack.updateButton()).toBeFocused()
      expect(await ownStackRecord(who.email)).toMatchObject({ verifiedOn: day, verificationBasis: "Re-read the Alerts terms." })
      expect(await ownStackRecordCount()).toBe(1)
    })
  }

  test("E8-05 Cancel discards edits and sends no save", async ({ page }) => {
    await setOwnStackRecord(BOLA.email, "2026-10-15", "Read terms.")
    const stack = await openAs(page, BOLA.email)
    await stack.updateButton().click()
    await stack.basisField().fill("Something else")
    await stack.dialog().getByRole("button", { name: SP8.cancel, exact: true }).click()
    await expect(stack.dialog()).toHaveCount(0)
    expect(browserRequests.filter((r) => r.method() === "PUT" && new URL(r.url()).pathname === ALERT_FEED_VERIFICATION_PATH)).toHaveLength(0)
    expect((await ownStackRecord(BOLA.email))?.verificationBasis).toBe("Read terms.")
  })

  test("E8-06 Ada and Bola each record and update their own; neither changes the other's record or the legacy row", async ({ browser }) => {
    await setLegacyRecord(true)
    const ada = await openInNewContext(browser, ADA.email)
    const bola = await openInNewContext(browser, BOLA.email)
    await ada.stack.recordButton().click()
    await ada.stack.saveVerification("2026-10-01", "Ada's basis")
    await expect(ada.stack.recordedLine("1 Oct 2026")).toBeVisible()
    const adaBefore = await ownStackRecord(ADA.email)

    await bola.stack.openAndWait() // a reload lands on Search (EPIC-0015); openAndWait selects Set up alerts again
    await expect(bola.stack.recordButton()).toBeVisible()
    await bola.stack.recordButton().click()
    await bola.stack.saveVerification("2026-10-21", "Bola's basis")
    await expect(bola.stack.recordedLine("21 Oct 2026")).toBeVisible()
    expect(await ownStackRecord(ADA.email)).toEqual(adaBefore)

    await bola.stack.updateButton().click()
    await expect(bola.stack.basisField()).toHaveValue("Bola's basis")
    await bola.stack.saveVerification("2026-10-22", "Bola updated")
    await expect(bola.stack.recordedLine("22 Oct 2026")).toBeVisible()
    expect(await ownStackRecord(ADA.email)).toEqual(adaBefore)
    expect(await ownStackRecordCount()).toBe(2)
    expect(await legacyRecord()).toEqual({ verifiedOn: "2026-09-30", verificationBasis: "Reviewed Google Alerts terms on 30 Sep." })

    await ada.stack.openAndWait()
    await expect(ada.stack.recordedLine("1 Oct 2026")).toBeVisible()
    await ada.stack.updateButton().click()
    await expect(ada.stack.basisField()).toHaveValue("Ada's basis")
    await ada.close()
    await bola.close()
  })

  test("E8-07 Bola records, then registers her first Stack posts feed: one request to the stand-in, row shows label and last 6 digits", async ({ page }) => {
    await onFeed(SFEED_A, { kind: "body", body: twoPostFeed() })
    const stack = await openAs(page, BOLA.email)
    await stack.recordButton().click()
    await stack.saveVerification(watDay(), BASIS)
    await expect(stack.feedUrlField()).toBeFocused()
    expect((await stack.registerFeed(SFEED_A, "React posts")).status()).toBe(201)
    await expect(stack.toasts().getByText(SP8.feedAdded, { exact: true })).toBeVisible()
    await expect(stack.feedRow("React posts", "654321")).toBeVisible()
    expect(await feedRequests(SFEED_A)).toHaveLength(1)
    expect(await stackFeedUrls(BOLA.email)).toEqual([SFEED_A])
    await expect(stack.feedsSection()).not.toContainText("9876543210987654321")
  })
})

test.describe("Dialog validation and failed saves (own-record:203 to :303; AC 1.2)", () => {
  for (const [date, basis, field, message] of [
    ["", "Read Google's terms.", SP8.verifyDateLabel, SP8.verifyDateErr],
    ["tomorrow", "Read Google's terms.", SP8.verifyDateLabel, SP8.verifyDateFuture],
    ["2026-10-21", "   ", SP8.verifyBasisLabel, SP8.verifyBasisErr],
    ["2026-10-21", "a".repeat(501), SP8.verifyBasisLabel, SP8.verifyBasisLong],
    ["2026-10-21", "Read\u202Eterms", SP8.verifyBasisLabel, SP8.verifyBasisErrChars],
  ] as const) {
    test(`E8-08 Bola: ${field} shows "${message}", keeps the input and saves nothing`, async ({ page }) => {
      const stack = await openAs(page, BOLA.email)
      await stack.recordButton().click()
      const day = date === "tomorrow" ? watDay(1) : date
      await stack.dateField().fill(day)
      await stack.basisField().fill(basis)
      await stack.saveButton().click()
      await expect(stack.dialog().getByText(message, { exact: true })).toBeVisible()
      await expect(stack.dateField()).toHaveValue(day)
      await expect(stack.basisField()).toHaveValue(basis)
      expect(await ownStackRecord(BOLA.email)).toBeNull()
    })
  }

  test("E8-09 every field error at once after one submit; no 'not found' text", async ({ page }) => {
    const stack = await openAs(page, BOLA.email)
    await stack.recordButton().click()
    await stack.dateField().fill(watDay(1))
    await stack.basisField().fill("   ")
    await stack.saveButton().click()
    await expect(stack.dialog().getByText(SP8.verifyDateFuture, { exact: true })).toBeVisible()
    await expect(stack.dialog().getByText(SP8.verifyBasisErr, { exact: true })).toBeVisible()
    await expect(stack.dialog().getByText(/not found/i)).toHaveCount(0)
  })

  test("E8-10 a network failure shows C-SP-VERIFY-ERR-NET, keeps the input and changes nothing", async ({ page }) => {
    await setOwnStackRecord(BOLA.email, "2026-10-15", "Read terms.")
    const stack = await openAs(page, BOLA.email)
    await stack.updateButton().click()
    await stack.basisField().fill("Read the terms again.")
    // QG-2 (as QA-G-02 in check-this-job.phase2): the network fails while the browser stays online.
    // context.setOffline flips navigator.onLine and TanStack Query pauses the mutation instead of
    // failing it. Failure injection only, not a canned response: abort exactly one PUT at the network
    // layer (net::ERR_INTERNET_DISCONNECTED, so fetch rejects) and let every other request through.
    let aborted = 0
    // eslint-disable-next-line no-restricted-properties -- single request-abort failure injection (QG-2)
    await page.route(`**${ALERT_FEED_VERIFICATION_PATH}`, async (route) => {
      if (route.request().method() !== "PUT" || aborted > 0) return route.fallback()
      aborted += 1
      await route.abort("internetdisconnected")
    })
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    await stack.saveButton().click()
    await expect(stack.dialog().getByText(SP8.verifyErrNet, { exact: true })).toBeVisible()
    expect(aborted).toBe(1)
    await page.unrouteAll()
    await expect(stack.basisField()).toHaveValue("Read the terms again.")
    expect((await ownStackRecord(BOLA.email))?.verificationBasis).toBe("Read terms.")
  })

  test("E8-11 a save without a valid CSRF token is 403 csrf_invalid and records nothing", async ({ page }) => {
    await openAs(page, BOLA.email)
    const response = await page.request.put(ALERT_FEED_VERIFICATION_PATH, { data: { verifiedOn: "2026-10-21", verificationBasis: "x" } })
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } })
    expect(await ownStackRecord(BOLA.email)).toBeNull()
  })

  test("E8-12 double-activating 'I confirm' leaves one record and at most one toast", async ({ page }) => {
    const stack = await openAs(page, BOLA.email)
    await stack.recordButton().click()
    await stack.dateField().fill("2026-10-21")
    await stack.basisField().fill("Read terms.")
    await stack.saveButton().dblclick()
    await expect(stack.toasts().getByText(SP8.verifySaved, { exact: true })).toHaveCount(1)
    expect(await ownStackRecordCount()).toBe(1)
  })
})

test.describe("Registration is gated by her own record (registration-gate:27 to :105; isolation:123)", () => {
  test("E8-13 Bola without her record: no form, and a stale-page registration is refused with the 409 message and no request", async ({ page }) => {
    await setOwnStackRecord(BOLA.email)
    await onFeed(SFEED_A, { kind: "body", body: twoPostFeed() })
    const stack = await openAs(page, BOLA.email)
    await expect(stack.feedUrlField()).toBeVisible()
    // The record disappears behind the open page (stale data); the form is still on screen.
    await resetEpic8()
    await onFeed(SFEED_A, { kind: "body", body: twoPostFeed() })
    // QG-10: the 409 triggers a list refetch that swaps the form for the not-recorded panel ~40 ms later,
    // removing the message. Record the first moment the message is in the section, synchronously in the
    // page, before the request is made, so the transient state is observed without depending on timing.
    await page.evaluate(
      ({ sectionTitle, message, urlLabel }) => {
        type Seen = { urlValue: string | null; text: string }
        const w = window as unknown as { __e813Seen: Seen | null }
        w.__e813Seen = null
        const section = (): Element | undefined =>
          Array.from(document.querySelectorAll("[aria-labelledby]")).find((el) =>
            (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim() === sectionTitle),
          )
        const check = (): void => {
          const root = section()
          if (w.__e813Seen || !root) return
          const hit = Array.from(root.querySelectorAll("*")).some((el) => el.textContent?.trim() === message)
          if (!hit) return
          const input = Array.from(root.querySelectorAll("input")).find((el) => el.labels && Array.from(el.labels).some((l) => l.textContent?.trim() === urlLabel))
          const parts: string[] = [root.textContent ?? ""]
          for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
            for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
              const value = node.getAttribute(attr)
              if (value) parts.push(value)
            }
            for (const attr of ["aria-labelledby", "aria-describedby"]) {
              for (const id of (node.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) parts.push(document.getElementById(id)?.textContent ?? "")
            }
          }
          w.__e813Seen = { urlValue: input ? input.value : null, text: parts.join("\n") }
        }
        new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
      },
      { sectionTitle: SP8.feedsSectionTitle, message: SP8.notVerifiedMessage, urlLabel: SP8.feedUrlLabel },
    )
    // Count list reads made after the refused POST was sent (the second GET of the list).
    let posted = false
    const listReads: string[] = []
    page.on("request", (r) => {
      if (new URL(r.url()).pathname !== ALERT_FEEDS_PATH) return
      if (r.method() === "POST") posted = true
      else if (r.method() === "GET" && posted) listReads.push(r.url())
    })
    const response = await stack.registerFeed(SFEED_A)
    expect(response.status()).toBe(409)
    expect(await response.json()).toEqual({ error: { code: "alert_feeds_not_verified", message: SP8.notVerifiedMessage } })
    // The form showed the 409 message (C-SP-ERR-API) and kept SFEED_A (registration-gate:76-79).
    await expect.poll(() => page.evaluate(() => (window as unknown as { __e813Seen: unknown }).__e813Seen)).not.toBeNull()
    const seen = (await page.evaluate(() => (window as unknown as { __e813Seen: { urlValue: string | null; text: string } }).__e813Seen))!
    expect(seen.urlValue).toBe(SFEED_A)
    expect(seen.text).toContain(SP8.notVerifiedMessage)
    expect(bannedIn(seen.text)).toEqual([])
    // Her list is read again, then the not-recorded panel replaces the form (registration-gate:80-83).
    await expect.poll(() => listReads.length).toBeGreaterThanOrEqual(1)
    await expect(stack.confirmStep()).toBeVisible()
    await expect(stack.recordButton()).toBeVisible()
    await expect(stack.feedUrlField()).toHaveCount(0)
    await expect(stack.addFeedButton()).toHaveCount(0)
    expect(bannedIn(await stack.surfaceText(stack.feedsSection()))).toEqual([])
    expect(await feedRequests(SFEED_A)).toHaveLength(0)
    expect(await stackFeedUrls(BOLA.email)).toEqual([])
  })

  for (const [name, given] of [
    ["Ada has her own record", () => setOwnStackRecord(ADA.email)],
    ["the legacy shared record exists", () => setLegacyRecord(true)],
  ] as const) {
    test(`E8-14 Bola without her record (${name}): not-recorded panel and no registration form`, async ({ page }) => {
      await given()
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === ALERT_FEEDS_PATH && r.request().method() === "GET")
      await signIn(page.context(), BOLA.email)
      await page.goto("/find-jobs#set-up-alerts")
      expect((await (await response).json()).verification).toBeNull()
      const stack = new StackFeedPage(page)
      await expect(stack.recordButton()).toBeVisible()
      await expect(stack.feedUrlField()).toHaveCount(0)
      await expect(stack.addFeedButton()).toHaveCount(0)
    })
  }

  test("E8-15 the Operator without her own record (no legacy row) sees the same not-recorded panel and no form", async ({ page }) => {
    const stack = await openAs(page, ADA.email)
    await expect(stack.confirmStep()).toBeVisible()
    await expect(stack.feedUrlField()).toHaveCount(0)
  })

  test("E8-16 an invitee with her record reaches 10 feeds; the 11th shows C-SP-FEED-ERR-LIMIT with no request", async ({ page }) => {
    await setOwnStackRecord(BOLA.email)
    for (let n = 1; n <= 9; n += 1) await insertStackFeed(BOLA.email, stackFeedUrl(n))
    await onFeed(stackFeedUrl(10), { kind: "body", body: atomFeed([]) })
    await onFeed(stackFeedUrl(11), { kind: "body", body: atomFeed([]) })
    const stack = await openAs(page, BOLA.email)
    expect((await stack.registerFeed(stackFeedUrl(10))).status()).toBe(201)
    await expect(stack.feedsSection().getByRole("listitem")).toHaveCount(10)
    // registration-gate:151: the 11th is refused with the EPIC-0005 limit refusal before any request (client limit check).
    const posts: Request[] = []
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === ALERT_FEEDS_PATH && r.method() === "POST") posts.push(r)
    })
    await stack.feedUrlField().fill(stackFeedUrl(11))
    await stack.feedLabelField().fill("")
    await stack.addFeedButton().click()
    await expect(stack.feedsSection().getByText(SP8.feedErrLimit, { exact: true })).toBeVisible()
    await expect(stack.feedUrlField()).toHaveValue(stackFeedUrl(11))
    expect(posts).toHaveLength(0)
    expect(await feedRequests(stackFeedUrl(11))).toHaveLength(0)
    expect(await stackFeedUrls(BOLA.email)).toHaveLength(10)
  })
})

test.describe("Invitee legacy feeds before her own record: read-only (migration:121 to :193; design S1 read-only variant)", () => {
  test("E8-17 Bola's 2 legacy feeds are listed read-only with HASFEEDS body, count, Remove only; no form; Posts note shown", async ({ page }) => {
    await setLegacyRecord(true)
    await setOwnStackRecord(ADA.email)
    await insertStackFeed(BOLA.email, "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111222333", "Old React feed")
    await insertStackFeed(BOLA.email, "https://www.google.com/alerts/feeds/01234567890123456789/3333333333333444555")
    await insertStackPosts(BOLA.email, 2, "Legacy post")
    const stack = await openAs(page, BOLA.email)
    const feeds = stack.feedsSection()
    await expect(stack.confirmStep()).toBeVisible()
    await expect(feeds.getByText(SP8.verifyMissingBodyHasFeeds(2), { exact: true })).toBeVisible()
    await expect(feeds.getByRole("heading", { name: SP8.feedsTitle, exact: true })).toBeVisible()
    await expect(feeds.getByText(SP8.feedsCount(2), { exact: true })).toBeVisible()
    await expect(stack.feedRow("Old React feed", "222333")).toBeVisible()
    await expect(stack.feedRow(SP8.feedFallbackName, "444555")).toBeVisible()
    await expect(stack.removeButton("Old React feed", "222333")).toBeVisible()
    await expect(stack.feedUrlField()).toHaveCount(0)
    await expect(stack.addFeedButton()).toHaveCount(0)
    await expect(feeds.getByText(SP8.feedsChangeHelp, { exact: true })).toHaveCount(0)
    // The list and its unconfirmed note live on the Posts from your field tab.
    await stack.openPosts()
    await expect(stack.postsSection().getByText(SP8.postsUnverifiedNote, { exact: true })).toBeVisible()
    await expect(stack.postsSection().getByText("Legacy post 0")).toBeVisible()
    expect(await feedRequests()).toHaveLength(0)
  })

  test("E8-18 one legacy feed uses the singular body", async ({ page }) => {
    await insertStackFeed(BOLA.email, "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111222333")
    const stack = await openAs(page, BOLA.email)
    await expect(stack.feedsSection().getByText(SP8.verifyMissingBodyHasFeeds(1), { exact: true })).toBeVisible()
  })

  test("E8-19 she removes a legacy feed without a record: toast, row gone; the record is not created", async ({ page }) => {
    await insertStackFeed(BOLA.email, "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111222333", "Old React feed")
    const stack = await openAs(page, BOLA.email)
    await stack.removeButton("Old React feed", "222333").click()
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"))
    const del = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith(`${ALERT_FEEDS_PATH}/`) && r.request().method() === "DELETE")
    await dialog.getByRole("button", { name: SP8.removeConfirm, exact: true }).click()
    expect((await del).status()).toBe(204)
    await expect(stack.toasts().getByText(SP8.removeDone, { exact: true })).toBeVisible()
    await expect(stack.feedRow("Old React feed", "222333")).toHaveCount(0)
    expect(await stackFeedUrls(BOLA.email)).toEqual([])
    expect(await ownStackRecord(BOLA.email)).toBeNull()
  })

  test("E8-20 after she records, the read-only list becomes the normal list with the form; her legacy feeds are kept", async ({ page }) => {
    await insertStackFeed(BOLA.email, "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111222333", "Old React feed")
    const stack = await openAs(page, BOLA.email)
    await stack.recordButton().click()
    await stack.saveVerification(watDay(), BASIS)
    await expect(stack.feedUrlField()).toBeVisible()
    await expect(stack.feedRow("Old React feed", "222333")).toBeVisible()
    await expect(stack.feedsSection().getByText(SP8.feedsCount(1), { exact: true })).toBeVisible()
    expect(await feedRequests()).toHaveLength(0)
  })

  test("E8-21 migration:63 Ada with her copied record sees 30 Sep 2026, Update and the form", async ({ page }) => {
    await setOwnStackRecord(ADA.email, "2026-09-30", "Reviewed Google Alerts terms on 30 Sep.")
    const stack = await openAs(page, ADA.email)
    await expect(stack.recordedLine("30 Sep 2026")).toBeVisible()
    await expect(stack.updateButton()).toBeVisible()
    await expect(stack.feedUrlField()).toBeVisible()
  })
})

test.describe("Posts empty state and pause note (copy-and-unchanged:83 to :104)", () => {
  test("E8-22 no confirmation and no posts: the Posts from your field empty state; its 'Set up alerts' action focuses that section; exactly one confirm control", async ({ page }) => {
    const stack = await openAs(page, BOLA.email)
    // The empty state lives on the Posts from your field tab; its action moves the page to Set up alerts.
    await stack.openPosts()
    const posts = stack.postsSection()
    // EPIC-0011 repair wave 1 (find.stack.empty): not confirmed and no feeds read the same, with one action.
    await expect(posts.getByText(SP8.postsEmpty, { exact: true })).toBeVisible()
    await posts.getByRole("link", { name: SP8.setUpAlertsAction, exact: true }).click()
    await expect(page.getByRole("heading", { level: 2, name: SP8.setUpAlertsAction, exact: true })).toBeFocused()
    // One shared confirm step; the posts empty state adds no control of its own.
    await expect(stack.confirmButton()).toHaveCount(1)
    await expect(posts.getByRole("button", { name: SP8.confirmButton, exact: true })).toHaveCount(0)
  })

  test("E8-23 the pause note says reads restart after automation resumes, never 'after you resume automation'", async ({ page }) => {
    await setOwnStackRecord(BOLA.email)
    await setPaused(true)
    const stack = await openAs(page, BOLA.email)
    await expect(stack.feedsSection().getByText(SP8.paused, { exact: true })).toBeVisible()
    await expect(stack.feedsSection()).not.toContainText("after you resume automation")
  })

  // QA gate epic-0008-fu2 (CR-F1 / QG-F2). copy-and-unchanged r2 Outline "The Alert feeds and Hiring Alert feeds
  // pause notes follow the header pause control without a reload" (4 rows) and hiring-alert-feeds r7 Outline
  // "The Hiring Alert feeds pause note follows the header pause control without a reload" (2 rows). Real header
  // control, real PUT /v1/controls/global-pause, real feeds refetch; no stubbed response.
  const HIRING_PAUSED = "Scheduled reads are paused. You can still add feeds. Reads restart at the next scheduled time after automation resumes." // C-HP-PAUSED
  for (const view of ["Stack posts view", "Hiring view"] as const) {
    for (const action of ["pause", "resume"] as const) {
      test(`E8-31 ${view}: Ada ${action}s from the header; the ${view === "Hiring view" ? "Hiring Alert feeds" : "Alert feeds"} note follows with no reload, navigation or focus change`, async ({ page }) => {
        await setOwnStackRecord(ADA.email)
        await setHiringVerification(ADA.email)
        await setPaused(action === "resume")
        // EPIC-0011: the header pause control shows only while Advanced is on (the Operator's default after the upgrade).
        await setAdvanced(ADA.email, true)
        await signIn(page.context(), ADA.email)
        let section: Locator, note: string, feedsPath: string
        if (view === "Hiring view") {
          const hiring = new HiringPhase3Page(page)
          await hiring.openAndWait()
          section = hiring.feedsSection()
          note = HIRING_PAUSED
          feedsPath = HIRING_FEEDS_PATH
        } else {
          const stack = new StackFeedPage(page)
          await stack.openAndWait()
          section = stack.feedsSection()
          note = SP8.paused
          feedsPath = ALERT_FEEDS_PATH
        }
        const noteText = section.getByText(note, { exact: true })
        await expect(noteText).toHaveCount(action === "resume" ? 1 : 0)
        const url = page.url()
        let navigations = 0
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) navigations += 1
        })
        // The app header sits inside <main>, so Chromium exposes no banner landmark for it; scope by the element.
        const header = page.locator("header")
        const refetched = page.waitForResponse((r) => new URL(r.url()).pathname === feedsPath && r.request().method() === "GET")
        const put = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/controls/global-pause" && r.request().method() === "PUT")

        if (action === "pause") {
          await header.getByRole("button", { name: "Pause automation", exact: true }).click()
        } else {
          await header.getByRole("button", { name: "Resume automation", exact: true }).click()
          await page.getByRole("alertdialog", { name: "Resume automation?" }).getByRole("button", { name: "Resume automation", exact: true }).click()
        }
        expect((await put).status()).toBe(200)
        const feedsBody = (await (await refetched).json()) as { globalPaused: boolean }
        expect(feedsBody.globalPaused).toBe(action === "pause")

        if (action === "pause") await expect(noteText).toBeVisible()
        else await expect(noteText).toHaveCount(0)
        // The note agrees with the header pause control.
        const next = header.getByRole("button", { name: action === "pause" ? "Resume automation" : "Pause automation", exact: true })
        await expect(next).toBeVisible()
        await expect(next).toBeFocused()
        expect(page.url()).toBe(url)
        expect(navigations).toBe(0)
      })
    }
  }
})

test.describe("No Operator wording (copy-and-unchanged:27, :62, :69, :107; AC 7.1 to 7.3)", () => {
  test("E8-24 every Stack posts surface (both roles, all states) has no banned wording or retired slot in text or accessible names", async ({ browser }) => {
    const found: string[] = []
    // QG-4: while the modal is open the page regions are aria-hidden (no accessible name to locate them by),
    // so the regions are scanned only with no dialog open; with a dialog open, the dialog and toasts are scanned.
    const scanRegions = async (stack: StackFeedPage, where: string) => {
      await expect(stack.dialog()).toHaveCount(0)
      // Each list is on its own tab (EPIC-0015), so select the tab before reading its region.
      for (const [name, root, tab] of [
        ["Alert feeds", stack.feedsSection(), SP8.setUpAlertsAction],
        ["Posts", stack.postsSection(), SP8.postsTitle],
      ] as const) {
        await stack.showTab(tab)
        const text = await stack.surfaceText(root)
        for (const hit of bannedIn(text)) found.push(`${where} / ${name}: ${hit}`)
        // Retired slots, including "Verified" in recorded states (CR-E8-03: no exemption; see retiredIn).
        for (const retired of retiredIn(text)) found.push(`${where} / ${name}: retired "${retired}"`)
      }
      // Leave the page where every caller expects it: Set up alerts.
      await stack.openFeeds()
    }
    const scanToasts = async (stack: StackFeedPage, where: string) => {
      for (const hit of bannedIn(await stack.surfaceText(stack.toasts()))) found.push(`${where} / toast: ${hit}`)
    }
    const check = async (stack: StackFeedPage, where: string) => {
      await scanRegions(stack, where)
      await scanToasts(stack, where)
    }
    const checkDialog = async (stack: StackFeedPage, where: string) => {
      await expect(stack.dialog()).toBeVisible()
      for (const hit of bannedIn(await stack.surfaceText(stack.dialog()))) found.push(`${where} / dialog: ${hit}`)
      await scanToasts(stack, where)
    }

    for (const who of [ADA, BOLA]) {
      await resetEpic8()
      const none = await openInNewContext(browser, who.email)
      await check(none.stack, `${who.email} not recorded`)
      await none.stack.recordButton().click()
      await checkDialog(none.stack, `${who.email} record dialog`)
      await none.stack.dateField().fill(watDay(1))
      await none.stack.basisField().fill("")
      await none.stack.saveButton().click()
      await expect(none.stack.dialog().getByText(SP8.verifyDateFuture, { exact: true })).toBeVisible()
      await checkDialog(none.stack, `${who.email} field errors`)
      await none.stack.saveVerification(watDay(), BASIS)
      await expect(none.stack.toasts().getByText(SP8.verifySaved, { exact: true })).toBeVisible()
      await check(none.stack, `${who.email} saved toast`)
      await none.stack.updateButton().click()
      await checkDialog(none.stack, `${who.email} update dialog`)
      await none.stack.page.keyboard.press("Escape")
      await check(none.stack, `${who.email} update dialog closed`)
      await none.close()
    }

    await resetEpic8()
    await insertStackFeed(BOLA.email, stackFeedUrl(1), "Legacy")
    await insertStackPosts(BOLA.email, 1)
    const readOnly = await openInNewContext(browser, BOLA.email)
    await check(readOnly.stack, "bola read-only")
    await readOnly.close()
    expect(found).toEqual([])
  })

  test("E8-25 the Operator and an invitee without a record see the same Alert feeds text and the same enabled action", async ({ browser }) => {
    const texts: string[] = []
    for (const who of [ADA, BOLA]) {
      const { stack, close } = await openInNewContext(browser, who.email)
      await expect(stack.recordButton()).toBeEnabled()
      texts.push(await stack.surfaceText(stack.feedsSection()))
      await close()
    }
    expect(texts[0]).toBe(texts[1])
  })

  test("E8-26 no control in Alert feeds links to the Hiring view's panel or offers to ask, notify or request anyone", async ({ page }) => {
    const stack = await openAs(page, BOLA.email)
    await expect(stack.feedsSection().locator('a[href*="view=hiring"], a[href*="#hiring-alert-feeds"]')).toHaveCount(0)
    await expect(stack.feedsSection().getByRole("button", { name: /ask|notify|request/i })).toHaveCount(0)
    await expect(stack.feedsSection().getByRole("link", { name: /ask|notify|request/i })).toHaveCount(0)
  })
})

test.describe("Hiring view unaffected (own-record:401 to :442; copy-and-unchanged:150 to :170; AC 6.2)", () => {
  // Replacement for superseded E8-27 (S-01, see superseded-scenarios.md): with only her Stack posts record stored (seeded), Hiring stays unrecorded and
  // Hiring registration is still 409 with no request to the stand-in.
  test("E8-27r her Stack posts record alone (seeded) leaves Hiring unconfirmed: its form is absent and registration is still 409 with no request", async ({ page }) => {
    await onFeed(HFEED_A, { kind: "body", body: twoPostFeed() })
    await setOwnStackRecord(BOLA.email)
    await signIn(page.context(), BOLA.email)
    const hiring = new HiringPhase3Page(page)
    await hiring.openAndWait()
    await expect(hiring.confirmStep()).toBeVisible()
    expect(await hiringRecord(BOLA.email)).toBeNull()
    await expect(hiring.feedUrlField()).toHaveCount(0)
    const csrf = (await (await page.request.get("/v1/session")).json()) as { csrfToken: string }
    const response = await page.request.post(HIRING_FEEDS_PATH, { data: { url: HFEED_A, label: null }, headers: { [CSRF_HEADER]: csrf.csrfToken } })
    expect(response.status()).toBe(409)
    expect(await feedRequests(HFEED_A)).toHaveLength(0)
  })

  for (const [stackRecorded, hiringRecorded] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const) {
    test(`E8-29 Stack record ${stackRecorded} x Hiring record ${hiringRecorded}: each section follows only its own record`, async ({ page }) => {
      if (stackRecorded) await setOwnStackRecord(BOLA.email)
      if (hiringRecorded) {
        await signIn(page.context(), BOLA.email)
        const csrf = (await (await page.request.get("/v1/session")).json()) as { csrfToken: string }
        expect((await page.request.put(HIRING_VERIFICATION_PATH, { data: { verifiedOn: "2026-10-21", verificationBasis: "Hiring" }, headers: { [CSRF_HEADER]: csrf.csrfToken } })).status()).toBe(200)
      }
      const stack = await openAs(page, BOLA.email)
      await expect(stackRecorded ? stack.updateButton() : stack.recordButton()).toBeVisible()
      await expect(stack.feedUrlField()).toHaveCount(stackRecorded ? 1 : 0)
      const hiring = new HiringPhase3Page(page)
      await hiring.openAndWait()
      await expect(hiringRecorded ? hiring.updateButton() : hiring.verifyMissingButton()).toBeVisible()
      await expect(hiring.feedUrlField()).toHaveCount(hiringRecorded ? 1 : 0)
    })
  }
})

test.describe("No request to linkedin.com or google.com (copy-and-unchanged:122; AC 8.1)", () => {
  test("E8-30 record, update, register and copy a search link: the browser never requests linkedin.com or google.com; the api only reaches the stand-in", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await onFeed(SFEED_A, { kind: "body", body: twoPostFeed() })
    const stack = await openAs(page, BOLA.email)
    await stack.recordButton().click()
    await stack.saveVerification(watDay(), BASIS)
    await stack.updateButton().click()
    await stack.saveVerification(watDay(), `${BASIS} Again.`)
    expect((await stack.registerFeed(SFEED_A)).status()).toBe(201)
    const copy = page.getByRole("region", { name: "Search links", exact: true }).getByRole("button", { name: /^Copy/ }).first()
    if ((await copy.count()) > 0) await copy.click()
    expect(await feedRequests(SFEED_A)).toHaveLength(1)
    // afterEach asserts no browser or api request to a forbidden host.
  })
})
