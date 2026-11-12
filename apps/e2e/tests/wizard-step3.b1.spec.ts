import { type Locator, type Page, expect, test } from "@playwright/test"

import { B1 } from "../support/b1-copy.ts"
import { PREFS_PATH, clearPreferences, storedPreferences, versionCount } from "../support/b1-db.ts"
import { signIn } from "../support/db.ts"
import { BOLA } from "../support/stack.ts"

/**
 * EPIC-0002 B1 (run epic-0002-b1, qa-author, qa-tests-1). Wizard step 3
 * (`/onboarding/preferences`, design-spec.r4 F3) over the shared Job
 * Preferences form. The B1 Gherkin map defers every onboarding-wizard.feature
 * step 3 scenario to slice C (no invite flow or wizard shell exists before C),
 * and B1 proves the shared form in Settings (job-preferences-settings.b1.spec.ts).
 *
 * These journeys are written now so slice C inherits them unchanged. They run
 * only with E2E_SLICE_C=1; in a B1 gate they are reported as skipped, never as a
 * pass. Slice C must seed Bola as an invitee with steps 1 and 2 done before
 * these run (no onboarding state exists to seed before C).
 *
 * Gherkin: onboarding-wizard.feature :93, :574, :769 (D30 text, also :773);
 * job-preferences.feature :60, :98, :103, :109, :634 (step 3 wording).
 */
test.skip(process.env.E2E_SLICE_C !== "1", "Slice C: wizard step 3 needs the invitee wizard shell (gherkin-map 'Deferred: C'). Set E2E_SLICE_C=1 to run.")

async function openStep3(page: Page): Promise<Locator> {
  await signIn(page.context(), BOLA.email)
  await page.goto("/onboarding/preferences")
  await expect(page.getByRole("heading", { level: 1, name: B1.wizardTitle, exact: true })).toBeVisible()
  return page.getByRole("main")
}

const primary = (step: Locator) => step.getByRole("button", { name: B1.saveWizard, exact: true })
const capRadio = (step: Locator, n: number) => step.getByRole("radiogroup", { name: B1.dailyCap }).getByRole("radio", { name: B1.capOption(n), exact: true })

test.beforeEach(async () => {
  await clearPreferences(BOLA.email)
})

test("B1-W01 (jp :98, :103, :109, :634) step 3 opens on the defaults: sponsorship Yes, all levels and types, cap 5; opening writes nothing", async ({ page }) => {
  const step = await openStep3(page)
  await expect(step.getByRole("radiogroup", { name: B1.sponsorship }).getByRole("radio", { name: "Yes", exact: true })).toBeChecked()
  for (const label of B1.seniorityOptions) await expect(step.getByRole("group", { name: B1.seniority }).getByRole("checkbox", { name: label, exact: true })).toBeChecked()
  for (const label of B1.employmentOptions) await expect(step.getByRole("group", { name: B1.employment }).getByRole("checkbox", { name: label, exact: true })).toBeChecked()
  await expect(capRadio(step, 5)).toBeChecked()
  await expect(step.getByRole("button", { name: B1.saveSettings, exact: true })).toHaveCount(0)
  expect(await storedPreferences(BOLA.email)).toBeNull()
})

test("B1-W02 (jp :60) choosing Kenya defaults the time zone to Africa/Nairobi and the latest work hour to 23:00", async ({ page }) => {
  const step = await openStep3(page)
  await step.getByRole("combobox", { name: B1.homeCountry }).click()
  await page.getByRole("option", { name: "Kenya", exact: true }).click()
  await expect(step.getByRole("combobox", { name: B1.timeZone })).toContainText("Africa/Nairobi")
  await expect(step.getByLabel(B1.latestWorkHour, { exact: true })).toHaveValue("23:00")
})

test("B1-W03 (ow :93) Save and continue stores version 1 with baseVersion null and moves to step 4; no toast", async ({ page }) => {
  const step = await openStep3(page)
  await step.getByRole("combobox", { name: B1.homeCountry }).click()
  await page.getByRole("option", { name: "Kenya", exact: true }).click()
  await capRadio(step, 3).check()
  const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith(PREFS_PATH) && r.request().method() === "PUT"), primary(step).click()])
  expect(response.request().postDataJSON()).toMatchObject({ baseVersion: null, values: { homeCountry: "KE", dailyCap: 3 } })
  expect(response.status()).toBe(200)
  await expect(page).toHaveURL(/\/onboarding\/resume$/)
  await expect(page.getByText(B1.saved, { exact: true })).toHaveCount(0)
  expect(await storedPreferences(BOLA.email)).toMatchObject({ version: 1 })
})

test("B1-W04 (ow :574) invalid latest work hour does not complete the step and shows the field error", async ({ page }) => {
  const step = await openStep3(page)
  await step.getByRole("combobox", { name: B1.homeCountry }).click()
  await page.getByRole("option", { name: "Kenya", exact: true }).click()
  await step.getByLabel(B1.latestWorkHour, { exact: true }).fill("00:00")
  await primary(step).click()
  await expect(step.getByText(B1.latestWorkHourError, { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/onboarding\/preferences$/)
  expect(await storedPreferences(BOLA.email)).toBeNull()
})

test("B1-W05 (ow :769, :773) step 3 saved from two tabs: one applies, the other shows the D30 conflict text", async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()]
  try {
    const [a, b] = await Promise.all(contexts.map((c) => c.newPage()))
    const stepA = await openStep3(a!)
    const stepB = await openStep3(b!)
    for (const [page, step, cap] of [[a!, stepA, 3], [b!, stepB, 4]] as const) {
      await step.getByRole("combobox", { name: B1.homeCountry }).click()
      await page.getByRole("option", { name: "Kenya", exact: true }).click()
      await capRadio(step, cap).check()
    }
    await Promise.all([primary(stepA).click(), primary(stepB).click()])
    await expect.poll(async () => (await a!.getByText(B1.conflict, { exact: true }).count()) + (await b!.getByText(B1.conflict, { exact: true }).count())).toBe(1)
    expect(await versionCount(BOLA.email)).toBe(1)
  } finally {
    for (const c of contexts) await c.close()
  }
})
