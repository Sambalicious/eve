import { expect, test } from "@playwright/test"

import { GREENHOUSE_JOB_URL } from "../support/ats-fixtures.mjs"
import { COPY } from "../support/copy.ts"
import { outboundRequests, postingsWithUrl, resetPostings, setRelevance, signIn } from "../support/db.ts"
import { HiringPage, isForbiddenHost, pasteRequests, recordRequests } from "../support/hiring-page.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0007 Phase 2, outbound-and-separation.feature r3: the Phase 2 rows of the
 * outbound host audit (AC 10.3), the unchanged existing paste form (AC 10.4,
 * OUT:162 Outline) and the fixtures-only rule (AC 10.5). Browser requests are
 * recorded with page.on("request"); api requests by support/outbound-stub.mjs.
 * r3 (D10): a paste of a host Eve does not fetch is undated, so it shows the
 * EPIC-0006 B7 hidden line instead of "Job Posting saved.".
 */
const hosts = (urls: readonly string[]) => [...new Set(urls.map((url) => new URL(url).hostname))].sort()

test.beforeEach(async ({ context }) => {
  await resetPostings()
  await setRelevance(ADA.email, ["senior_frontend"])
  await signIn(context, ADA.email)
})

const hiddenUndated = COPY.hiddenCreated(COPY.hiddenUndated)

test("OUT-01 loading the Hiring view makes no outbound request from the api and none from the browser to linkedin.com or google.com", async ({ page }) => {
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  const hiring = new HiringPage(page)
  await hiring.open()
  await expect(hiring.checkSection()).toBeVisible()
  await page.waitForLoadState("networkidle")
  expect(outboundRequests().slice(before)).toEqual([])
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
})

test("OUT-02 pasting a Greenhouse link reaches the Greenhouse public API only", async ({ page }) => {
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  const hiring = new HiringPage(page)
  await hiring.open()
  await hiring.submit(GREENHOUSE_JOB_URL)
  await expect(hiring.resultStatus().getByText(COPY.created, { exact: true })).toBeVisible()
  await page.waitForTimeout(1000)
  expect(hosts(outboundRequests().slice(before).map((r) => r.url))).toEqual(["boards-api.greenhouse.io"])
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
})

test("OUT-03 pasting a linkedin.com URL anyway reaches no host", async ({ page }) => {
  const browserRequests = recordRequests(page)
  const before = outboundRequests().length
  const hiring = new HiringPage(page)
  await hiring.open()
  await hiring.submit("https://www.linkedin.com/jobs/view/3999999999")
  await hiring.saveAnyway().click()
  await expect(hiring.resultStatus().filter({ hasText: hiddenUndated })).toHaveCount(1)
  await page.waitForTimeout(1000)
  expect(outboundRequests().slice(before)).toEqual([])
  expect(browserRequests.map((r) => r.url()).filter(isForbiddenHost)).toEqual([])
})

test("OUT-04 pasting an unsupported host reaches no host", async ({ page }) => {
  const before = outboundRequests().length
  const hiring = new HiringPage(page)
  await hiring.open()
  await hiring.submit("https://careers.example.org/jobs/123")
  await expect(hiring.resultStatus().filter({ hasText: hiddenUndated })).toHaveCount(1)
  await page.waitForTimeout(1000)
  expect(outboundRequests().slice(before)).toEqual([])
})

/**
 * OUT:162 Outline. The "recorded on origin/main" result is the behaviour of the
 * unchanged existing form (features/paste-job-link/ui/add-job-link.tsx and
 * use-paste-job-link.ts on origin/main 6ce2123, read for this repair): a visible
 * created posting gives the C-LINK-1 success toast and no inline line; a hidden
 * created posting gives the B7 line plus "View it" and no toast. The existing form
 * shows no Hiring-view copy (C-HP-CHECK-CREATED, help texts).
 */
const OUT_162 = [
  { link: GREENHOUSE_JOB_URL, expectToast: true, line: null, stored: { origin: "pasted_link", skipReason: null } },
  { link: "https://careers.example.org/jobs/123", expectToast: false, line: COPY.hiddenCreated(COPY.hiddenUndated), stored: { origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system" } },
] as const

for (const row of OUT_162) {
  test(`OUT-05 (OUT:162) the existing paste form on /postings with ${row.link}: same request, stored posting and message as origin/main`, async ({ page }) => {
    const requests = recordRequests(page)
    await page.goto("/postings")
    const legacy = page.getByRole("region", { name: COPY.addJobLinkTitle })
    await legacy.getByRole("textbox").fill(row.link)
    await legacy.getByRole("button", { name: COPY.submit, exact: true }).click()
    const toast = page.getByRole("region", { name: "Messages" }).getByText(COPY.linkAccepted, { exact: true })
    if (row.line === null) {
      await expect(toast).toBeVisible()
      await expect(legacy.getByRole("status")).toHaveCount(0)
    } else {
      const status = legacy.getByRole("status").filter({ hasText: row.line })
      await expect(status).toHaveText(`${row.line} ${COPY.hiddenView}`)
      await expect(status.getByRole("link", { name: COPY.hiddenView, exact: true })).toHaveAttribute("href", /^\/postings\/[0-9a-f-]{36}$/)
      await page.waitForTimeout(500)
      await expect(toast).toHaveCount(0)
    }
    expect(pasteRequests(requests).map((r) => r.postDataJSON())).toEqual([{ url: row.link }])
    const stored = await postingsWithUrl(row.link)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ ...row.stored, candidateEmail: ADA.email })
    // The Hiring view's own copy never appears in the existing form.
    await expect(legacy.getByText(COPY.created, { exact: true })).toHaveCount(0)
    await expect(legacy.getByText(COPY.checkHelpSolo, { exact: true })).toHaveCount(0)
    await expect(legacy.getByText(COPY.checkHelp, { exact: true })).toHaveCount(0)
  })
}

test("OUT-06 the whole Phase 2 run reached no live host: every api outbound request was a fixture host", async () => {
  // Runs last in this file; the log covers every earlier test in the run.
  const allowed = new Set(["boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com"])
  expect(hosts(outboundRequests().map((r) => r.url)).filter((host) => !allowed.has(host))).toEqual([])
})
