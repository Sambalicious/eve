import { type Page, type Request, expect, test } from "@playwright/test"

import { signIn } from "../support/db.ts"
import { EH, SRC } from "../support/explanatory-help-copy.ts"
import { HelpPage, expectInOrder, follows, verificationPath } from "../support/help-page.ts"
import { recordRequests } from "../support/hiring-page.ts"
import { failOnce } from "../support/network-faults.ts"
import { type BoardRow, boardRow, restoreRemoteBoards, setDraftSources, snapshotRemoteBoards } from "../support/remote-board-db.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0009 QA test authoring: mark-verified-help.feature (MVH:<line>), the
 * Mark verified dialog on /sources (design-spec S1). Real web, api and Postgres.
 * Ada is the Operator: verify and enable are @OperatorOnly (architecture "PRD Q2").
 * `remote_board` is installation-wide, so the file snapshots it, sets the Gherkin
 * draftSources fixture before each test and restores the snapshot after the file.
 * No first-party response is stubbed; MVH:226 aborts exactly one PUT (QA-G-02).
 */
const WWR = "We Work Remotely"
const WWR_PATH = verificationPath("weworkremotely")

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

function verifyPuts(requests: readonly Request[]): Request[] {
  return requests.filter((r) => r.method() === "PUT" && new URL(r.url()).pathname === WWR_PATH)
}

async function settle(page: Page): Promise<void> {
  // Give a would-be request time to start before asserting it never did.
  await page.waitForTimeout(500)
}

test.describe("Description and basis help (AC-1, AC-2)", () => {
  test("MV9-01 (MVH:36 row 1) opened from the row button, the dialog shows C-EH-VERIFY-DESC under its title as its accessible description", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog(WWR)
    const desc = dialog.getByText(EH.verifyDesc, { exact: true })
    await expect(desc).toBeVisible()
    expect(await follows(dialog.getByRole("heading", { name: SRC.dialogTitle(WWR) }), desc)).toBe(true)
    expect(await follows(desc, help.dateField(WWR))).toBe(true)
    await expect(dialog).toHaveAccessibleDescription(EH.verifyDesc)
  })

  test("MV9-02 (MVH:36 row 2) opened from the refusal's Mark verified action, the dialog shows the same description", async ({ page }) => {
    const help = await openSources(page)
    await help.rowSwitch(WWR).click()
    await expect(help.refusal(WWR)).toContainText(EH.enableRefused)
    await help.refusalMarkVerified(WWR).click()
    const dialog = help.verifyDialog(WWR)
    await expect(dialog.getByText(EH.verifyDesc, { exact: true })).toBeVisible()
    await expect(dialog).toHaveAccessibleDescription(EH.verifyDesc)
  })

  test("MV9-03 (MVH:48) the description is the same for an already verified board (Himalayas)", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog("Himalayas")
    await expect(dialog.getByText(EH.verifyDesc, { exact: true })).toBeVisible()
  })

  test("MV9-04 (MVH:54) opening the dialog still puts focus on the date field, not on (i)", async ({ page }) => {
    const help = await openSources(page)
    await help.openVerifyDialog(WWR)
    await expect(help.dateField(WWR)).toBeFocused()
    await expect(help.trigger("verify")).not.toBeFocused()
  })

  test("MV9-05 (MVH:61) C-EH-VERIFY-BASIS-HELP is visible under the basis field, holds an example and is its accessible description", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog(WWR)
    const line = dialog.getByText(EH.verifyBasisHelp, { exact: true })
    await expect(line).toBeVisible()
    expect(EH.verifyBasisHelp).toContain(EH.verifyBasisHelpExample)
    expect(await follows(help.basisField(WWR), line)).toBe(true)
    const fieldBox = (await help.basisField(WWR).boundingBox())!
    const lineBox = (await line.boundingBox())!
    expect(lineBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 1)
    await expect(help.basisField(WWR)).toHaveAccessibleDescription(EH.verifyBasisHelp)
  })

  test("MV9-06 (MVH:69) after a missing-basis error the basis field is described by the help line then the error, and the help stays", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog(WWR)
    await help.dateField(WWR).fill("2026-10-30")
    await help.basisField(WWR).fill("")
    await help.dialogSubmit(WWR).click()
    const error = dialog.getByText(SRC.basisMissing, { exact: true })
    await expect(error).toBeVisible()
    const line = dialog.getByText(EH.verifyBasisHelp, { exact: true })
    expect(await follows(line, error)).toBe(true)
    await expect(help.basisField(WWR)).toHaveAccessibleDescription(`${EH.verifyBasisHelp} ${SRC.basisMissing}`)
    await expect(line).toBeVisible()
  })

  test("MV9-07 (MVH:77) the trigger's name is in neither the dialog description nor the basis description", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog(WWR)
    await expect(dialog).not.toHaveAccessibleDescription(new RegExp(EH.verifyTrigger))
    await expect(help.basisField(WWR)).not.toHaveAccessibleDescription(new RegExp(EH.verifyTrigger))
  })
})

test.describe("The (i) trigger and its popover (AC-3, AC-14)", () => {
  test("MV9-08 (MVH:83) the dialog has exactly one (i), named \"Why…\", after the description, collapsed", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog(WWR)
    await expect(help.trigger("verify", dialog)).toHaveCount(1)
    expect(EH.verifyTrigger.startsWith("Why")).toBe(true)
    expect(await follows(dialog.getByText(EH.verifyDesc, { exact: true }), help.trigger("verify", dialog))).toBe(true)
    await expect(help.trigger("verify")).toHaveAttribute("aria-expanded", "false")
  })

  test("MV9-09 (MVH:92) activating (i) opens the popover with P1, P2, the examples lead-in, a list of three examples and the note, in order", async ({ page }) => {
    const help = await openSources(page)
    await help.openVerifyDialog(WWR)
    const popover = await help.open("verify")
    await expectInOrder(popover, [EH.verifyTitle, EH.verifyP1, EH.verifyP2, EH.verifyExamples, EH.verifyEx1, EH.verifyEx2, EH.verifyEx3, EH.verifyNote])
    await expect(popover.getByRole("list").getByRole("listitem")).toHaveText([EH.verifyEx1, EH.verifyEx2, EH.verifyEx3])
    await expect(help.trigger("verify")).toHaveAttribute("aria-expanded", "true")
  })

  const closeActions = [
    ["pressing Escape", (h: HelpPage) => h.page.keyboard.press("Escape")],
    ["activating the button named by C-EH-POPOVER-CLOSE", (h: HelpPage) => h.closeButton("verify").click()],
    ["clicking inside the dialog outside the popover", (h: HelpPage) => h.verifyDialog(WWR).getByRole("heading", { name: SRC.dialogTitle(WWR) }).click()],
    ["activating the button named by C-EH-VERIFY-WHY-TRIGGER-SR again", (h: HelpPage) => h.trigger("verify").click()],
  ] as const
  for (const [label, close] of closeActions) {
    test(`MV9-10 (MVH:100) closing the popover by ${label} keeps the typed date and basis and leaves the dialog open`, async ({ page }) => {
      const help = await openSources(page)
      await help.openVerifyDialog(WWR)
      await help.dateField(WWR).fill("2026-10-28")
      await help.basisField(WWR).fill("Terms page section 4 allows API use with credit")
      await help.open("verify")
      await close(help)
      await expect(help.popover("verify")).toHaveCount(0)
      await expect(help.dateField(WWR)).toHaveValue("2026-10-28")
      await expect(help.basisField(WWR)).toHaveValue("Terms page section 4 allows API use with credit")
      await expect(help.verifyDialog(WWR)).toBeVisible()
    })
  }

  test.describe("touch", () => {
    test.use({ hasTouch: true })
    test("MV9-10 (MVH:100) closing the popover by tapping inside the dialog outside the popover keeps the values and the dialog", async ({ page }) => {
      const help = await openSources(page)
      await help.openVerifyDialog(WWR)
      await help.dateField(WWR).fill("2026-10-28")
      await help.basisField(WWR).fill("Terms page section 4 allows API use with credit")
      await help.trigger("verify").tap()
      await expect(help.popover("verify")).toBeVisible()
      await help.verifyDialog(WWR).getByRole("heading", { name: SRC.dialogTitle(WWR) }).tap()
      await expect(help.popover("verify")).toHaveCount(0)
      await expect(help.dateField(WWR)).toHaveValue("2026-10-28")
      await expect(help.basisField(WWR)).toHaveValue("Terms page section 4 allows API use with credit")
      await expect(help.verifyDialog(WWR)).toBeVisible()
    })
  })

  test("MV9-11 (MVH:120) Escape inside the popover closes only the popover and returns focus to (i)", async ({ page }) => {
    const help = await openSources(page)
    await help.openVerifyDialog(WWR)
    await help.basisField(WWR).fill("Written permission email from support, 2026-10-27")
    await help.openWithKeyboard("verify")
    await page.keyboard.press("Escape")
    await expect(help.popover("verify")).toHaveCount(0)
    await expect(help.verifyDialog(WWR)).toBeVisible()
    await expect(help.trigger("verify")).toBeFocused()
    await expect(help.basisField(WWR)).toHaveValue("Written permission email from support, 2026-10-27")
  })

  test("MV9-12 (MVH:130) with the popover closed, Escape closes the dialog as before and nothing is sent", async ({ page }) => {
    const help = await openSources(page)
    await help.openVerifyDialog(WWR)
    await help.open("verify")
    await help.closeButton("verify").click()
    await expect(help.popover("verify")).toHaveCount(0)
    const requests = recordRequests(page)
    await page.keyboard.press("Escape")
    await expect(help.verifyDialog(WWR)).toHaveCount(0)
    await expect(help.row(WWR)).toContainText(SRC.notVerified)
    await settle(page)
    expect(verifyPuts(requests)).toHaveLength(0)
    expect((await boardRow("weworkremotely")).verifiedOn).toBeNull()
  })
})

test.describe("Submit is unchanged (AC-4)", () => {
  test("MV9-13 (MVH:139) after reading the help, submit sends exactly the date and the trimmed basis", async ({ page }) => {
    const help = await openSources(page)
    await help.openVerifyDialog(WWR)
    await help.open("verify")
    await help.closeButton("verify").click()
    const requests = recordRequests(page)
    await help.dateField(WWR).fill("2026-10-28")
    await help.basisField(WWR).fill("  Terms page section 4 allows API use with credit  ")
    const put = page.waitForResponse((r) => new URL(r.url()).pathname === WWR_PATH && r.request().method() === "PUT")
    await help.dialogSubmit(WWR).click()
    expect((await put).ok()).toBe(true)
    await expect(help.row(WWR)).toContainText(SRC.verified("28 Oct 2026", "Terms page section 4 allows API use with credit"))
    const sent = verifyPuts(requests)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.postDataJSON()).toEqual({ verifiedOn: "2026-10-28", basis: "Terms page section 4 allows API use with credit" })
  })

  test("MV9-14 (MVH:150) submitting with the popover still open sends the same single request", async ({ page }) => {
    const help = await openSources(page)
    await help.openVerifyDialog(WWR)
    await help.dateField(WWR).fill("2026-10-28")
    await help.basisField(WWR).fill("API policy page allows public feed use")
    await help.open("verify")
    const requests = recordRequests(page)
    await help.dialogSubmit(WWR).click()
    await expect(help.row(WWR)).toContainText(SRC.verified("28 Oct 2026", "API policy page allows public feed use"))
    await settle(page)
    const sent = verifyPuts(requests)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.postDataJSON()).toEqual({ verifiedOn: "2026-10-28", basis: "API policy page allows public feed use" })
  })

  const rows = [
    { date: "", basis: "", errors: [SRC.dateMissing, SRC.basisMissing], focused: "date" },
    { date: "", basis: "Terms section 4", errors: [SRC.dateMissing], focused: "date" },
    { date: "2026-10-28", basis: "", errors: [SRC.basisMissing], focused: "basis" },
    { date: "2026-10-28", basis: "   ", errors: [SRC.basisMissing], focused: "basis" },
  ] as const
  for (const row of rows) {
    test(`MV9-15 (MVH:159) date "${row.date}", basis "${row.basis}": errors ${row.errors.join(" + ")}, focus on ${row.focused}, nothing sent`, async ({ page }) => {
      const help = await openSources(page)
      const dialog = await help.openVerifyDialog(WWR)
      await help.dateField(WWR).fill(row.date)
      await help.basisField(WWR).fill(row.basis)
      const requests = recordRequests(page)
      await help.dialogSubmit(WWR).click()
      for (const error of [SRC.dateMissing, SRC.basisMissing]) {
        await expect(dialog.getByText(error, { exact: true })).toHaveCount((row.errors as readonly string[]).includes(error) ? 1 : 0)
      }
      await expect(row.focused === "date" ? help.dateField(WWR) : help.basisField(WWR)).toBeFocused()
      await settle(page)
      expect(verifyPuts(requests)).toHaveLength(0)
    })
  }

  test("MV9-16 (MVH:182) opening and closing the popover while an error is shown keeps the error and the date, and sends nothing", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog(WWR)
    await help.dateField(WWR).fill("2026-10-28")
    await help.basisField(WWR).fill("")
    const requests = recordRequests(page)
    await help.dialogSubmit(WWR).click()
    await expect(dialog.getByText(SRC.basisMissing, { exact: true })).toBeVisible()
    await help.open("verify")
    await help.closeButton("verify").click()
    await expect(dialog.getByText(SRC.basisMissing, { exact: true })).toBeVisible()
    await expect(help.dateField(WWR)).toHaveValue("2026-10-28")
    await settle(page)
    expect(verifyPuts(requests)).toHaveLength(0)
  })

  for (const [entered, held] of [
    [1, 1],
    [2000, 2000],
    [2001, 2000],
  ] as const) {
    test(`MV9-17 (MVH:193) a basis of ${entered} characters holds ${held}, and the help line stays`, async ({ page }) => {
      const help = await openSources(page)
      const dialog = await help.openVerifyDialog(WWR)
      await help.dateField(WWR).fill("2026-10-28")
      await help.basisField(WWR).fill("b".repeat(entered))
      expect((await help.basisField(WWR).inputValue()).length).toBe(held)
      await expect(dialog.getByText(EH.verifyBasisHelp, { exact: true })).toBeVisible()
    })
  }
})

test.describe("Repeats and failures (AC-1, AC-3)", () => {
  test("MV9-18 (MVH:208) opening and closing the popover five times leaves one trigger, at most one popover and the basis unchanged", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog(WWR)
    await help.basisField(WWR).fill("API policy page, public feed allowed")
    for (let i = 0; i < 5; i += 1) {
      await help.open("verify")
      await expect(help.anyPopover()).toHaveCount(1)
      await help.closeButton("verify").click()
      await expect(help.popover("verify")).toHaveCount(0)
    }
    await expect(help.trigger("verify", dialog)).toHaveCount(1)
    await expect(help.basisField(WWR)).toHaveValue("API policy page, public feed allowed")
  })

  test("MV9-19 (MVH:217) reopening the dialog after Cancel shows both help texts with the popover closed", async ({ page }) => {
    const help = await openSources(page)
    await help.openVerifyDialog(WWR)
    await help.open("verify")
    await help.dialogCancel(WWR).click()
    await expect(help.verifyDialog(WWR)).toHaveCount(0)
    const dialog = await help.openVerifyDialog(WWR)
    await expect(dialog.getByText(EH.verifyDesc, { exact: true })).toBeVisible()
    await expect(dialog.getByText(EH.verifyBasisHelp, { exact: true })).toBeVisible()
    await expect(help.popover("verify")).toHaveCount(0)
    await expect(help.trigger("verify")).toHaveAttribute("aria-expanded", "false")
  })

  test("MV9-20 (MVH:226) a failed save shows the existing C-ERR-2 toast and keeps the help and the typed values", async ({ page }) => {
    const help = await openSources(page)
    const dialog = await help.openVerifyDialog(WWR)
    await help.dateField(WWR).fill("2026-10-28")
    await help.basisField(WWR).fill("Terms section 4")
    // The network fails while the browser stays online (QA-G-02): one PUT aborted, nothing canned.
    const fault = await failOnce(page, WWR_PATH, "PUT")
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    await help.dialogSubmit(WWR).click()
    await expect(help.toasts().getByText(SRC.verifyFailed, { exact: true })).toBeVisible()
    expect(fault.aborted()).toBe(1)
    await page.unrouteAll()
    await expect(dialog.getByText(EH.verifyDesc, { exact: true })).toBeVisible()
    await expect(dialog.getByText(EH.verifyBasisHelp, { exact: true })).toBeVisible()
    await expect(help.basisField(WWR)).toHaveValue("Terms section 4")
    expect((await boardRow("weworkremotely")).verifiedOn).toBeNull()
  })
})
