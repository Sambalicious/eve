import { type Locator, type Page, expect } from "@playwright/test"

import { COPY } from "./copy.ts"

/**
 * The `/postings` "Add a job link" form (EPIC-0011): the page shows one outline
 * button on its own row and opens the form in a dialog. Home keeps its own paste
 * box and has no such trigger.
 */
export class AddJobLinkDialog {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  trigger(): Locator {
    return this.page.getByRole("button", { name: COPY.addJobLinkTitle, exact: true })
  }

  /** The dialog (only present while open). */
  dialog(): Locator {
    return this.page.getByRole("dialog", { name: COPY.addJobLinkTitle, exact: true })
  }

  /** Opens the dialog unless it is open, and returns it. */
  async open(): Promise<Locator> {
    if ((await this.dialog().count()) === 0) await this.trigger().click()
    await expect(this.dialog()).toBeVisible()
    return this.dialog()
  }

  field(): Locator {
    return this.dialog().getByRole("textbox").first()
  }

  submitButton(): Locator {
    return this.dialog().getByRole("button", { name: COPY.submit, exact: true })
  }

  resultStatus(): Locator {
    return this.dialog().getByRole("status")
  }

  toasts(): Locator {
    return this.page.getByRole("region", { name: "Messages" })
  }

  /** Opens the dialog, fills the link and submits with "Check link". */
  async submit(url: string): Promise<void> {
    await this.open()
    await this.field().fill(url)
    await this.submitButton().click()
  }
}

/** Opens the dialog and returns it, for specs that scope their queries to the form. */
export async function openAddJobLink(page: Page): Promise<Locator> {
  return await new AddJobLinkDialog(page).open()
}
