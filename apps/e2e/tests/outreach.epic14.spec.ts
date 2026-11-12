import { type Locator, type Page, expect, test } from "@playwright/test"

import { signIn } from "../support/db.ts"
import { INTRODUCTION_BODY, NOTE_BODY, OUTREACH, QUOTE, REFERRAL_BODY, codePoints, outreachRows, resetOutreach, seedOutreach } from "../support/outreach-db.ts"
import { ADA } from "../support/stack.ts"

/**
 * QA test authoring, step [5e], EPIC-0014 Outreach messages, tier 3 (real stack).
 *
 * Declared double: the stack has no AI provider (support/global-setup.ts sets ANTHROPIC_API_KEY to
 * empty and blocks every non-loopback host), so the outreach rows a finished Run writes are seeded
 * directly (support/outreach-db.ts). The read, the section, Copy and Open in email all run against
 * the real api and Postgres.
 *
 * Covers gherkin/outreach-section.feature (AC 1.1, 1.4, 1.5), outreach-copy-and-email.feature
 * (AC 6.1 to AC 6.4), outreach-reader-name.feature (the greeting) and
 * outreach-blocked-quote.feature (AC 7.10, 11.4).
 */

test.beforeEach(async () => {
  await resetOutreach()
})
test.afterEach(async () => {
  await resetOutreach()
})

async function openApplication(page: Page, applicationId: string, email = ADA.email) {
  await signIn(page.context(), email)
  // The copy assertion reads the real clipboard (Chromium headless, loopback origin).
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto(`/applications/${applicationId}`)
  const section = page.getByRole("region", { name: OUTREACH.heading })
  await expect(section).toBeVisible()
  return section
}

async function selectKind(section: Locator, label: string) {
  await section.getByRole("tab", { name: new RegExp(`^${label}`) }).click()
}

test("OM14-E2E-01 the three kinds are readable, one copies exactly and one opens in the mail app", async ({ page }) => {
  const application = await seedOutreach(ADA.email)
  const section = await openApplication(page, application.id)

  // One tablist, three tabs in the fixed order (AC 1.1).
  const tablist = section.getByRole("tablist", { name: OUTREACH.tabsLabel })
  await expect(tablist.getByRole("tab")).toHaveCount(3)
  expect(await tablist.getByRole("tab").allTextContents()).toEqual([OUTREACH.referralLabel, OUTREACH.introductionLabel, OUTREACH.noteLabel])
  await expect(section.getByText(OUTREACH.description)).toBeVisible()

  // Referral request: Ready text, count, profile version, Copy and Open in email (AC 1.4).
  const referralText = `Hi Amara Okafor,\n\n${REFERRAL_BODY}`
  await selectKind(section, OUTREACH.referralLabel)
  await expect(section.getByText(OUTREACH.referralPurpose)).toBeVisible()
  const textbox = section.getByRole("textbox", { name: /^Text of the referral request/ })
  await expect(textbox).toHaveValue(referralText)
  await expect(section.getByText(OUTREACH.count(codePoints(referralText), 600))).toBeVisible()
  // The three panels stay mounted, so scope the profile version to the selected tabpanel.
  const referralPanel = section.getByRole("tabpanel", { name: new RegExp(`^${OUTREACH.referralLabel}`) })
  await expect(referralPanel.getByText("Profile version 1")).toBeVisible()

  // Copy puts exactly the Ready text on the clipboard, with its greeting and line break (AC 6.1, AC 6.2).
  await section.getByRole("button", { name: /^Copy/ }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(referralText)
  // The button and the live region both say "… copied", so read the button by role.
  await expect(section.getByRole("button", { name: /^Copied/ })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain("Eve")

  // Open in email is an ordinary mailto link with no recipient whose body is the text (AC 6.3).
  const href = (await section.getByRole("link", { name: /^Open in email/ }).getAttribute("href")) ?? ""
  expect(href.startsWith("mailto:?")).toBe(true)
  const decodedBody = new URL(href).searchParams.get("body") ?? ""
  expect(decodedBody.replace(/\r\n/g, "\n")).toBe(referralText)
  expect(new URL(href).searchParams.get("subject")).toBe(`${OUTREACH.referralLabel} for ${application.title} at ${application.company}`)
  const before = page.url()
  await section.getByRole("link", { name: /^Open in email/ }).click()
  await page.waitForTimeout(300)
  expect(page.url()).toBe(before)

  // Introduction and Application note each hold their own Ready text (AC 1.4).
  await selectKind(section, OUTREACH.introductionLabel)
  await expect(section.getByText(OUTREACH.introductionPurpose)).toBeVisible()
  await expect(section.getByRole("textbox", { name: /^Text of the introduction/ })).toHaveValue(`Hello,\n\n${INTRODUCTION_BODY}`)
  await selectKind(section, OUTREACH.noteLabel)
  await expect(section.getByText(OUTREACH.notePurpose)).toBeVisible()
  await expect(section.getByRole("textbox", { name: /^Text of the application note/ })).toHaveValue(NOTE_BODY)
})

test("OM14-E2E-02 a blocked Run's quote is visible, complete and readable, and is not part of the text or the copy", async ({ page }) => {
  const application = await seedOutreach(ADA.email, { blockedIntroduction: QUOTE })
  const section = await openApplication(page, application.id)
  await selectKind(section, OUTREACH.introductionLabel)

  // The cause line, the label and the quote (AC 7.10, AC 11.4).
  await expect(section.getByText(OUTREACH.blockedCause)).toBeVisible()
  await expect(section.getByText(OUTREACH.blockedQuoteLabel)).toBeVisible()
  const quote = section.getByRole("blockquote")
  await expect(quote).toBeVisible()
  await expect(quote).toHaveAttribute("dir", "auto")
  expect(await quote.textContent()).toContain(QUOTE)

  // Readable in full: no line clamp, no inner scroll, no horizontal overflow at 375px.
  await page.setViewportSize({ width: 375, height: 900 })
  const shape = await quote.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clipped: style.webkitLineClamp !== "none" && style.webkitLineClamp !== "",
      verticalClamp: style.overflowY === "hidden" && element.scrollHeight > element.clientHeight + 1,
      horizontal: document.documentElement.scrollWidth > window.innerWidth + 1,
    }
  })
  expect(shape).toEqual({ clipped: false, verticalClamp: false, horizontal: false })

  // The quote is inert text: no link, no button, no textarea (AC 11.4).
  await expect(quote.locator("a")).toHaveCount(0)
  await expect(quote.locator("button")).toHaveCount(0)
  await expect(quote.locator("textarea")).toHaveCount(0)
  await expect(section.getByRole("textbox", { name: /^Text of the introduction/ })).toHaveCount(0)

  // Neither Copy nor the mailto body carries it, and neither control is offered with no Ready text.
  await expect(section.getByRole("button", { name: /^Copy/ })).toHaveCount(0)
  await expect(section.getByRole("link", { name: /^Open in email/ })).toHaveCount(0)

  // The stored row keeps the sentence in its own column, never in a body (AC 11.6).
  const rows = await outreachRows(application.id)
  const introduction = rows.find((row) => row.kind === "introduction")
  expect(introduction).toMatchObject({ body: null, last_failure: "blocked", first_failed_sentence: QUOTE })
})
