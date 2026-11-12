import { expect, test } from "@playwright/test"

import { signIn } from "../support/db.ts"
import { E11, SIDEBAR_NAV } from "../support/epic-0011-copy.ts"
import { ensureProfileInUse, readAdvanced, readAutomatic, setAdvanced, setAutomatic, setGlobalPause } from "../support/epic-0011-db.ts"
import { ADA } from "../support/stack.ts"

/**
 * QA gate r4, real-stack check for CR-01 (code-review.md) and advanced-switch.r1.feature ADV:101:
 * "The Operator who turns Advanced on then enables automatic submission stays locked", in the same session.
 * The Operator starts with Advanced off and automatic off (gate passed), turns automatic on from Pause and cost,
 * then opens Settings through the sidebar (no reload): the switch must already be on and locked.
 */
test.beforeEach(async () => {
  await setGlobalPause(false)
  await setAutomatic(ADA.email, false, true)
  await setAdvanced(ADA.email, false)
  await ensureProfileInUse(ADA.email)
})

test.afterAll(async () => {
  await setAutomatic(ADA.email, false)
  await setAdvanced(ADA.email, true)
})

test("CR-01 / ADV:101 enabling automatic locks the Advanced switch in the same session, without a reload", async ({ page, context }) => {
  await signIn(context, ADA.email)
  await page.goto("/pause-and-cost")
  await expect(page.getByText(E11.hiddenNote)).toBeVisible()
  await page.getByRole("button", { name: "Turn on automatic submission" }).click()
  const dialog = page.getByRole("alertdialog", { name: "Turn on automatic submission?" })
  await dialog.getByRole("button", { name: "Turn on" }).click()
  await expect(page.getByText("Automatic submission is on").first()).toBeVisible()
  expect(await readAutomatic(ADA.email)).toBe(true)
  expect((await readAdvanced(ADA.email))?.advanced).toBe(true)

  let reloaded = false
  page.on("load", () => (reloaded = true))
  await page.locator(SIDEBAR_NAV).first().getByRole("link", { name: /^Settings/ }).click()
  await expect(page).toHaveURL(/\/settings$/)
  const toggle = page.getByRole("switch", { name: E11.switchLabel })
  await expect(toggle).toBeChecked()
  await expect(toggle).toBeDisabled()
  // The group appears in the nav at once too (the viewer was refreshed, not only the switch).
  await expect(page.locator(SIDEBAR_NAV).first().getByText(E11.navGroup, { exact: true })).toBeVisible()
  expect(reloaded).toBe(false)
})
