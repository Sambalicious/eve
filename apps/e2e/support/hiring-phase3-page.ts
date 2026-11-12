import { type Locator, type Response, expect } from "@playwright/test"

import { COPY } from "./copy.ts"
import { HiringPage } from "./hiring-page.ts"
import { P3 } from "./phase3-copy.ts"

/** api-contract.r1 Phase 3 paths (`@eve/contracts` constants, retyped so a wrong product path fails). */
export const HIRING_FEEDS_PATH = "/v1/stack-posts/hiring-feeds"
export const HIRING_VERIFICATION_PATH = "/v1/stack-posts/hiring-feeds/verification"
export const HIRING_POSTS_PATH = "/v1/stack-posts/hiring-posts"
export const ALERT_FEEDS_PATH = "/v1/stack-posts/alert-feeds"

/**
 * The Phase 3 sections of the Hiring view (design-spec.r2 B3, B4, H6b), by
 * role, accessible name and copy-deck text only.
 */
export class HiringPhase3Page extends HiringPage {
  /**
   * Opens Find jobs with Set up alerts open and waits for the Hiring Alert feeds section to leave its
   * loading state. `query` is a raw query string such as "&page=2" or "?page=2".
   */
  async openAndWait(query = ""): Promise<void> {
    const feedsLoaded = this.page.waitForResponse((r) => new URL(r.url()).pathname === HIRING_FEEDS_PATH && r.request().method() === "GET")
    const search = query === "" ? "" : `?${query.replace(/^[?&]/, "")}`
    await this.page.goto(`${COPY.findPath}${search}`)
    await feedsLoaded
    await this.openAlerts()
    await expect(this.confirmButton().or(this.updateButton()).first()).toBeVisible()
  }

  feedsSection(): Locator {
    return this.page.getByRole("region", { name: P3.feedsTitle, exact: true })
  }

  postsSection(): Locator {
    return this.page.getByRole("region", { name: P3.postsTitle, exact: true })
  }

  /** The one "Confirm you may use these feeds" step at the top of Set up alerts (shown while any list is unconfirmed). */
  confirmStep(): Locator {
    return this.page.getByRole("group", { name: P3.confirmTitle, exact: true })
  }

  /** Its "I confirm" button: opens the date-and-basis dialog, which records every unconfirmed list. */
  confirmButton(): Locator {
    return this.confirmStep().getByRole("button", { name: P3.confirmButton, exact: true })
  }

  /** TD-RW1: what used to be this section's own "Record permitted use" button is now the shared confirm step. */
  verifyMissingButton(): Locator {
    return this.confirmButton()
  }

  updateButton(): Locator {
    return this.feedsSection().getByRole("button", { name: P3.verifyUpdateSr, exact: true })
  }

  dialog(): Locator {
    return this.page.getByRole("dialog", { name: P3.dialogTitle, exact: true })
  }

  dateField(): Locator {
    return this.dialog().getByLabel(new RegExp(`^${P3.verifyDateLabel}`))
  }

  basisField(): Locator {
    return this.dialog().getByLabel(new RegExp(`^${P3.verifyBasisLabel}`))
  }

  saveButton(): Locator {
    return this.dialog().getByRole("button", { name: P3.verifySubmit, exact: true })
  }

  /** Fills and saves the permitted-use dialog; resolves with the PUT response. */
  async saveVerification(date: string, basis: string): Promise<Response> {
    await this.dateField().fill(date)
    await this.basisField().fill(basis)
    const put = this.page.waitForResponse((r) => new URL(r.url()).pathname === HIRING_VERIFICATION_PATH && r.request().method() === "PUT")
    await this.saveButton().click()
    return put
  }

  feedUrlField(): Locator {
    return this.feedsSection().getByRole("textbox", { name: P3.feedUrlLabel, exact: true })
  }

  feedLabelField(): Locator {
    return this.feedsSection().getByRole("textbox", { name: P3.feedLabelLabel, exact: true })
  }

  addFeedButton(): Locator {
    return this.feedsSection().getByRole("button", { name: P3.feedAdd, exact: true })
  }

  /** Feed rows: list items named "{name}, feed ending d d d d d d". */
  feedRows(): Locator {
    return this.feedsSection().getByRole("listitem").filter({ has: this.page.getByRole("button", { name: /^Remove / }) })
  }

  feedRow(name: string, digits: string): Locator {
    return this.feedsSection().getByRole("listitem", { name: P3.feedRowName(name, digits), exact: true })
  }

  /** Registers through the form; resolves with the POST response. */
  async registerFeed(url: string, label = ""): Promise<Response> {
    await this.feedUrlField().fill(url)
    await this.feedLabelField().fill(label)
    const post = this.page.waitForResponse((r) => new URL(r.url()).pathname === HIRING_FEEDS_PATH && r.request().method() === "POST")
    await this.addFeedButton().click()
    return post
  }

  /** Hiring post rows: list items holding the "Not vetted" label. */
  postRows(): Locator {
    return this.postsSection().getByRole("listitem").filter({ hasText: P3.notVetted })
  }

  postRow(title: string): Locator {
    return this.postRows().filter({ has: this.page.getByRole("link", { name: new RegExp(`^${escapeRegExp(title)}`) }) })
  }

  pagination(): Locator {
    return this.postsSection().getByRole("navigation", { name: P3.pageNav, exact: true })
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
