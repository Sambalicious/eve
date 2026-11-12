import { type Page, expect, test } from "@playwright/test"

import { RANKED, resetApplyAnyway, seedDecidedPosting } from "../support/apply-anyway-db.ts"
import { freshRecord, kenyaValues, targetEveryFamily } from "../support/b1-db.ts"
import { signIn } from "../support/db.ts"
import { E11, SIDEBAR_NAV } from "../support/epic-0011-copy.ts"
import {
  ensureProfileInUse,
  markContactAndCriteriaDone,
  resetEpic11,
  seedApplication,
  setAdvanced,
  setAutomatic,
  setRuleResults,
} from "../support/epic-0011-db.ts"
import { setExistingCompletedAt } from "../support/existing-applications-db.ts"
import { HFEED_A } from "../support/feed-stand-in.ts"
import { insertHiringFeed, resetPhase3, setHiringVerification } from "../support/hiring-feeds-db.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * QA test authoring, EPIC-0011 gate gap scenarios (test-plan.r1.md "Scenario gaps"): NAV:129, BRD:273, ST:65, ONB:144.
 * ST:202 (daily summary words) is the API spec test/qa-epic-0011-st202-summary-words.spec.ts. UPG:60 cannot be set up in the
 * stack (see test-plan.r2.md). Strings come from support/epic-0011-copy.ts.
 */
const sidebar = (page: Page) => page.locator(SIDEBAR_NAV).first()

test.beforeEach(async () => {
  await resetEpic11()
  await resetApplyAnyway()
  await resetPhase3()
  await setAutomatic(ADA.email, false)
  await setAdvanced(ADA.email, false)
  await setAdvanced(BOLA.email, false)
  await ensureProfileInUse(ADA.email)
  await ensureProfileInUse(BOLA.email)
})

test.afterAll(async () => {
  await resetEpic11()
  await resetApplyAnyway()
  await resetPhase3()
  await setAdvanced(ADA.email, true)
})

test.describe("gate gap scenarios", () => {
  test("NAV:129 (AC-3.7) Needs you disappears once the last item is resolved: marking the only Uncertain send confirmed removes the entry", async ({ page, context }) => {
    await seedApplication(ADA.email, { company: "Last Unsure", submissionState: "uncertain" })
    await signIn(context, ADA.email)
    await page.goto("/dashboard")
    await expect(sidebar(page).getByRole("button", { name: new RegExp(E11.needsYou) }).or(sidebar(page).getByRole("link", { name: new RegExp(E11.needsYou) })).first()).toBeVisible()

    await page.goto("/uncertain")
    await expect(page.getByText("E11 Last Unsure").first()).toBeVisible()
    const confirmed = page.waitForResponse((r) => r.request().method() === "POST" && /\/mark-confirmed$/.test(new URL(r.url()).pathname))
    await page.getByRole("button", { name: "Mark confirmed" }).first().click()
    await page.getByRole("alertdialog").getByRole("button", { name: /Mark (as )?confirmed/ }).click()
    expect((await confirmed).status()).toBeLessThan(300)

    await page.goto("/dashboard")
    await expect(sidebar(page).getByText(E11.needsYou)).toHaveCount(0)
    await expect(sidebar(page).getByRole("link")).toHaveCount(E11.navDefault.length)
  })

  test("BRD:273 (AC-6.1) a signed-out visitor to /applications is sent to sign in, with /applications as the return path", async ({ page }) => {
    await page.goto("/applications")
    await expect(page).toHaveURL(/\/sign-in\?/)
    expect(new URL(page.url()).searchParams.get("next")).toBe("/applications")
    await expect(sidebar(page).getByRole("link", { name: "Applications" })).toHaveCount(0)
  })

  test("ST:65 (AC-4.1) Unverified stays a rule result label and is never a posting status word", async ({ page, context }) => {
    await targetEveryFamily(BOLA.email)
    const posting = await seedDecidedPosting(BOLA.email, RANKED, { company: "Unverified Co" })
    await setRuleResults(BOLA.email, posting.id, [
      { rule: "pay", result: "unverified", quote: "The posting doesn't say." },
      { rule: "location", result: "met", quote: "Remote" },
    ])
    await signIn(context, BOLA.email)
    await page.goto(`/postings/${posting.id}`)
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(posting.title) })).toBeVisible()
    // The rule result keeps its label ...
    await expect(page.getByText("Unverified: pay").or(page.getByText(/^Unverified$/)).first()).toBeVisible()
    // ... and the posting's one status word is still one of the five, here Good match.
    await expect(page.getByText("Good match", { exact: true }).first()).toBeVisible()
    // The list row shows the five-word status, not "Unverified", as its status badge.
    await page.goto("/postings")
    const row = page.getByRole("row").filter({ hasText: posting.title }).first()
    await expect(row.getByText("Good match", { exact: true }).first()).toBeVisible()
  })

  test("ONB:144 (AC-2.5) with every Improve item Done the list is still shown, all Done, with its dismiss action", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await page.goto("/")
    await freshRecord(page, BOLA.email, kenyaValues())
    await markContactAndCriteriaDone(BOLA.email)
    // Bola has no activation_state row in the e2e stack (the same missing-singleton gap as B-01); create it, then mark the step complete.
    await setAutomatic(BOLA.email, false)
    await setExistingCompletedAt(BOLA.email, "2026-10-17T10:00:00Z")
    await setHiringVerification(BOLA.email)
    await insertHiringFeed(BOLA.email, HFEED_A, "Frontend hiring")
    await page.goto("/dashboard")
    await expect(page.getByRole("heading", { name: E11.improveHeading })).toBeVisible()
    for (const item of ["Job preferences", "Job criteria", "Contact details", "Jobs you've already applied to", "Set up job alerts"]) {
      const row = page.getByRole("listitem").filter({ hasText: item })
      await expect(row.getByText("Done", { exact: true })).toBeVisible()
      await expect(row.getByText("Not done", { exact: true })).toHaveCount(0)
    }
    await expect(page.getByRole("button", { name: "Hide this list" })).toBeVisible()
  })
})
