import { type Locator, type Page, type Request, type Response, expect } from "@playwright/test"

import { EXIST } from "./existing-applications-copy.ts"

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const

export type ExistingInput = Readonly<{ company?: string; role?: string; url?: string; requisition?: string; date?: string }>

/**
 * `/existing-applications` (design-spec.r4.md F1 step 6a) by role, label and
 * spec text only. `scope` is the page on desktop and the sheet (dialog named
 * C-EXIST-5) below 768px, so the same field helpers serve both layouts.
 */
export class ExistingApplicationsPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /** Opens the route and waits for the list request to settle. */
  async open(): Promise<void> {
    const loaded = this.page.waitForResponse((r) => new URL(r.url()).pathname === EXIST.apiPath && r.request().method() === "GET")
    await this.page.goto(EXIST.path)
    await loaded
    await expect(this.heading()).toBeVisible()
  }

  heading(): Locator {
    return this.page.getByRole("heading", { level: 1, name: EXIST.title, exact: true })
  }

  markCompleteButton(): Locator {
    return this.page.getByRole("button", { name: EXIST.markComplete, exact: true })
  }

  confirmDialog(): Locator {
    return this.page.getByRole("alertdialog", { name: EXIST.confirmTitle }).or(this.page.getByRole("dialog", { name: EXIST.confirmTitle }))
  }

  /** The add form's dialog (C-EXIST-5 title); it is a modal at every width. */
  form(): Locator {
    return this.page.getByRole("dialog", { name: EXIST.formHeading, exact: true })
  }

  /** The button above the table that opens the add form. */
  addButton(): Locator {
    return this.page.getByRole("button", { name: EXIST.submit, exact: true })
  }

  /** Opens the add dialog unless it is already open. */
  async openAddForm(): Promise<Locator> {
    if ((await this.form().count()) === 0) await this.addButton().click()
    const form = this.form()
    await expect(form).toBeVisible()
    return form
  }

  field(scope: Page | Locator, name: keyof typeof EXIST.labels): Locator {
    return scope.getByLabel(EXIST.labels[name], { exact: true })
  }

  submitButton(scope: Page | Locator): Locator {
    return scope.getByRole("button", { name: EXIST.submit, exact: true })
  }

  toasts(): Locator {
    return this.page.getByRole("region", { name: "Messages" })
  }

  table(): Locator {
    return this.page.getByRole("table")
  }

  row(text: string): Locator {
    return this.table().getByRole("row").filter({ hasText: text })
  }

  /** Fills the given fields in the add dialog (others left as they are). */
  async fill(_scope: Page | Locator, input: ExistingInput): Promise<void> {
    const form = await this.openAddForm()
    if (input.company !== undefined) await this.field(form, "company").fill(input.company)
    if (input.role !== undefined) await this.field(form, "role").fill(input.role)
    if (input.url !== undefined) await this.field(form, "url").fill(input.url)
    if (input.requisition !== undefined) await this.field(form, "requisition").fill(input.requisition)
    if (input.date !== undefined) await this.pickDate(form, input.date)
  }

  /** Fills and submits; resolves with the POST response. */
  async add(_scope: Page | Locator, input: ExistingInput): Promise<Response> {
    const form = await this.openAddForm()
    if (input.company !== undefined) await this.field(form, "company").fill(input.company)
    if (input.role !== undefined) await this.field(form, "role").fill(input.role)
    if (input.url !== undefined) await this.field(form, "url").fill(input.url)
    if (input.requisition !== undefined) await this.field(form, "requisition").fill(input.requisition)
    if (input.date !== undefined) await this.pickDate(form, input.date)
    const post = this.page.waitForResponse((r) => new URL(r.url()).pathname === EXIST.apiPath && r.request().method() === "POST")
    await this.submitButton(form).click()
    return post
  }

  /**
   * Sets "Date applied" to `day` ("YYYY-MM-DD"). The spec asks for the
   * calendar-in-popover picker; a native or text date input is accepted too so
   * the test checks the outcome, not the widget. The calendar path uses
   * react-day-picker's default ARIA: month grid named "September 2026",
   * "Go to the Previous Month", day buttons named like "Wednesday, September 30th, 2026".
   */
  async pickDate(scope: Page | Locator, day: string): Promise<void> {
    const control = this.field(scope, "date")
    const kind = await control.evaluate((el) => (el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase()))
    if (kind === "date" || kind === "text") {
      await control.fill(day)
      return
    }
    const [y, m, d] = day.split("-").map(Number) as [number, number, number]
    const month = `${MONTH_NAMES[m - 1]} ${y}`
    await control.click()
    const grid = this.page.getByRole("grid", { name: month })
    for (let i = 0; i < 36 && !(await grid.isVisible()); i += 1) {
      await this.page.getByRole("button", { name: /previous month/i }).click()
    }
    await expect(grid).toBeVisible()
    await grid.getByRole("button", { name: new RegExp(`${MONTH_NAMES[m - 1]} ${d}(st|nd|rd|th)?, ${y}`) }).click()
  }
}

/** Records every POST to the existing-applications endpoint, to prove client-side refusals send nothing. */
export function recordPosts(page: Page): Request[] {
  const posts: Request[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === EXIST.apiPath) posts.push(request)
  })
  return posts
}
