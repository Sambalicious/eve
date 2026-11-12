import { type Locator, type Page, expect, test } from "@playwright/test"
import pg from "pg"

import { B1 } from "../support/b1-copy.ts"
import { freshRecord, kenyaValues, storedPreferences, targetEveryFamily } from "../support/b1-db.ts"
import { setRelevance, signIn, stackState } from "../support/db.ts"
import { BOLA } from "../support/stack.ts"

/**
 * EPIC-0002 B1 QA gate gap tests (run epic-0002-b1, qa-1 attempt qa-3).
 * settings-b1.feature :86, :130 and :141 are "both" rows (a UI assertion over
 * API state). Before this file they had only mocked component tests
 * (apps/web settings-b1.test.tsx). These run them against the real web, api
 * and Postgres: every save goes through the real Settings page, and the
 * stored state is read back from the database.
 */

const ALL_FAMILIES = [
  "senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering", "backend", "mobile",
  "platform_engineering", "devops_platform", "people_management", "data_ml", "solutions_customer", "other",
] as const

async function withDb<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

type Stored = { minCoreMatchPercent: number; fullName: string; families: string[]; seniorityFloor: "all_levels" | "hide_entry_level" }

async function stored(email: string): Promise<Stored> {
  return withDb(async (client) => {
    const { rows } = await client.query<Stored>(
      `select jc.min_core_match_percent as "minCoreMatchPercent", jc.target_role_families as "families", jc.seniority_floor as "seniorityFloor",
              coalesce((select full_name from candidate_contact cc where cc.candidate_id = c.id), '') as "fullName"
         from candidate c join job_criteria jc on jc.candidate_id = c.id where c.email = $1`,
      [email]
    )
    if (!rows[0]) throw new Error(`no job_criteria for ${email}`)
    return rows[0]
  })
}

async function setMinCoreMatch(email: string, percent: number): Promise<void> {
  await withDb((client) => client.query("update job_criteria set min_core_match_percent = $2 where candidate_id = (select id from candidate where email = $1)", [email, percent]))
}

async function openSettings(page: Page): Promise<{ prefs: Locator; criteria: Locator; contact: Locator }> {
  await page.goto("/settings")
  const prefs = page.getByRole("region", { name: B1.settingsTitle, exact: true })
  const criteria = page.getByRole("region", { name: "Job criteria", exact: true })
  const contact = page.getByRole("region", { name: "Contact details", exact: true })
  await expect(prefs).toBeVisible()
  await expect(criteria).toBeVisible()
  return { prefs, criteria, contact }
}

const capRadio = (prefs: Locator, n: number) => prefs.getByRole("radiogroup", { name: B1.dailyCap }).getByRole("radio", { name: B1.capOption(n), exact: true })
const toast = (page: Page, text: string) => page.getByRole("region", { name: "Messages" }).getByText(text, { exact: true })

test.describe("settings-b1.feature: three saves on the real stack (QA gate gap tests)", () => {
  let before: Stored

  test.beforeEach(async ({ page }) => {
    before = await stored(BOLA.email)
    await targetEveryFamily(BOLA.email)
    await setMinCoreMatch(BOLA.email, 70)
    await signIn(page.context(), BOLA.email)
    await page.goto("/")
    await freshRecord(page, BOLA.email, kenyaValues({ dailyCap: 5 }))
  })

  test.afterEach(async () => {
    await setMinCoreMatch(BOLA.email, before.minCoreMatchPercent)
    await setRelevance(BOLA.email, before.families, before.seniorityFloor)
  })

  test("GATE-S141 (:141) saving Job preferences leaves an unsaved Job criteria edit on screen and unsaved", async ({ page }) => {
    const { prefs, criteria } = await openSettings(page)
    const match = criteria.getByLabel("Minimum core Match", { exact: true })
    await match.fill("85")
    await capRadio(prefs, 3).check()
    await prefs.getByRole("button", { name: B1.saveSettings, exact: true }).click()
    await expect(toast(page, B1.saved)).toBeVisible()
    expect(await storedPreferences(BOLA.email)).toMatchObject({ version: 2, values: { dailyCap: 3 } })
    await expect(match).toHaveValue("85")
    expect((await stored(BOLA.email)).minCoreMatchPercent).toBe(70)
  })

  test("GATE-S130 (:130) saving Job criteria leaves unsaved Job preferences and Contact edits on screen and unsaved", async ({ page }) => {
    const { prefs, criteria, contact } = await openSettings(page)
    const nameBefore = (await stored(BOLA.email)).fullName
    await capRadio(prefs, 3).check()
    const name = contact.getByLabel(/^Full name/)
    await name.fill("Kofi A. Mensah")
    const match = criteria.getByLabel("Minimum core Match", { exact: true })
    await match.fill("75")
    await criteria.getByRole("button", { name: "Save job criteria", exact: true }).click()
    await expect(toast(page, "Job criteria saved.")).toBeVisible()
    expect((await stored(BOLA.email)).minCoreMatchPercent).toBe(75)
    await expect(capRadio(prefs, 3)).toBeChecked()
    await expect(name).toHaveValue("Kofi A. Mensah")
    expect(await storedPreferences(BOLA.email)).toMatchObject({ version: 1, values: { dailyCap: 5 } })
    expect((await stored(BOLA.email)).fullName).toBe(nameBefore)
  })

  test("GATE-S86 (:86) saving the board families updates the Hidden labels without saving Job preferences", async ({ page }) => {
    await setRelevance(BOLA.email, ALL_FAMILIES.filter((f) => f !== "other"), "all_levels")
    const { prefs, criteria } = await openSettings(page)
    await expect(prefs.getByRole("radiogroup", { name: "Other, Hidden", exact: true })).toBeVisible()
    await expect(prefs.getByText(/hidden by Job criteria/)).toBeVisible()
    await criteria.getByRole("group", { name: "Families on your board" }).getByRole("checkbox", { name: /^Other/ }).check()
    await criteria.getByRole("button", { name: "Save job criteria", exact: true }).click()
    await expect(toast(page, "Job criteria saved.")).toBeVisible()
    await expect(prefs.getByRole("radiogroup", { name: "Other", exact: true })).toBeVisible()
    await expect(prefs.getByText("Hidden", { exact: true })).toHaveCount(0)
    await expect(prefs.getByText(/hidden by Job criteria/)).toHaveCount(0)
    expect((await stored(BOLA.email)).families).toContain("other")
    expect((await storedPreferences(BOLA.email))?.version).toBe(1)
  })
})
