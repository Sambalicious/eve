import { type Locator, type Page, expect, test } from "@playwright/test"

import { B1 } from "../support/b1-copy.ts"
import { PREFS_PATH, changePreferences, clearPreferences, freshRecord, kenyaValues, putPreferences, storedPreferences, versionCount } from "../support/b1-db.ts"
import { signIn } from "../support/db.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * EPIC-0002 B1 (run epic-0002-b1, qa-author, qa-tests-1). Settings Job
 * Preferences journeys against the real web, api and Postgres. Bola (an
 * onboarded invited Candidate) plays Kofi; Ada is the Operator. Selectors are
 * roles and accessible names from copy-b1.md; no product copy object is
 * imported. The one route use aborts a single PUT at the network layer to make
 * the save fail (failure injection, not a canned response; as E8-10 QG-2).
 *
 * Gherkin (job-preferences.feature): :54, :60, :74, :93, :98, :103, :109, :195,
 * :201, :225, :245, :308, :352 (UI rows), :577, :634, :656, :665, :675, :690,
 * :698, :706; job-postings-per-candidate.feature :742 (Settings row), :899, :947.
 * onboarding-wizard.feature :773 shares the conflict alert; the wizard itself is
 * slice C (see wizard-step3.b1.spec.ts).
 */

async function openSettings(page: Page, email: string): Promise<Locator> {
  await signIn(page.context(), email)
  await page.goto("/settings#preferences")
  const form = page.getByRole("region", { name: B1.settingsTitle, exact: true })
  await expect(form).toBeVisible()
  return form
}

const saveButton = (form: Locator) => form.getByRole("button", { name: B1.saveSettings, exact: true })
const capRadio = (form: Locator, n: number) => form.getByRole("radiogroup", { name: B1.dailyCap }).getByRole("radio", { name: B1.capOption(n), exact: true })
const keyword = (form: Locator) => form.getByRole("textbox", { name: new RegExp(`^${B1.keywordLabel}`) })
const familyGroup = (form: Locator, label: string) => form.getByRole("group", { name: label, exact: true })
// The S4a picker opens from a button named by the "Home country" label (plus the chosen country);
// its combobox is the search input inside the popover (design-spec.r4 S4a, country-picker.tsx).
const homeCountry = (form: Locator) => form.getByRole("button", { name: new RegExp(`^${B1.homeCountry}`) })
// A multi country picker is its label, a button named by it, then the chips list (country-picker.tsx);
// the field is not a named group.
const chips = (form: Locator, label: string) => form.getByRole("button", { name: label, exact: true }).locator("xpath=following::ul[1]")

test.describe("Settings Job Preferences: view, edit and save (job-preferences.feature:54, :201, :690)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page.context(), BOLA.email)
    await page.goto("/")
    await freshRecord(page, BOLA.email, kenyaValues({ dailyCap: 3 }))
  })

  test("B1-E01 (:54) Bola opens Job preferences in Settings, sets the daily cap to 4 and saves; version 2 holds 4", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await expect(capRadio(form, 3)).toBeChecked()
    await expect(saveButton(form)).toBeDisabled()
    await capRadio(form, 4).check()
    await expect(saveButton(form)).toBeEnabled()
    const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith(PREFS_PATH) && r.request().method() === "PUT"), saveButton(form).click()])
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toMatchObject({ baseVersion: 1, values: { dailyCap: 4 } })
    await expect(capRadio(form, 4)).toBeChecked()
    expect(await storedPreferences(BOLA.email)).toMatchObject({ version: 2, values: { dailyCap: 4 } })
  })

  test("B1-E02 (:201, :690) saving keyword react shows the toast, the two after-save lines, the active line, and no retired line", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await expect(form.getByText(B1.saveHelpSettings, { exact: true })).toBeVisible()
    await keyword(form).fill("react")
    await saveButton(form).click()
    await expect(page.getByRole("region", { name: "Messages" }).getByText(B1.saved, { exact: true })).toBeVisible()
    await expect(form.getByText(B1.appliesPattern)).toBeVisible()
    await expect(form.getByText(B1.appliesLater, { exact: true })).toBeVisible()
    await expect(page.getByText(B1.retiredApplies)).toHaveCount(0)
    await expect(form.getByText(B1.keywordActive("react"), { exact: true })).toBeVisible()
    expect(await storedPreferences(BOLA.email)).toMatchObject({ version: 2, values: { titleKeyword: "react" } })
  })

  test("B1-E03 (jppc :947) the keyword keeps its display form 'Réact Native' after save and reload", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await keyword(form).fill("Réact Native")
    await saveButton(form).click()
    await expect(page.getByRole("region", { name: "Messages" }).getByText(B1.saved, { exact: true })).toBeVisible()
    await page.reload()
    await expect(keyword(page.getByRole("region", { name: B1.settingsTitle, exact: true }))).toHaveValue("Réact Native")
  })

  test("B1-E04 (jppc :899) saving a zero-width-only keyword is accepted, shows the no-rule information line, and stores no keyword", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await keyword(form).fill("\u200B")
    await saveButton(form).click()
    await expect(page.getByRole("region", { name: "Messages" }).getByText(B1.saved, { exact: true })).toBeVisible()
    // jppc :899: the information line shows once the save is accepted.
    await expect(form.getByText(B1.keywordInfoEmpty, { exact: true })).toBeVisible()
    expect((await storedPreferences(BOLA.email))?.values.titleKeyword).toBeNull()
  })
})

test.describe("Settings Job Preferences: save states (job-preferences.feature:665, :675, :698, :706)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page.context(), BOLA.email)
    await page.goto("/")
    await freshRecord(page, BOLA.email, kenyaValues({ dailyCap: 3 }))
  })

  test("B1-E05 (:665) a save from an old version shows the D30 conflict alert with Reload preferences; the edit stays; nothing stored", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    // Another tab saves first: the stored version moves to 2 while this tab holds 1.
    await changePreferences(page, BOLA.email, { emphasisThemes: ["other tab"] })
    await capRadio(form, 2).check()
    const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith(PREFS_PATH) && r.request().method() === "PUT"), saveButton(form).click()])
    expect(response.status()).toBe(409)
    expect((await response.json()).error).toMatchObject({ code: "preferences_stale", currentVersion: 2 })
    const alert = page.getByRole("alert").filter({ hasText: B1.conflict })
    await expect(alert).toBeVisible()
    await expect(alert.getByText(B1.conflict, { exact: true })).toBeVisible()
    await expect(alert.getByRole("button", { name: B1.conflictButton, exact: true })).toBeVisible()
    await expect(alert).toBeFocused()
    await expect(capRadio(form, 2)).toBeChecked()
    expect(await storedPreferences(BOLA.email)).toMatchObject({ version: 2, values: { dailyCap: 3 } })
  })

  test("B1-E06 (:675) Reload preferences, then saving daily cap 2 on the latest version stores version 3 with cap 2", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await changePreferences(page, BOLA.email, { emphasisThemes: ["other tab"] })
    await capRadio(form, 2).check()
    await saveButton(form).click()
    await page.getByRole("button", { name: B1.conflictButton, exact: true }).click()
    await expect(page.getByText(B1.conflict)).toHaveCount(0)
    await expect(capRadio(form, 3)).toBeChecked()
    await capRadio(form, 2).check()
    const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith(PREFS_PATH) && r.request().method() === "PUT"), saveButton(form).click()])
    expect(response.request().postDataJSON()).toMatchObject({ baseVersion: 2 })
    expect(response.status()).toBe(200)
    expect(await storedPreferences(BOLA.email)).toMatchObject({ version: 3, values: { dailyCap: 2, emphasisThemes: ["other tab"] } })
  })

  test("B1-E07 (:656) two tabs save at once: one applies, the other shows the conflict alert, one new version", async ({ browser }) => {
    const contexts = [await browser.newContext(), await browser.newContext()]
    try {
      const [a, b] = await Promise.all(contexts.map((c) => c.newPage()))
      const formA = await openSettings(a!, BOLA.email)
      const formB = await openSettings(b!, BOLA.email)
      await capRadio(formA, 2).check()
      await formB.getByRole("textbox", { name: B1.payFloor }).first().fill("4500")
      await Promise.all([saveButton(formA).click(), saveButton(formB).click()])
      await expect.poll(async () => (await a!.getByText(B1.conflict, { exact: true }).count()) + (await b!.getByText(B1.conflict, { exact: true }).count())).toBe(1)
      expect(await versionCount(BOLA.email)).toBe(2)
    } finally {
      for (const c of contexts) await c.close()
    }
  })

  test("B1-E08 (:698) a failed save shows the network alert above Save with Try again; keyword and cap stay; version unchanged", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await keyword(form).fill("react")
    await capRadio(form, 2).check()
    let aborted = 0
    // eslint-disable-next-line no-restricted-properties -- single request-abort failure injection (as E8-10 QG-2)
    await page.route(`**${PREFS_PATH}`, async (route) => {
      if (route.request().method() !== "PUT" || aborted > 0) return route.fallback()
      aborted += 1
      await route.abort("internetdisconnected")
    })
    await saveButton(form).click()
    const alert = form.getByRole("alert").filter({ hasText: B1.errorNetwork })
    await expect(alert).toBeVisible()
    await expect(alert.getByRole("button", { name: B1.errorNetworkButton, exact: true })).toBeVisible()
    await expect(alert).toBeFocused()
    expect(aborted).toBe(1)
    await page.unrouteAll()
    await expect(keyword(form)).toHaveValue("react")
    await expect(capRadio(form, 2)).toBeChecked()
    expect((await storedPreferences(BOLA.email))?.version).toBe(1)
    // Alert above the save action (B-PREF-3).
    const alertBox = await alert.boundingBox()
    const saveBox = await saveButton(form).boundingBox()
    expect(alertBox!.y).toBeLessThan(saveBox!.y)
  })

  test("B1-E09 (:706) after 10 save attempts this minute, the 11th shows the rate-limit alert with focus; edits and Save stay", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    // openSettings signs in again, so this session has made no attempt yet (the fresh record
    // was saved from the beforeEach session). 10 attempts here; 400s count too. The UI save is the 11th.
    for (let i = 0; i < 10; i += 1) await putPreferences(page, 999, kenyaValues())
    await keyword(form).fill("react")
    const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith(PREFS_PATH) && r.request().method() === "PUT"), saveButton(form).click()])
    expect(response.status()).toBe(429)
    const alert = form.getByRole("alert").filter({ hasText: B1.errorRateLimited })
    await expect(alert.getByText(B1.errorRateLimited, { exact: true })).toBeVisible()
    await expect(alert).toBeFocused()
    await expect(keyword(form)).toHaveValue("react")
    await expect(saveButton(form)).toBeEnabled()
    const alertBox = await alert.boundingBox()
    const saveBox = await saveButton(form).boundingBox()
    expect(alertBox!.y).toBeLessThan(saveBox!.y)
    expect((await storedPreferences(BOLA.email))?.values.titleKeyword).toBeNull()
  })

  test("B1-E10 (:352 UI row) latest work hour 00:00 shows 'Choose a time from 01:00 to 23:59.' and stores nothing", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await form.getByLabel(B1.latestWorkHour, { exact: true }).fill("00:00")
    await saveButton(form).click()
    await expect(form.getByText(B1.latestWorkHourError, { exact: true })).toBeVisible()
    await expect(form.getByLabel(B1.latestWorkHour, { exact: true })).toHaveAttribute("aria-invalid", "true")
    expect((await storedPreferences(BOLA.email))?.version).toBe(1)
  })
})

test.describe("Settings Job Preferences: form content (job-preferences.feature:60 to :109, :195, :225, :245, :308; jppc :742)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page.context(), BOLA.email)
    await page.goto("/")
    await freshRecord(page, BOLA.email, kenyaValues())
  })

  test("B1-E11 (:195, jppc :742) the tiers list every catalog family with Tier 1, Tier 2, Tier 3 and Excluded; senior_frontend reads 'Frontend'", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await expect(form.getByRole("heading", { name: B1.familiesTitle, exact: true })).toBeVisible()
    const frontend = familyGroup(form, B1.familyFrontend)
    await expect(frontend).toBeVisible()
    for (const tier of [B1.tier[1], B1.tier[2], B1.tier[3], B1.tier.excluded]) await expect(frontend.getByRole("radio", { name: tier, exact: true })).toBeVisible()
    await expect(frontend.getByRole("radio", { name: B1.tier[1], exact: true })).toBeChecked()
    await expect(form.getByText(B1.retiredFrontend, { exact: true })).toHaveCount(0)
    // 13 family rows (contract decision: the live catalog, not nine).
    // Counted inside the "Role families" group, which wraps the 13 family fieldsets (and so also holds Excluded radios).
    const families = form.getByRole("group", { name: B1.familiesTitle, exact: true })
    await expect(families.getByRole("group").filter({ has: page.getByRole("radio", { name: B1.tier.excluded, exact: true }) })).toHaveCount(13)
  })

  test("B1-E12 (:98, :103, :109) a saved record shows sponsorship Yes, all five levels, all three types and the daily cap", async ({ page }) => {
    await freshRecord(page, BOLA.email, kenyaValues({ dailyCap: 5 }))
    const form = await openSettings(page, BOLA.email)
    await expect(form.getByRole("radiogroup", { name: B1.sponsorship }).getByRole("radio", { name: "Yes", exact: true })).toBeChecked()
    const levels = form.getByRole("group", { name: B1.seniority })
    for (const label of B1.seniorityOptions) await expect(levels.getByRole("checkbox", { name: label, exact: true })).toBeChecked()
    const types = form.getByRole("group", { name: B1.employment })
    for (const label of B1.employmentOptions) await expect(types.getByRole("checkbox", { name: label, exact: true })).toBeChecked()
    await expect(capRadio(form, 5)).toBeChecked()
  })

  test("B1-E13 (:308) the pay floor currency lists exactly the 20 rate-table codes, USD first, EUR second, with its help line", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    const group = form.getByRole("group", { name: /^Lowest pay you'll accept/ })
    const currency = group.getByRole("combobox")
    const options = await currency.locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value).filter(Boolean))
    expect(options).toEqual(["USD", "EUR", "AUD", "BRL", "CAD", "CHF", "CZK", "DKK", "GBP", "ILS", "INR", "JPY", "MXN", "NOK", "NZD", "PLN", "SEK", "SGD", "TRY", "ZAR"])
    await expect(currency.locator("option", { hasText: "EUR, Euro" })).toHaveCount(1)
    for (const missing of ["NGN", "KES", "GHS", "EGP", "AED", "SAR"]) expect(options).not.toContain(missing)
    await expect(form.getByText(B1.currencyHelp, { exact: true })).toBeVisible()
  })

  test("B1-E14 (:225) changing home country Kenya to Ghana adds Ghana, keeps Kenya, shows the home-changed line, and leaves time zone", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await homeCountry(form).click()
    await page.getByRole("option", { name: "Ghana", exact: true }).click()
    await expect(form.getByText(B1.homeChanged("Ghana", "Kenya"), { exact: true })).toBeVisible()
    const auth = chips(form, B1.workAuth)
    await expect(auth.getByText("Ghana", { exact: true })).toBeVisible()
    await expect(auth.getByRole("button", { name: "Remove Kenya", exact: true })).toBeVisible()
    await expect(auth.getByRole("button", { name: "Remove Ghana", exact: true })).toHaveCount(0)
    await expect(form.getByRole("combobox", { name: B1.timeZone })).toContainText("Africa/Nairobi")
    await expect(form.getByLabel(B1.latestWorkHour, { exact: true })).toHaveValue("23:00")
  })

  test("B1-E15 (:245) changing home country to an excluded relocation country removes it there and says so", async ({ page }) => {
    await freshRecord(page, BOLA.email, kenyaValues({ excludedRelocationCountries: ["ZA", "EG"] }))
    const form = await openSettings(page, BOLA.email)
    await homeCountry(form).click()
    await page.getByRole("option", { name: "South Africa", exact: true }).click()
    await expect(form.getByText(B1.homeUnexcluded("South Africa"), { exact: true })).toBeVisible()
    const excluded = chips(form, B1.excludedRelocation)
    await expect(excluded.getByText("South Africa", { exact: true })).toHaveCount(0)
    await expect(excluded.getByText("Egypt", { exact: true })).toBeVisible()
  })

  test("B1-E16 (:74) the home country choice offers Nigeria, Ghana, Kenya, South Africa and Egypt", async ({ page }) => {
    const form = await openSettings(page, BOLA.email)
    await homeCountry(form).click()
    for (const country of ["Nigeria", "Ghana", "Kenya", "South Africa", "Egypt"]) await expect(page.getByRole("option", { name: country, exact: true })).toBeVisible()
  })

  test("B1-E17 (:60) choosing a home country with no time zone set defaults the time zone (Settings shares the step 3 form)", async ({ page }) => {
    await clearPreferences(BOLA.email)
    const form = await openSettings(page, BOLA.email)
    for (const [country, zone] of [["Nigeria", "Africa/Lagos"], ["Kenya", "Africa/Nairobi"], ["Ghana", "Africa/Accra"], ["South Africa", "Africa/Johannesburg"], ["Egypt", "Africa/Cairo"]] as const) {
      await page.reload()
      await homeCountry(form).click()
      await page.getByRole("option", { name: country, exact: true }).click()
      await expect(form.getByRole("combobox", { name: B1.timeZone })).toContainText(zone)
      await expect(form.getByLabel(B1.latestWorkHour, { exact: true })).toHaveValue("23:00")
    }
  })
})

test.describe("no record and privacy (job-preferences.feature:634, :577)", () => {
  test("B1-E18 (:634) with no record Settings shows the step 3 defaults: no home country, cap 5, all levels; nothing is written by opening it", async ({ page }) => {
    await signIn(page.context(), BOLA.email)
    await clearPreferences(BOLA.email)
    const form = await openSettings(page, BOLA.email)
    await expect(capRadio(form, 5)).toBeChecked()
    await expect(form.getByRole("radiogroup", { name: B1.sponsorship }).getByRole("radio", { name: "Yes", exact: true })).toBeChecked()
    expect(await storedPreferences(BOLA.email)).toBeNull()
  })

  test("B1-E19 (:577) Ada's Settings shows her own preferences; no Operator page or request shows Bola's values", async ({ page }) => {
    await signIn(page.context(), BOLA.email)
    await page.goto("/")
    await freshRecord(page, BOLA.email, kenyaValues({ titleKeyword: "bolasentinelkeyword", emphasisThemes: ["BOLA-SENTINEL-THEME"] }))
    await page.context().clearCookies()
    const responses: string[] = []
    page.on("response", async (r) => {
      if (r.url().includes("/v1/")) responses.push(await r.text().catch(() => ""))
    })
    const form = await openSettings(page, ADA.email)
    await expect(keyword(form)).not.toHaveValue("bolasentinelkeyword")
    await page.goto("/settings")
    await page.goto("/dashboard")
    expect(responses.join("\n")).not.toMatch(/bolasentinelkeyword|BOLA-SENTINEL-THEME/)
    await expect(page.getByText("BOLA-SENTINEL-THEME")).toHaveCount(0)
  })
})
