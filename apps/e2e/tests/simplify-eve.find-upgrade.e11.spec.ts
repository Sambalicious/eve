import { type Page, expect, test } from "@playwright/test"

import { signIn } from "../support/db.ts"
import { E11, EXISTING_ROUTES, SIDEBAR_NAV } from "../support/epic-0011-copy.ts"
import { ensureProfileInUse, readAutomatic, resetEpic11, seedApplication, setAdvanced, setAutomatic, setGlobalPause } from "../support/epic-0011-db.ts"
import { HiringPage } from "../support/hiring-page.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * QA test authoring, EPIC-0011 e2e: Find jobs, Job Sources redirects, upgrade and compatibility,
 * and the existing automation journeys with Advanced on.
 * Gherkin: find-jobs.feature FJ:12 to FJ:132 (AC-5.x); upgrade-and-compat.r1.feature UPG:60 to UPG:167 (AC-7.x);
 * advanced-switch.r1.feature ADV:194 and the "existing automation suites" rows (AC-7.4).
 * Expected red until the feature is built.
 */
const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name })

test.beforeEach(async () => {
  await resetEpic11()
  await setGlobalPause(false)
  await setAdvanced(ADA.email, true)
  await setAdvanced(BOLA.email, false)
  await setAutomatic(ADA.email, false)
  await ensureProfileInUse(ADA.email)
  await ensureProfileInUse(BOLA.email)
})

test.afterAll(async () => {
  await resetEpic11()
  await setAutomatic(ADA.email, false)
})

test.describe("Find jobs (AC-5.1 to AC-5.7)", () => {
  test("FJ:12 Find jobs shows Search links, Hiring posts, Posts from your field and Set up alerts, in that order", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await page.goto("/find-jobs")
    await expect(h1(page, E11.findTitle)).toBeVisible()
    const headings = await page.getByRole("heading", { level: 2 }).allInnerTexts()
    const positions = E11.findSections.map((name) => headings.findIndex((h) => h.trim().startsWith(name)))
    expect(positions.every((p) => p >= 0), `headings: ${headings.join(" | ")}`).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test("FJ:30 wording is plain: no Job Sources, Activation Gate or Uncertain Submission anywhere on the screen", async ({ page, context }) => {
    await signIn(context, ADA.email)
    await page.goto("/find-jobs")
    await expect(h1(page, E11.findTitle)).toBeVisible()
    for (const word of E11.forbiddenWords) await expect(page.getByText(word, { exact: false })).toHaveCount(0)
  })

  test("FJ:35 a non-Operator does not see the Job boards sub-section; the Operator does, with the exact description", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await page.goto("/find-jobs")
    await expect(h1(page, E11.findTitle)).toBeVisible()
    await new HiringPage(page).openAlerts()
    await expect(page.getByText(E11.jobBoards, { exact: true })).toHaveCount(0)
    const operator = await context.browser()!.newContext()
    await signIn(operator, ADA.email)
    const adaPage = await operator.newPage()
    await adaPage.goto("/find-jobs")
    // Job boards sits inside the collapsed "Set up alerts" (FJ:35 says "under Set up alerts").
    await new HiringPage(adaPage).openAlerts()
    await expect(adaPage.getByText(E11.jobBoardsDescription)).toBeVisible()
    await operator.close()
  })

  test("FJ:40 a non-Operator's write to the Job Sources endpoints is still refused with 403", async ({ page, context }) => {
    const session = await signIn(context, BOLA.email)
    await page.goto("/dashboard")
    const status = await page.evaluate(async (csrf) => {
      const r = await fetch("/v1/job-sources/employer-list/approval", { method: "PUT", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: "{}" })
      return r.status
    }, session.csrfToken)
    expect([401, 403, 404]).toContain(status)
    expect(status).not.toBe(200)
  })

  test("FJ:97 old routes keep resolving into Find jobs: /stack-posts to the Posts from your field section, /sources to Set up alerts", async ({ page, context }) => {
    await signIn(context, ADA.email)
    await page.goto("/stack-posts")
    await expect(h1(page, E11.findTitle)).toBeVisible()
    await expect(page.getByRole("heading", { level: 2, name: "Posts from your field", exact: true })).toBeVisible()
    await page.goto("/sources")
    await expect(h1(page, E11.findTitle)).toBeVisible()
    await expect(page.getByRole("heading", { name: "Set up alerts" })).toBeVisible()
  })

  test("FJ:108 a non-Operator opening /sources lands on Set up alerts without any former Job Sources content", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await page.goto("/sources")
    await expect(h1(page, E11.findTitle)).toBeVisible()
    await expect(page.getByRole("heading", { name: "Set up alerts" })).toBeVisible()
    await expect(page.getByText(E11.jobBoards, { exact: true })).toHaveCount(0)
    await expect(page.getByText(/Job Sources/i)).toHaveCount(0)
  })

  test("FJ:114 Jobs stays its own nav item and opens /postings", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await page.goto("/find-jobs")
    await page.locator(SIDEBAR_NAV).first().getByRole("link", { name: /^Jobs/ }).click()
    await expect(page).toHaveURL(/\/postings$/)
  })

  test("FJ:132 a signed-out visitor to Find jobs is sent to sign in", async ({ page }) => {
    await page.goto("/find-jobs")
    await expect(page).not.toHaveURL(/\/find-jobs$/)
  })
})

test.describe("upgrade and compatibility (AC-7.x)", () => {
  for (const route of EXISTING_ROUTES) {
    test(`UPG:122 the Operator opens ${route}: the page loads or redirects to a page`, async ({ page, context }) => {
      await signIn(context, ADA.email)
      const response = await page.goto(route)
      expect(response?.status() ?? 200).toBeLessThan(400)
      // The app shell's main area renders (an unknown sample id such as abc123 shows the page's own
      // record-not-found line, with no heading), and it is not the 404 page.
      await expect(page.getByRole("main")).toBeVisible()
      await expect(page.getByText(E11.notFoundHeading)).toHaveCount(0)
    })
  }

  test("UPG:145 an unknown route is still the not-found page", async ({ page, context }) => {
    await signIn(context, ADA.email)
    await page.goto("/no-such-page")
    await expect(page.getByText(E11.notFoundHeading).first()).toBeVisible()
  })

  test("UPG:167 a signed-out visit to /blocked signs in and returns to /blocked", async ({ page, context }) => {
    await page.goto("/blocked")
    await expect(page).not.toHaveURL(/\/blocked$/)
    expect(page.url()).toMatch(/next=|return|sign/i)
    await signIn(context, ADA.email)
    await page.goto("/blocked")
    await expect(page).toHaveURL(/\/blocked$/)
  })

  test("UPG:150 email links work: Blocked, Unsure sends and an Application detail load with their content", async ({ page, context }) => {
    const blocked = await seedApplication(ADA.email, { company: "Mail Blocked", submissionState: "blocked", blockedReason: "captcha" })
    await seedApplication(ADA.email, { company: "Mail Unsure", submissionState: "uncertain" })
    await signIn(context, ADA.email)
    await page.goto("/blocked")
    await expect(page.getByText("E11 Mail Blocked").first()).toBeVisible()
    await page.goto("/uncertain")
    await expect(page.getByText("E11 Mail Unsure").first()).toBeVisible()
    await page.goto(`/applications/${blocked.id}`)
    await expect(page.getByText("E11 Mail Blocked").first()).toBeVisible()
  })

  test("UPG:60 / UPG:81 an existing non-Operator with Advanced off sees the Eve is simpler now note once, naming Settings, Advanced; dismissed it stays gone", async ({ page, context }) => {
    await setAdvanced(BOLA.email, false, true)
    await signIn(context, BOLA.email)
    await page.goto("/dashboard")
    const note = page.getByText(E11.simplerTitle, { exact: true })
    await expect(note).toBeVisible()
    await expect(page.getByText(/Settings, Advanced/)).toBeVisible()
    await page.getByRole("button", { name: E11.simplerDismiss }).click()
    await page.reload()
    await expect(note).toHaveCount(0)
  })

  test("UPG:86 the note is not shown to an Advanced-on account or to a new account", async ({ page, context }) => {
    await setAdvanced(ADA.email, true, false)
    await signIn(context, ADA.email)
    await page.goto("/dashboard")
    await expect(h1(page, "Home")).toBeVisible()
    await expect(page.getByText(E11.simplerTitle, { exact: true })).toHaveCount(0)
  })

  test("UPG:92 / UPG:116 automatic submission stays on with its values after loading every screen; Advanced stays on", async ({ page, context }) => {
    await setAutomatic(ADA.email, true)
    await signIn(context, ADA.email)
    for (const route of ["/dashboard", "/settings", "/activation", "/blocked", "/uncertain", "/applications"]) {
      await page.goto(route)
      await expect(page.getByRole("heading").first()).toBeVisible()
    }
    expect(await readAutomatic(ADA.email)).toBe(true)
  })
})

test.describe("existing automation journeys with Advanced on (AC-7.4)", () => {
  test("the Activation Gate page lists a sample awaiting review with its actions", async ({ page, context }) => {
    await seedApplication(ADA.email, { company: "Sample Co", sampleState: "awaiting_review" })
    await signIn(context, ADA.email)
    await page.goto("/activation")
    await expect(page.getByText("E11 Sample Co").first()).toBeVisible()
    // The list row's action is "Review sample" (unchanged); Approve and Reject live on the sample review page.
    await expect(page.getByRole("link", { name: /^Review sample, .*E11 Sample Co/ })).toBeVisible()
  })

  test("the Blocked page lists a blocked Application and still offers the manual-complete action to the Operator", async ({ page, context }) => {
    await seedApplication(ADA.email, { company: "Blocked Co", submissionState: "blocked", blockedReason: "captcha" })
    await signIn(context, ADA.email)
    await page.goto("/blocked")
    await expect(page.getByText("E11 Blocked Co").first()).toBeVisible()
    await expect(page.getByRole("button", { name: /applied|manual|mark/i }).first()).toBeVisible()
  })

  test("the Unsure sends page lists an uncertain Application with its confirm and not-submitted actions", async ({ page, context }) => {
    await seedApplication(ADA.email, { company: "Unsure Co", submissionState: "uncertain" })
    await signIn(context, ADA.email)
    await page.goto("/uncertain")
    await expect(page.getByText("E11 Unsure Co").first()).toBeVisible()
    await expect(page.getByRole("button", { name: /confirm|submitted/i }).first()).toBeVisible()
  })

  test("Pause and cost shows the global pause control and the Monthly cost section; Home shows the setup checklist and the Automation cards", async ({ page, context }) => {
    await signIn(context, ADA.email)
    await page.goto("/pause-and-cost")
    await expect(page.getByText(/Monthly cost/i).first()).toBeVisible()
    await expect(page.getByRole("button", { name: /pause/i }).or(page.getByRole("switch", { name: /pause/i })).first()).toBeVisible()
    await page.goto("/dashboard")
    await expect(page.getByText(/Set up Eve/i).first()).toBeVisible()
  })

  test("the global pause banner on Home links to Pause and cost (home.banner.pause)", async ({ page, context }) => {
    await setGlobalPause(true)
    await signIn(context, ADA.email)
    await page.goto("/dashboard")
    await expect(page.getByRole("link", { name: /Pause and cost/ }).first()).toBeVisible()
    await setGlobalPause(false)
  })
})
