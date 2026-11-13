import { type Page, expect, test } from "@playwright/test"

import { COPY } from "../support/copy.ts"
import { CSRF_HEADER, outboundRequests, signIn } from "../support/db.ts"
import { HFEED_A, HFEED_B, SFEED_A, atomFeed, feedRequests, hiringFeedUrl, onFeed, resetFeeds, stackFeedUrl, twoPostFeed } from "../support/feed-stand-in.ts"
import { databaseFingerprint } from "../support/hiring-db.ts"
import {
  hiringFeeds,
  hiringPostCount,
  hiringVerification,
  hiringVerificationCount,
  insertHiringFeed,
  insertStackFeed,
  resetPhase3,
  setHiringVerification,
  setSharedVerification,
  sharedVerificationExists,
  stackFeeds,
  stackPostCount,
} from "../support/hiring-feeds-db.ts"
import { isForbiddenHost, recordRequests } from "../support/hiring-page.ts"
import { setOwnStackRecord } from "../support/stack-feed-db.ts"
import { ALERT_FEEDS_PATH, HIRING_FEEDS_PATH, HIRING_VERIFICATION_PATH, HiringPhase3Page } from "../support/hiring-phase3-page.ts"
import { FORBIDDEN_ROLE_TEXT, P3 } from "../support/phase3-copy.ts"
import { ADA, BOLA } from "../support/stack.ts"
import { formatDay, watDay } from "../support/wat.ts"

/**
 * EPIC-0007 Phase 3, hiring-alert-feeds.feature r4 (browser-reachable
 * scenarios). Real web, real api and Postgres; Hiring Alert feed URLs are read
 * from support/feed-stand-in.mjs (declared loopback double behind the EPIC-0005
 * ALERT_FEED_TEST_ORIGIN seam). Ada is the Operator, Bola an invited Candidate;
 * each records her own permitted use (D14). No first-party response is stubbed.
 */
const BASIS = "Read Google's terms for Alerts RSS on 21 Oct."

test.beforeEach(async () => {
  await resetPhase3()
  await resetFeeds()
})

async function openAs(page: Page, email: string): Promise<HiringPhase3Page> {
  await signIn(page.context(), email)
  const hiring = new HiringPhase3Page(page)
  await hiring.openAndWait()
  return hiring
}

test.describe("Not recorded (HAF:314, :333, :352; HP:357)", () => {
  for (const [who, shared] of [
    [ADA.email, true],
    [ADA.email, false],
    [BOLA.email, true],
    [BOLA.email, false],
  ] as const) {
    test(`HAF-01 ${who} with no own record, shared record ${shared ? "recorded" : "not recorded"}: the confirm step, the not-confirmed hint and no form`, async ({ page }) => {
      await setSharedVerification(shared)
      const feedsResponse = page.waitForResponse((r) => new URL(r.url()).pathname === HIRING_FEEDS_PATH && r.request().method() === "GET")
      await signIn(page.context(), who)
      await page.goto("/find-jobs#set-up-alerts")
      expect(await (await feedsResponse).json()).toEqual({ verification: null, feeds: [], limit: 10, globalPaused: false }) // r2 OWN-1
      const hiring = new HiringPhase3Page(page)
      const section = hiring.feedsSection()
      // TD-RW1: no per-section panel any more. The shared "Confirm you may use these feeds" step asks, and the section
      // says there are no feeds yet and to confirm above.
      await expect(hiring.confirmStep()).toBeVisible()
      await expect(section.getByText(P3.hiringFeedsEmpty, { exact: true })).toBeVisible()
      await expect(section.getByText(P3.unconfirmedHint, { exact: true })).toBeVisible()
      await expect(hiring.confirmButton()).toBeVisible()
      await expect(hiring.feedUrlField()).toHaveCount(0)
      await expect(hiring.addFeedButton()).toHaveCount(0)
    })
  }

  test("HAF-02 the Operator and an invited Candidate see the same panel text and button (no role variant)", async ({ browser }) => {
    const texts: string[] = []
    for (const who of [ADA.email, BOLA.email]) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const hiring = await openAs(page, who)
      texts.push((await hiring.feedsSection().innerText()).trim())
      await context.close()
    }
    expect(texts[0]).toBe(texts[1])
  })

  test("HAF-03 neither the section nor the dialog names another person or a shared record, and nothing links to the Stack posts Alert feeds", async ({ page }) => {
    const hiring = await openAs(page, BOLA.email)
    await hiring.verifyMissingButton().click()
    await hiring.saveVerification("2026-10-21", BASIS)
    await expect(hiring.updateButton()).toBeVisible()
    // Repair wave 1 (G-03): the dialog is modal, so the page behind it is aria-hidden while it is open.
    // Read the dialog while open, then the section once the dialog has closed.
    await hiring.updateButton().click()
    await expect(hiring.dialog()).toBeVisible()
    const dialogText = await hiring.dialog().innerText()
    await expect(hiring.dialog().locator('a[href*="#alert-feeds"]')).toHaveCount(0)
    await hiring.dialog().getByRole("button", { name: P3.cancel, exact: true }).click()
    await expect(hiring.dialog()).toHaveCount(0)
    const sectionText = await hiring.feedsSection().innerText()
    for (const forbidden of FORBIDDEN_ROLE_TEXT) {
      expect(dialogText).not.toContain(forbidden)
      expect(sectionText).not.toContain(forbidden)
    }
    await expect(hiring.feedsSection().locator('a[href*="#alert-feeds"]')).toHaveCount(0)
  })
})

test.describe("Record and update her own permitted use (HAF:362 to :421; AC 6.6; Ada and Bola independent)", () => {
  test("HAF-04 Record opens the dialog empty: title, help, today's WAT date focused, empty basis, submit, no delete", async ({ page }) => {
    const hiring = await openAs(page, BOLA.email)
    await hiring.verifyMissingButton().click()
    const dialog = hiring.dialog()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(P3.dialogHelp, { exact: true })).toBeVisible()
    await expect(hiring.dateField()).toHaveValue(watDay())
    // Design-spec r2 H6b step 1 / EPIC-0005 F3 (design review B-1): the dialog opens with focus on the date.
    await expect(hiring.dateField()).toBeFocused()
    await expect(hiring.basisField()).toHaveValue("")
    await expect(hiring.saveButton()).toBeVisible()
    await expect(dialog.getByRole("button", { name: /delete|clear/i })).toHaveCount(0)
  })

  test("HAF-05 Bola records her own permitted use: toast, recorded line, form appears, focus to Feed URL; Ada's state is unchanged", async ({ page, browser }) => {
    const hiring = await openAs(page, BOLA.email)
    await hiring.verifyMissingButton().click()
    const response = await hiring.saveVerification("2026-10-21", BASIS)
    expect(response.status()).toBe(200)
    expect(response.request().headers()[CSRF_HEADER]).toBeTruthy()
    expect(await response.json()).toMatchObject({ verification: { verifiedOn: "2026-10-21", verificationBasis: BASIS }, feeds: [], limit: 10 })
    await expect(hiring.toasts().getByText(P3.verifySaved, { exact: true })).toBeVisible()
    await expect(hiring.toasts()).not.toContainText(BASIS)
    await expect(hiring.dialog()).toHaveCount(0)
    await expect(hiring.feedsSection().getByText(P3.verifyDone("21 Oct 2026"), { exact: true })).toBeVisible()
    await expect(hiring.feedsSection().getByRole("heading", { name: P3.feedsListTitle, exact: true })).toBeVisible()
    // TD-RW1: the one confirm step records both lists, so the form appears in both sections and focus moves to the
    // first form (the Alert feeds' Feed URL field), not to this section's.
    await expect(hiring.feedUrlField()).toBeVisible()
    await expect(page.getByRole("region", { name: P3.stackFeedsTitle, exact: true }).getByRole("textbox", { name: P3.feedUrlLabel, exact: true })).toBeFocused()
    await expect(hiring.feedsSection()).not.toContainText(BASIS)
    expect(await hiringVerification(BOLA.email)).toMatchObject({ verifiedOn: "2026-10-21", verificationBasis: BASIS })
    expect(await hiringVerification(ADA.email)).toBeNull()

    const adaContext = await browser.newContext()
    const adaPage = await adaContext.newPage()
    const ada = await openAs(adaPage, ADA.email)
    await expect(ada.verifyMissingButton()).toBeVisible()
    await adaContext.close()
  })

  test("HAF-06 Ada and Bola each record and update their own record; neither changes the other or the shared record", async ({ browser }) => {
    await setSharedVerification(false)
    const adaContext = await browser.newContext()
    const bolaContext = await browser.newContext()
    const ada = await openAs(await adaContext.newPage(), ADA.email)
    const bola = await openAs(await bolaContext.newPage(), BOLA.email)

    await ada.verifyMissingButton().click()
    await ada.saveVerification("2026-10-01", "Ada's basis")
    await expect(ada.feedsSection().getByText(P3.verifyDone("1 Oct 2026"), { exact: true })).toBeVisible()
    const adaBefore = await hiringVerification(ADA.email)

    await bola.openAndWait() // a reload lands on Search (EPIC-0015); openAndWait selects Set up alerts again
    await expect(bola.verifyMissingButton()).toBeVisible()
    await bola.verifyMissingButton().click()
    await bola.saveVerification("2026-10-21", "Bola's basis")
    await expect(bola.feedsSection().getByText(P3.verifyDone("21 Oct 2026"), { exact: true })).toBeVisible()

    expect(await hiringVerification(ADA.email)).toEqual(adaBefore)
    await ada.openAndWait()
    await expect(ada.feedsSection().getByText(P3.verifyDone("1 Oct 2026"), { exact: true })).toBeVisible()
    await ada.updateButton().click()
    await expect(ada.basisField()).toHaveValue("Ada's basis")
    await ada.dialog().getByRole("button", { name: P3.cancel, exact: true }).click()

    await bola.updateButton().click()
    await expect(bola.basisField()).toHaveValue("Bola's basis")
    await bola.saveVerification("2026-10-22", "Bola updated")
    await expect(bola.feedsSection().getByText(P3.verifyDone("22 Oct 2026"), { exact: true })).toBeVisible()
    expect(await hiringVerification(ADA.email)).toEqual(adaBefore)
    expect(await hiringVerificationCount()).toBe(2)
    expect(await sharedVerificationExists()).toBe(false)
    await adaContext.close()
    await bolaContext.close()
  })

  test("HAF-07 Update opens pre-filled; a save replaces the record and focus returns to Update", async ({ page }) => {
    await setHiringVerification(BOLA.email, "2026-10-21", BASIS)
    const hiring = await openAs(page, BOLA.email)
    await expect(hiring.feedsSection().getByText(P3.verifyDone("21 Oct 2026"), { exact: true })).toBeVisible()
    await expect(hiring.feedsSection().getByRole("button", { name: P3.verifyUpdateSr, exact: true })).toHaveText(P3.verifyUpdate)
    await expect(page.getByText(BASIS)).toHaveCount(0)
    await hiring.updateButton().click()
    await expect(hiring.dateField()).toHaveValue("2026-10-21")
    await expect(hiring.dateField()).toBeFocused() // design review B-1: focus on the date, not Close
    await expect(hiring.basisField()).toHaveValue(BASIS)
    const today = watDay()
    await hiring.saveVerification(today, "Re-read the Alerts terms.")
    await expect(hiring.toasts().getByText(P3.verifySaved, { exact: true })).toBeVisible()
    await expect(hiring.feedsSection().getByText(P3.verifyDone(formatDay(today)), { exact: true })).toBeVisible()
    await expect(hiring.updateButton()).toBeFocused()
    expect(await hiring.feedUrlField().count()).toBe(1)
    expect(await hiringVerification(BOLA.email)).toMatchObject({ verifiedOn: today, verificationBasis: "Re-read the Alerts terms." })
  })

  test("HAF-08 Cancel discards edits, sends no save and returns focus to Update", async ({ page }) => {
    await setHiringVerification(BOLA.email, "2026-10-21", BASIS)
    const hiring = await openAs(page, BOLA.email)
    const saves = recordRequests(page)
    await hiring.updateButton().click()
    await hiring.basisField().fill("Something else")
    await hiring.dialog().getByRole("button", { name: P3.cancel, exact: true }).click()
    await expect(hiring.dialog()).toHaveCount(0)
    await expect(hiring.updateButton()).toBeFocused()
    expect(saves.filter((r) => new URL(r.url()).pathname === HIRING_VERIFICATION_PATH)).toHaveLength(0)
    expect((await hiringVerification(BOLA.email))?.verificationBasis).toBe(BASIS)
  })

  for (const [name, date, basis, message] of [
    ["empty date", "", "Read Google's terms.", P3.verifyDateErr],
    ["tomorrow in WAT", watDay(1), "Read Google's terms.", P3.verifyDateFuture],
    ["empty basis", "2026-10-21", "", P3.verifyBasisErr],
    ["spaces-only basis", "2026-10-21", "   ", P3.verifyBasisErr],
    ["501-character basis", "2026-10-21", "a".repeat(501), P3.verifyBasisLong],
  ] as const) {
    test(`HAF-09 ${name}: the field error shows in the dialog, input kept, nothing saved`, async ({ page }) => {
      const hiring = await openAs(page, BOLA.email)
      await hiring.verifyMissingButton().click()
      await hiring.dateField().fill(date)
      await hiring.basisField().fill(basis)
      await hiring.saveButton().click()
      await expect(hiring.dialog().getByText(message, { exact: true })).toBeVisible()
      await expect(hiring.dateField()).toHaveValue(date)
      await expect(hiring.basisField()).toHaveValue(basis)
      expect(await hiringVerification(BOLA.email)).toBeNull()
    })
  }

  test("HAF-10 every field error at once: future date and empty basis shown together, focus to the date", async ({ page }) => {
    const hiring = await openAs(page, BOLA.email)
    await hiring.verifyMissingButton().click()
    await hiring.dateField().fill(watDay(1))
    await hiring.basisField().fill("")
    await hiring.saveButton().click()
    await expect(hiring.dialog().getByText(P3.verifyDateFuture, { exact: true })).toBeVisible()
    await expect(hiring.dialog().getByText(P3.verifyBasisErr, { exact: true })).toBeVisible()
    await expect(hiring.dateField()).toBeFocused()
  })

  test("HAF-11 a save without a valid CSRF token is 403 csrf_invalid and records nothing (HAF:545, HV:141)", async ({ page }) => {
    await signIn(page.context(), BOLA.email)
    await page.goto("/find-jobs")
    const response = await page.request.put(HIRING_VERIFICATION_PATH, { data: { verifiedOn: "2026-10-21", verificationBasis: "x" }, headers: { [CSRF_HEADER]: "not-the-token" } })
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "csrf_invalid", message: COPY.csrfInvalid } })
    expect(await hiringVerification(BOLA.email)).toBeNull()
  })

  test("HAF-12 recording and updating makes no outbound request from the api and none from the browser to linkedin.com or google.com", async ({ page }) => {
    const hiring = await openAs(page, BOLA.email)
    const browserRequests = recordRequests(page)
    const before = outboundRequests().length
    await hiring.verifyMissingButton().click()
    await hiring.saveVerification("2026-10-21", BASIS)
    await expect(hiring.updateButton()).toBeVisible()
    await hiring.updateButton().click()
    await hiring.saveVerification("2026-10-22", "Again.")
    await expect(hiring.feedsSection().getByText(P3.verifyDone("22 Oct 2026"), { exact: true })).toBeVisible()
    expect(outboundRequests().slice(before)).toEqual([])
    expect(await feedRequests()).toEqual([])
    expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
  })
})

test.describe("Register a Hiring Alert feed (HAF:47, :74, :82, :971)", () => {
  test("HAF-13 Ada registers HFEED_A with a label: toast, row with label and last 6 digits, one request to the stand-in, posts stored as Hiring posts", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await onFeed(HFEED_A, { kind: "body", body: twoPostFeed() })
    const hiring = await openAs(page, ADA.email)
    const browserRequests = recordRequests(page)
    const before = outboundRequests().length
    const response = await hiring.registerFeed(HFEED_A, "Frontend hiring")
    expect(response.status()).toBe(201)
    await expect(hiring.toasts().getByText(P3.feedAdded, { exact: true })).toBeVisible()
    await expect(hiring.feedRow("Frontend hiring", "123456")).toBeVisible()
    await expect(hiring.feedsSection().getByText(P3.feedsCount(1), { exact: true })).toBeVisible()
    await expect(hiring.feedUrlField()).toHaveValue("")
    await expect(hiring.feedUrlField()).toBeFocused()
    expect(await feedRequests(HFEED_A)).toHaveLength(1)
    expect(await hiringPostCount(ADA.email)).toBe(2)
    expect(await stackPostCount(ADA.email)).toBe(0)
    expect(outboundRequests().slice(before)).toEqual([])
    expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
  })

  test("HAF-14 an unlabelled feed shows \"Hiring Alert feed\" and the last 6 digits; the full URL never renders after reload", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await onFeed(HFEED_A, { kind: "body", body: atomFeed([]) })
    const hiring = await openAs(page, ADA.email)
    await hiring.registerFeed(HFEED_A)
    await expect(hiring.feedRow(P3.feedFallbackName, "123456")).toBeVisible()
    await hiring.openAndWait()
    await expect(hiring.feedRow(P3.feedFallbackName, "123456")).toBeVisible()
    expect(await page.content()).not.toContain("5555555555555123456")
    const list = await page.request.get(HIRING_FEEDS_PATH)
    expect(await list.text()).not.toContain("alerts/feeds")
  })

  test("HAF-15 each Candidate sees only her own feeds (HAF:990)", async ({ browser }) => {
    await setHiringVerification(ADA.email)
    await setHiringVerification(BOLA.email)
    await insertHiringFeed(ADA.email, HFEED_A, "Ada frontend hiring", "timed_out")
    await insertHiringFeed(BOLA.email, HFEED_B, "Bola backend hiring")
    const context = await browser.newContext()
    const bola = await openAs(await context.newPage(), BOLA.email)
    await expect(bola.feedRow("Bola backend hiring", "777888")).toBeVisible()
    await expect(bola.feedRows()).toHaveCount(1)
    await expect(bola.feedsSection()).not.toContainText("Ada frontend hiring")
    await context.close()
  })
})

test.describe("Limit, duplicate and the other list (HAF:94 to :164, :254 to :294, :841)", () => {
  test("HAF-16 the 10th feed is accepted; the 11th shows C-HP-FEED-ERR-LIMIT, keeps the input and makes no request", async ({ page }) => {
    await setHiringVerification(ADA.email)
    for (let n = 1; n <= 9; n += 1) await insertHiringFeed(ADA.email, hiringFeedUrl(n), `Feed ${n}`)
    await onFeed(HFEED_A, { kind: "body", body: atomFeed([]) })
    await onFeed(HFEED_B, { kind: "body", body: atomFeed([]) })
    const hiring = await openAs(page, ADA.email)
    expect((await hiring.registerFeed(HFEED_A, "Tenth")).status()).toBe(201)
    await expect(hiring.feedsSection().getByText(P3.feedsCount(10), { exact: true })).toBeVisible()
    // Repair wave 1 (G-04): design-spec r2 B3 step 8 and HAF:266 refuse the 11th before any request,
    // so the browser sends no POST (the server's 400 limit_reached is covered by qa-hiring-registration "cap").
    const browserRequests = recordRequests(page)
    await hiring.feedUrlField().fill(HFEED_B)
    await hiring.feedLabelField().fill("Eleventh")
    await hiring.addFeedButton().click()
    const limitError = hiring.feedsSection().getByText(P3.feedErrLimit, { exact: true })
    await expect(limitError).toBeVisible()
    await expect(hiring.feedUrlField()).toHaveValue(HFEED_B)
    await expect(hiring.feedLabelField()).toHaveValue("Eleventh")
    await expect(hiring.addFeedButton()).toBeEnabled()
    await page.waitForTimeout(500)
    expect(browserRequests.filter((r) => r.method() === "POST" && new URL(r.url()).pathname === HIRING_FEEDS_PATH)).toHaveLength(0)
    expect(await feedRequests(HFEED_B)).toHaveLength(0)
    expect(await hiringFeeds(ADA.email)).toHaveLength(10)
  })

  test("HAF-17 Ada at 10 does not block Bola (cap per Candidate, D5)", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await setHiringVerification(BOLA.email)
    for (let n = 1; n <= 10; n += 1) await insertHiringFeed(ADA.email, hiringFeedUrl(n))
    await onFeed(HFEED_A, { kind: "body", body: atomFeed([]) })
    const hiring = await openAs(page, BOLA.email)
    expect((await hiring.registerFeed(HFEED_A)).status()).toBe(201)
  })

  test("HAF-18 10 Stack posts feeds do not block a Hiring feed", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await setOwnStackRecord(ADA.email)
    for (let n = 1; n <= 10; n += 1) await insertStackFeed(ADA.email, stackFeedUrl(n))
    await onFeed(HFEED_A, { kind: "body", body: atomFeed([]) })
    const hiring = await openAs(page, ADA.email)
    expect((await hiring.registerFeed(HFEED_A)).status()).toBe(201)
    expect(await stackFeeds(ADA.email)).toHaveLength(10)
  })

  test("HAF-19 a URL already a Hiring feed shows the EPIC-0005 duplicate error and makes no request", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await insertHiringFeed(ADA.email, HFEED_A, "Existing")
    await onFeed(HFEED_A, { kind: "body", body: atomFeed([]) })
    const hiring = await openAs(page, ADA.email)
    expect((await hiring.registerFeed(HFEED_A)).status()).toBe(400)
    await expect(hiring.feedsSection().getByText(P3.feedUrlErrDup, { exact: true })).toBeVisible()
    expect(await feedRequests(HFEED_A)).toHaveLength(0)
  })

  test("HAF-20 a URL already a Stack posts feed: C-HP-FEED-ERR-OTHER-LIST under the URL, input kept, no request, nothing stored", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await setOwnStackRecord(ADA.email)
    await insertStackFeed(ADA.email, SFEED_A, "React posts")
    await onFeed(SFEED_A, { kind: "body", body: atomFeed([]) })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.feedsSection()).not.toContainText("React posts")
    const response = await hiring.registerFeed(SFEED_A, "Hiring copy")
    expect(response.status()).toBe(400)
    expect(await response.json()).toMatchObject({ error: { fieldErrors: [{ field: "url", position: null, problem: "in_other_list" }] } })
    await expect(hiring.feedsSection().getByText(P3.feedErrOtherList, { exact: true })).toBeVisible()
    await expect(hiring.feedUrlField()).toHaveValue(SFEED_A)
    await expect(page.getByText(P3.stackFeedErrOtherList, { exact: true })).toHaveCount(0)
    expect(await feedRequests(SFEED_A)).toHaveLength(0)
    expect(await hiringFeeds(ADA.email)).toEqual([])
  })

  test("HAF-21 a URL already a Hiring feed in the Stack posts form: C-SP-FEED-ERR-OTHER-LIST in the duplicate slot, focus to URL, input kept", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await setOwnStackRecord(ADA.email)
    await insertHiringFeed(ADA.email, HFEED_A, "Frontend hiring")
    await onFeed(HFEED_A, { kind: "body", body: atomFeed([]) })
    await signIn(page.context(), ADA.email)
    await page.goto("/find-jobs#set-up-alerts")
    const feeds = page.getByRole("region", { name: P3.stackFeedsTitle, exact: true })
    await expect(feeds).not.toContainText("Frontend hiring")
    const url = feeds.getByRole("textbox", { name: P3.feedUrlLabel, exact: true })
    const label = feeds.getByRole("textbox", { name: P3.feedLabelLabel, exact: true })
    await url.fill(HFEED_A)
    await label.fill("React posts")
    const post = page.waitForResponse((r) => new URL(r.url()).pathname === ALERT_FEEDS_PATH && r.request().method() === "POST")
    await feeds.getByRole("button", { name: P3.stackFeedAdd, exact: true }).click()
    expect((await post).status()).toBe(400)
    const error = feeds.getByText(P3.stackFeedErrOtherList, { exact: true })
    await expect(error).toBeVisible()
    await expect(url).toBeFocused()
    await expect(url).toHaveAttribute("aria-invalid", "true")
    const describedBy = (await url.getAttribute("aria-describedby")) ?? ""
    const errorId = await error.evaluate((el) => el.closest("[id]")?.id ?? "")
    expect(describedBy.split(/\s+/)).toContain(errorId)
    await expect(url).toHaveValue(HFEED_A)
    await expect(label).toHaveValue("React posts")
    await expect(page.getByText(P3.feedErrOtherList, { exact: true })).toHaveCount(0)
    expect(await feedRequests(HFEED_A)).toHaveLength(0)
    expect(await stackFeeds(ADA.email)).toEqual([])
  })

  test("HAF-22 Bola's Stack posts feed with the same URL does not block Ada and is not revealed (HAF:164)", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await insertStackFeed(BOLA.email, SFEED_A, "BOLA-SECRET")
    await onFeed(SFEED_A, { kind: "body", body: atomFeed([]) })
    const hiring = await openAs(page, ADA.email)
    expect((await hiring.registerFeed(SFEED_A)).status()).toBe(201)
    await expect(hiring.feedsSection()).not.toContainText("BOLA-SECRET")
  })
})

test.describe("Remove (HAF:910, :919, :998; masking)", () => {
  test("HAF-23 removing a feed: the dialog names it by label and mask only, toast, row gone, posts kept with \"Removed feed\"", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await onFeed(HFEED_A, { kind: "body", body: twoPostFeed() })
    const hiring = await openAs(page, ADA.email)
    await hiring.registerFeed(HFEED_A, "Frontend hiring")
    await expect(hiring.feedRow("Frontend hiring", "123456")).toBeVisible()
    await hiring.feedsSection().getByRole("button", { name: P3.feedRemoveSr("Frontend hiring", "123456"), exact: true }).click()
    const dialog = page.getByRole("alertdialog", { name: P3.removeTitle }).or(page.getByRole("dialog", { name: P3.removeTitle }))
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("Frontend hiring")
    await expect(dialog).toContainText("…123456")
    await expect(dialog).not.toContainText("5555555555555123456")
    const del = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith(`${HIRING_FEEDS_PATH}/`) && r.request().method() === "DELETE")
    await dialog.getByRole("button", { name: P3.removeConfirm, exact: true }).click()
    expect((await del).status()).toBe(204)
    await expect(hiring.toasts().getByText(P3.removeDone, { exact: true })).toBeVisible()
    await expect(hiring.feedRows()).toHaveCount(0)
    await expect(hiring.feedsSection().getByText(P3.feedsNone, { exact: true })).toBeVisible()
    // The posts that keep the removed feed's source live on the Hiring posts tab.
    await hiring.openHiringPosts()
    await expect(hiring.postRows()).toHaveCount(2)
    for (const row of await hiring.postRows().all()) await expect(row).toContainText(P3.sourceRemoved)
    expect(await hiringPostCount(ADA.email)).toBe(2)
    expect(await page.content()).not.toContain("5555555555555123456")
  })

  test("HAF-24 removing a feed already removed in another tab changes nothing else", async ({ page }) => {
    await setHiringVerification(ADA.email)
    const id = await insertHiringFeed(ADA.email, HFEED_A, "Gone")
    await insertHiringFeed(ADA.email, HFEED_B, "Kept")
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.feedRows()).toHaveCount(2)
    const csrf = ((await (await page.request.get("/v1/session")).json()) as { csrfToken: string }).csrfToken
    expect((await page.request.delete(`${HIRING_FEEDS_PATH}/${id}`, { headers: { [CSRF_HEADER]: csrf } })).status()).toBe(204)
    await hiring.feedsSection().getByRole("button", { name: P3.feedRemoveSr("Gone", "123456"), exact: true }).click()
    const dialog = page.getByRole("alertdialog", { name: P3.removeTitle }).or(page.getByRole("dialog", { name: P3.removeTitle }))
    await dialog.getByRole("button", { name: P3.removeConfirm, exact: true }).click()
    await hiring.openAndWait()
    await expect(hiring.feedRows()).toHaveCount(1)
    await expect(hiring.feedRow("Kept", "777888")).toBeVisible()
  })

  test("HAF-25 removal without a valid CSRF token is 403 and changes no row (HV:141)", async ({ page }) => {
    await setHiringVerification(ADA.email)
    const id = await insertHiringFeed(ADA.email, HFEED_A)
    await openAs(page, ADA.email)
    const before = await databaseFingerprint()
    const response = await page.request.delete(`${HIRING_FEEDS_PATH}/${id}`, { headers: { [CSRF_HEADER]: "not-the-token" } })
    expect(response.status()).toBe(403)
    expect(await databaseFingerprint()).toEqual(before)
  })

  test("HAF-26 a registration without a valid CSRF token is 403 and changes no row (HV:141)", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await onFeed(HFEED_A, { kind: "body", body: atomFeed([]) })
    await openAs(page, ADA.email)
    const before = await databaseFingerprint()
    const response = await page.request.post(HIRING_FEEDS_PATH, { data: { url: HFEED_A }, headers: { [CSRF_HEADER]: "not-the-token" } })
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "csrf_invalid", message: COPY.csrfInvalid } })
    expect(await databaseFingerprint()).toEqual(before)
    expect(await feedRequests(HFEED_A)).toHaveLength(0)
  })
})
