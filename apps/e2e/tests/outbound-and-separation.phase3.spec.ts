import { expect, test } from "@playwright/test"

import { COPY, PLACEHOLDER_PATTERN } from "../support/copy.ts"
import { outboundRequests, signIn } from "../support/db.ts"
import { HFEED_A, POST_1, atomFeed, feedRequests, googleRedirect, onFeed, resetFeeds } from "../support/feed-stand-in.ts"
import { setHiringInputs } from "../support/hiring-db.ts"
import { insertHiringFeed, insertHiringPosts, resetPhase3, setHiringVerification } from "../support/hiring-feeds-db.ts"
import { isForbiddenHost, recordRequests } from "../support/hiring-page.ts"
import { HiringPhase3Page } from "../support/hiring-phase3-page.ts"
import { LINKS_COPY } from "../support/hiring-links-copy.ts"
import { P3 } from "../support/phase3-copy.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0007 Phase 3, outbound-and-separation.feature r4 (OUT:24 Phase 3 rows,
 * OUT:57 row 1) and hiring-view.feature r4 (HV:98, :105 Phases 2, 1 and 3 row,
 * :237 Hiring post title link). Browser requests are recorded with
 * page.on("request"); api requests by support/outbound-stub.mjs; Hiring feed
 * reads by support/feed-stand-in.mjs. Neither linkedin.com nor any google.com
 * host may be requested by the browser or the api.
 */
test.beforeEach(async ({ context }) => {
  await resetPhase3()
  await resetFeeds()
  await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
  await signIn(context, ADA.email)
})

test("OUT3-01 Find jobs holds the four Hiring sections in order across its tabs (Search: links, check; Hiring posts; Posts from your field; Set up alerts: the feeds) and no placeholder (HV:104 r5; replaces retired HV1-01)", async ({ page }) => {
  const hiring = new HiringPhase3Page(page)
  await hiring.open()
  // The four tabs are the page's order (EPIC-0015): Search carries the links and the check, then one list per tab,
  // then the feeds in Set up alerts.
  await expect(page.getByRole("tab")).toHaveText([COPY.searchTab, P3.postsTitle, COPY.stackSectionTitle, COPY.setUpAlerts])
  await hiring.showTab(COPY.searchTab)
  expect(await page.getByRole("heading", { level: 2 }).allInnerTexts()).toEqual([LINKS_COPY.title, COPY.checkTitle, COPY.stackLinksSectionTitle])
  await hiring.openHiringPosts()
  await expect(hiring.postsSection()).toBeVisible()
  await hiring.showTab(COPY.stackSectionTitle)
  await expect(hiring.heading(COPY.stackPostsTitle)).toBeVisible()
  await hiring.openAlerts()
  await expect(hiring.feedsSection()).toBeVisible()
  await expect(page.getByRole("main")).not.toContainText(PLACEHOLDER_PATTERN)
})

test("OUT3-02 with Phase 3 the Alerts disclosure says C-HP-ALERTQ-HOWTO-FEEDS and its \"Hiring Alert feeds\" links to the section (HSL:89 r5; replaces retired HSL-06)", async ({ page }) => {
  const hiring = new HiringPhase3Page(page)
  await hiring.openAndWait()
  // The links live on Search; the link itself moves the page to the feeds' tab.
  await hiring.showTab(COPY.searchTab)
  const links = page.getByRole("region", { name: LINKS_COPY.title, exact: true })
  await links.getByRole("button", { name: /^Google Alerts query/ }).first().click()
  await expect(links.getByText(LINKS_COPY.alertsHowToFeeds, { exact: false }).first()).toBeVisible()
  await expect(page.getByText(LINKS_COPY.alertsHowTo, { exact: true })).toHaveCount(0)
  await links.getByRole("link", { name: P3.feedsTitle, exact: true }).first().click()
  await expect(hiring.heading(P3.feedsTitle)).toBeFocused()
})

test("OUT3-03 loading the Hiring view with a feed and a post: no api outbound request, no feed read, no browser request to linkedin.com or google.com", async ({ page }) => {
  await setHiringVerification(ADA.email)
  const feed = await insertHiringFeed(ADA.email, HFEED_A, "Frontend hiring")
  await insertHiringPosts(ADA.email, [{ canonicalUrl: POST_1, title: "We're hiring", sourceFeedId: feed }])
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  const hiring = new HiringPhase3Page(page)
  await hiring.openAndWait()
  await hiring.openHiringPosts()
  await expect(hiring.postRows()).toHaveCount(1)
  await page.waitForLoadState("networkidle")
  expect(outboundRequests().slice(before)).toEqual([])
  expect(await feedRequests()).toEqual([])
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
})

test("OUT3-04 registering HFEED_A reaches only the feed stand-in: no other api host, the entries' Google redirect and LinkedIn targets never requested", async ({ page }) => {
  await setHiringVerification(ADA.email)
  await onFeed(HFEED_A, {
    kind: "body",
    body: atomFeed(Array.from({ length: 20 }, (_, i) => ({ title: `Hiring ${i}`, link: googleRedirect(`https://www.linkedin.com/posts/out-${i}-activity-1-a`), published: "2026-10-24T06:00:00Z" }))),
  })
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  const hiring = new HiringPhase3Page(page)
  await hiring.openAndWait()
  expect((await hiring.registerFeed(HFEED_A, "Frontend hiring")).status()).toBe(201)
  await hiring.openHiringPosts()
  await expect(hiring.postRows()).toHaveCount(20)
  await page.waitForLoadState("networkidle")
  expect(await feedRequests()).toEqual([{ path: new URL(HFEED_A).pathname, at: expect.any(String) }])
  expect(outboundRequests().slice(before)).toEqual([])
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
})

test("OUT3-05 a Hiring post title link to linkedin.com opens in a new tab with noopener noreferrer and is never requested (HV:237, OUT:57)", async ({ page }) => {
  await setHiringVerification(ADA.email)
  await insertHiringFeed(ADA.email, HFEED_A)
  await insertHiringPosts(ADA.email, [{ canonicalUrl: "https://www.linkedin.com/posts/x-activity-1-a", title: "Linked title" }])
  const browserRequests = recordRequests(page)
  const hiring = new HiringPhase3Page(page)
  await hiring.openAndWait()
  await hiring.openHiringPosts()
  const link = hiring.postRow("Linked title").getByRole("link", { name: /^Linked title/ })
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(link).toHaveAttribute("rel", "noopener noreferrer")
  await page.waitForLoadState("networkidle")
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
})
