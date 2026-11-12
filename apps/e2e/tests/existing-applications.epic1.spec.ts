import { type Locator, type Page, type Request, expect, test } from "@playwright/test"

import { SIDEBAR_NAV } from "../support/epic-0011-copy.ts"

import { CSRF_HEADER, signIn } from "../support/db.ts"
import { EXIST } from "../support/existing-applications-copy.ts"
import { existingApplications, existingCompletedAt, insertExistingApplication, resetExistingApplications, setExistingCompletedAt } from "../support/existing-applications-db.ts"
import { ExistingApplicationsPage, recordPosts } from "../support/existing-applications-page.ts"
import { ensureProfileInUse, setAdvanced } from "../support/epic-0011-db.ts"
import { ADA } from "../support/stack.ts"
import { formatDay, watDay } from "../support/wat.ts"

/**
 * EPIC-0001 existing applications screen (run existing-apps-screen, QA test
 * authoring, step [5e]). Bug brief: .runs/existing-apps-screen/scope.md.
 * Authority: design-spec.r4.md F1 step 6/6a, F2 step 1, C-EXIST-1..8,
 * C-CONFIRM-2, C-VAL-EXIST-1/2, C-GATE-6/7; gherkin/daily-cap-and-duplicates.feature
 * (DCD) lines 97-120, 353-357, 436-440, 459-464, 483-487; activation-gate.feature.
 * Real web, real api, real Postgres; no route interception. Ada is the
 * Operator; her existing applications and step completion are reset per test.
 */
const WHO = ADA.email

const GLOBEX = { company: "Globex", role: "Frontend Lead", url: "https://jobs.lever.co/globex/abc-123", requisition: "L-77", date: "2026-09-30" } as const
const HOOLI = { company: "Hooli", role: "Senior Frontend Engineer", url: "https://jobs.ashbyhq.com/hooli/77ab", date: "2026-10-01" } as const
const INITECH = { company: "Initech", role: "Fullstack Engineer", url: "https://boards.greenhouse.io/initech/jobs/998", requisition: "I-998", date: "2026-10-02" } as const

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * C-EXIST-3 notice (design-spec.r4.md line 1223: the sentence, then Link "View it").
 * The "View it" control may sit inside the same alert, so the alert's whole text
 * must be exactly the sentence followed by "View it", nothing else.
 */
function alreadyRecorded(scope: Page | Locator, role: string, company: string, date: string): Locator {
  const sentence = EXIST.duplicate(role, company, date)
  return scope.getByRole("alert").filter({ hasText: new RegExp(`^${escape(sentence)}\\s*${escape(EXIST.viewIt)}$`) })
}

function viewItControl(scope: Page | Locator): Locator {
  return scope.getByRole("link", { name: EXIST.viewIt, exact: true }).or(scope.getByRole("button", { name: EXIST.viewIt, exact: true }))
}

let posts: Request[] = []

test.beforeEach(async ({ page }) => {
  await resetExistingApplications(WHO)
  posts = recordPosts(page)
})

async function openAs(page: Page): Promise<ExistingApplicationsPage> {
  await signIn(page.context(), WHO)
  const screen = new ExistingApplicationsPage(page)
  await screen.open()
  return screen
}

test.describe("Navigation and page frame (design-spec.r4.md:540, F1 6a)", () => {
  // EPIC-0011 AC-6.8 / OQ-8: "Existing applications" left the sidebar; Settings links to it as "Jobs you've already applied to".
  test("EA-01 Settings > Jobs you've already applied to opens the page: title, description, document title; the sidebar has no such entry", async ({ page }) => {
    await signIn(page.context(), WHO)
    await page.goto("/settings")
    await expect(page.locator(SIDEBAR_NAV).first().getByRole("link", { name: EXIST.navItem, exact: true })).toHaveCount(0)
    const link = page.getByRole("link", { name: "Jobs you've already applied to", exact: true })
    await expect(link).toHaveAttribute("href", EXIST.path)
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === EXIST.apiPath && r.request().method() === "GET")
    await link.click()
    await loaded
    await expect(page).toHaveURL(new RegExp(`${EXIST.path}$`))
    await expect(page.getByRole("heading", { level: 1, name: EXIST.title, exact: true })).toBeVisible()
    await expect(page.getByText(EXIST.description, { exact: true })).toBeVisible()
    await expect(page).toHaveTitle(EXIST.docTitle)
  })
})

test.describe("Empty state (DCD:459 A new installation shows no existing applications)", () => {
  test("EA-02 no records: C-EXIST-1, C-EXIST-8 and 'Mark this step complete'; the step can be completed with zero records", async ({ page }) => {
    const screen = await openAs(page)
    await expect(page.getByText(EXIST.emptyTitle, { exact: true })).toBeVisible()
    await expect(page.getByText(EXIST.emptyText, { exact: true })).toBeVisible()
    await expect(page.getByText(EXIST.notComplete, { exact: true })).toBeVisible()
    await screen.markCompleteButton().click()
    const dialog = screen.confirmDialog()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(EXIST.confirmBody, { exact: true })).toBeVisible()
    const complete = page.waitForResponse((r) => new URL(r.url()).pathname === EXIST.apiCompletePath && r.request().method() === "POST")
    await dialog.getByRole("button", { name: EXIST.confirmAction, exact: true }).click()
    expect((await complete).status()).toBe(200)
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText(EXIST.completedOn(formatDay(watDay())), { exact: true })).toBeVisible()
    expect(await existingCompletedAt(WHO)).not.toBeNull()
    expect(await existingApplications(WHO)).toEqual([])
  })
})

test.describe("Recording (DCD:97, DCD:103; F1 6a.2-6a.4)", () => {
  test("EA-03 the add form: heading, labels in order, requisition help, no CSV import or upload control", async ({ page }) => {
    const screen = await openAs(page)
    const form = await screen.openAddForm()
    await expect(page.getByRole("heading", { name: EXIST.formHeading, exact: true })).toBeVisible()
    for (const name of ["company", "role", "url", "requisition", "date"] as const) await expect(screen.field(form, name)).toBeVisible()
    await expect(screen.field(form, "requisition")).toHaveAccessibleDescription(new RegExp(escape(EXIST.requisitionHelp)))
    await expect(page.getByText(/csv/i)).toHaveCount(0)
    await expect(page.locator('input[type="file"]')).toHaveCount(0)
  })

  test("EA-04 recording one with a requisition ID: 201, toast, form clears, focus on Company, row shows every value; URL is text, not a link", async ({ page }) => {
    const screen = await openAs(page)
    const response = await screen.add(page, GLOBEX)
    expect(response.status()).toBe(201)
    expect(response.request().headers()[CSRF_HEADER]).toBeTruthy()
    expect(response.request().postDataJSON()).toMatchObject({ company: GLOBEX.company, roleTitle: GLOBEX.role, applicationUrl: GLOBEX.url, requisitionId: GLOBEX.requisition, appliedOn: GLOBEX.date })
    await expect(screen.toasts().getByText(EXIST.added, { exact: true })).toBeVisible()
    await expect(screen.form()).toHaveCount(0)
    await expect(screen.addButton()).toBeFocused()
    for (const column of EXIST.columns) await expect(screen.table().getByRole("columnheader", { name: column, exact: true })).toBeVisible()
    const row = screen.row(GLOBEX.company)
    await expect(row).toHaveCount(1)
    for (const cell of [GLOBEX.company, GLOBEX.role, GLOBEX.url, GLOBEX.requisition, formatDay(GLOBEX.date)]) await expect(row.getByRole("cell", { name: cell, exact: true })).toBeVisible()
    await expect(row.getByRole("link")).toHaveCount(0)
    await expect(row).not.toContainText("WAT")
    await expect(page.getByText(EXIST.emptyTitle, { exact: true })).toHaveCount(0)
    expect(await existingApplications(WHO)).toEqual([{ company: GLOBEX.company, roleTitle: GLOBEX.role, applicationUrl: GLOBEX.url, requisitionId: GLOBEX.requisition, appliedOn: GLOBEX.date }])
  })

  test("EA-05 recording one without a requisition ID: the cell shows C-EXIST-7 'None' and the record stores null", async ({ page }) => {
    const screen = await openAs(page)
    const response = await screen.add(page, HOOLI)
    expect(response.status()).toBe(201)
    const row = screen.row(HOOLI.company)
    await expect(row.getByRole("cell", { name: EXIST.noRequisition, exact: true })).toBeVisible()
    expect(await existingApplications(WHO)).toEqual([{ company: HOOLI.company, roleTitle: HOOLI.role, applicationUrl: HOOLI.url, requisitionId: null, appliedOn: HOOLI.date }])
  })

  test("EA-06 rows are oldest first: a new record appears at the bottom", async ({ page }) => {
    await insertExistingApplication(WHO, { company: "Umbrella", roleTitle: "UI Engineer", applicationUrl: "https://jobs.lever.co/umbrella/u-1", requisitionId: "U-1", appliedOn: "2026-08-01" })
    const screen = await openAs(page)
    expect((await screen.add(page, HOOLI)).status()).toBe(201)
    const bodyRows = screen.table().getByRole("row").filter({ has: page.getByRole("cell") })
    await expect(bodyRows).toHaveCount(2)
    await expect(bodyRows.nth(0)).toContainText("Umbrella")
    await expect(bodyRows.nth(1)).toContainText(HOOLI.company)
  })
})

test.describe("Validation (DCD:353 Scenario Outline; F1 6a.5, C-VAL-EXIST-1/2)", () => {
  const cases = [
    { field: "company", error: EXIST.missing.company },
    { field: "role", error: EXIST.missing.role },
    { field: "url", error: EXIST.missing.url },
    { field: "date", error: EXIST.missing.date },
  ] as const

  for (const { field, error } of cases) {
    test(`EA-07 ${field} left empty: '${error}' on that field, aria-invalid, focus moves there, nothing sent or recorded`, async ({ page }) => {
      const screen = await openAs(page)
      const input: Record<string, string> = { ...GLOBEX }
      delete input[field]
      await screen.fill(page, input)
      const form = await screen.openAddForm()
      await screen.submitButton(form).click()
      await expect(page.getByText(error, { exact: true })).toBeVisible()
      const control = screen.field(form, field)
      await expect(control).toHaveAttribute("aria-invalid", "true")
      await expect(control).toHaveAccessibleDescription(new RegExp(escape(error)))
      await expect(control).toBeFocused()
      // Kept values: the form isn't cleared by a refusal.
      if (field !== "company") await expect(screen.field(form, "company")).toHaveValue(GLOBEX.company)
      expect(posts).toHaveLength(0)
      expect(await existingApplications(WHO)).toEqual([])
    })
  }

  test("EA-08 every field empty: the first empty field in contract order wins (company)", async ({ page }) => {
    const screen = await openAs(page)
    const form = await screen.openAddForm()
    await screen.submitButton(form).click()
    await expect(screen.field(form, "company")).toBeFocused()
    await expect(screen.field(form, "company")).toHaveAccessibleDescription(new RegExp(escape(EXIST.missing.company)))
    expect(posts).toHaveLength(0)
    expect(await existingApplications(WHO)).toEqual([])
  })

  for (const bad of ["jobs.lever.co/globex/abc-123", "ftp://jobs.lever.co/globex/abc-123", "not a link"]) {
    test(`EA-09 malformed URL '${bad}': C-VAL-EXIST-2 under the URL field, values kept, nothing sent or recorded`, async ({ page }) => {
      const screen = await openAs(page)
      await screen.fill(page, { ...GLOBEX, url: bad })
      const form = await screen.openAddForm()
      await screen.submitButton(form).click()
      await expect(page.getByText(EXIST.badUrl, { exact: true })).toBeVisible()
      await expect(screen.field(form, "url")).toHaveAttribute("aria-invalid", "true")
      await expect(screen.field(form, "url")).toHaveAccessibleDescription(new RegExp(escape(EXIST.badUrl)))
      await expect(screen.field(form, "url")).toHaveValue(bad)
      await expect(screen.field(form, "company")).toHaveValue(GLOBEX.company)
      expect(posts).toHaveLength(0)
      expect(await existingApplications(WHO)).toEqual([])
    })
  }
})

test.describe("Duplicates (DCD:436 Recording the same existing application twice keeps one record; F1 failure paths)", () => {
  test("EA-10 the same URL + requisition again: C-EXIST-3 with the stored record's values, form keeps its values, still one row, 'View it' brings the row into view", async ({ page }) => {
    await insertExistingApplication(WHO, { company: GLOBEX.company, roleTitle: GLOBEX.role, applicationUrl: GLOBEX.url, requisitionId: GLOBEX.requisition, appliedOn: GLOBEX.date })
    const screen = await openAs(page)
    // Different company, role and date typed: the notice must name the stored record, not the form.
    const typed = { ...GLOBEX, company: "Globex Corp", role: "Lead Frontend", date: "2026-10-05" }
    const response = await screen.add(page, typed)
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ created: false })
    const notice = alreadyRecorded(page, GLOBEX.role, GLOBEX.company, formatDay(GLOBEX.date))
    await expect(notice).toBeVisible()
    await expect(viewItControl(notice)).toHaveCount(1)
    await expect(screen.toasts().getByText(EXIST.added, { exact: true })).toHaveCount(0)
    const form = await screen.openAddForm()
    await expect(screen.field(form, "company")).toHaveValue(typed.company)
    await expect(screen.field(form, "url")).toHaveValue(typed.url)
    await expect(screen.field(form, "requisition")).toHaveValue(typed.requisition)
    expect(await existingApplications(WHO)).toHaveLength(1)
    const viewIt = viewItControl(form)
    await expect(viewIt).toHaveCount(1)
    await page.evaluate(() => window.scrollTo(0, 0))
    await viewIt.click()
    await expect(screen.table().getByRole("row").filter({ hasText: GLOBEX.url })).toHaveCount(1)
    await expect(screen.row(GLOBEX.url)).toBeInViewport()
  })

  test("EA-11 duplicate after normalisation (trailing slash, tracking parameter) is also refused as already recorded", async ({ page }) => {
    await insertExistingApplication(WHO, { company: GLOBEX.company, roleTitle: GLOBEX.role, applicationUrl: GLOBEX.url, requisitionId: GLOBEX.requisition, appliedOn: GLOBEX.date })
    const screen = await openAs(page)
    const response = await screen.add(page, { ...GLOBEX, url: `${GLOBEX.url}/?lever-source=x` })
    expect(response.status()).toBe(200)
    const notice = alreadyRecorded(page, GLOBEX.role, GLOBEX.company, formatDay(GLOBEX.date))
    await expect(notice).toBeVisible()
    await expect(viewItControl(notice)).toHaveCount(1)
    expect(await existingApplications(WHO)).toHaveLength(1)
  })
})

test.describe("Marking complete (DCD:109, DCD:114; F1 6a.1, C-CONFIRM-2, C-EXIST-2)", () => {
  test("EA-12 with 2 records: C-CONFIRM-2 dialog, Cancel changes nothing, Mark complete shows C-EXIST-2 and removes the button", async ({ page }) => {
    await insertExistingApplication(WHO, { company: GLOBEX.company, roleTitle: GLOBEX.role, applicationUrl: GLOBEX.url, requisitionId: GLOBEX.requisition, appliedOn: GLOBEX.date })
    await insertExistingApplication(WHO, { company: HOOLI.company, roleTitle: HOOLI.role, applicationUrl: HOOLI.url, requisitionId: null, appliedOn: HOOLI.date })
    const screen = await openAs(page)
    await expect(page.getByText(EXIST.notComplete, { exact: true })).toBeVisible()

    await screen.markCompleteButton().click()
    let dialog = screen.confirmDialog()
    await expect(dialog.getByText(EXIST.confirmBody, { exact: true })).toBeVisible()
    await dialog.getByRole("button", { name: EXIST.confirmCancel, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(await existingCompletedAt(WHO)).toBeNull()
    await expect(screen.markCompleteButton()).toBeVisible()

    await screen.markCompleteButton().click()
    dialog = screen.confirmDialog()
    const complete = page.waitForResponse((r) => new URL(r.url()).pathname === EXIST.apiCompletePath && r.request().method() === "POST")
    await dialog.getByRole("button", { name: EXIST.confirmAction, exact: true }).click()
    const response = await complete
    expect(response.status()).toBe(200)
    expect(response.request().headers()[CSRF_HEADER]).toBeTruthy()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText(EXIST.completedOn(formatDay(watDay())), { exact: true })).toBeVisible()
    await expect(screen.markCompleteButton()).toHaveCount(0)
    await expect(page.getByText(EXIST.notComplete, { exact: true })).toHaveCount(0)
    expect(await existingCompletedAt(WHO)).not.toBeNull()

    // A reload keeps the completed state (the backend keeps the first time).
    await screen.open()
    await expect(page.getByText(EXIST.completedOn(formatDay(watDay())), { exact: true })).toBeVisible()
    await expect(screen.markCompleteButton()).toHaveCount(0)
  })

  test("EA-13 after completion more can be added; the status line still shows the original date", async ({ page }) => {
    await setExistingCompletedAt(WHO, "2026-10-17T10:00:00Z")
    const screen = await openAs(page)
    await expect(page.getByText(EXIST.completedOn("17 Oct 2026"), { exact: true })).toBeVisible()
    await expect(screen.markCompleteButton()).toHaveCount(0)
    expect((await screen.add(page, INITECH)).status()).toBe(201)
    await expect(screen.toasts().getByText(EXIST.added, { exact: true })).toBeVisible()
    await expect(screen.row(INITECH.company)).toHaveCount(1)
    await expect(page.getByText(EXIST.completedOn("17 Oct 2026"), { exact: true })).toBeVisible()
    expect((await existingCompletedAt(WHO))?.toISOString()).toBe("2026-10-17T10:00:00.000Z")
  })
})

test.describe("Mobile, 375px: the same add modal (F1 6a.2, 6a.4)", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("EA-14 'Add existing application' opens the modal; a refusal keeps it open; success closes it, toasts, focus returns to the opener, the record shows", async ({ page }) => {
    const screen = await openAs(page)
    await expect(page.getByRole("heading", { name: EXIST.formHeading, exact: true })).toHaveCount(0)
    await screen.addButton().click()
    const sheet = screen.form()
    await expect(sheet).toBeVisible()
    const width = await sheet.evaluate((el) => el.getBoundingClientRect().width)
    expect(width).toBeLessThanOrEqual(375)

    // Refusal (missing role) keeps the modal open with the error.
    await screen.fill(sheet, { company: GLOBEX.company, url: GLOBEX.url, date: GLOBEX.date })
    await screen.submitButton(sheet).click()
    await expect(sheet.getByText(EXIST.missing.role, { exact: true })).toBeVisible()
    await expect(sheet).toBeVisible()
    expect(posts).toHaveLength(0)

    const response = await screen.add(sheet, { role: GLOBEX.role, requisition: GLOBEX.requisition })
    expect(response.status()).toBe(201)
    await expect(sheet).toHaveCount(0)
    await expect(screen.toasts().getByText(EXIST.added, { exact: true })).toBeVisible()
    await expect(screen.addButton()).toBeFocused()
    // F1 6a.4: below 640px each row is a card, so the record is checked in the visible card, not the hidden table.
    await expect(screen.table()).toBeHidden()
    const card = page.getByRole("main").getByRole("listitem").filter({ hasText: GLOBEX.url })
    await expect(card).toHaveCount(1)
    await expect(card).toBeVisible()
    for (const text of [GLOBEX.company, GLOBEX.role, GLOBEX.url, GLOBEX.requisition, formatDay(GLOBEX.date)]) await expect(card).toContainText(text)
    expect(await existingApplications(WHO)).toHaveLength(1)
  })

  test("EA-15 duplicate in the modal: it stays open with C-EXIST-3", async ({ page }) => {
    await insertExistingApplication(WHO, { company: GLOBEX.company, roleTitle: GLOBEX.role, applicationUrl: GLOBEX.url, requisitionId: GLOBEX.requisition, appliedOn: GLOBEX.date })
    const screen = await openAs(page)
    await screen.addButton().click()
    const sheet = screen.form()
    expect((await screen.add(sheet, GLOBEX)).status()).toBe(200)
    await expect(sheet).toBeVisible()
    const notice = alreadyRecorded(sheet, GLOBEX.role, GLOBEX.company, formatDay(GLOBEX.date))
    await expect(notice).toBeVisible()
    await expect(viewItControl(notice)).toHaveCount(1)
    expect(await existingApplications(WHO)).toHaveLength(1)
  })
})

test.describe("Activation Gate row (C-GATE-6; C-GATE-7 retired; activation-gate.feature:199)", () => {
  async function gateRow(page: Page): Promise<Locator> {
    await signIn(page.context(), WHO)
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/submission/status" && r.request().method() === "GET")
    await page.goto("/activation")
    await loaded
    return page.getByRole("listitem").filter({ hasText: EXIST.gateRow })
  }

  test("EA-16 incomplete: the row label is the link to /existing-applications; no C-GATE-7 line, no old label", async ({ page }) => {
    const row = await gateRow(page)
    await expect(row).toHaveCount(1)
    const link = row.getByRole("link", { name: EXIST.gateRow, exact: true })
    await expect(link).toHaveAttribute("href", EXIST.path)
    await expect(row.getByRole("link")).toHaveCount(1)
    await expect(page.getByText(EXIST.gate7Fragment)).toHaveCount(0)
    await expect(page.getByText(EXIST.gateRowOld)).toHaveCount(0)
    await expect(row.getByText(EXIST.gateHint)).toBeVisible()
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${EXIST.path}$`))
    await expect(page.getByRole("heading", { level: 1, name: EXIST.title, exact: true })).toBeVisible()
  })

  test("EA-16b before the gate passes, three steps explain samples and what approving does", async ({ page }) => {
    await gateRow(page)
    await expect(page.getByRole("heading", { level: 2, name: EXIST.gateHowTitle, exact: true })).toBeVisible()
    await expect(page.getByText("Eve picks a few of your strongest matches and writes their documents. She does not send them.")).toBeVisible()
    await expect(page.getByText(/then choose Approve and submit\. That sends it to the employer/)).toBeVisible()
  })

  test("EA-17 complete: plain label with its check, no link; C-GATE-7 never shown", async ({ page }) => {
    await setExistingCompletedAt(WHO, "2026-10-17T10:00:00Z")
    const row = await gateRow(page)
    await expect(row).toHaveCount(1)
    await expect(row.getByRole("link")).toHaveCount(0)
    await expect(row.getByText(EXIST.gateRow, { exact: true })).toBeVisible()
    await expect(row.getByLabel("Done", { exact: true })).toBeVisible()
    await expect(page.getByText(EXIST.gate7Fragment)).toHaveCount(0)
  })

  test("EA-18 completing the step on the screen flips the gate row from link to done", async ({ page }) => {
    const screen = await openAs(page)
    await screen.markCompleteButton().click()
    await screen.confirmDialog().getByRole("button", { name: EXIST.confirmAction, exact: true }).click()
    await expect(page.getByText(EXIST.completedOn(formatDay(watDay())), { exact: true })).toBeVisible()
    await page.goto("/activation")
    const row = page.getByRole("listitem").filter({ hasText: EXIST.gateRow })
    await expect(row.getByLabel("Done", { exact: true })).toBeVisible()
    await expect(row.getByRole("link")).toHaveCount(0)
  })
})

// EPIC-0011 AC-2.4 / AC-3.4: the "Set up Eve" checklist shows on Home only with Advanced on (the Operator's default);
// with Advanced off the same step is the "Jobs you've already applied to" row of "Improve your results" (EA-21b).
test.describe("Home setup checklist item 4 (F1 step 1, item 4), Advanced on", () => {
  async function item(page: Page): Promise<Locator> {
    await setAdvanced(WHO, true)
    await ensureProfileInUse(WHO)
    await signIn(page.context(), WHO)
    await page.goto("/dashboard")
    const li = page.getByRole("listitem").filter({ hasText: EXIST.checklistItem })
    await expect(li).toHaveCount(1)
    return li
  }

  test("EA-19 none recorded: 'Start' links to /existing-applications; tagged Required for automatic submission", async ({ page }) => {
    const li = await item(page)
    await expect(li.getByText(EXIST.checklistRequired, { exact: true })).toBeVisible()
    const start = li.getByRole("link", { name: /^Start\b/ })
    await expect(start).toHaveAttribute("href", EXIST.path)
    await expect(li.getByRole("link", { name: /^Continue\b/ })).toHaveCount(0)
  })

  test("EA-20 one recorded, not complete: 'Continue'", async ({ page }) => {
    await insertExistingApplication(WHO, { company: HOOLI.company, roleTitle: HOOLI.role, applicationUrl: HOOLI.url, requisitionId: null, appliedOn: HOOLI.date })
    const li = await item(page)
    await expect(li.getByRole("link", { name: /^Continue\b/ })).toHaveAttribute("href", EXIST.path)
    await expect(li.getByRole("link", { name: /^Start\b/ })).toHaveCount(0)
  })

  test("EA-21 complete: 'Done', no link", async ({ page }) => {
    await setExistingCompletedAt(WHO, "2026-10-17T10:00:00Z")
    const li = await item(page)
    await expect(li.getByText("Done", { exact: true })).toBeVisible()
    await expect(li.getByRole("link")).toHaveCount(0)
  })
})

test.describe("Improve your results row for existing applications (EPIC-0011 AC-2.4, AC-2.5), Advanced off", () => {
  async function row(page: Page): Promise<Locator> {
    await setAdvanced(WHO, false)
    await ensureProfileInUse(WHO)
    await signIn(page.context(), WHO)
    await page.goto("/dashboard")
    const li = page.getByRole("listitem").filter({ hasText: "Jobs you've already applied to" })
    await expect(li).toHaveCount(1)
    return li
  }

  test.afterAll(async () => {
    await setAdvanced(WHO, true)
  })

  test("EA-21b none recorded: Not done, and Open links to /existing-applications; no 'Required for automatic submission' tag", async ({ page }) => {
    const li = await row(page)
    await expect(li.getByText("Not done", { exact: true })).toBeVisible()
    await expect(li.getByRole("link", { name: /^Open/ })).toHaveAttribute("href", EXIST.path)
    await expect(li.getByText(EXIST.checklistRequired)).toHaveCount(0)
  })

  test("EA-21c complete: Done", async ({ page }) => {
    await setExistingCompletedAt(WHO, "2026-10-17T10:00:00Z")
    const li = await row(page)
    await expect(li.getByText("Done", { exact: true })).toBeVisible()
  })
})

test.describe("Refused writes (DCD:483 An unauthenticated request cannot record an existing application)", () => {
  // apps/api/test/submission.int-spec.ts:1040 asserts the 401; this adds "no existing application is recorded" through the running stack.
  test("EA-22 no session: 401 unauthenticated and nothing recorded", async ({ playwright }) => {
    const { baseURL } = test.info().project.use
    const anonymous = await playwright.request.newContext({ baseURL })
    const response = await anonymous.post(EXIST.apiPath, {
      data: { company: GLOBEX.company, roleTitle: GLOBEX.role, applicationUrl: GLOBEX.url, requisitionId: GLOBEX.requisition, appliedOn: GLOBEX.date },
      headers: { [CSRF_HEADER]: "a".repeat(43) },
    })
    expect(response.status()).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unauthenticated")
    expect(await existingApplications(WHO)).toEqual([])
    await anonymous.dispose()
  })

  test("EA-23 unauthenticated visit to the page redirects to sign-in with next", async ({ page }) => {
    await page.goto(EXIST.path)
    await expect(page).toHaveURL(/\/sign-in\?(.*&)?next=(%2F|\/)existing-applications/)
  })
})
