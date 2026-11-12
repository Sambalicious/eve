import { type Locator, type Page, expect, test } from "@playwright/test"

import { GREENHOUSE_JOB_URL } from "../support/ats-fixtures.mjs"
import { JOB_POSTING_LINKS_PATH, outboundRequests, postingsWithUrl, resetPostings, signIn } from "../support/db.ts"
import { HiringPage } from "../support/hiring-page.ts"
import { PD, PD_PREFIX, applicationRow, description, holdsOf, markEvaluated, postingsContaining, resetPastedDescription, seedGeneratedDocuments } from "../support/pasted-description.ts"
import { approveAiProvider, clearAiApproval, ensureProfileInUse } from "../support/epic-0011-db.ts"
import { ADA } from "../support/stack.ts"

/**
 * QA test authoring, step [5e], EPIC-0010 (pasted job descriptions; api-contract.md v1.27.0,
 * gherkin/*.feature, design-spec.r1.md B1 to B3, copy-deck.r1.md). The real web app, api and
 * Postgres; no route interception. Locators by role and accessible name; strings byte for byte
 * from the copy deck (support/pasted-description.ts).
 *
 * Declared doubles: no AI provider in the E2E stack, so the evaluation result and generated
 * documents are written by fixtures (markEvaluated, seedGeneratedDocuments). These journeys prove
 * the browser flow and the api's handling around them, not the model calls.
 *
 * Covers: PD:44, PD:58 (Home), PD:167, EV:39 (posting part), EV:182, DOC:25 (ranked, UI),
 * MO:75, MO:170 (detail), RP:46 (Job Postings form), DOC:146 (card rendering), PD-4.1 API refusal
 * from the browser. Expected red until the integrated candidate lands.
 */
const TITLE = "Senior Frontend Engineer"

test.beforeEach(async () => {
  await resetPastedDescription()
})

test.afterAll(async () => {
  await resetPastedDescription()
})

function addJobLink(page: Page): Locator {
  return page.getByRole("region", { name: "Add a job link" })
}

async function openPanel(form: Locator): Promise<void> {
  const toggle = form.getByRole("button", { name: PD.toggle, exact: true })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  // C-PD-2: the opened panel replaces the toggle (design-spec r2 Disclosure), so assert the panel, not the toggle.
  await expect(form.getByRole("textbox", { name: PD.descriptionLabel })).toBeVisible()
}

async function fillDescription(form: Locator, text: string, title?: string, company?: string): Promise<void> {
  await form.getByRole("textbox", { name: PD.descriptionLabel }).fill(text)
  if (title !== undefined) await form.getByRole("textbox", { name: PD.titleLabel, exact: true }).fill(title)
  if (company !== undefined) await form.getByRole("textbox", { name: PD.companyLabel, exact: true }).fill(company)
}

const isPaste = (r: { request(): { method(): string }; url(): string }) => r.request().method() === "POST" && new URL(r.url()).pathname === JOB_POSTING_LINKS_PATH

test.describe("the description panel in every paste form (PD-1.1, PD-1.3)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context, ADA.email)
  })

  for (const [label, open] of [
    ['"Add a job link" on Job Postings', async (page: Page) => { await page.goto("/postings"); return addJobLink(page) }],
    ['"Check this job" in the Hiring view', async (page: Page) => { const hiring = new HiringPage(page); await hiring.open(); return await hiring.openCheck() }],
  ] as const) {
    test(`PD:44 ${label}: closed by default; opening shows the description, Job title, Company and the 0 / 30,000 counter`, async ({ page }) => {
      const form = await open(page)
      await expect(form.getByRole("textbox", { name: PD.descriptionLabel })).toHaveCount(0)
      await openPanel(form)
      await expect(form.getByRole("textbox", { name: PD.descriptionLabel })).toBeFocused()
      await expect(form.getByText(/Optional/).first()).toBeVisible()
      await expect(form.getByRole("textbox", { name: PD.titleLabel, exact: true })).toBeVisible()
      await expect(form.getByRole("textbox", { name: PD.companyLabel, exact: true })).toBeVisible()
      await expect(form.getByText(PD.counterEmpty, { exact: true })).toBeVisible()
      await expect(form.getByRole("button", { name: PD.send, exact: true })).toBeVisible()
    })
  }

  // EPIC-0011 R1: Home's "Add a job link" form is replaced by one paste box (link or description in the same field).
  test("PD:44 (Home, EPIC-0011) the one paste box takes a pasted description: Job title and Company appear for text, and the request carries description, title and company", async ({ page }) => {
    const company = `${PD_PREFIX} Home Box`
    // EPIC-0011 FD:154: the Home paste box needs a Career Profile in use and an approved AI provider.
    await ensureProfileInUse(ADA.email)
    await approveAiProvider()
    try {
      await page.goto("/dashboard")
      const box = page.getByRole("textbox", { name: "Job link or description" })
      await expect(box).toBeVisible()
      await expect(page.getByRole("textbox", { name: "Job title", exact: true })).toHaveCount(0)
      await box.fill(description("QA-E2E-PD-HOME"))
      await page.getByRole("textbox", { name: "Job title", exact: true }).fill(TITLE)
      await page.getByRole("textbox", { name: "Company", exact: true }).fill(company)
      const pasted = page.waitForResponse(isPaste)
      await page.getByRole("button", { name: "Check this job", exact: true }).click()
      const response = await pasted
      expect(response.status()).toBe(201)
      expect(response.request().postDataJSON()).toMatchObject({ description: description("QA-E2E-PD-HOME"), title: TITLE, company })
      expect(await response.json()).toMatchObject({ descriptionOutcome: "stored", posting: { origin: "pasted_description" } })
    } finally {
      await clearAiApproval()
    }
  })

  test("PD:167 30,001 characters: C-PD-22 shows, send is unavailable and no request is sent", async ({ page }) => {
    await page.goto("/postings")
    const form = addJobLink(page)
    await form.getByRole("textbox").first().fill("https://careers.flutterwave.com/jobs/senior-frontend-42")
    await openPanel(form)
    const pastes: string[] = []
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === JOB_POSTING_LINKS_PATH) pastes.push(r.url())
    })
    await fillDescription(form, "x".repeat(30_001), TITLE, `${PD_PREFIX} Flutterwave`)
    await expect(form.getByText(PD.descriptionLong, { exact: true })).toBeVisible()
    const send = form.getByRole("button", { name: PD.send, exact: true })
    await expect(send).toHaveAttribute("aria-disabled", "true")
    await send.click({ force: true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(pastes).toEqual([])
  })
})

test.describe("journey: paste a description → evaluated → Prepare documents → ATS score (F1)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context, ADA.email)
  })

  test("PD:58 / EV:182 / DOC:25 / MO:75 / DOC:146 description only from Job Postings (Home's form became the in-place paste box, see PD:44 Home), through to the ATS card, never offering queue or sample", async ({ page }) => {
    const company = `${PD_PREFIX} Paystack`
    const text = description("QA-E2E-PD-F1")
    await page.goto("/postings")
    const form = addJobLink(page)
    await openPanel(form)
    await fillDescription(form, text, TITLE, company)

    const pasted = page.waitForResponse(isPaste)
    await form.getByRole("button", { name: PD.send, exact: true }).click()
    const response = await pasted
    expect(response.status()).toBe(201)
    const sent = response.request().postDataJSON() as Record<string, unknown>
    expect(sent).toMatchObject({ description: text, title: TITLE, company })
    expect(sent.url ?? "").toBe("")
    const body = (await response.json()) as { descriptionOutcome: string; waitingReason: string | null; posting: { id: string; origin: string; applicationUrl: string | null } }
    expect(body).toMatchObject({ descriptionOutcome: "stored", posting: { origin: "pasted_description", applicationUrl: null } })

    // C-PD-30, or the waiting line that replaces it (contract: waitingReason wins).
    const line = form.getByRole("status")
    if (body.waitingReason === null) await expect(line.getByText(PD.created, { exact: true })).toBeVisible()
    else if (body.waitingReason === "cost_pause") await expect(line.getByText(PD.waitingCost)).toBeVisible()
    else await expect(line.getByText(PD.waitingInvitee, { exact: true })).toBeVisible()
    await expect(line.getByRole("link", { name: PD.view, exact: true })).toHaveAttribute("href", `/postings/${body.posting.id}`)

    const [held] = await holdsOf(ADA.email)
    expect(held).toMatchObject({ id: body.posting.id, origin: "pasted_description", posting_text: text, title: TITLE, company, apply_mode: "manual", application_url: expect.stringMatching(/^urn:eve:pasted:|^$/) })

    // Evaluation finishes (declared double): ranked, with keywords.
    await markEvaluated(ADA.email, body.posting.id, { status: "ranked" })
    await page.goto(`/postings/${body.posting.id}`)
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(TITLE) })).toBeVisible()
    await expect(page.getByText(PD.pastedBadge, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(PD.pastedNote, { exact: true })).toBeVisible()
    await expect(page.getByText(PD.warningTitle, { exact: true })).toHaveCount(0)
    await expect(page.getByText(`pasted:${body.posting.id}`)).toHaveCount(0)
    await expect(page.getByRole("button", { name: /anyway/i })).toHaveCount(0)

    // "Prepare documents": no dialog, no acknowledgement.
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v1/applications")
    await page.getByRole("button", { name: PD.prepare }).click()
    const createResponse = await created
    expect(createResponse.status()).toBe(201)
    expect(createResponse.request().postDataJSON()).toEqual({ jobPostingId: body.posting.id })
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/)
    const applicationId = new URL(page.url()).pathname.split("/").pop()!
    expect(await applicationRow(applicationId)).toMatchObject({ override_created_at: null, submission_state: null })

    // Documents are generated (declared double), then the unchanged ATS card shows.
    await seedGeneratedDocuments(applicationId, { score: 67, total: 4, matched: ["React", "TypeScript"], missing: [], gaps: ["Kubernetes", "GraphQL"] })
    await page.reload()
    await expect(page.getByText(PD.applicationBadge, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(PD.manualOnlyTitle, { exact: true })).toBeVisible()
    await expect(page.getByText(PD.manualOnlyBodyNoLink, { exact: true })).toBeVisible()
    await expect(page.getByText("Override", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "ATS match 67%" })).toBeVisible()

    // MO:75: no queue, sample, approve or remove-from-queue action is offered.
    await expect(page.getByRole("button", { name: /queue|sample|approve/i })).toHaveCount(0)

    // PD-4.1: the api refuses them anyway, from the signed-in browser.
    const refused = await page.evaluate(async (id) => {
      const session = await (await fetch("/v1/session", { credentials: "include" })).json()
      const results: { status: number; body: unknown }[] = []
      for (const action of ["queue", "sample", "sample/approve"]) {
        const r = await fetch(`/v1/applications/${id}/${action}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: "{}" })
        results.push({ status: r.status, body: await r.json() })
      }
      return results
    }, applicationId)
    for (const result of refused) expect(result).toEqual({ status: 409, body: { error: { code: "manual_application_only", message: PD.manualOnlyError } } })
    expect(await applicationRow(applicationId)).toMatchObject({ state: "documents_ready", submission_state: null })
  })
})

test.describe("journey: a readable ATS link wins over the description (RP:46, OQ-3)", () => {
  test.beforeEach(async ({ context }) => {
    await resetPostings()
    await signIn(context, ADA.email)
  })

  test("RP:46 / RP:88 Greenhouse link + description, no names, on Job Postings: C-PD-31; employer's text used; the description stored nowhere", async ({ page }) => {
    const marker = "QA-E2E-PD-RP46"
    await page.goto("/postings")
    const form = addJobLink(page)
    await form.getByRole("textbox").first().fill(GREENHOUSE_JOB_URL)
    await openPanel(form)
    await fillDescription(form, description(marker))
    const before = outboundRequests().length

    const pasted = page.waitForResponse(isPaste)
    await form.getByRole("button", { name: PD.send, exact: true }).click()
    const response = await pasted
    expect(response.status()).toBe(201)
    expect(await response.json()).toMatchObject({ descriptionOutcome: "employer_page_used", posting: { origin: "pasted_link" } })
    await expect(form.getByRole("status").getByText(PD.employerPage, { exact: true })).toBeVisible()

    const stored = await postingsWithUrl(GREENHOUSE_JOB_URL)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ origin: "pasted_link", candidateEmail: ADA.email })
    expect(await postingsContaining(marker)).toBe(0)
    expect(outboundRequests().slice(before).some((r) => r.url.startsWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345"))).toBe(true)

    await page.goto(`/postings/${stored[0]!.id}`)
    await expect(page.getByText(PD.pastedNote, { exact: true })).toHaveCount(0)
    await expect(page.getByText(PD.pastedBadge, { exact: true })).toHaveCount(0)
  })
})
