import { type Locator, type Page, type Response, expect } from "@playwright/test"

import { SP8 } from "./stack-feed-copy.ts"

/** api-contract.md v1.22.0 paths, retyped so a wrong product path fails. */
export const ALERT_FEEDS_PATH = "/v1/stack-posts/alert-feeds"
export const ALERT_FEED_VERIFICATION_PATH = "/v1/stack-posts/alert-feeds/verification"

/** The Stack posts view's Alert feeds and Posts sections (design-spec S1 to S3), by role, accessible name and deck text only. */
export class StackFeedPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /** Opens Find jobs, opens Set up alerts, and waits for the Alert feeds section to leave its loading state. */
  async openAndWait(): Promise<void> {
    const loaded = this.page.waitForResponse((r) => new URL(r.url()).pathname === ALERT_FEEDS_PATH && r.request().method() === "GET")
    await this.page.goto("/find-jobs")
    await loaded
    const toggle = this.page.getByRole("button", { name: /^Set up alerts/ })
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
    await expect(this.confirmButton().or(this.updateButton()).first()).toBeVisible()
  }

  feedsSection(): Locator {
    return this.page.getByRole("region", { name: SP8.feedsSectionTitle, exact: true })
  }

  postsSection(): Locator {
    return this.page.getByRole("region", { name: SP8.postsTitle, exact: true })
  }

  /** The one "Confirm you may use these feeds" step at the top of Set up alerts (shown while any list is unconfirmed). */
  confirmStep(): Locator {
    return this.page.getByRole("group", { name: SP8.confirmTitle, exact: true })
  }

  confirmButton(): Locator {
    return this.confirmStep().getByRole("button", { name: SP8.confirmButton, exact: true })
  }

  /** TD-RW1: what used to be this section's own "Record permitted use" button is now the shared confirm step. */
  recordButton(): Locator {
    return this.confirmButton()
  }

  updateButton(): Locator {
    return this.feedsSection().getByRole("button", { name: SP8.verifyUpdateSr, exact: true })
  }

  recordedLine(date: string): Locator {
    return this.feedsSection().getByText(SP8.verifyRecorded(date), { exact: true })
  }

  dialog(): Locator {
    return this.page.getByRole("dialog", { name: SP8.dialogTitle, exact: true })
  }

  dateField(): Locator {
    return this.dialog().getByLabel(new RegExp(`^${SP8.verifyDateLabel}`))
  }

  basisField(): Locator {
    return this.dialog().getByLabel(new RegExp(`^${SP8.verifyBasisLabel}`))
  }

  saveButton(): Locator {
    return this.dialog().getByRole("button", { name: SP8.verifySubmit, exact: true })
  }

  toasts(): Locator {
    return this.page.getByRole("region", { name: "Messages" })
  }

  /** Fills and saves the dialog; resolves with the PUT response. */
  async saveVerification(date: string, basis: string): Promise<Response> {
    await this.dateField().fill(date)
    await this.basisField().fill(basis)
    const put = this.page.waitForResponse((r) => new URL(r.url()).pathname === ALERT_FEED_VERIFICATION_PATH && r.request().method() === "PUT")
    await this.saveButton().click()
    return put
  }

  feedUrlField(): Locator {
    return this.feedsSection().getByRole("textbox", { name: SP8.feedUrlLabel, exact: true })
  }

  feedLabelField(): Locator {
    return this.feedsSection().getByRole("textbox", { name: SP8.feedLabelLabel, exact: true })
  }

  addFeedButton(): Locator {
    return this.feedsSection().getByRole("button", { name: SP8.feedAdd, exact: true })
  }

  feedRow(name: string, digits: string): Locator {
    return this.feedsSection().getByRole("listitem", { name: SP8.feedRowName(name, digits), exact: true })
  }

  removeButton(name: string, digits: string): Locator {
    return this.feedsSection().getByRole("button", { name: SP8.feedRemoveSr(name, digits), exact: true })
  }

  /** Registers through the form; resolves with the POST response. */
  async registerFeed(url: string, label = ""): Promise<Response> {
    await this.feedUrlField().fill(url)
    await this.feedLabelField().fill(label)
    const post = this.page.waitForResponse((r) => new URL(r.url()).pathname === ALERT_FEEDS_PATH && r.request().method() === "POST")
    await this.addFeedButton().click()
    return post
  }

  /** Visible text plus every accessible name (aria-label, aria-describedby targets, title) under `root`. */
  async surfaceText(root: Locator): Promise<string> {
    return root.evaluate((element) => {
      const parts: string[] = [element.textContent ?? ""]
      for (const node of [element, ...Array.from(element.querySelectorAll("*"))]) {
        for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
          const value = node.getAttribute(attr)
          if (value) parts.push(value)
        }
        for (const attr of ["aria-labelledby", "aria-describedby"]) {
          for (const id of (node.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) parts.push(document.getElementById(id)?.textContent ?? "")
        }
      }
      return parts.join("\n")
    })
  }
}
