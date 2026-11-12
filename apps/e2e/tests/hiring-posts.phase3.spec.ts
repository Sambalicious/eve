import { type Page, expect, test } from "@playwright/test"

import { GREENHOUSE_JOB_URL } from "../support/ats-fixtures.mjs"
import { COPY } from "../support/copy.ts"
import { JOB_POSTING_LINKS_PATH, outboundRequests, postingsWithUrl, resetPostings, setRelevance, signIn } from "../support/db.ts"
import { HFEED_A, POST_1, POST_2, resetFeeds } from "../support/feed-stand-in.ts"
import { insertHiringFeed, insertHiringPosts, resetPhase3, setHiringVerification, setSharedVerification } from "../support/hiring-feeds-db.ts"
import { isForbiddenHost, pasteRequests, recordRequests } from "../support/hiring-page.ts"
import { HiringPhase3Page } from "../support/hiring-phase3-page.ts"
import { LINKS_COPY } from "../support/hiring-links-copy.ts"
import { setOwnStackRecord } from "../support/stack-feed-db.ts"
import { setHiringInputs } from "../support/hiring-db.ts"
import { FORBIDDEN_LABELS, P3 } from "../support/phase3-copy.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * EPIC-0007 Phase 3, hiring-posts.feature r4 (list and empty states) and
 * check-this-job.feature AC 8.1/8.2 from a Hiring post row. Hiring posts are
 * stored by fixture; a row's "Check this job" goes through the real paste flow
 * (POST /v1/job-postings/links) with the Greenhouse fixture behind the outbound
 * stub. No first-party response is stubbed.
 */
test.beforeEach(async () => {
  await resetPhase3()
  await resetFeeds()
  await resetPostings()
  await setRelevance(ADA.email, ["senior_frontend"])
})

async function openAs(page: Page, email: string): Promise<HiringPhase3Page> {
  await signIn(page.context(), email)
  const hiring = new HiringPhase3Page(page)
  await hiring.openAndWait()
  return hiring
}

test.describe("Hiring posts list (HP:221 to :348)", () => {
  test("HP-01 a row shows the title link, date, matched technology, snippet, source and \"Not vetted\", and no EPIC-0006 status", async ({ page }) => {
    await setHiringVerification(ADA.email)
    const feed = await insertHiringFeed(ADA.email, HFEED_A, "Frontend hiring")
    await insertHiringPosts(ADA.email, [
      { canonicalUrl: POST_1, title: "We're hiring a frontend engineer", snippet: "Remote, React and TypeScript", publishedAt: new Date("2026-10-24T08:30:00Z"), matched: ["React"], sourceFeedId: feed },
    ])
    const hiring = await openAs(page, ADA.email)
    const row = hiring.postRow("We're hiring a frontend engineer")
    await expect(row).toHaveCount(1)
    const link = row.getByRole("link", { name: /^We're hiring a frontend engineer/ })
    await expect(link).toHaveAttribute("href", POST_1)
    await expect(link).toHaveAttribute("target", "_blank")
    await expect(link).toHaveAttribute("rel", "noopener noreferrer")
    await expect(row).toContainText("24 Oct 2026")
    await expect(row).toContainText("React")
    await expect(row).toContainText("Remote, React and TypeScript")
    await expect(row).toContainText(P3.source("Frontend hiring"))
    await expect(row.getByText(P3.notVetted, { exact: true })).toBeVisible()
    for (const label of FORBIDDEN_LABELS) await expect(hiring.postsSection().getByText(label, { exact: true })).toHaveCount(0)
  })

  test("HP-02 rows are newest first by published date, ties broken by first-seen", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await insertHiringFeed(ADA.email, HFEED_A)
    await insertHiringPosts(ADA.email, [
      { title: "Dated 22", publishedAt: new Date("2026-10-22T08:00:00Z") },
      { title: "Dated 24", publishedAt: new Date("2026-10-24T08:00:00Z") },
      { title: "Dated 23", publishedAt: new Date("2026-10-23T08:00:00Z") },
      { title: "Tie first", publishedAt: new Date("2026-10-21T08:00:00Z"), firstSeenAt: new Date("2026-10-24T08:00:00Z") },
      { title: "Tie second", publishedAt: new Date("2026-10-21T08:00:00Z"), firstSeenAt: new Date("2026-10-24T09:00:00Z") },
    ])
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.postRows()).toHaveCount(5)
    const titles = await hiring.postRows().evaluateAll((rows) => rows.map((row) => row.querySelector("a")?.textContent?.replace(/\(opens in a new tab\)/, "").trim() ?? ""))
    expect(titles.map((t) => t.replace(/\s+/g, " "))).toEqual(["Dated 24", "Dated 23", "Dated 22", "Tie second", "Tie first"])
  })

  test("HP-03 120 posts: 50 per page, \"Page 1 of 3\" in \"Hiring posts pages\", next and previous", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await insertHiringFeed(ADA.email, HFEED_A)
    await insertHiringPosts(ADA.email, Array.from({ length: 120 }, (_, i) => ({ title: `Post ${String(i).padStart(3, "0")}` })))
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.postRows()).toHaveCount(50)
    await expect(hiring.pagination().getByText(P3.pageStatus(1, 3), { exact: true })).toBeVisible()
    await hiring.pagination().getByRole("link", { name: P3.pageNext }).click()
    await expect(page).toHaveURL(/[?&]page=2/)
    await expect(hiring.pagination().getByText(P3.pageStatus(2, 3), { exact: true })).toBeVisible()
    await expect(hiring.postRows()).toHaveCount(50)
    await hiring.pagination().getByRole("link", { name: P3.pageNext }).click()
    await expect(hiring.pagination().getByText(P3.pageStatus(3, 3), { exact: true })).toBeVisible()
    await expect(hiring.postRows()).toHaveCount(20)
    await expect(hiring.heading(P3.postsTitle)).toBeFocused()
  })

  test("HP-04 each Candidate sees only her own Hiring posts (HP:334)", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await setHiringVerification(BOLA.email)
    await insertHiringFeed(BOLA.email, HFEED_A)
    await insertHiringPosts(ADA.email, [{ title: "ADA-ONE" }, { title: "ADA-TWO" }, { title: "ADA-THREE" }])
    await insertHiringPosts(BOLA.email, [{ title: "Bola one" }, { title: "Bola two" }])
    const hiring = await openAs(page, BOLA.email)
    await expect(hiring.postRows()).toHaveCount(2)
    await expect(hiring.postsSection()).not.toContainText("ADA-")
  })

  test("HP-05 Hiring posts are not in the Stack posts list", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await setOwnStackRecord(ADA.email)
    await insertHiringPosts(ADA.email, [{ canonicalUrl: POST_1, title: "Only a Hiring post" }])
    await signIn(page.context(), ADA.email)
    await page.goto("/find-jobs")
    await expect(page.getByRole("region", { name: COPY.stackPostsTitle, exact: true })).not.toContainText("Only a Hiring post")
  })
})

test.describe("Check this job from a row (AC 8.1, 8.2; CTJ row scenarios)", () => {
  const TITLE = "We're hiring a frontend engineer"

  async function withOnePost(page: Page): Promise<HiringPhase3Page> {
    await setHiringVerification(ADA.email)
    await insertHiringFeed(ADA.email, HFEED_A, "Frontend hiring")
    await insertHiringPosts(ADA.email, [{ canonicalUrl: POST_1, title: TITLE, publishedAt: new Date("2026-10-24T08:30:00Z") }])
    return openAs(page, ADA.email)
  }

  test("HP-06 the row control opens an empty application-link field (never the LinkedIn URL), focus moves to it, nothing is requested", async ({ page }) => {
    const browserRequests = recordRequests(page)
    const before = outboundRequests().length
    const hiring = await withOnePost(page)
    const control = hiring.postRow(TITLE).getByRole("button", { name: P3.rowCheckSr(TITLE), exact: true })
    await expect(control).toHaveText(P3.rowCheck)
    await expect(control).toHaveAttribute("aria-expanded", "false")
    await control.click()
    await expect(control).toHaveAttribute("aria-expanded", "true")
    const field = hiring.postsSection().getByRole("textbox", { name: P3.rowUrlLabel(TITLE), exact: true })
    await expect(field).toBeVisible()
    await expect(field).toHaveValue("")
    await expect(field).toBeFocused()
    await expect(hiring.postsSection().getByText(P3.rowHelp, { exact: true })).toBeVisible()
    await page.waitForTimeout(500)
    expect(pasteRequests(browserRequests)).toHaveLength(0)
    expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
    expect(outboundRequests().slice(before)).toEqual([])
  })

  test("HP-07 an empty submit from the row shows \"Paste a job link.\" and stores nothing", async ({ page }) => {
    const hiring = await withOnePost(page)
    await hiring.postRow(TITLE).getByRole("button", { name: P3.rowCheckSr(TITLE), exact: true }).click()
    await hiring.postsSection().getByRole("button", { name: P3.checkLink, exact: true }).click()
    await expect(hiring.postsSection().getByText(COPY.linkEmpty, { exact: true })).toBeVisible()
    expect(await postingsWithUrl(POST_1)).toEqual([])
  })

  test("HP-08 a pasted Greenhouse link goes through the paste flow: one CSRF POST with that URL, \"Job Posting saved.\" in the panel; the row is unchanged and POST_1 is never a Job Posting", async ({ page }) => {
    const hiring = await withOnePost(page)
    const browserRequests = recordRequests(page)
    await hiring.postRow(TITLE).getByRole("button", { name: P3.rowCheckSr(TITLE), exact: true }).click()
    const field = hiring.postsSection().getByRole("textbox", { name: P3.rowUrlLabel(TITLE), exact: true })
    await field.fill(GREENHOUSE_JOB_URL)
    const paste = page.waitForResponse((r) => new URL(r.url()).pathname === JOB_POSTING_LINKS_PATH && r.request().method() === "POST")
    await hiring.postsSection().getByRole("button", { name: P3.checkLink, exact: true }).click()
    const response = await paste
    expect(response.request().postDataJSON()).toEqual({ url: GREENHOUSE_JOB_URL })
    expect(response.request().headers()["x-csrf-token"]).toBeTruthy()
    await expect(hiring.postsSection().getByText(COPY.created, { exact: true })).toBeVisible()
    expect(pasteRequests(browserRequests)).toHaveLength(1)
    const stored = await postingsWithUrl(GREENHOUSE_JOB_URL)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ origin: "pasted_link", candidateEmail: ADA.email })
    expect(await postingsWithUrl(POST_1)).toEqual([])
    await expect(hiring.postRow(TITLE).getByText(P3.notVetted, { exact: true })).toBeVisible()
    expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
  })

  test("HP-09 Close returns focus to the row's control; opening another row closes the first and discards its value", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await insertHiringFeed(ADA.email, HFEED_A)
    await insertHiringPosts(ADA.email, [
      { canonicalUrl: POST_1, title: "First post", publishedAt: new Date("2026-10-24T08:30:00Z") },
      { canonicalUrl: POST_2, title: "Second post", publishedAt: new Date("2026-10-23T08:30:00Z") },
    ])
    const hiring = await openAs(page, ADA.email)
    const first = hiring.postRow("First post").getByRole("button", { name: P3.rowCheckSr("First post"), exact: true })
    const second = hiring.postRow("Second post").getByRole("button", { name: P3.rowCheckSr("Second post"), exact: true })
    await first.click()
    await hiring.postsSection().getByRole("textbox", { name: P3.rowUrlLabel("First post"), exact: true }).fill("https://example.org/x")
    await second.click()
    await expect(hiring.postsSection().getByRole("textbox", { name: P3.rowUrlLabel("First post"), exact: true })).toHaveCount(0)
    await expect(first).toHaveAttribute("aria-expanded", "false")
    await hiring.postsSection().getByRole("button", { name: P3.rowClose, exact: true }).click()
    await expect(second).toBeFocused()
    await first.click()
    await expect(hiring.postsSection().getByRole("textbox", { name: P3.rowUrlLabel("First post"), exact: true })).toHaveValue("")
  })
})

test.describe("Empty states (HP:357 to :424; AC 7.5)", () => {
  for (const [who, shared] of [
    [BOLA.email, true],
    [ADA.email, true],
    [ADA.email, false],
  ] as const) {
    test(`HP-10 ${who} with no own record (shared ${shared ? "recorded" : "not recorded"}): the Hiring posts empty state with its Set up alerts action`, async ({ page }) => {
      await setSharedVerification(shared)
      const hiring = await openAs(page, who)
      const posts = hiring.postsSection()
      // EPIC-0011 repair wave 1: not confirmed and no feeds read the same (find.hiring.empty).
      await expect(posts.getByText(P3.postsEmptyHiring, { exact: true })).toBeVisible()
      await expect(posts.getByRole("link", { name: P3.setUpAlertsAction, exact: true })).toBeVisible()
    })
  }

  test("HP-11 \"Set up alerts\" in the empty state moves focus to the Set up alerts heading, whose section holds the confirm step", async ({ page }) => {
    const hiring = await openAs(page, BOLA.email)
    await hiring.postsSection().getByRole("link", { name: P3.setUpAlertsAction, exact: true }).click()
    const heading = page.getByRole("heading", { level: 2, name: P3.setUpAlertsAction, exact: true })
    await expect(heading).toBeFocused()
    await expect(heading).toBeInViewport()
    await expect(hiring.confirmButton()).toBeVisible()
  })

  test("HP-12 after her first confirmation the empty state stays (no feeds yet) and nothing reloads", async ({ page }) => {
    const hiring = await openAs(page, BOLA.email)
    await expect(hiring.postsSection().getByText(P3.postsEmptyHiring, { exact: true })).toBeVisible()
    let navigations = 0
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1
    })
    await hiring.verifyMissingButton().click()
    await hiring.saveVerification("2026-10-21", "Read terms.")
    await expect(hiring.feedsSection().getByText(P3.verifyDone("21 Oct 2026"), { exact: true })).toBeVisible()
    await expect(hiring.postsSection().getByText(P3.postsEmptyHiring, { exact: true })).toBeVisible()
    await expect(hiring.postsSection().getByText(P3.postsEmptyWaitingTitle, { exact: true })).toHaveCount(0)
    expect(navigations).toBe(0)
  })

  test("HP-13 Ada's record does not change Bola's empty state", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await insertHiringFeed(ADA.email, HFEED_A)
    const hiring = await openAs(page, BOLA.email)
    await expect(hiring.postsSection().getByText(P3.postsEmptyHiring, { exact: true })).toBeVisible()
    await expect(hiring.postsSection().getByText(P3.postsEmptyWaitingTitle, { exact: true })).toHaveCount(0)
  })

  test("HP-14 own record, no feeds: the same empty state, whose action opens Set up alerts", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    const posts = hiring.postsSection()
    await expect(posts.getByText(P3.postsEmptyHiring, { exact: true })).toBeVisible()
    await posts.getByRole("link", { name: P3.setUpAlertsAction, exact: true }).click()
    await expect(page.getByRole("heading", { level: 2, name: P3.setUpAlertsAction, exact: true })).toBeFocused()
  })

  // Replacement for superseded HP-15 (S-03, see superseded-scenarios.md): with only Other targeted, the links section itself shows "No role family to search for".
  test("HP-15r only Other targeted: the Hiring search links section shows its own \"No role family to search for\" and its action", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await setHiringInputs(ADA.email, { families: ["other"] })
    await openAs(page, ADA.email)
    const links = page.getByRole("region", { name: LINKS_COPY.title, exact: true })
    await expect(links.getByText(LINKS_COPY.noFamilyTitle, { exact: true })).toBeVisible()
    await expect(links.getByRole("link", { name: LINKS_COPY.noFamilyAction, exact: true })).toBeVisible()
  })

  test("HP-16 feeds but no posts yet: the waiting empty state", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await insertHiringFeed(ADA.email, HFEED_A)
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.postsSection().getByText(P3.postsEmptyWaitingTitle, { exact: true })).toBeVisible()
    await expect(hiring.postsSection().getByText(P3.postsEmptyWaitingBody, { exact: true })).toBeVisible()
  })

  test("HP-17 posts from a removed feed, no feed registered: the list shows and no empty state", async ({ page }) => {
    await setHiringVerification(ADA.email)
    await insertHiringPosts(ADA.email, [{ title: "Kept one" }, { title: "Kept two" }])
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.postRows()).toHaveCount(2)
    for (const text of [P3.postsEmptyHiring, P3.postsEmptyWaitingTitle]) {
      await expect(hiring.postsSection().getByText(text, { exact: true })).toHaveCount(0)
    }
    for (const row of await hiring.postRows().all()) await expect(row).toContainText(P3.sourceRemoved)
  })

  test("HP-18 exactly one empty state at a time: no confirmation + a fixture feed + no posts shows only the Set up alerts empty state", async ({ page }) => {
    await insertHiringFeed(BOLA.email, HFEED_A)
    const hiring = await openAs(page, BOLA.email)
    await expect(hiring.postsSection().getByText(P3.postsEmptyHiring, { exact: true })).toBeVisible()
    await expect(hiring.postsSection().getByText(P3.postsEmptyWaitingTitle, { exact: true })).toHaveCount(0)
  })
})
