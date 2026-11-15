import { expect, test } from "@playwright/test"

import { AddJobLinkDialog } from "../support/add-job-link.ts"
import { COPY } from "../support/copy.ts"
import { resetPostings, signIn } from "../support/db.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0011: `/postings` shows one outline "Add a job link" button on its own row
 * and opens the paste form in a dialog. Home keeps its own paste box. Locators by
 * role and deck text only.
 */
test.beforeEach(async ({ context }) => {
  await resetPostings()
  await signIn(context, ADA.email)
})

test.describe("Add a job link dialog on /postings", () => {
  test("the trigger opens the dialog with the link field focused; Escape closes it and focus returns to the trigger", async ({ page }) => {
    await page.goto("/postings")
    const add = new AddJobLinkDialog(page)

    await expect(add.trigger()).toBeVisible()
    await expect(add.trigger()).toHaveAttribute("aria-expanded", "false")
    await expect(add.dialog()).toHaveCount(0)

    const dialog = await add.open()
    await expect(dialog.getByRole("heading", { name: COPY.addJobLinkTitle, exact: true })).toBeVisible()
    await expect(add.field()).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(add.dialog()).toHaveCount(0)
    await expect(add.trigger()).toBeFocused()
  })

  test("an empty submit shows C-VAL-LINK-1 inline and keeps the dialog open", async ({ page }) => {
    await page.goto("/postings")
    const add = new AddJobLinkDialog(page)
    const dialog = await add.open()

    await add.submitButton().click()

    await expect(dialog.getByText(COPY.linkEmpty, { exact: true })).toBeVisible()
    await expect(add.field()).toHaveAttribute("aria-invalid", "true")
    await expect(add.field()).toBeFocused()
    await expect(add.dialog()).toBeVisible()
  })
})
