import { type Page, expect, test } from "@playwright/test"

import { outboundRequests, signIn } from "../support/db.ts"
import { EH, type Surface } from "../support/explanatory-help-copy.ts"
import { HelpPage } from "../support/help-page.ts"
import { restoreHiringInputs, setHiringInputs, snapshotHiringInputs } from "../support/hiring-db.ts"
import { isForbiddenHost, recordRequests } from "../support/hiring-page.ts"
import { type BoardRow, restoreRemoteBoards, setDraftSources, snapshotRemoteBoards } from "../support/remote-board-db.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0009 AC-17 rows of the outbound host audit, beside the EPIC-0007 OUT1/2/3
 * files: opening and closing a help popover and following the Hiring "Go to"
 * links makes no browser request at all, none to linkedin.com or google.com, and
 * no api outbound request (support/outbound-stub.mjs records and refuses every
 * non-fixture host). Help-accessibility-and-invariants.feature (HAI:250) and
 * hiring-view-help.feature (HVH:136, HVH:145).
 */
let savedInputs: Awaited<ReturnType<typeof snapshotHiringInputs>>
let savedBoards: BoardRow[]
test.beforeAll(async () => {
  savedInputs = await snapshotHiringInputs()
  savedBoards = await snapshotRemoteBoards()
})
test.afterAll(async () => {
  await restoreHiringInputs(savedInputs)
  await restoreRemoteBoards(savedBoards)
})
test.beforeEach(async () => {
  await setHiringInputs(ADA.email, { families: ["senior_frontend", "backend"], frameworks: ["React"] })
  await setDraftSources()
})

async function reachSettled(page: Page, surface: Surface): Promise<HelpPage> {
  await signIn(page.context(), ADA.email)
  const help = new HelpPage(page)
  await help.reach(surface)
  if (surface === "hiring") await help.hiring().waitUntilReady()
  await page.waitForLoadState("networkidle")
  return help
}

for (const surface of ["verify", "sources", "hiring"] as const) {
  test(`OUT9-01 (HAI:250 ${surface}) opening and closing the ${surface} popover makes zero browser requests and no api outbound request`, async ({ page }) => {
    const help = await reachSettled(page, surface)
    const browser = recordRequests(page)
    const before = outboundRequests().length
    await help.open(surface)
    await help.closeButton(surface).click()
    await expect(help.popover(surface)).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(browser.map((r) => r.url())).toEqual([])
    expect(browser.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
    expect(outboundRequests().slice(before)).toEqual([])
  })
}

test("OUT9-02 (HVH:145) on the settled Hiring view, opening and closing the popover with Close help sends nothing from the browser or the api", async ({ page }) => {
  const help = await reachSettled(page, "hiring")
  const browser = recordRequests(page)
  const before = outboundRequests().length
  await help.open("hiring")
  await help.closeButton("hiring").click()
  await page.waitForTimeout(500)
  expect(browser.map((r) => r.url())).toEqual([])
  expect(outboundRequests().slice(before)).toEqual([])
})

test("OUT9-03 (HVH:136) recording from page load, opening the Hiring popover and following each Go to link reaches no linkedin.com or google.com host", async ({ page }) => {
  await signIn(page.context(), ADA.email)
  const browser = recordRequests(page)
  const before = outboundRequests().length
  const help = new HelpPage(page)
  await help.reach("hiring")
  await help.hiring().waitUntilReady()
  for (const link of [EH.hiringLinksGo, EH.hiringCheckGo, EH.hiringFeedsGo]) {
    await help.open("hiring")
    await help.goLink(link).click()
    await expect(help.popover("hiring")).toHaveCount(0)
  }
  await page.waitForLoadState("networkidle")
  expect(browser.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
  expect(outboundRequests().slice(before).map((r) => r.url).filter(isForbiddenHost)).toEqual([])
  expect(outboundRequests().slice(before)).toEqual([])
})
