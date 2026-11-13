import { type Locator, type Page, expect, test } from "@playwright/test"

import { B1 } from "../support/b1-copy.ts"
import { changePreferences, freshRecord, kenyaValues, postingState, seedPosting, targetEveryFamily } from "../support/b1-db.ts"
import { resetPostings, signIn } from "../support/db.ts"
import { BOLA } from "../support/stack.ts"

/**
 * EPIC-0002 B1 (run epic-0002-b1, qa-author, qa-tests-1). Job Postings journeys
 * for the four tabs, their empty states, the All hint, the skip reasons and the
 * "Frontend" label, against the real web, api and Postgres. Bola plays Kofi.
 * Preferences change through the real PUT; postings are seeded rows.
 *
 * Gherkin (job-postings-per-candidate.feature): :360, :369, :451 (UI part),
 * :490, :507, :567, :590, :597, :603, :613, :618, :666, :682, :689, :698, :705,
 * :711, :732, :742, :757, :779, :788, :996; job-criteria-in-preferences.feature :446
 * and :455 ("on the next page load"); copy-b1 key 92 (C-JC-EMPTY-BODY rename).
 * :567 and :666 follow owner decision D46 (slice 8 design; qa-tests-2, F-QA-B1-04).
 */
const tiers = (change: Record<string, number | string>) => ({ ...(kenyaValues().roleFamilyTiers as Record<string, unknown>), ...change })

async function openPostings(page: Page, query = ""): Promise<void> {
  await page.goto(`/postings${query}`)
  await expect(page.getByRole("tablist")).toBeVisible()
}

const tab = (page: Page, name: string) => page.getByRole("tablist").getByRole("tab", { name, exact: true })
const panel = (page: Page, name: string) => page.getByRole("region", { name, exact: true })
/** Not a match's second list: the former Excluded families tab (`#excluded-families`, heading "Outside your role families"). */
const familiesSection = (page: Page) => page.getByRole("region", { name: B1.notMatchFamiliesHeading, exact: true })
// The list renders each posting twice: a table at md and up, and a CSS-hidden list below md
// (components/posting-list/ui/posting-list.tsx). Text matches take the visible copy only.
const visibleText = (scope: Page | Locator, text: string) => scope.getByText(text, { exact: true }).filter({ visible: true })
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// The status region is filled one animation frame after a view settles (use-announcer.ts); two frames
// later, a silent region is silent for good.
const settleFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))

test.beforeEach(async ({ page }) => {
  await resetPostings()
  await targetEveryFamily(BOLA.email)
  await signIn(page.context(), BOLA.email)
  await page.goto("/")
  await freshRecord(page, BOLA.email, kenyaValues())
})

test.describe("four tabs (jppc :507, :603, :613, :618; EPIC-0011 AC-4.5)", () => {
  test("B1-P01 (:507) the tabs are Good matches, Manual apply, Not a match, All in order, none with a count; the old labels are gone", async ({ page }) => {
    await openPostings(page)
    await expect(page.getByRole("tablist").getByRole("tab")).toHaveText([...B1.tabs])
    for (const name of B1.tabs) await expect(tab(page, name)).not.toHaveText(/\d/)
    await expect(page.getByText(B1.retiredSkippedTab)).toHaveCount(0)
    for (const old of B1.retiredTabs) await expect(tab(page, old)).toHaveCount(0)
  })

  test("B1-P02 (:603) an old ?tab=skipped link opens Not a match with its filter kept; excluded-family postings sit in the second list", async ({ page }) => {
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    for (let i = 0; i < 2; i += 1) await seedPosting(BOLA.email, { title: `Backend Engineer ${i}`, family: "backend", status: "skipped", skipReason: "weak_core_match" })
    for (let i = 0; i < 3; i += 1) await seedPosting(BOLA.email, { title: `Mobile Engineer ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    // Deterministic (was flaky: the page could still read "Loading…" at the first assertion). Wait for the two list reads
    // Not a match makes (skipped, then excluded_family) to settle, and for the section to leave aria-busy, before asserting.
    const isList = (tabValue: string) => (r: { url(): string; request(): { method(): string } }) => {
      const url = new URL(r.url())
      return r.request().method() === "GET" && url.pathname.endsWith("/v1/job-postings") && url.searchParams.get("tab") === tabValue && !url.searchParams.has("cursor")
    }
    const reads = Promise.all([page.waitForResponse(isList("skipped")), page.waitForResponse(isList("excluded_family"))])
    await page.goto("/postings?tab=skipped&families=backend,mobile&keyword=engineer")
    for (const response of await reads) expect(response.status()).toBe(200)
    await expect(tab(page, "Not a match")).toHaveAttribute("aria-selected", "true")
    await expect(panel(page, "Not a match")).not.toHaveAttribute("aria-busy", "true")
    await expect.poll(() => new URL(page.url()).search).toBe("?tab=not_a_match&families=backend,mobile&keyword=engineer")
    await expect(page.getByRole("searchbox", { name: B1.searchLabel }).or(page.getByRole("textbox", { name: B1.searchLabel }))).toHaveValue("engineer")
    await expect(panel(page, "Not a match").getByRole("link", { name: /^Backend Engineer 0 at / })).toBeVisible()
    // The excluded-family postings are not in the first list; they are in the "Outside your role families" section.
    await expect(panel(page, "Not a match").getByText(/^Mobile Engineer/)).toHaveCount(0)
    await expect(familiesSection(page).getByRole("link", { name: /^Mobile Engineer 0 at / })).toBeVisible()
  })

  test("B1-P03 (:613) ?tab=excluded_family selects Not a match and scrolls to the Outside your role families list", async ({ page }) => {
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    await seedPosting(BOLA.email, { title: "Mobile Engineer", family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    await openPostings(page, "?tab=excluded_family")
    await expect(tab(page, "Not a match")).toHaveAttribute("aria-selected", "true")
    await expect(familiesSection(page)).toBeInViewport()
    await expect.poll(() => new URL(page.url()).hash).toBe("#excluded-families")
  })

  test("B1-P03b ?tab=ranked opens Good matches", async ({ page }) => {
    await openPostings(page, "?tab=ranked")
    await expect(tab(page, "Good matches")).toHaveAttribute("aria-selected", "true")
  })

  for (const value of ["excluded", "excluded_families", "Skipped"]) {
    test(`B1-P04 (:618) ?tab=${value} opens Good matches and drops the tab parameter`, async ({ page }) => {
      await openPostings(page, `?tab=${value}`)
      await expect(tab(page, "Good matches")).toHaveAttribute("aria-selected", "true")
      await expect.poll(() => new URL(page.url()).searchParams.has("tab")).toBe(false)
    })
  }
})

test.describe("empty states and the All hint (jppc :590, :597, :682, :689, :698, :705, :711)", () => {
  test("B1-P05 (:682) Not a match with nothing ruled out and no family excluded: the Nothing ruled out empty state (the old Excluded families none state has no tab of its own)", async ({ page }) => {
    await seedPosting(BOLA.email, { title: "Senior React Engineer", status: "ranked" })
    await openPostings(page, "?tab=not_a_match")
    const region = panel(page, "Not a match")
    await expect(region.getByText(B1.skippedEmptyTitle, { exact: true })).toBeVisible()
    await expect(region.getByText(B1.skippedEmptyText, { exact: true })).toBeVisible()
    await expect(familiesSection(page)).toHaveCount(0)
  })

  test("B1-P06 (:689) Not a match with only excluded-family postings: the Outside your role families list shows them and the Nothing ruled out state does not contradict it", async ({ page }) => {
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    await seedPosting(BOLA.email, { title: "Senior iOS Engineer", family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    await openPostings(page, "?tab=not_a_match")
    await expect(familiesSection(page).getByRole("link", { name: /^Senior iOS Engineer at / })).toBeVisible()
    await expect(page.getByText(B1.skippedEmptyTitle, { exact: true })).toHaveCount(0)
  })

  test("B1-P07 (:698) Not a match with nothing skipped: its own empty state and no action", async ({ page }) => {
    for (let i = 0; i < 4; i += 1) await seedPosting(BOLA.email, { title: `Ranked ${i}`, status: "ranked" })
    await openPostings(page, "?tab=not_a_match")
    const region = panel(page, "Not a match")
    await expect(region.getByText(B1.skippedEmptyTitle, { exact: true })).toBeVisible()
    await expect(region.getByText(B1.skippedEmptyText, { exact: true })).toBeVisible()
    await expect(region.getByRole("link")).toHaveCount(0)
  })

  test("B1-P08 (:705) the Good matches empty state tells the user how to get matches", async ({ page }) => {
    await seedPosting(BOLA.email, { title: "Weak One", status: "skipped", skipReason: "no_core_responsibilities" })
    await openPostings(page)
    const region = panel(page, "Good matches")
    await expect(region.getByText(B1.rankedEmptyTitle, { exact: true })).toBeVisible()
    await expect(region.getByText(B1.rankedEmptyText, { exact: true })).toBeVisible()
  })

  test("B1-P09 (:711) Not a match filtered to backend when only mobile is excluded gives the filter empty state", async ({ page }) => {
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    for (let i = 0; i < 3; i += 1) await seedPosting(BOLA.email, { title: `Mobile ${i}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    await openPostings(page, "?tab=not_a_match&families=backend")
    const region = panel(page, "Not a match")
    await expect(region.getByText(B1.filterEmptyTitle, { exact: true })).toBeVisible()
    await expect(region.getByText(B1.filterEmptyText, { exact: true })).toBeVisible()
  })

  test("B1-P10 (:590) the All tab with mobile excluded shows the hint under the count, linking to ?tab=not_a_match&families=backend", async ({ page }) => {
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    await seedPosting(BOLA.email, { title: "Backend Engineer", family: "backend", status: "ranked" })
    await openPostings(page, "?tab=all&families=backend")
    const region = panel(page, "All")
    await expect(region.getByText(B1.allExcludedHint, { exact: true })).toBeVisible()
    const link = region.getByRole("link", { name: B1.allExcludedHintLink, exact: true })
    await expect(link).toHaveAttribute("href", "/postings?tab=not_a_match&families=backend")
  })

  test("B1-P11 (:597) the All tab shows no hint when no family is excluded", async ({ page }) => {
    await seedPosting(BOLA.email, { title: "Backend Engineer", family: "backend", status: "ranked" })
    await openPostings(page, "?tab=all")
    await expect(page.getByText(B1.allExcludedHint)).toHaveCount(0)
  })

  test("B1-P12 (copy key 92) the criteria empty body never uses the old tab labels", async ({ page }) => {
    await seedPosting(BOLA.email, { title: "Weak One", status: "skipped", skipReason: "weak_core_match" })
    await openPostings(page)
    await expect(page.getByText(B1.retiredSkippedTab)).toHaveCount(0)
    await expect(page.getByText("Skipped by rules")).toHaveCount(0)
  })
})

test.describe("count lines and paging (jppc :567, :666, :732)", () => {
  /** A GET /v1/job-postings response for `tabValue`, with or without a cursor. */
  const listResponse = (tabValue: string, withCursor: boolean) => (r: { url(): string }) => {
    const url = new URL(r.url())
    return url.pathname.endsWith("/v1/job-postings") && url.searchParams.get("tab") === tabValue && url.searchParams.has("cursor") === withCursor
  }
  // jppc :567 (D46, slice 8): opening on a tab shows the count line without announcing it; a tab change
  // announces it once the tab settles (postings.announce.viewSettled is the count line itself).
  // Seeds keep the <other> tab's count different from "Showing 25 of 60 postings" so the return is the announcement.
  const weak = (i: number) => ({ title: `Weak ${i}`, status: "skipped" as const, skipReason: "weak_core_match" })
  for (const { name, query, other, seed } of [
    { name: "Good matches", query: "", other: "All", seed: async () => {
      for (let i = 0; i < 60; i += 1) await seedPosting(BOLA.email, { title: `Ranked ${i}`, status: "ranked", minutesAgo: 60 + i })
      for (let i = 0; i < 2; i += 1) await seedPosting(BOLA.email, { ...weak(i), minutesAgo: 200 + i })
    } },
    { name: "Not a match", query: "?tab=not_a_match", other: "Good matches", seed: async () => {
      for (let i = 0; i < 60; i += 1) await seedPosting(BOLA.email, { ...weak(i), minutesAgo: 60 + i })
    } },
    { name: "All", query: "?tab=all", other: "Good matches", seed: async () => {
      for (let i = 0; i < 60; i += 1) await seedPosting(BOLA.email, { ...weak(i), minutesAgo: 60 + i })
    } },
  ] as const) {
    test(`B1-P13 (:567) opening on ${name} with 60 postings shows "Showing 25 of 60 postings" unannounced; after ${other} and back it is announced`, async ({ page }) => {
      await seed()
      const line = B1.countPartial(25, 60)
      const announced = page.getByRole("status").filter({ hasText: new RegExp(`^${escapeRegExp(line)}$`) })
      await openPostings(page, query)
      await expect(panel(page, name).getByText(line, { exact: true })).toBeVisible()
      await settleFrames(page)
      await expect(page.getByRole("status").filter({ hasText: line })).toHaveCount(0)

      await tab(page, other).click()
      await expect(tab(page, other)).toHaveAttribute("aria-selected", "true")
      await expect(panel(page, other)).toBeVisible()
      await expect(panel(page, other).getByText(line, { exact: true })).toHaveCount(0)
      await settleFrames(page)
      await expect(page.getByRole("status").filter({ hasText: line })).toHaveCount(0)

      await tab(page, name).click()
      await expect(panel(page, name).getByText(line, { exact: true })).toBeVisible()
      await expect(announced).toHaveCount(1)
    })
  }

  // jppc :666 (D46, slice 8 F4-8c). The real page can't be made to hold another tab's cursor without route
  // interception, which tier 3 forbids (qa.md; eslint no-restricted-properties). The server refuses a cursor
  // after a tier change the same way (400; use-postings-view.ts treats every 400 cursor alike), so that drives
  // the page here. The cross-tab 400 itself is api-tier: qa-b1-four-tabs.int-spec.ts (jppc :644).
  test("B1-P14 (:666) on Not a match, after 2 pages, a refused cursor: Load more shows the error and Try again; Try again reloads page 1 and announces the restart", async ({ page }) => {
    for (let i = 0; i < 55; i += 1) await seedPosting(BOLA.email, { title: `Weak ${i}`, family: "backend", status: "skipped", skipReason: "weak_core_match", minutesAgo: 60 + i })
    const region = panel(page, "Not a match")
    await openPostings(page, "?tab=not_a_match")
    await expect(region.getByText(B1.countPartial(25, 55), { exact: true })).toBeVisible()
    await page.getByRole("button", { name: B1.loadMore, exact: true }).click()
    await expect(region.getByText(B1.countPartial(50, 55), { exact: true })).toBeVisible()
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ backend: 1 }) })

    const refused = page.waitForResponse(listResponse("skipped", true))
    await page.getByRole("button", { name: B1.loadMore, exact: true }).click()
    expect((await refused).status()).toBe(400)
    const retry = page.getByRole("button", { name: B1.loadMoreRetry, exact: true })
    await expect(retry).toBeVisible()
    await expect(retry).toHaveAccessibleDescription(B1.loadMoreError)
    await expect(region.getByText(B1.loadMoreError, { exact: true })).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`^${escapeRegExp(B1.announceLoadFailed)}$`) })).toHaveCount(1)
    await expect(region.getByText(B1.countPartial(50, 55), { exact: true })).toBeVisible()

    const reload = page.waitForResponse(listResponse("skipped", false))
    await retry.click()
    expect((await reload).status()).toBe(200)
    await expect(region.getByText(B1.countPartial(25, 55), { exact: true })).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`^${escapeRegExp(B1.restarted(B1.countPartial(25, 55)))}$`) })).toHaveCount(1)
    await expect(region.getByText(B1.loadMoreError, { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: B1.loadMore, exact: true })).toBeVisible()
  })

  test("B1-P14b (:732) excluding mobile in another tab while paging Not a match: the open skipped cursor gets 400, and page 1 of the excluded-family list succeeds on reload", async ({ page }) => {
    for (let i = 0; i < 30; i += 1) await seedPosting(BOLA.email, { title: `Weak ${i}`, family: "backend", status: "skipped", skipReason: "weak_core_match", minutesAgo: 60 + i })
    await openPostings(page, "?tab=not_a_match")
    await expect(panel(page, "Not a match").getByText(B1.countPartial(25, 30), { exact: true })).toBeVisible()
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    const refused = page.waitForResponse(listResponse("skipped", true))
    await page.getByRole("button", { name: B1.loadMore, exact: true }).click()
    expect((await refused).status()).toBe(400)
    await expect(page.getByRole("button", { name: B1.loadMoreRetry, exact: true })).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`^${escapeRegExp(B1.announceLoadFailed)}$`) })).toHaveCount(1)
    const excluded = page.waitForResponse(listResponse("excluded_family", false))
    await page.reload()
    expect((await excluded).status()).toBe(200)
    await expect(tab(page, "Not a match")).toHaveAttribute("aria-selected", "true")
  })
})

test.describe("skip reasons on rows and details (jppc :360, :369, :779, :788; jcip :446, :455)", () => {
  test("B1-P15 (jcip :446, jppc :779) saving react skips the ranked 'Senior Vue Engineer'; on the next load its Not a match row says why", async ({ page }) => {
    const vue = await seedPosting(BOLA.email, { title: "Senior Vue Engineer", status: "ranked" })
    await changePreferences(page, BOLA.email, { titleKeyword: "react" })
    expect(await postingState(BOLA.email, vue)).toEqual({ status: "skipped", skipReason: "keyword_mismatch" })
    await openPostings(page, "?tab=not_a_match")
    const row = panel(page, "Not a match").getByRole("row").filter({ hasText: "Senior Vue Engineer" })
    await expect(row.getByText(B1.rowSkipKeyword, { exact: true })).toBeVisible()
    await expect(visibleText(row, "Not a match")).toBeVisible()
    await expect(page.getByText("Waiting to be checked")).toHaveCount(0)
  })

  test("B1-P16 (jppc :788) the keyword-mismatch detail names the saved keyword and links to Job preferences", async ({ page }) => {
    await changePreferences(page, BOLA.email, { titleKeyword: "react" })
    const vue = await seedPosting(BOLA.email, { title: "Senior Vue Engineer", status: "skipped", skipReason: "keyword_mismatch" })
    await page.goto(`/postings/${vue}`)
    await expect(page.getByText(B1.detailSkipKeyword("react"), { exact: true })).toBeVisible()
    await expect(page.getByRole("link", { name: B1.changePrefs, exact: true })).toHaveAttribute("href", "/settings#preferences")
  })

  test("B1-P17 (jcip :455, jppc :360) excluding mobile skips the ranked 'Senior iOS Engineer'; the Outside your role families row names Mobile", async ({ page }) => {
    const ios = await seedPosting(BOLA.email, { title: "Senior iOS Engineer", family: "mobile", status: "ranked" })
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    expect(await postingState(BOLA.email, ios)).toEqual({ status: "skipped", skipReason: "excluded_role_family" })
    await openPostings(page, "?tab=not_a_match")
    await expect(visibleText(familiesSection(page), B1.rowSkipFamily(B1.familyMobile))).toBeVisible()
    await tab(page, "Good matches").click()
    await expect(page.getByText("Senior iOS Engineer")).toHaveCount(0)
    await tab(page, "All").click()
    await expect(page.getByText("Senior iOS Engineer")).toHaveCount(0)
  })

  test("B1-P18 (jppc :369) the excluded-family detail names the family and links to Job preferences", async ({ page }) => {
    await changePreferences(page, BOLA.email, { roleFamilyTiers: tiers({ mobile: "excluded" }) })
    const ios = await seedPosting(BOLA.email, { title: "Senior iOS Engineer", family: "mobile", status: "skipped", skipReason: "excluded_role_family" })
    await page.goto(`/postings/${ios}`)
    await expect(page.getByText(B1.detailSkipFamily(B1.familyMobile), { exact: true })).toBeVisible()
    await expect(page.getByRole("link", { name: B1.changePrefs, exact: true })).toHaveAttribute("href", "/settings#preferences")
  })

  test("B1-P19 (jppc :996) the saved keyword is not the on-screen filter: the title search is empty and the mismatch is on All with its reason", async ({ page }) => {
    await changePreferences(page, BOLA.email, { titleKeyword: "react" })
    await seedPosting(BOLA.email, { title: "Senior Vue Engineer", status: "skipped", skipReason: "keyword_mismatch" })
    await openPostings(page, "?tab=all")
    await expect(page.getByRole("searchbox", { name: B1.searchLabel }).or(page.getByRole("textbox", { name: B1.searchLabel }))).toHaveValue("")
    await expect(visibleText(panel(page, "All"), B1.rowSkipKeyword)).toBeVisible()
  })
})

test.describe("the Frontend label (jppc :742, :757, :490)", () => {
  test("B1-P20 (:742) the family panel, the Good matches row and the detail say Frontend, never Senior frontend", async ({ page }) => {
    const id = await seedPosting(BOLA.email, { title: "Senior React Engineer", family: "senior_frontend", status: "ranked" })
    await openPostings(page)
    await expect(panel(page, "Good matches").getByText(B1.familyFrontend, { exact: true }).first()).toBeVisible()
    await page.getByRole("button", { name: new RegExp(`^${B1.familyTrigger}`) }).click()
    await expect(page.getByRole("dialog").getByRole("checkbox", { name: B1.familyFrontend, exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByText(B1.retiredFrontend, { exact: true })).toHaveCount(0)
    await page.goto(`/postings/${id}`)
    await expect(page.getByText(B1.familyFrontend, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(B1.retiredFrontend, { exact: true })).toHaveCount(0)
  })

  test("B1-P21 (:757) checking Frontend puts families=senior_frontend in the URL and the API request", async ({ page }) => {
    await seedPosting(BOLA.email, { title: "Senior React Engineer", family: "senior_frontend", status: "ranked" })
    await openPostings(page)
    await page.getByRole("button", { name: new RegExp(`^${B1.familyTrigger}`) }).click()
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/v1/job-postings?") && r.url().includes("families=")),
      page.getByRole("dialog").getByRole("checkbox", { name: B1.familyFrontend, exact: true }).click(),
    ])
    await expect(page.getByRole("dialog").getByRole("checkbox", { name: B1.familyFrontend, exact: true })).toBeChecked()
    expect(new URL(request.url()).searchParams.get("families")).toBe("senior_frontend")
    await expect.poll(() => new URL(page.url()).searchParams.get("families")).toBe("senior_frontend")
  })

  test("B1-P22 (:490) the on-screen family filter is not saved: a new session opens with no filter and the tiers are unchanged", async ({ page, browser }) => {
    await seedPosting(BOLA.email, { title: "Mobile Engineer", family: "mobile", status: "ranked" })
    await openPostings(page, "?families=mobile")
    const context = await browser.newContext()
    try {
      const other = await context.newPage()
      await signIn(context, BOLA.email)
      await other.goto("/postings")
      expect(new URL(other.url()).searchParams.has("families")).toBe(false)
      await expect(other.getByRole("button", { name: B1.familyTrigger, exact: true })).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
