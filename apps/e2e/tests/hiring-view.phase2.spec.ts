import { expect, test } from "@playwright/test"

import { SIDEBAR_NAV } from "../support/epic-0011-copy.ts"

import { COPY } from "../support/copy.ts"
import { expireSession, setJobCriteriaTerms, signIn } from "../support/db.ts"
import { HiringPage } from "../support/hiring-page.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0007 Phase 2, hiring-view.feature r2 (@phase2 scenarios that the browser
 * can exercise). Ship state: Phase 2 alone (D3), so the Hiring view holds only
 * "Check this job" with C-HP-CHECK-HELP-SOLO.
 */
test.describe("Hiring view frame (Phase 2), now Find jobs (EPIC-0011 R5)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context, ADA.email)
  })

  test("HV-01 the two views are gone: Find jobs is one page with no tablist, holding the Hiring and Stack sections", async ({ page }) => {
    const hiring = new HiringPage(page)
    await hiring.open(null)
    await expect(page.getByRole("tablist")).toHaveCount(0)
    await expect(hiring.heading(COPY.hiringPostsTitle)).toBeVisible()
    await expect(hiring.heading(COPY.stackSectionTitle)).toBeVisible()
  })

  test("HV-02 /stack-posts?view=hiring redirects into Find jobs and shows the Check this job section", async ({ page }) => {
    const hiring = new HiringPage(page)
    await page.goto("/stack-posts?view=hiring")
    await expect(page).toHaveURL(/\/find-jobs(\?|#|$)/)
    await expect(hiring.checkSection()).toBeVisible()
  })

  test("HV-03 /find-jobs shows Check this job directly, and the document title is Find jobs", async ({ page }) => {
    const hiring = new HiringPage(page)
    await hiring.open("hiring")
    await expect(hiring.checkSection()).toBeVisible()
    await expect(page).toHaveTitle(new RegExp(`^${COPY.findTitle}`))
  })

  test("HV-04 the sidebar entry \"Find jobs\" opens /find-jobs, in a new tab too", async ({ page, context }) => {
    const hiring = new HiringPage(page)
    await hiring.open("hiring")
    await expect(hiring.checkSection()).toBeVisible()
    const second = await context.newPage()
    await second.goto("/dashboard")
    await second.locator(SIDEBAR_NAV).first().getByRole("link", { name: COPY.findTitle, exact: true }).click()
    await expect(second).toHaveURL(/\/find-jobs$/)
    await expect(new HiringPage(second).checkSection()).toBeVisible()
  })

  test("HV-05 browser back returns from the legacy /stack-posts link target to the page before it", async ({ page }) => {
    await page.goto("/dashboard")
    await page.goto("/stack-posts")
    await expect(page).toHaveURL(/\/find-jobs/)
    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test("HV-06 the sidebar has one \"Find jobs\" entry and no \"Stack posts\" or \"Hiring\" entry", async ({ page }) => {
    await page.goto("/find-jobs")
    const nav = page.locator(SIDEBAR_NAV).first()
    await expect(nav.getByRole("link", { name: COPY.findTitle, exact: true })).toHaveCount(1)
    await expect(nav.getByRole("link", { name: "Stack posts", exact: true })).toHaveCount(0)
    await expect(nav.getByRole("link", { name: "Hiring", exact: true })).toHaveCount(0)
  })

  test("HV-07 Find jobs order: Hiring search links, Search links, Check this job, Hiring posts, Posts from your field, Set up alerts", async ({ page }) => {
    await setJobCriteriaTerms(ADA.email, ["React"], ["TypeScript"])
    const hiring = new HiringPage(page)
    await hiring.open(null)
    const titles = [COPY.hiringLinksTitle, COPY.stackLinksTitle, COPY.checkTitle, COPY.hiringPostsTitle, COPY.stackSectionTitle, COPY.setUpAlerts]
    const headings = await page.getByRole("heading", { level: 2 }).allInnerTexts()
    const at = titles.map((t) => headings.findIndex((h) => h.trim() === t))
    expect(at.every((i) => i >= 0), `headings: ${headings.join(" | ")}`).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    await expect(page.getByRole("link", { name: /LinkedIn posts/ }).first()).toBeVisible()
    // The two Alert feeds lists live inside the collapsed Set up alerts.
    await expect(hiring.heading(COPY.stackFeedsTitle)).toHaveCount(0)
    await hiring.openAlerts()
    await expect(hiring.heading(COPY.stackFeedsTitle)).toBeVisible()
    await expect(hiring.heading(COPY.hiringFeedsTitle)).toBeVisible()
  })

  for (const value of ["", "stack", "jobs", "HIRING", "hiring ", "<script>x</script>"]) {
    test(`HV-08 /stack-posts?view=${JSON.stringify(value)} lands on Find jobs with no error`, async ({ page }) => {
      const hiring = new HiringPage(page)
      await page.goto(`/stack-posts?view=${encodeURIComponent(value)}`)
      await expect(page).toHaveURL(/\/find-jobs/)
      await expect(hiring.heading(COPY.stackLinksTitle)).toBeVisible()
      await expect(page.getByRole("alert")).toHaveCount(0)
    })
  }

  // HV-09 and HV-10 retired in repair wave 1 (QA-P1-T-04, Gherkin r3): "Phase 2 alone" is unreachable in this build.
  // HV1-01 is retired (Gherkin r5 point 1); HV:104 r5 is OUT3-01. HV1-05/HV1-06 cover HV:284 and HV:291 r5 in hiring-view.phase1.spec.ts.

  test("HV-11 two tabs of Find jobs are independent: a pasted-field entry in one does not appear in the other", async ({ page, context }) => {
    const a = new HiringPage(page)
    await a.open(null)
    const b = new HiringPage(await context.newPage())
    await b.open("hiring")
    await a.openCheck()
    await b.openCheck()
    await a.urlField().fill("https://example.com/only-in-tab-a")
    await expect(b.urlField()).toHaveValue("")
    await page.keyboard.press("Escape")
    await expect(a.heading(COPY.stackLinksTitle)).toBeVisible()
  })

  test("HV-12 a field validation error is linked to the field and announced", async ({ page }) => {
    const hiring = new HiringPage(page)
    await hiring.open("hiring")
    await hiring.openCheck()
    await hiring.submitButton().click()
    const error = hiring.dialog().getByRole("alert").filter({ hasText: COPY.linkEmpty })
    await expect(error).toBeVisible()
    await expect(hiring.urlField()).toHaveAccessibleDescription(new RegExp(COPY.linkEmpty.replace(".", "\\.")))
    await expect(hiring.urlField()).toHaveAttribute("aria-invalid", "true")
  })

  test("HV-13 the Check this job controls are keyboard operable and named", async ({ page }) => {
    const hiring = new HiringPage(page)
    await hiring.open("hiring")
    await hiring.openCheck()
    await hiring.urlField().focus()
    await expect(hiring.urlField()).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(hiring.submitButton()).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(hiring.dialog().getByText(COPY.linkEmpty, { exact: true })).toBeVisible()
  })
})

test.describe("Hiring view permission (Phase 2)", () => {
  test("HV-P1 a visitor who is not signed in is sent to sign in from ?view=hiring", async ({ page }) => {
    await page.goto("/stack-posts?view=hiring")
    await expect(page).toHaveURL(/\/sign-in\?/)
    // The legacy link is kept as the return path (or its Find jobs target): both end on Find jobs after sign-in.
    expect(new URL(page.url()).searchParams.get("next")).toMatch(/^\/(stack-posts|find-jobs)\?view=hiring$/)
    await expect(page.getByRole("region", { name: COPY.checkTitle })).toHaveCount(0)
  })

  test("HV-P2 an expired session is sent to sign in again with view=hiring kept as the return path", async ({ page, context }) => {
    const session = await signIn(context, ADA.email)
    await expireSession(session)
    await page.goto("/stack-posts?view=hiring")
    await expect(page).toHaveURL(/\/sign-in\?/)
    const params = new URL(page.url()).searchParams
    expect(params.get("next")).toMatch(/^\/(stack-posts|find-jobs)\?view=hiring$/)
    // dashboard.feature:129-135 and design-spec.r4.md:46 (FU-1, QA-A-01).
    expect(params.get("reason")).toBe("expired")
    await expect(page.getByRole("status").filter({ hasText: COPY.sessionEnded })).toBeVisible()
  })
})
