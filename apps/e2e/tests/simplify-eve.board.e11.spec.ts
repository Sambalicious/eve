import { type Locator, type Page, expect, test } from "@playwright/test"

import { signIn } from "../support/db.ts"
import { E11 } from "../support/epic-0011-copy.ts"
import { ensureProfileInUse, applicationSubmission, outcomeTypes, resetEpic11, seedApplication, setAdvanced, setAutomatic } from "../support/epic-0011-db.ts"
import { failRequests } from "../support/network-faults.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * QA test authoring, EPIC-0011 e2e: the Applications board.
 * Gherkin: applications-board.r1.feature BRD:17 to BRD:273 (AC-6.1 to AC-6.8, API-C1, API-C3).
 * Bola plays "bisi@example.com" (non-Operator, Advanced off), Ada the Operator.
 * Columns are sections labelled with their heading; cards are list items (design-spec r1 accessibility).
 * Expected red until the board is built.
 */
const board = (page: Page) => page.getByRole("region", { name: E11.boardRegion })
const column = (page: Page, name: string) => board(page).getByRole("region", { name: new RegExp(`^${name}`) })
const card = (page: Page, col: string, company: string): Locator => column(page, col).getByRole("listitem").filter({ hasText: company })

async function openBoard(page: Page, { empty = false }: { empty?: boolean } = {}) {
  await page.goto("/applications")
  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible()
  // BRD:47 allows "each empty column or one empty state": with no Applications the page shows one empty state, no board.
  if (empty) await expect(page.getByText(/Applications appear here once you prepare one|Applications Eve prepares land here/)).toBeVisible()
  else await expect(board(page)).toBeVisible()
}

async function moveTo(page: Page, col: string, company: string, target: string | RegExp) {
  await card(page, col, company).getByRole("button", { name: /^Move .* to…/ }).click()
  await page.getByRole("menuitem", { name: target }).click()
}

test.beforeEach(async () => {
  await resetEpic11()
  await setAdvanced(BOLA.email, false)
  await setAdvanced(ADA.email, true)
  await ensureProfileInUse(ADA.email)
  await ensureProfileInUse(BOLA.email)
})

test.afterAll(async () => {
  await resetEpic11()
  await setAutomatic(ADA.email, false)
})

test.describe("columns (AC-6.1)", () => {
  test("BRD:17 the board shows Draft, Applied, Interview, Offer, Closed in that order", async ({ page, context }) => {
    // The five columns show once the board has an Application (an empty board is one empty state, BRD:47).
    await seedApplication(BOLA.email, { company: "Columns" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    const names = await board(page).getByRole("region").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.querySelector("h2,h3")?.textContent ?? ""))
    expect(names.map((n) => n.replace(/,\s*\d+ applications?$/, "").replace(/\s*\(?\d+\)?$/, "").trim())).toEqual([...E11.columns])
  })

  test("BRD:22 the List view keeps the table and the delete-records toolbar", async ({ page, context }) => {
    await seedApplication(BOLA.email, { company: "Listed" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    await page.getByRole("radio", { name: E11.viewList }).or(page.getByRole("tab", { name: E11.viewList })).or(page.getByRole("button", { name: E11.viewList })).first().click()
    await expect(page.getByRole("table")).toBeVisible()
    // The delete-records toolbar appears once a row is selected, as before EPIC-0011 (application-list.tsx unchanged).
    await page.getByRole("checkbox", { name: /^Select .*E11 Listed/ }).check()
    await expect(page.getByRole("toolbar", { name: "Selected Applications" }).getByRole("button", { name: /delete/i }).first()).toBeVisible()
    // BRD:22 helper: the Stage header explains the words, including Draft.
    await page.getByRole("button", { name: "What Stage means" }).hover()
    await expect(page.getByRole("tooltip")).toContainText("Draft means Eve prepared your documents and you haven't applied yet.")
  })

  test("BRD:27b every board column heading explains its word", async ({ page, context }) => {
    await seedApplication(BOLA.email, { company: "Explained" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    await page.getByRole("button", { name: "What Draft means" }).hover()
    await expect(page.getByRole("tooltip")).toContainText("Eve prepared the documents and you haven't applied yet.")
    for (const word of ["Draft", "Applied", "Interview", "Offer", "Closed"]) {
      await expect(page.getByRole("button", { name: `What ${word} means` })).toBeAttached()
    }
  })

  test("BRD:27 Sending and Needs you columns show only when they hold items and Advanced is on", async ({ page, context }) => {
    await seedApplication(ADA.email, { company: "Draft Only" })
    await signIn(context, ADA.email)
    await openBoard(page)
    await expect(board(page).getByRole("region", { name: /^Sending/ })).toHaveCount(0)
    await expect(board(page).getByRole("region", { name: /^Needs you/ })).toHaveCount(0)
    await seedApplication(ADA.email, { company: "Q", submissionState: "queued" })
    await seedApplication(ADA.email, { company: "B", submissionState: "blocked", blockedReason: "captcha" })
    await openBoard(page)
    await expect(card(page, "Sending", "Q")).toBeVisible()
    await expect(card(page, "Needs you", "B")).toBeVisible()
  })

  test("BRD:27 Advanced off: a queued Application sits in Draft with the waiting reason, and Sending is not shown", async ({ page, context }) => {
    await setAdvanced(ADA.email, false)
    await seedApplication(ADA.email, { company: "Queued Off", submissionState: "queued" })
    await signIn(context, ADA.email)
    await openBoard(page)
    await expect(board(page).getByRole("region", { name: /^Sending/ })).toHaveCount(0)
    await expect(card(page, "Draft", "Queued Off")).toBeVisible()
    await expect(card(page, "Draft", "Queued Off")).toContainText(/waiting to send/i)
  })

  test("BRD:41 Needs you shows with Advanced off when a Blocked Application exists (safety rule)", async ({ page, context }) => {
    await setAdvanced(ADA.email, false)
    await seedApplication(ADA.email, { company: "Safety", submissionState: "blocked", blockedReason: "captcha" })
    await signIn(context, ADA.email)
    await openBoard(page)
    await expect(card(page, "Needs you", "Safety")).toBeVisible()
    await expect(card(page, "Needs you", "Safety").getByRole("link", { name: E11.seeNeedsYou })).toHaveAttribute("href", /\/blocked/)
  })

  test("BRD:47 an empty board says what will appear and offers one action", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await openBoard(page, { empty: true })
    await expect(page.getByText(/Applications appear here once you prepare one|Applications Eve prepares land here/)).toBeVisible()
    await expect(page.getByRole("link", { name: /Go to Home|Home/ }).first()).toBeVisible()
  })
})

test.describe("placement derives from existing data (AC-6.2)", () => {
  const cases: [string, Parameters<typeof seedApplication>[1], string][] = [
    ["prepared, no submission", { company: "P1", state: "prepared" }, "Draft"],
    ["manual", { company: "P2", submissionState: "manual" }, "Applied"],
    ["confirmation", { company: "P3", submissionState: "manual", outcomes: ["confirmation"] }, "Applied"],
    ["interview_invitation", { company: "P4", submissionState: "manual", outcomes: ["interview_invitation"] }, "Interview"],
    ["offer", { company: "P5", submissionState: "manual", outcomes: ["offer"] }, "Offer"],
    ["rejection", { company: "P6", submissionState: "manual", outcomes: ["rejection"] }, "Closed"],
    ["declined", { company: "P7", submissionState: "declined" }, "Closed"],
    ["not_submitted", { company: "P8", submissionState: "not_submitted" }, "Closed"],
    ["confirmation then interview", { company: "P9", submissionState: "manual", outcomes: ["confirmation", "interview_invitation"] }, "Interview"],
    ["interview then offer", { company: "P10", submissionState: "manual", outcomes: ["interview_invitation", "offer"] }, "Offer"],
    ["offer then rejection", { company: "P11", submissionState: "manual", outcomes: ["offer", "rejection"] }, "Closed"],
    ["confirmed and rejection", { company: "P12", submissionState: "confirmed", outcomes: ["rejection"] }, "Closed"],
  ]
  for (const [label, seed, expected] of cases) {
    test(`BRD:53 ${label} is in ${expected}`, async ({ page, context }) => {
      await seedApplication(BOLA.email, seed)
      await signIn(context, BOLA.email)
      await openBoard(page)
      await expect(card(page, expected, `E11 ${seed.company}`)).toBeVisible()
    })
  }
})

test.describe("moves (AC-6.3 to AC-6.6)", () => {
  test("BRD:76 I applied: confirm dialog warns it can't be undone; confirming sends manual-complete (no daily cap) and moves the card to Applied", async ({ page, context }) => {
    const draft = await seedApplication(BOLA.email, { company: "Move1" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    await moveTo(page, "Draft", "Move1", E11.moveApplied)
    const dialog = page.getByRole("alertdialog", { name: E11.confirmAppliedTitle })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(E11.confirmAppliedBody)).toBeVisible()
    const sent = page.waitForResponse((r) => r.url().endsWith(`/v1/applications/${draft.id}/manual-complete`) && r.request().method() === "POST")
    await dialog.getByRole("button", { name: E11.moveApplied }).click()
    expect((await sent).status()).toBe(200)
    await expect(card(page, "Applied", "Move1")).toBeVisible()
    const row = await applicationSubmission(draft.id)
    expect(row).toMatchObject({ submission_state: "manual", submitted_local_day: null })
  })

  test("BRD:85 cancelling the confirm sends nothing and the card stays in Draft", async ({ page, context }) => {
    const draft = await seedApplication(BOLA.email, { company: "Move2" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    const requests: string[] = []
    page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("manual-complete")) requests.push(r.url()) })
    await moveTo(page, "Draft", "Move2", E11.moveApplied)
    await page.getByRole("alertdialog", { name: E11.confirmAppliedTitle }).getByRole("button", { name: /cancel/i }).click()
    await expect(card(page, "Draft", "Move2")).toBeVisible()
    expect(requests).toEqual([])
    expect((await applicationSubmission(draft.id)).submission_state).toBeNull()
  })

  test("BRD:148 a failed move rolls the card back to Draft and shows an error", async ({ page, context }) => {
    await seedApplication(BOLA.email, { company: "Move3" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    const fault = await failRequests(page, "/manual-complete", "POST")
    await moveTo(page, "Draft", "Move3", E11.moveApplied)
    await page.getByRole("alertdialog", { name: E11.confirmAppliedTitle }).getByRole("button", { name: E11.moveApplied }).click()
    await expect(card(page, "Draft", "Move3")).toBeVisible()
    await expect(page.getByRole("alert").or(page.getByRole("status")).filter({ hasText: /couldn't|could not|try again/i }).first()).toBeVisible()
    await fault.stop()
  })

  for (const [target, type] of [[E11.moveInterview, "interview_invitation"], [E11.moveOffer, "offer"], [E11.moveClosed, "rejection"]] as const) {
    test(`BRD:155 Applied to ${target} records a ${type} Outcome`, async ({ page, context }) => {
      const app = await seedApplication(BOLA.email, { company: `To${target}`, submissionState: "manual" })
      await signIn(context, BOLA.email)
      await openBoard(page)
      await moveTo(page, "Applied", `To${target}`, target)
      await expect(card(page, target, `To${target}`)).toBeVisible()
      expect(await outcomeTypes(app.id)).toEqual([type])
    })
  }

  for (const from of ["Interview", "Offer"] as const) {
    test(`BRD:189 Closed from ${from} records a rejection Outcome (owner decision)`, async ({ page, context }) => {
      const app = await seedApplication(BOLA.email, { company: `Close${from}`, submissionState: "manual", outcomes: [from === "Interview" ? "interview_invitation" : "offer"] })
      await signIn(context, BOLA.email)
      await openBoard(page)
      await moveTo(page, from, `Close${from}`, E11.moveClosed)
      await expect(card(page, "Closed", `Close${from}`)).toBeVisible()
      expect((await outcomeTypes(app.id)).at(-1)).toBe("rejection")
    })
  }

  test("BRD:180 moving back edits the placing Outcome (no delete): Interview to Applied leaves one Outcome of type confirmation", async ({ page, context }) => {
    const app = await seedApplication(BOLA.email, { company: "Back1", submissionState: "manual", outcomes: ["interview_invitation"] })
    await signIn(context, BOLA.email)
    await openBoard(page)
    await moveTo(page, "Interview", "Back1", E11.backToApplied)
    await expect(card(page, "Applied", "Back1")).toBeVisible()
    expect(await outcomeTypes(app.id)).toEqual(["confirmation"])
  })

  test("BRD:208 Offer back to Interview edits the Outcome to interview_invitation", async ({ page, context }) => {
    const app = await seedApplication(BOLA.email, { company: "Back2", submissionState: "manual", outcomes: ["offer"] })
    await signIn(context, BOLA.email)
    await openBoard(page)
    await moveTo(page, "Offer", "Back2", E11.backToInterview)
    await expect(card(page, "Interview", "Back2")).toBeVisible()
    expect(await outcomeTypes(app.id)).toEqual(["interview_invitation"])
  })

  test("BRD:215 an Applied card cannot go back to Draft: Draft is not offered and a line explains why", async ({ page, context }) => {
    await seedApplication(BOLA.email, { company: "NoBack", submissionState: "manual" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    await card(page, "Applied", "NoBack").getByRole("button", { name: /^Move .* to…/ }).click()
    await expect(page.getByRole("menuitem", { name: "Draft" })).toHaveCount(0)
    await expect(page.getByText(/can't be undone/i).first()).toBeVisible()
  })

  test("BRD:222 the Move to menu works from the keyboard without drag", async ({ page, context }) => {
    const app = await seedApplication(BOLA.email, { company: "Kbd", submissionState: "manual" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    const trigger = card(page, "Applied", "Kbd").getByRole("button", { name: /^Move .* to…/ })
    await trigger.focus()
    await page.keyboard.press("Enter")
    await page.getByRole("menuitem", { name: E11.moveInterview }).focus()
    await page.keyboard.press("Enter")
    await expect(card(page, "Interview", "Kbd")).toBeVisible()
    expect(await outcomeTypes(app.id)).toEqual(["interview_invitation"])
  })

  for (const [column_, seed] of [["Sending", { submissionState: "queued" }], ["Needs you", { submissionState: "blocked", blockedReason: "captcha" }]] as const) {
    test(`BRD:232 an automatic Application in ${column_} offers no Move to targets Sending or Needs you, and no move out`, async ({ page, context }) => {
      await seedApplication(ADA.email, { company: `Auto ${column_}`, ...seed })
      await signIn(context, ADA.email)
      await openBoard(page)
      const item = card(page, column_, `Auto ${column_}`)
      await expect(item).toBeVisible()
      const trigger = item.getByRole("button", { name: /^Move .* to…/ })
      if (await trigger.count()) {
        await trigger.click()
        await expect(page.getByRole("menuitem", { name: /^(Sending|Needs you)$/ })).toHaveCount(0)
        await expect(page.getByRole("menuitem")).toHaveCount(0)
      }
    })
  }

  test("BRD:249 each card links to the Application detail, which links to its documents; /documents still resolves", async ({ page, context }) => {
    const app = await seedApplication(BOLA.email, { company: "Detail" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    await card(page, "Draft", "Detail").getByRole("link").first().click()
    await expect(page).toHaveURL(new RegExp(`/applications/${app.id}$`))
    // Wave 3: the detail holds its tailored documents in a "Documents" region (the breadcrumb link is Applications).
    await expect(page.getByRole("region", { name: E11.documentsRegion })).toBeVisible()
    const documents = await page.goto("/documents")
    expect(documents?.status()).toBeLessThan(400)
  })

  test("BRD:218 a card moved elsewhere refreshes before moving: a stale Applied card moved to Closed on another device ends with a conflict or the fresh state, never a double write", async ({ page, context }) => {
    const app = await seedApplication(BOLA.email, { company: "Stale", submissionState: "manual" })
    await signIn(context, BOLA.email)
    await openBoard(page)
    await outcomeCloseBehindTheBoard(app.id)
    await moveTo(page, "Applied", "Stale", E11.moveInterview)
    await expect(page.getByText(/changed|refresh|already|newest/i).or(card(page, "Closed", "Stale")).first()).toBeVisible()
    expect((await outcomeTypes(app.id)).filter((t) => t === "interview_invitation")).toEqual([])
  })

  test("BRD:273 a signed-out visitor to /applications is sent to sign in", async ({ page }) => {
    await page.goto("/applications")
    await expect(page).not.toHaveURL(/\/applications$/)
  })
})

async function outcomeCloseBehindTheBoard(applicationId: string): Promise<void> {
  const { default: pg } = await import("pg")
  const { stackState } = await import("../support/db.ts")
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    await client.query("insert into outcome (candidate_id, id, application_id, type, created_at, updated_at) select candidate_id, gen_random_uuid(), id, 'rejection', now(), now() from application where id = $1", [applicationId])
  } finally {
    await client.end()
  }
}
