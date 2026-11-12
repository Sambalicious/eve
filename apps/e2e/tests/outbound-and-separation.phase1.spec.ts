import { expect, test } from "@playwright/test"

import { outboundRequests, signIn } from "../support/db.ts"
import { aiCallAndSpendCounts, databaseFingerprint, restoreHiringInputs, setHiringInputs, snapshotHiringInputs } from "../support/hiring-db.ts"
import { HiringLinksPage } from "../support/hiring-links-page.ts"
import { isForbiddenHost, recordRequests } from "../support/hiring-page.ts"
import { ALL_HINTS, FAMILIES, terms } from "../support/hiring-oracle.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * EPIC-0007 Phase 1, outbound-and-separation.feature r2: the Phase 1 rows of
 * the outbound host audit (AC 10.3), no AI and no spend (AC 10.2), and the
 * fixtures-only rule (AC 10.5). Browser requests are recorded with
 * page.on("request"); api requests by support/outbound-stub.mjs, which fails
 * every non-fixture host, so a request to linkedin.com or google.com from the
 * api would be both recorded and refused.
 */
let saved: Awaited<ReturnType<typeof snapshotHiringInputs>>
test.beforeAll(async () => {
  saved = await snapshotHiringInputs()
})
test.afterAll(async () => {
  await restoreHiringInputs(saved)
})

test("OUT1-01 loading the Hiring view with links: no api outbound request, no browser request to linkedin.com or google.com, no AI call, no spend, no write", async ({ page }) => {
  await setHiringInputs(ADA.email, { families: ["senior_frontend", "fullstack", "backend"], frameworks: terms("F", 10), technologies: ["C#"], prefs: ALL_HINTS })
  await signIn(page.context(), ADA.email)
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  const counts = await aiCallAndSpendCounts()
  const fingerprint = await databaseFingerprint()
  const hiring = new HiringLinksPage(page)
  await hiring.openWith()
  await hiring.waitForGroups(3)
  await hiring.alertsQueries()
  await page.waitForLoadState("networkidle")
  expect(outboundRequests().slice(before)).toEqual([])
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
  expect(await aiCallAndSpendCounts()).toEqual(counts)
  expect(await databaseFingerprint()).toEqual(fingerprint)
})

test("OUT1-02 switching the Role family choice: no request from the browser to any host and none from the api", async ({ page }) => {
  await setHiringInputs(ADA.email, { families: ["senior_frontend", "fullstack", "backend"], frameworks: ["React"] })
  await signIn(page.context(), ADA.email)
  const hiring = new HiringLinksPage(page)
  await hiring.openWith()
  await hiring.waitForGroups(1)
  await page.waitForLoadState("networkidle")
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  for (const family of ["fullstack", "backend", "senior_frontend"]) {
    await hiring.familySelect().selectOption(family)
    await expect(page).toHaveURL(new RegExp(`family=${family}`))
  }
  await page.waitForTimeout(500)
  expect(browserRequests.map((r) => r.url())).toEqual([])
  expect(outboundRequests().slice(before)).toEqual([])
})

test("OUT1-03 building hiring links for every target family (all 13 targeted, each family opened): no outbound host", async ({ page }) => {
  await setHiringInputs(ADA.email, { families: FAMILIES.map(([key]) => key), frameworks: ["React"], technologies: ["CI/CD"], prefs: ALL_HINTS })
  await signIn(page.context(), ADA.email)
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  const hiring = new HiringLinksPage(page)
  for (const [family] of FAMILIES.filter(([key]) => key !== "other")) {
    await hiring.openWith({ family })
    await expect(hiring.familySelect()).toHaveValue(family)
  }
  await page.waitForLoadState("networkidle")
  expect(outboundRequests().slice(before)).toEqual([])
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
})

test("OUT1-04 Bola's Hiring view (no Job Preferences) also reaches no outbound host", async ({ page }) => {
  await setHiringInputs(BOLA.email, { families: ["backend"], frameworks: ["Django"], prefs: null })
  await signIn(page.context(), BOLA.email)
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  const hiring = new HiringLinksPage(page)
  await hiring.openWith()
  await hiring.waitForGroups(1)
  await page.waitForLoadState("networkidle")
  expect(outboundRequests().slice(before)).toEqual([])
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
})

test("OUT1-05 the whole run reached no live host: every api outbound request went to an ATS fixture host, none to linkedin.com or google.com", async () => {
  const allowed = new Set(["boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com"])
  const urls = outboundRequests().map((r) => r.url)
  expect(urls.filter(isForbiddenHost)).toEqual([])
  expect([...new Set(urls.map((url) => new URL(url).hostname))].filter((host) => !allowed.has(host))).toEqual([])
})
