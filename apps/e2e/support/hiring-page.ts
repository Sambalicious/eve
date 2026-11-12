import { type Locator, type Page, type Request, expect } from "@playwright/test"

import { COPY } from "./copy.ts"
import { JOB_POSTING_LINKS_PATH } from "./db.ts"

/**
 * Locators for Find jobs (`/find-jobs`, EPIC-0011 R5), by role and deck text only. It replaces the
 * Stack posts page and its Hiring view: there is no tablist any more, every list is a section of one
 * page, and both Alert feeds lists sit inside the collapsed "Set up alerts" section.
 */
export class HiringPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /**
   * Opens Find jobs. The `view` argument is kept so older call sites read the same: since EPIC-0011 both
   * values open the same page, and it is ignored (the legacy `/stack-posts?view=` redirect is tested in
   * hiring-view.phase2.spec.ts).
   */
  async open(view: string | null = "hiring"): Promise<void> {
    void view
    await this.page.goto(COPY.findPath)
    await expect(this.page.getByRole("heading", { level: 1, name: COPY.findTitle })).toBeVisible()
  }

  /** The "Set up alerts" disclosure button (aria-expanded), whose name starts with the heading. */
  alertsToggle(): Locator {
    return this.page.getByRole("button", { name: new RegExp(`^${COPY.setUpAlerts}`) })
  }

  /** Opens Set up alerts if it is closed, so the Alert feeds and Hiring Alert feeds sections are mounted. */
  async openAlerts(): Promise<void> {
    const toggle = this.alertsToggle()
    await expect(toggle).toBeVisible()
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
  }

  /** The "Check this job" section: a region named by its h2. */
  checkSection(): Locator {
    return this.page.getByRole("region", { name: COPY.checkTitle, exact: true })
  }

  /** The section's one button: it opens the check form in a dialog (EPIC-0011). */
  checkButton(): Locator {
    return this.checkSection().getByRole("button", { name: COPY.checkTitle, exact: true })
  }

  /** The check form's dialog (only present while open). */
  dialog(): Locator {
    return this.page.getByRole("dialog", { name: COPY.checkTitle, exact: true })
  }

  /** Opens the check form's dialog unless it is open, and returns it. */
  async openCheck(): Promise<Locator> {
    const dialog = this.page.getByRole("dialog", { name: COPY.checkTitle, exact: true })
    if ((await dialog.count()) === 0) await this.checkButton().click()
    await expect(dialog).toBeVisible()
    return dialog
  }

  urlField(): Locator {
    return this.page.getByRole("dialog", { name: COPY.checkTitle, exact: true }).getByRole("textbox", { name: COPY.urlLabel, exact: true })
  }

  submitButton(): Locator {
    return this.page.getByRole("dialog", { name: COPY.checkTitle, exact: true }).getByRole("button", { name: COPY.submit, exact: true })
  }

  warning(): Locator {
    return this.page.getByRole("dialog", { name: COPY.checkTitle, exact: true }).getByRole("alert").filter({ hasText: COPY.liWarn })
  }

  saveAnyway(): Locator {
    return this.page.getByRole("dialog", { name: COPY.checkTitle, exact: true }).getByRole("button", { name: COPY.liWarnSend, exact: true })
  }

  resultStatus(): Locator {
    return this.page.getByRole("dialog", { name: COPY.checkTitle, exact: true }).getByRole("status")
  }

  toasts(): Locator {
    return this.page.getByRole("region", { name: "Messages" })
  }

  heading(name: string): Locator {
    return this.page.getByRole("heading", { level: 2, name, exact: true })
  }

  async submit(url: string): Promise<void> {
    await this.openCheck()
    await this.urlField().fill(url)
    await this.submitButton().click()
  }
}

/** Records every request the browser makes, for no-request and outbound-host assertions. */
export function recordRequests(page: Page): Request[] {
  const requests: Request[] = []
  page.on("request", (request) => requests.push(request))
  return requests
}

export function pasteRequests(requests: readonly Request[]): Request[] {
  return requests.filter((request) => request.method() === "POST" && new URL(request.url()).pathname === JOB_POSTING_LINKS_PATH)
}

/** True for linkedin.com or any subdomain, and any google.com host (AC 5.7, 10.3). */
export function isForbiddenHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase()
  return host === "linkedin.com" || host.endsWith(".linkedin.com") || host === "google.com" || host.endsWith(".google.com")
}

export async function expectNoPasteRequest(requests: readonly Request[]): Promise<void> {
  // Give a would-be request time to start before asserting it never did.
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(pasteRequests(requests)).toHaveLength(0)
}
