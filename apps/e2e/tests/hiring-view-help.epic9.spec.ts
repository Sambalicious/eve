import { type Page, expect, test } from "@playwright/test"

import { SIDEBAR_NAV } from "../support/epic-0011-copy.ts"

import { COPY } from "../support/copy.ts"
import { signIn } from "../support/db.ts"
import { EH } from "../support/explanatory-help-copy.ts"
import { HIRING_SEARCH_INPUTS_PATH, HelpPage, JOB_CRITERIA_PATH, expectInOrder, follows } from "../support/help-page.ts"
import { restoreHiringInputs, setHiringInputs, snapshotHiringInputs } from "../support/hiring-db.ts"
import { resetPhase3 } from "../support/hiring-feeds-db.ts"
import { LINKS_COPY } from "../support/hiring-links-copy.ts"
import { P3 } from "../support/phase3-copy.ts"
import { failRequests, holdRequests } from "../support/network-faults.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * EPIC-0009 QA test authoring: hiring-view-help.feature (HVH:<line>), the
 * Hiring view lead line and its (i) popover (design-spec S3). Real web, api
 * and Postgres. Ada targets Frontend and Backend unless a test says otherwise.
 * The loading state holds the Job criteria GET pending, then sends it on to the
 * real api; the error state aborts it at the network layer. Neither returns a
 * canned response (support/network-faults.ts). The no-request rows for this
 * surface (HVH:136, HVH:145) are in outbound-and-separation.epic9.spec.ts.
 */
let saved: Awaited<ReturnType<typeof snapshotHiringInputs>>
test.beforeAll(async () => {
  saved = await snapshotHiringInputs()
})
test.afterAll(async () => {
  await restoreHiringInputs(saved)
})
test.beforeEach(async () => {
  await setHiringInputs(ADA.email, { families: ["senior_frontend", "backend"], frameworks: ["React"] })
})

const SECTIONS = [LINKS_COPY.title, COPY.checkTitle, P3.feedsTitle] as const

async function signedIn(page: Page, email: string = ADA.email): Promise<HelpPage> {
  await signIn(page.context(), email)
  return new HelpPage(page)
}

async function openHiring(page: Page, query = "", email: string = ADA.email): Promise<HelpPage> {
  const help = await signedIn(page, email)
  await page.goto(query === "" ? "/find-jobs" : `/find-jobs?${query}`)
  await help.hiring().waitUntilReady()
  return help
}

/** The lead line sits under the page heading and before the Hiring search links section, once. */
async function expectLeadLine(help: HelpPage): Promise<void> {
  const line = help.line("hiring")
  await expect(line).toBeVisible()
  await expect(help.page.getByText(EH.hiringLine, { exact: true })).toHaveCount(1)
  expect(await follows(help.pageHeading(), line)).toBe(true)
  expect(await follows(line, help.hiring().linksSection())).toBe(true)
}

test.describe("Lead line in every links state (AC-9)", () => {
  test("HH9-01 (HVH:32 loading) while Job criteria loads, the line shows once under the page heading and the links section is still loading", async ({ page }) => {
    const help = await signedIn(page)
    const hold = await holdRequests(page, JOB_CRITERIA_PATH)
    await page.goto("/find-jobs")
    await expect(help.hiring().linksSection()).toBeVisible()
    await expect.poll(() => hold.held()).toBeGreaterThan(0)
    await expectLeadLine(help)
    // Loading: no link, no error, no no-family state yet.
    await expect(help.hiring().linkedinLinks()).toHaveCount(0)
    await expect(help.hiring().linksSection().getByText(LINKS_COPY.noFamilyTitle)).toHaveCount(0)
    await expect(help.hiring().linksSection().getByRole("button", { name: "Try again" })).toHaveCount(0)
    await hold.release()
    await help.hiring().waitUntilReady()
  })

  test("HH9-02 (HVH:32 error) when Job criteria fails, the line shows once and the links section shows its load error", async ({ page }) => {
    const help = await signedIn(page)
    const fault = await failRequests(page, JOB_CRITERIA_PATH)
    await page.goto("/find-jobs")
    await expect(help.hiring().linksSection().getByRole("button", { name: "Try again", exact: true })).toBeVisible({ timeout: 20_000 })
    expect(fault.aborted()).toBeGreaterThan(0)
    await expectLeadLine(help)
    await fault.stop()
  })

  test("HH9-03 (HVH:32 no Role family) targeting only Other, the line shows once with the no-family empty state", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["other"], frameworks: ["React"] })
    const help = await openHiring(page)
    await expect(help.hiring().linksSection().getByText(LINKS_COPY.noFamilyTitle, { exact: true })).toBeVisible()
    await expectLeadLine(help)
  })

  test("HH9-04 (HVH:32 ready) with links ready, the line shows once and the links section shows its links", async ({ page }) => {
    const help = await openHiring(page)
    await expect(help.hiring().linkedinLinks().first()).toBeVisible()
    await expectLeadLine(help)
  })

  test("HH9-05 (HVH:47) the line stays, once, when the links section moves from error to ready after Retry", async ({ page }) => {
    const help = await signedIn(page)
    const fault = await failRequests(page, JOB_CRITERIA_PATH)
    await page.goto("/find-jobs")
    const retry = help.hiring().linksSection().getByRole("button", { name: "Try again", exact: true })
    await expect(retry).toBeVisible({ timeout: 20_000 })
    await fault.stop()
    await retry.click()
    await expect(help.hiring().linkedinLinks().first()).toBeVisible()
    await expect(page.getByText(EH.hiringLine, { exact: true })).toHaveCount(1)
    await expectLeadLine(help)
  })

  test("HH9-06 (HVH:55) C-HP-HINT still renders in the ready state, unchanged, and the lead line is outside that note", async ({ page }) => {
    const help = await openHiring(page)
    const note = help.hiring().hintNote()
    await expect(note).toBeVisible()
    await expect(note).toContainText(LINKS_COPY.hint)
    await expect(note.getByText(EH.hiringLine)).toHaveCount(0)
    await expect(help.line("hiring")).toBeVisible()
  })

  test("HH9-07 (HVH:198) with no Hiring alert feeds and no confirmation, the line shows and the posts empty state is the Set up alerts one", async ({ page }) => {
    await resetPhase3()
    const help = await openHiring(page)
    await expect(help.line("hiring")).toBeVisible()
    await expect(page.getByText(P3.postsEmptyHiring, { exact: true })).toBeVisible()
  })

  test("HH9-08 (HVH:208) an invited Candidate (Bola) sees the same line and exactly one (i)", async ({ page }) => {
    await setHiringInputs(BOLA.email, { families: ["backend"], frameworks: ["Django"] })
    const help = await openHiring(page, "view=hiring", BOLA.email)
    await expect(help.line("hiring")).toBeVisible()
    await expect(help.trigger("hiring")).toHaveCount(1)
  })
})

test.describe("The (i) and its popover (AC-10)", () => {
  test("HH9-09 (HVH:62) the Hiring view has exactly one (i), named \"Why…\", after the line, collapsed", async ({ page }) => {
    const help = await openHiring(page)
    await expect(help.trigger("hiring")).toHaveCount(1)
    expect(EH.hiringTrigger.startsWith("Why")).toBe(true)
    expect(await follows(help.line("hiring"), help.trigger("hiring"))).toBe(true)
    await expect(help.trigger("hiring")).toHaveAttribute("aria-expanded", "false")
  })

  test("HH9-10 (HVH:70, HVH:79) the popover shows the reason, the lead-in, then the three ways in order; the feeds item names the record and says not vetted", async ({ page }) => {
    const help = await openHiring(page)
    const popover = await help.open("hiring")
    await expectInOrder(popover, [EH.hiringTitle, EH.hiringReason, EH.hiringWays, EH.hiringLinks, EH.hiringCheck, EH.hiringFeeds])
    const items = popover.getByRole("list").getByRole("listitem")
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toContainText(EH.hiringLinks)
    await expect(items.nth(1)).toContainText(EH.hiringCheck)
    await expect(items.nth(2)).toContainText(EH.hiringFeeds)
    // HVH:79: only after the record; incomplete and not vetted.
    await expect(items.nth(2)).toContainText("only after you confirm you may use these feeds")
    await expect(items.nth(2)).toContainText("They miss some posts, and Eve hasn't vetted them.")
    await expect(help.trigger("hiring")).toHaveAttribute("aria-expanded", "true")
  })

  test("HH9-11 (HVH:189) open, close, open again: exactly one popover, (i) expanded", async ({ page }) => {
    const help = await openHiring(page)
    await help.open("hiring")
    await help.closeButton("hiring").click()
    await expect(help.popover("hiring")).toHaveCount(0)
    await help.open("hiring")
    await expect(help.popover("hiring")).toHaveCount(1)
    await expect(help.trigger("hiring")).toHaveAttribute("aria-expanded", "true")
  })

  test("HH9-12 (HVH:154) the three Go to links point to sections on this page and the popover links to no external host", async ({ page }) => {
    const help = await openHiring(page)
    const popover = await help.open("hiring")
    const hrefs = await popover.getByRole("link").evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""))
    expect(hrefs).toEqual(["#hiring-search-links", "#check-this-job", "#hiring-alert-feeds"])
    // EPIC-0011 FJ: Hiring Alert feeds sits inside the collapsed "Set up alerts", which mounts it when opened
    // (the Go to link opens it: HH9-13). Check the first two now and the third once Set up alerts is open.
    for (const href of hrefs.slice(0, 2)) await expect(page.locator(href)).toHaveCount(1)
    for (const [name, href] of [
      [EH.hiringLinksGo, "#hiring-search-links"],
      [EH.hiringCheckGo, "#check-this-job"],
      [EH.hiringFeedsGo, "#hiring-alert-feeds"],
    ] as const) {
      await expect(help.goLink(name)).toHaveAttribute("href", href)
    }
    await help.closeButton("hiring").click()
    await help.hiring().openAlerts()
    await expect(page.locator(hrefs[2]!)).toHaveCount(1)
  })
})

test.describe("Go to links (AC-11)", () => {
  const links = [
    [EH.hiringLinksGo, SECTIONS[0]],
    [EH.hiringCheckGo, SECTIONS[1]],
    [EH.hiringFeedsGo, SECTIONS[2]],
  ] as const
  for (const [name, heading] of links) {
    test(`HH9-13 (HVH:85) "${name}" closes the popover, focuses and shows the "${heading}" heading, and keeps ?family=backend`, async ({ page }) => {
      const help = await openHiring(page, "family=backend")
      await help.open("hiring")
      await help.goLink(name).click()
      await expect(help.popover("hiring")).toHaveCount(0)
      await expect(help.heading(heading)).toBeFocused()
      await expect(help.heading(heading)).toBeInViewport()
      const url = new URL(page.url())
      expect(`${url.pathname}${url.search}${url.hash}`).toBe("/find-jobs?family=backend")
    })
  }

  test("HH9-14 (HVH:101) by keyboard: Enter on (i), Tab to Go to Check this job, Enter focuses the Check this job heading", async ({ page }) => {
    const help = await openHiring(page)
    await help.openWithKeyboard("hiring")
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab")
      if (await help.goLink(EH.hiringCheckGo).evaluate((el) => el === document.activeElement)) break
    }
    await expect(help.goLink(EH.hiringCheckGo)).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(help.popover("hiring")).toHaveCount(0)
    await expect(help.heading(COPY.checkTitle)).toBeFocused()
    // EPIC-0011 FJ: Find jobs is one screen with no tabs, so there is no view param to keep.
    expect(new URL(page.url()).pathname).toBe("/find-jobs")
  })

  test("HH9-15 (HVH:111) while the links section is loading, Go to Check this job still focuses the Check this job heading", async ({ page }) => {
    const help = await signedIn(page)
    const hold = await holdRequests(page, HIRING_SEARCH_INPUTS_PATH)
    await page.goto("/find-jobs")
    await expect.poll(() => hold.held()).toBeGreaterThan(0)
    await expect(help.hiring().linkedinLinks()).toHaveCount(0)
    await help.open("hiring")
    await help.goLink(EH.hiringCheckGo).click()
    await expect(help.heading(COPY.checkTitle)).toBeFocused()
    await hold.release()
  })

  // HVH:171 writes the URL literally as family=frontend. The Role family key for Frontend is
  // senior_frontend; "frontend" is not a key, so the page resolves it to the first target (Frontend).
  // Both forms are checked: the literal Gherkin URL, and the real key.
  for (const family of ["frontend", "senior_frontend"]) {
    test(`HH9-16 (HVH:171) after Go to Hiring Alert feeds, ?family=${family} is kept and the Role family still shows Frontend`, async ({ page }) => {
      const help = await openHiring(page, `family=${family}`)
      await help.open("hiring")
      await help.goLink(EH.hiringFeedsGo).click()
      await expect(help.heading(P3.feedsTitle)).toBeFocused()
      const url = new URL(page.url())
      expect(`${url.pathname}${url.search}`).toBe(`/find-jobs?family=${family}`)
      await expect(help.hiring().familySelect()).toHaveValue("senior_frontend")
      await expect(help.hiring().familySelect().locator("option:checked")).toHaveText("Frontend")
    })
  }

  test("HH9-17 (HVH:180) following a Go to link adds no history entry: Back returns to the dashboard", async ({ page }) => {
    const help = await signedIn(page)
    await page.goto("/dashboard")
    await page.goto("/find-jobs")
    await help.hiring().waitUntilReady()
    await help.open("hiring")
    await help.goLink(EH.hiringCheckGo).click()
    await expect(help.heading(COPY.checkTitle)).toBeFocused()
    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
  })
})

test.describe("Find jobs keeps the Hiring lead line and (i) in one place (AC-12 after EPIC-0011 R5)", () => {
  test("HH9-18 (HVH:119) /find-jobs shows the Hiring lead line once and one (i), with the Search links and Posts from your field sections beside it; the legacy /stack-posts lands there", async ({ page }) => {
    const help = await signedIn(page)
    await page.goto("/stack-posts")
    await expect(page).toHaveURL(/\/find-jobs/)
    await expect(page.getByRole("region", { name: COPY.stackLinksTitle, exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: COPY.stackSectionTitle, exact: true })).toBeVisible()
    await expect(page.getByText(EH.hiringLine, { exact: true })).toHaveCount(1)
    await expect(help.trigger("hiring")).toHaveCount(1)
  })

  test("HH9-19 (HVH:126) leaving Find jobs with the popover open closes it and the line is gone on the next page", async ({ page }) => {
    const help = await openHiring(page)
    await help.open("hiring")
    await page.locator(SIDEBAR_NAV).first().getByRole("link", { name: "Applications" }).click()
    await expect(help.popover("hiring")).toHaveCount(0)
    await expect(page.getByText(EH.hiringLine, { exact: true })).toHaveCount(0)
  })
})
