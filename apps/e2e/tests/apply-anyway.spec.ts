import { type Page, expect, test } from "@playwright/test"

import {
  INDUSTRY_ONLY,
  LOCATION_EXCLUDED,
  RANKED,
  WEAK_SKIP,
  applicationRow,
  applicationsForPosting,
  resetApplyAnyway,
  seedDecidedPosting,
  seedQueuedApplication,
} from "../support/apply-anyway-db.ts"
import { signIn } from "../support/db.ts"
import { ADA } from "../support/stack.ts"

/**
 * QA test authoring, step [5e]: apply anyway, bounds and consent
 * (api-contract.md v1.24.0, gherkin/apply-anyway.feature, design-spec-apply-anyway.md r1,
 * copy-deck-apply-anyway.md). The real web app against the real api and Postgres.
 * Locators by role and accessible name only; strings byte for byte from the deck,
 * kept here so a wrong string in the product fails the test.
 *
 * Expected red until the integrated candidate lands: the button, the dialog,
 * the Override badge and "Remove from queue" do not exist yet on the base.
 */
const COPY = {
  anyway: "Prepare documents anyway", // C-AA-1
  anywayName: (role: string, company: string) => `Prepare documents anyway for ${role} at ${company}`, // C-AA-2
  prepare: "Prepare documents",
  dialogTitle: "Apply to this posting anyway?", // C-AA-3
  dialogLead: "You're overriding this reason:", // C-AA-4
  // Dialog quote = the posting's full reason line (copy deck mapping table). seedDecidedPosting stores no Match,
  // so the weak core Match row is the "Match null" form, C-SKIP-4; "weak core Match" is only the short form.
  // EPIC-0011 R4 reworded the reason lines (no "Skipped:" / "Excluded:" prefix; copy deck status.reason.notMatch.*).
  weakReason: "Your profile doesn't back enough of the core responsibilities.",
  industryReason: "This job doesn't fit your industry rule.",
  autoSend: /^Eve may send this Application automatically\./, // C-AA-5
  scope: "This covers only the reason above. If the posting's decision changes, Eve won't send it automatically.", // C-AA-6
  confirm: "Prepare anyway", // C-AA-7
  badge: "Override", // C-AA-15
  remove: "Remove from queue", // C-AA-23
  removeName: (role: string, company: string) => `Remove from queue for ${role} at ${company}`, // C-AA-24
  removeTitle: "Remove from the automatic queue?", // C-AA-25
  removeBody: "Eve won't send this Application automatically. Its documents, answers and any override are kept. You can't queue it again in Eve, but you can still apply on the employer's site.", // C-AA-26
  removed: "Removed from the queue. Nothing was sent, and its documents are kept.", // C-AA-29
  preparedForYou: "Draft", // C-DOC-5
} as const

const ROLE = "Senior Frontend Engineer"

async function openPosting(page: Page, id: string, title: string) {
  await page.goto(`/postings/${id}`)
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(title) })).toBeVisible()
}

test.describe("apply anyway (AA-1, AA-2, AA-4, AA-5)", () => {
  test.beforeEach(async ({ context }) => {
    await resetApplyAnyway()
    await signIn(context, ADA.email)
  })

  test.afterAll(async () => {
    await resetApplyAnyway()
  })

  for (const [label, decision, reasonLine] of [
    ["weak core Match skip", WEAK_SKIP, COPY.weakReason],
    ["Industry-only exclusion", INDUSTRY_ONLY, COPY.industryReason],
  ] as const) {
    test(`apply-anyway:44 + :652 + :679 @AA-1.1 @AA-4.1 @AA-4.2 @AA-4.4 ${label}: button → dialog quoting the reason → Confirm → Application with the Override badge`, async ({ page }) => {
      const posting = await seedDecidedPosting(ADA.email, decision, { company: label === "Industry-only exclusion" ? "Lucky Odds" : "Acme Payments" })
      await openPosting(page, posting.id, posting.title)

      const button = page.getByRole("button", { name: COPY.anywayName(ROLE, posting.company), exact: true })
      await expect(button).toBeVisible()
      await expect(button).toHaveText(COPY.anyway)
      await expect(page.getByRole("button", { name: new RegExp(`^${COPY.prepare} for`) })).toHaveCount(0)

      await button.click()
      const dialog = page.getByRole("alertdialog", { name: COPY.dialogTitle })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText(COPY.dialogLead, { exact: true })).toBeVisible()
      await expect(dialog.getByText(reasonLine, { exact: true })).toBeVisible()
      await expect(dialog.getByText(COPY.autoSend)).toBeVisible()
      await expect(dialog.getByText(COPY.scope, { exact: true })).toBeVisible()
      // Initial focus is Cancel (design-spec B2).
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused()

      const created = page.waitForResponse((r) => r.url().endsWith("/v1/applications") && r.request().method() === "POST")
      await dialog.getByRole("button", { name: COPY.confirm, exact: true }).click()
      const response = await created
      expect(response.status()).toBe(201)
      expect(response.request().postDataJSON()).toEqual({
        jobPostingId: posting.id,
        acknowledgement: { confirmed: true, decision: { status: decision.status, skipReason: decision.skipReason, skipDetail: decision.skipDetail, violatedRules: [...decision.violatedRules] } },
      })

      await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/)
      await expect(page.getByText(COPY.badge, { exact: true }).first()).toBeVisible()

      const rows = await applicationsForPosting(posting.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ override_status: decision.status, override_skip_reason: decision.skipReason, override_violated_rules: [...decision.violatedRules] })
      expect(rows[0]!.override_created_at).not.toBeNull()

      // The posting itself is unchanged (AA-1.5): still in the Not a match tab, not a good match.
      await openPosting(page, posting.id, posting.title)
      await expect(page.getByRole("button", { name: COPY.anywayName(ROLE, posting.company), exact: true })).toBeVisible()
    })
  }

  test("apply-anyway:670 @AA-4.2 Cancel closes the dialog, sends nothing and returns focus to the button", async ({ page }) => {
    const posting = await seedDecidedPosting(ADA.email, WEAK_SKIP, { company: "Cancel Co" })
    const posts: string[] = []
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/v1/applications")) posts.push(r.url())
    })
    await openPosting(page, posting.id, posting.title)
    const button = page.getByRole("button", { name: COPY.anywayName(ROLE, posting.company), exact: true })
    await button.click()
    const dialog = page.getByRole("alertdialog", { name: COPY.dialogTitle })
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
    expect(posts).toEqual([])
    expect(await applicationsForPosting(posting.id)).toEqual([])
  })

  test("apply-anyway:88 @AA-1.2 @AA-1.4 a non-overridable exclusion (location) shows no 'anyway' button and no 'Prepare documents'", async ({ page }) => {
    const posting = await seedDecidedPosting(ADA.email, LOCATION_EXCLUDED, { company: "Initech" })
    await openPosting(page, posting.id, posting.title)
    await expect(page.getByRole("button", { name: new RegExp(`^${COPY.anyway}`) })).toHaveCount(0)
    await expect(page.getByRole("button", { name: new RegExp(`^${COPY.prepare}`) })).toHaveCount(0)
  })

  test("apply-anyway:88 @AA-1.4 the api refuses a forged acknowledgement for that posting with C-AA-10 and creates nothing", async ({ page }) => {
    const posting = await seedDecidedPosting(ADA.email, LOCATION_EXCLUDED, { company: "Forged Co" })
    await openPosting(page, posting.id, posting.title)
    const result = await page.evaluate(async (jobPostingId) => {
      const session = await (await fetch("/v1/session", { credentials: "include" })).json()
      const response = await fetch("/v1/applications", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ jobPostingId, acknowledgement: { confirmed: true, decision: { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violatedRules: ["location"] } } }),
      })
      return { status: response.status, body: await response.json() }
    }, posting.id)
    expect(result).toEqual({ status: 409, body: { error: { code: "override_not_allowed", message: "This posting's reason can't be overridden. Nothing changed." } } })
    expect(await applicationsForPosting(posting.id)).toEqual([])
  })

  test("apply-anyway:194 @AA-1.6 a ranked posting keeps 'Prepare documents' and creates an Application with no Override badge", async ({ page }) => {
    const posting = await seedDecidedPosting(ADA.email, RANKED, { company: "Globex", title: "Frontend Lead" })
    await openPosting(page, posting.id, posting.title)
    await expect(page.getByRole("button", { name: new RegExp(`^${COPY.anyway}`) })).toHaveCount(0)
    await page.getByRole("button", { name: `${COPY.prepare} for Frontend Lead at ${posting.company}`, exact: true }).click()
    await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/)
    await expect(page.getByText(COPY.badge, { exact: true })).toHaveCount(0)
    expect((await applicationsForPosting(posting.id))[0]!.override_created_at).toBeNull()
  })

  test("apply-anyway:888 + :920 @AA-5.1 @AA-5.2 Remove from queue: dialog, confirm, back to documents ready with documents kept and no button", async ({ page }) => {
    const { applicationId, posting } = await seedQueuedApplication(ADA.email, { company: "Queue Co" })
    await page.goto(`/applications/${applicationId}`)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

    const button = page.getByRole("button", { name: COPY.removeName(ROLE, posting.company), exact: true })
    await expect(button).toHaveText(COPY.remove)
    await button.click()
    const dialog = page.getByRole("alertdialog", { name: COPY.removeTitle })
    await expect(dialog.getByText(COPY.removeBody, { exact: true })).toBeVisible()

    const removed = page.waitForResponse((r) => r.url().endsWith(`/v1/applications/${applicationId}/remove-from-queue`))
    await dialog.getByRole("button", { name: COPY.remove, exact: true }).click()
    expect((await removed).status()).toBe(200)

    await expect(page.getByText(COPY.removed, { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: COPY.removeName(ROLE, posting.company), exact: true })).toHaveCount(0)
    await expect(page.getByText(COPY.preparedForYou, { exact: true }).first()).toBeVisible()
    // Focus goes to the page h1 (the button is gone): design-spec B4 finalFocus.
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused()

    expect(await applicationRow(applicationId)).toMatchObject({ state: "documents_ready", submission_state: null, queue_removed: 1, documents: 2 })
  })

  test("apply-anyway:959 @AA-5.3 Remove from queue after the claim got there first shows C-AA-30 and nothing changes", async ({ page }) => {
    const { applicationId, posting } = await seedQueuedApplication(ADA.email, { company: "Race Co" })
    await page.goto(`/applications/${applicationId}`)
    await page.getByRole("button", { name: COPY.removeName(ROLE, posting.company), exact: true }).click()
    // The claim takes it before Confirm.
    const { Client } = (await import("pg")).default
    const { stackState } = await import("../support/db.ts")
    const client = new Client({ connectionString: stackState().adminUrl })
    await client.connect()
    try {
      await client.query("update application set submission_state = 'submit_claimed', attempt_id = gen_random_uuid(), attempt_number = 1 where id = $1", [applicationId])
    } finally {
      await client.end()
    }
    await page.getByRole("alertdialog", { name: COPY.removeTitle }).getByRole("button", { name: COPY.remove, exact: true }).click()
    await expect(page.getByText("It already left the queue, so it can't be removed. Its status shows where it is now.", { exact: true })).toBeVisible()
    expect(await applicationRow(applicationId)).toMatchObject({ submission_state: "submit_claimed", queue_removed: 0 })
  })
})
