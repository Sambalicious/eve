import { type Page, type Request, expect, test } from "@playwright/test"

import { signIn } from "../support/db.ts"
import { EH, SRC } from "../support/explanatory-help-copy.ts"
import { HelpPage, JOB_SOURCES_PATH, enabledPath, expectInOrder, follows, hasHorizontalScroll, lineCount } from "../support/help-page.ts"
import { recordRequests } from "../support/hiring-page.ts"
import { failRequests } from "../support/network-faults.ts"
import { type BoardRow, DRAFT_SOURCES, boardRow, restoreRemoteBoards, setBoardVerification, setDraftSources, snapshotRemoteBoards } from "../support/remote-board-db.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0009 QA test authoring: job-sources-help.feature (JSH:<line>), the
 * Remote-job boards section on /sources (design-spec S2) and the revised C-SRC-3.
 * Real web, api and Postgres; Ada is the Operator (enable is @OperatorOnly).
 * `remote_board` is installation-wide: the file snapshots it, sets the Gherkin
 * draftSources fixture before each test and restores the snapshot afterwards.
 * The backend refusal (JSH:68) is produced for real: the page loads Remote OK as
 * verified, then the fixture clears its verification, so the api answers the
 * enable with job_source_not_verified. JSH:126 aborts the Job Sources GET at the
 * network layer (no canned response).
 */
const WWR = "We Work Remotely"
const BOARDS = ["Himalayas", "Remote OK", "Remotive", WWR] as const

let saved: BoardRow[]
test.beforeAll(async () => {
  saved = await snapshotRemoteBoards()
})
test.afterAll(async () => {
  await restoreRemoteBoards(saved)
})
test.beforeEach(async () => {
  await setDraftSources()
})

async function openSources(page: Page): Promise<HelpPage> {
  await signIn(page.context(), ADA.email)
  const help = new HelpPage(page)
  await help.openSources()
  return help
}

function apiWrites(requests: readonly Request[]): Request[] {
  return requests.filter((r) => r.method() !== "GET" && new URL(r.url()).pathname.startsWith(JOB_SOURCES_PATH))
}

test.describe("Help line and (i) (AC-5, AC-6)", () => {
  test("JS9-01 (JSH:35) the section shows C-EH-SRC-HELP once, directly under its heading, with no interaction", async ({ page }) => {
    const help = await openSources(page)
    const line = help.boardsSection().getByText(EH.srcHelp, { exact: true })
    await expect(line).toBeVisible()
    await expect(page.getByText(EH.srcHelp, { exact: true })).toHaveCount(1)
    expect(await follows(help.boardsHeading(), line)).toBe(true)
    expect(await follows(line, help.row(BOARDS[0]))).toBe(true)
    await expect(help.anyPopover()).toHaveCount(0)
  })

  test("JS9-02 (JSH:42) exactly one (i), named \"Why…\", after the help line, outside the heading and outside every row", async ({ page }) => {
    const help = await openSources(page)
    await expect(help.trigger("sources", help.boardsSection())).toHaveCount(1)
    await expect(help.trigger("sources")).toHaveCount(1)
    expect(EH.srcTrigger.startsWith("Why")).toBe(true)
    for (const board of BOARDS) await expect(help.trigger("sources", help.row(board))).toHaveCount(0)
    expect(await follows(help.boardsSection().getByText(EH.srcHelp, { exact: true }), help.trigger("sources"))).toBe(true)
    await expect(help.boardsHeading().getByRole("button")).toHaveCount(0)
    await expect(help.boardsHeading()).toHaveText(SRC.sectionTitle)
  })

  test("JS9-03 (JSH:51) the popover gives P1, P2 and the note in order, and (i) reports expanded", async ({ page }) => {
    const help = await openSources(page)
    const popover = await help.open("sources")
    await expectInOrder(popover, [EH.srcTitle, EH.srcP1, EH.srcP2, EH.srcNote])
    await expect(help.trigger("sources")).toHaveAttribute("aria-expanded", "true")
  })

  test("JS9-04 (JSH:165) with every available board verified, the help line and one (i) still show", async ({ page }) => {
    await setBoardVerification("weworkremotely", { on: "2026-10-19", basis: "API policy page allows public feed use" })
    const help = await openSources(page)
    await expect(help.boardsSection().getByText(EH.srcHelp, { exact: true })).toBeVisible()
    await expect(help.trigger("sources")).toHaveCount(1)
  })
})

test.describe("Revised C-SRC-3 refusal (AC-7)", () => {
  test("JS9-05 (JSH:59) enabling We Work Remotely shows the revised C-SRC-3 then Mark verified, keeps the switch off, describes it and sends nothing", async ({ page }) => {
    const help = await openSources(page)
    const requests = recordRequests(page)
    await help.rowSwitch(WWR).click()
    const alert = help.refusal(WWR)
    await expect(alert).toHaveText(`${EH.enableRefused} ${SRC.markVerified}`)
    await expect(help.refusalMarkVerified(WWR)).toBeVisible()
    await expect(help.rowSwitch(WWR)).not.toBeChecked()
    await expect(help.rowSwitch(WWR)).toHaveAccessibleDescription(`${EH.enableRefused} ${SRC.markVerified}`)
    await page.waitForTimeout(500)
    expect(apiWrites(requests)).toHaveLength(0)
  })

  test("JS9-06 (JSH:68) the api's job_source_not_verified refusal shows the same revised message and describes the switch", async ({ page }) => {
    const help = await openSources(page)
    // The page shows Remote OK as verified; the board loses its verification before the click.
    await setBoardVerification("remoteok", null)
    const put = page.waitForResponse((r) => new URL(r.url()).pathname === enabledPath("remoteok") && r.request().method() === "PUT")
    await help.rowSwitch("Remote OK").click()
    const response = await put
    expect(response.status()).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("job_source_not_verified")
    await expect(help.refusal("Remote OK")).toHaveText(`${EH.enableRefused} ${SRC.markVerified}`)
    await expect(help.rowSwitch("Remote OK")).toHaveAccessibleDescription(`${EH.enableRefused} ${SRC.markVerified}`)
    expect((await boardRow("remoteok")).enabled).toBe(false)
  })

  test("JS9-07 (JSH:76) the refusal's Mark verified opens the dialog for that board with C-EH-VERIFY-DESC", async ({ page }) => {
    const help = await openSources(page)
    await help.rowSwitch(WWR).click()
    await help.refusalMarkVerified(WWR).click()
    await expect(help.verifyDialog(WWR)).toBeVisible()
    await expect(help.verifyDialog(WWR).getByText(EH.verifyDesc, { exact: true })).toBeVisible()
  })

  test("JS9-08 (JSH:83) after verifying, the board can be enabled and the refusal is gone", async ({ page }) => {
    const help = await openSources(page)
    await help.rowSwitch(WWR).click()
    await expect(help.refusal(WWR)).toBeVisible()
    await help.refusalMarkVerified(WWR).click()
    await help.dateField(WWR).fill("2026-10-28")
    await help.basisField(WWR).fill("API policy page allows public feed use")
    await help.dialogSubmit(WWR).click()
    await expect(help.verifyDialog(WWR)).toHaveCount(0)
    await expect(help.row(WWR)).toContainText(SRC.verified("28 Oct 2026", "API policy page allows public feed use"))
    await help.rowSwitch(WWR).click()
    await expect(help.rowSwitch(WWR)).toBeChecked()
    await expect(help.refusal(WWR)).toHaveCount(0)
    await expect.poll(async () => (await boardRow("weworkremotely")).enabled).toBe(true)
  })

  test("JS9-09 (JSH:112) the revised refusal replaces the old message: one alert, and the old C-SRC-3 text is nowhere", async ({ page }) => {
    const help = await openSources(page)
    await help.rowSwitch(WWR).click()
    await expect(help.refusal(WWR)).toHaveCount(1)
    await expect(page.getByText(SRC.oldEnableRefused)).toHaveCount(0)
  })

  test("JS9-10 (JSH:119) the section popover and a refusal show together", async ({ page }) => {
    const help = await openSources(page)
    await help.rowSwitch(WWR).click()
    await expect(help.refusal(WWR)).toBeVisible()
    await help.open("sources")
    await expect(help.popover("sources")).toBeVisible()
    await expect(help.refusal(WWR)).toContainText(EH.enableRefused)
  })

  test("JS9-11 (JSH:135) at 375px the revised C-SRC-3 and its Mark verified span at most two lines, with no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    const help = await openSources(page)
    await help.rowSwitch(WWR).click()
    const alert = help.refusal(WWR)
    await expect(alert).toBeVisible()
    // QA-G9-03: count lines as height / line-height; client-rect tops differ by 1px for the underlined button.
    const lines = await lineCount(alert)
    expect(lines).toBeLessThanOrEqual(2)
    expect(await hasHorizontalScroll(page)).toBe(false)
  })

  test("JS9-12 (JSH:145) refusing two unverified boards in turn leaves only the latest refusal; the first switch loses its description", async ({ page }) => {
    await setBoardVerification("remoteok", null)
    const help = await openSources(page)
    await help.rowSwitch(WWR).click()
    await expect(help.refusal(WWR)).toBeVisible()
    await help.rowSwitch("Remote OK").click()
    await expect(help.refusal("Remote OK")).toContainText(EH.enableRefused)
    await expect(help.refusal(WWR)).toHaveCount(0)
    await expect(help.boardsSection().getByRole("alert")).toHaveCount(1)
    await expect(help.rowSwitch(WWR)).not.toHaveAttribute("aria-describedby", /\S/)
  })

  test("JS9-13 (JSH:156) toggling an unverified board twice shows one refusal and sends nothing", async ({ page }) => {
    const help = await openSources(page)
    const requests = recordRequests(page)
    await help.rowSwitch(WWR).click()
    await help.rowSwitch(WWR).click()
    await expect(help.refusal(WWR)).toHaveCount(1)
    await expect(help.refusal(WWR)).toContainText(EH.enableRefused)
    await page.waitForTimeout(500)
    expect(apiWrites(requests)).toHaveLength(0)
  })
})

test.describe("Unchanged rows and page states (AC-5, AC-8)", () => {
  const rowTexts = [
    ["Himalayas", SRC.verified("19 Oct 2026", DRAFT_SOURCES.himalayasBasis)],
    ["Remote OK", SRC.verified("19 Oct 2026", DRAFT_SOURCES.remoteOkBasis)],
    ["Remotive", DRAFT_SOURCES.remotiveReason],
    [WWR, SRC.notVerified],
  ] as const
  for (const [board, text] of rowTexts) {
    test(`JS9-14 (JSH:91) the ${board} row shows "${text}"`, async ({ page }) => {
      const help = await openSources(page)
      await expect(help.row(board)).toContainText(text)
    })
  }

  test("JS9-15 (JSH:103) every row shows its type; three rows have Mark verified and Enabled, Remotive has neither", async ({ page }) => {
    const help = await openSources(page)
    for (const board of BOARDS) await expect(help.row(board).getByText(SRC.boardType, { exact: true })).toBeVisible()
    for (const board of ["Himalayas", "Remote OK", WWR]) {
      await expect(help.rowMarkVerified(board)).toBeVisible()
      await expect(help.rowSwitch(board)).toBeVisible()
    }
    await expect(help.row("Remotive").getByRole("button", { name: new RegExp(`^${SRC.markVerified}`) })).toHaveCount(0)
    await expect(help.row("Remotive").getByRole("switch")).toHaveCount(0)
  })

  test("JS9-16 (JSH:126) when the Job Sources data fails to load, the existing C-ERR-1 load error shows and no popover is open", async ({ page }) => {
    await signIn(page.context(), ADA.email)
    const help = new HelpPage(page)
    // Network-layer abort of the GET (no canned response); the app's own retries fail too.
    const fault = await failRequests(page, JOB_SOURCES_PATH, "GET")
    await page.goto("/sources")
    await expect(page.getByText(SRC.loadError, { exact: true })).toBeVisible({ timeout: 20_000 })
    expect(fault.aborted()).toBeGreaterThan(0)
    await expect(page.getByRole("button", { name: SRC.retry, exact: true })).toBeVisible()
    await expect(help.anyPopover()).toHaveCount(0)
    await expect(page.getByText(EH.srcHelp, { exact: true })).toHaveCount(0)
    await fault.stop()
  })
})
