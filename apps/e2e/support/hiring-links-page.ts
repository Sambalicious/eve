import { type Locator, expect } from "@playwright/test"

import { HiringPage } from "./hiring-page.ts"
import { LINKS_COPY } from "./hiring-links-copy.ts"

/**
 * The Phase 1 "Hiring search links" section (design-spec.r1 B1), located by
 * role, accessible name and copy-deck text only.
 */
export class HiringLinksPage extends HiringPage {
  /** Opens Find jobs (the former Hiring view) and waits until the links section has left its loading state (QA-P1-T-05). */
  async openWith(params: Record<string, string> = {}): Promise<void> {
    const search = new URLSearchParams(params)
    await this.page.goto(`/find-jobs${search.size > 0 ? `?${search.toString()}` : ""}`)
    await this.waitUntilReady()
  }

  /** Raw query string, for values URLSearchParams would normalise (a trailing space, markup). */
  async openRaw(query: string): Promise<void> {
    await this.page.goto(`/find-jobs?${query.replace(/^view=hiring&?/, "")}`)
    await this.waitUntilReady()
  }

  /**
   * QA-P1-T-05: the section renders first in its loading state (design-spec H4
   * step 1), so it is ready only once it shows a hiring link or the no-family
   * empty state (C-HP-NOFAMILY-TITLE). Call after every navigation or reload
   * before reading hrefs, query strings or the family choice.
   */
  async waitUntilReady(): Promise<void> {
    await expect(this.linksSection()).toBeVisible()
    const ready = this.linkedinLinks().first().or(this.linksSection().getByText(LINKS_COPY.noFamilyTitle, { exact: true }))
    await expect(ready).toBeVisible()
  }

  linksSection(): Locator {
    return this.page.getByRole("region", { name: LINKS_COPY.title, exact: true })
  }

  hintNote(): Locator {
    return this.linksSection().getByText(LINKS_COPY.hint, { exact: false })
  }

  hintLink(): Locator {
    return this.linksSection().getByRole("link", { name: LINKS_COPY.hintLink, exact: true })
  }

  familySelect(): Locator {
    return this.linksSection().getByRole("combobox", { name: LINKS_COPY.familyLabel, exact: true })
  }

  /** Group rows: list items that carry a LinkedIn link. */
  groups(): Locator {
    return this.linksSection()
      .getByRole("listitem")
      .filter({ has: this.page.getByRole("link", { name: /^LinkedIn posts/ }) })
  }

  linkedinLinks(scope: Locator = this.linksSection()): Locator {
    return scope.getByRole("link", { name: /^LinkedIn posts/ })
  }

  googleLinks(scope: Locator = this.linksSection()): Locator {
    return scope.getByRole("link", { name: /^Google posts/ })
  }

  alertsToggles(scope: Locator = this.linksSection()): Locator {
    return scope.getByRole("button", { name: /^Google Alerts query/ })
  }

  copyButtons(scope: Locator = this.linksSection()): Locator {
    return scope.getByRole("button", { name: /^Copy hiring query/ })
  }

  /** Query blocks, by their accessible name C-HP-ALERTQ-BLOCK-SR "Hiring query for {group label}". */
  queryBlocks(scope: Locator = this.linksSection()): Locator {
    return scope.getByLabel(/^Hiring query for /)
  }

  async waitForGroups(count: number): Promise<void> {
    await expect(this.groups()).toHaveCount(count)
  }

  async linkedinHrefs(): Promise<string[]> {
    return this.linkedinLinks().evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""))
  }

  async googleHrefs(): Promise<string[]> {
    return this.googleLinks().evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""))
  }

  /** Expands every group's Google Alerts disclosure and returns the query strings in group order. */
  async alertsQueries(): Promise<string[]> {
    const toggles = this.alertsToggles()
    const n = await toggles.count()
    for (let i = 0; i < n; i += 1) {
      const toggle = toggles.nth(i)
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
    }
    await expect(this.queryBlocks()).toHaveCount(n)
    return this.queryBlocks().allTextContents()
  }

  /** Options offered by the Role family select, as visible labels. */
  async familyOptions(): Promise<string[]> {
    return this.familySelect().locator("option").allTextContents()
  }
}
