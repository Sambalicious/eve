import { expect, test } from "@playwright/test"

import { ASHBY_JOB_URL, GREENHOUSE_JOB_URL, HIDDEN_CASES, LEVER_JOB_URL } from "../support/ats-fixtures.mjs"
import { COPY } from "../support/copy.ts"
import { CSRF_HEADER, aiCallsForUrl, insertPastedPosting, outboundRequests, postingCount, postingsWithUrl, resetPostings, setRelevance, signIn } from "../support/db.ts"
import { HiringPage, expectNoPasteRequest, pasteRequests, recordRequests } from "../support/hiring-page.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * The EPIC-0006 B7 hidden line (r3 D10): `line` then " View it" linking to the
 * posting, no "Job Posting saved." and no success toast.
 */
async function expectHiddenLine(hiring: HiringPage, line: string): Promise<void> {
  const status = hiring.resultStatus().filter({ hasText: line })
  await expect(status).toHaveCount(1)
  await expect(status).toHaveText(`${line} ${COPY.hiddenView}`)
  await expect(status.getByRole("link", { name: COPY.hiddenView, exact: true })).toHaveAttribute("href", /^\/postings\/[0-9a-f-]{36}$/)
  await expect(hiring.dialog().getByText(COPY.created, { exact: true })).toHaveCount(0)
  await expect(hiring.toasts().getByText(COPY.linkAccepted, { exact: true })).toHaveCount(0)
}

/**
 * EPIC-0007 Phase 2, check-this-job.feature r3 (@phase2 scenarios that the
 * browser can exercise). Real api and Postgres; the ATS public APIs are the
 * fixtures in support/ats-fixtures.mjs. No first-party response is stubbed.
 *
 * r3 Background (owner decision D10): Phases 2 and 1 shipped, Ada targets
 * Frontend with the default seniority setting. The Greenhouse, Lever and Ashby
 * fixtures are visible postings (dated, Frontend, not entry-level). Hosts Eve
 * does not fetch are undated, so their pastes show the EPIC-0006 B7 hidden line.
 */
test.beforeEach(async () => {
  await resetPostings()
  await setRelevance(ADA.email, ["senior_frontend"])
  await setRelevance(BOLA.email, ["senior_frontend"])
})

test.describe("Check this job: section and submit (AC 5.1 to 5.3)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context, ADA.email)
  })

  // CTJ-01: check-this-job.feature r3 CTJ:50 Outline (QA-P1-T-04 retired the Phase-2-alone SOLO expectation).
  for (const [families, hint, help, other] of [
    [["senior_frontend"], true, COPY.checkHelp, COPY.checkHelpSolo],
    [["other"], false, COPY.checkHelpSolo, COPY.checkHelp],
  ] as const) {
    test(`CTJ-01 targets ${families.join("+")}: one URL field "Application link", one submit "Check link", C-HP-HINT ${hint ? "rendered" : "not rendered"}, help ${hint ? "C-HP-CHECK-HELP" : "C-HP-CHECK-HELP-SOLO"}`, async ({ page }) => {
      await setRelevance(ADA.email, families)
      try {
        const hiring = new HiringPage(page)
        await hiring.open()
        // EPIC-0011: the section keeps one button and its one help line; the form is in the dialog.
        await expect(hiring.checkButton()).toBeVisible()
        await expect(hiring.checkSection().getByRole("textbox")).toHaveCount(0)
        await expect(page.getByText(COPY.hint, { exact: false })).toHaveCount(hint ? 1 : 0)
        await expect(hiring.checkSection().getByText(help, { exact: true })).toBeVisible()
        await expect(page.getByText(other, { exact: true })).toHaveCount(0)
        await hiring.openCheck()
        await expect(hiring.dialog().getByRole("textbox")).toHaveCount(1)
        await expect(hiring.urlField()).toBeVisible()
        // PD:124 r2: the link submit button plus the "Add the job description" toggle.
        await expect(hiring.dialog().getByRole("button", { name: "Add the job description", exact: true })).toBeVisible()
        await expect(hiring.submitButton()).toBeVisible()
      } finally {
        await setRelevance(ADA.email, ["senior_frontend"])
      }
    })
  }

  test("CTJ-02 a Greenhouse link sends the existing paste request ({ url } + CSRF) and stores origin pasted_link", async ({ page }) => {
    const requests = recordRequests(page)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(GREENHOUSE_JOB_URL)
    await expect(hiring.resultStatus().getByText(COPY.created, { exact: true })).toBeVisible()

    const [paste] = pasteRequests(requests)
    expect(paste, "one POST /v1/job-postings/links").toBeDefined()
    expect(paste!.postDataJSON()).toEqual({ url: GREENHOUSE_JOB_URL })
    expect(paste!.headers()[CSRF_HEADER]).toBeTruthy()

    const stored = await postingsWithUrl(GREENHOUSE_JOB_URL)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ origin: "pasted_link", candidateEmail: ADA.email })
    expect(outboundRequests().some((r) => r.url.startsWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345"))).toBe(true)
  })

  test("CTJ-03 the request carries no new field and goes to the same endpoint as the existing paste form", async ({ page }) => {
    const requests = recordRequests(page)
    await page.goto("/postings")
    const legacy = page.getByRole("region", { name: COPY.addJobLinkTitle })
    await legacy.getByRole("textbox").fill(LEVER_JOB_URL)
    // Repair wave 1: wait for the paste response (the posting is stored) before removing it, or the reset races the insert.
    const stored = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/v1/job-postings/links"))
    await legacy.getByRole("button", { name: COPY.submit, exact: true }).click()
    await stored
    expect(pasteRequests(requests)).toHaveLength(1)
    await resetPostings()

    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(LEVER_JOB_URL)
    await expect.poll(() => pasteRequests(requests).length).toBe(2)
    const [fromLegacy, fromHiring] = pasteRequests(requests)
    // Repair wave 1b: wait for the stored row before the next test's resetPostings.
    expect((await fromHiring!.response())?.ok()).toBe(true)
    expect(new URL(fromHiring!.url()).pathname).toBe(new URL(fromLegacy!.url()).pathname)
    expect(Object.keys(fromHiring!.postDataJSON() as object)).toEqual(["url"])
  })

  test("CTJ-04 a new posting shows \"Job Posting saved.\", its status badge and \"View it\"; the field clears; a success toast shows", async ({ page }) => {
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(ASHBY_JOB_URL)
    const status = hiring.resultStatus()
    await expect(status.getByText(COPY.created, { exact: true })).toBeVisible()
    await expect(status.getByText(/^(Checking|Good match|Not a match|Couldn't check|Hidden)$/)).toBeVisible()
    const stored = await postingsWithUrl(ASHBY_JOB_URL)
    expect(stored).toHaveLength(1)
    await expect(status.getByRole("link", { name: COPY.view, exact: true })).toHaveAttribute("href", `/postings/${stored[0]!.id}`)
    await expect(hiring.urlField()).toHaveValue("")
    await expect(hiring.toasts().getByText(COPY.linkAccepted, { exact: true })).toBeVisible()
    await expect(page.getByText(/Saved, but hidden/)).toHaveCount(0)
  })

  test("CTJ-05 a link already stored shows the existing already-stored message, links to it, stores nothing and calls no ATS", async ({ page }) => {
    const id = await insertPastedPosting(ADA.email, GREENHOUSE_JOB_URL)
    const before = outboundRequests().length
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(GREENHOUSE_JOB_URL)
    const line = hiring.resultStatus().filter({ hasText: COPY.alreadySaved })
    await expect(line).toBeVisible()
    await expect(line.getByRole("link", { name: COPY.view, exact: true })).toHaveAttribute("href", `/postings/${id}`)
    await expect(hiring.urlField()).toHaveValue(GREENHOUSE_JOB_URL)
    expect(await postingsWithUrl(GREENHOUSE_JOB_URL)).toHaveLength(1)
    expect(outboundRequests().slice(before).filter((r) => r.url.includes("greenhouse"))).toEqual([])
  })

  test("CTJ-06 double-submitting the same link stores one posting and never shows an error", async ({ page }) => {
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.openCheck()
    await hiring.urlField().fill(GREENHOUSE_JOB_URL)
    await hiring.urlField().press("Enter")
    await hiring.urlField().press("Enter").catch(() => {})
    await expect(hiring.resultStatus().filter({ hasText: new RegExp(`${COPY.created}|${COPY.alreadySaved}`) })).toBeVisible()
    await expect(hiring.toasts().getByText(COPY.checkFailed)).toHaveCount(0)
    await expect(page.getByText(/Saved, but hidden/)).toHaveCount(0)
    expect(await postingsWithUrl(GREENHOUSE_JOB_URL)).toHaveLength(1)
  })

  const invalid: ReadonlyArray<readonly [string, string]> = [
    ["", COPY.linkEmpty],
    ["   ", COPY.linkEmpty],
    ["not a link", COPY.linkInvalid],
    ["ftp://acme.com/job/1", COPY.linkInvalid],
    ["javascript:alert(1)", COPY.linkInvalid],
  ]
  for (const [input, message] of invalid) {
    test(`CTJ-07 ${JSON.stringify(input)} shows "${message}", keeps the input and stores nothing`, async ({ page }) => {
      const hiring = new HiringPage(page)
      await hiring.open()
      await hiring.submit(input)
      await expect(hiring.dialog().getByRole("alert").filter({ hasText: message })).toBeVisible()
      await expect(hiring.urlField()).toHaveValue(input)
      await expect(hiring.urlField()).toBeFocused()
      expect(await postingCount()).toBe(0)
    })
  }

  test("CTJ-08 a 2,048-character https link is sent unchanged, accepted, and shows the undated hidden line (CTJ:158 r3)", async ({ page }) => {
    const base = "https://careers.example.org/jobs/123?ref="
    const url = base + "a".repeat(2048 - base.length)
    expect(url).toHaveLength(2048)
    const requests = recordRequests(page)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(url)
    await expectHiddenLine(hiring, COPY.hiddenCreated(COPY.hiddenUndated))
    expect(pasteRequests(requests)[0]!.postDataJSON()).toEqual({ url })
    expect(await postingCount()).toBe(1)
    expect((await postingsWithUrl(url))[0]).toMatchObject({ origin: "pasted_link" })
  })

  test("CTJ-09 a 2,049-character link gets the plain 400, the C-ERR-2 toast, no field error, input kept, nothing stored", async ({ page }) => {
    const base = "https://careers.example.org/jobs/123?ref="
    const url = base + "a".repeat(2049 - base.length)
    expect(url).toHaveLength(2049)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.openCheck()
    await hiring.urlField().fill(url)
    const responsePromise = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/v1/job-postings/links"))
    await hiring.submitButton().click()
    const response = await responsePromise
    expect(response.request().postDataJSON()).toEqual({ url })
    expect(response.status()).toBe(400)
    const body = (await response.json()) as { error: { code: string; message: string; fieldErrors?: unknown } }
    expect(body.error.code).toBe("bad_request")
    expect(body.error.fieldErrors).toBeUndefined()

    await expect(hiring.toasts().getByText(COPY.checkFailed, { exact: true })).toBeVisible()
    await expect(hiring.dialog().getByRole("alert")).toHaveCount(0)
    await expect(hiring.urlField()).not.toHaveAttribute("aria-invalid", "true")
    await expect(hiring.urlField()).toHaveValue(url)
    expect(await postingCount()).toBe(0)
  })

  test("CTJ-10 spaces around a pasted link are trimmed before it is stored", async ({ page }) => {
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(`  ${GREENHOUSE_JOB_URL}  `)
    await expect(hiring.resultStatus().getByText(COPY.created, { exact: true })).toBeVisible()
    expect(await postingsWithUrl(GREENHOUSE_JOB_URL)).toHaveLength(1)
  })

  test("CTJ-11 an unsupported host is stored with no fetch, skipped as unsupported and hidden as undated (CTJ:182 r3)", async ({ page }) => {
    const before = outboundRequests().length
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit("https://careers.example.org/jobs/123")
    await expectHiddenLine(hiring, COPY.hiddenCreated(COPY.hiddenUndated))
    const stored = await postingsWithUrl("https://careers.example.org/jobs/123")
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system", postedAt: null })
    expect(outboundRequests().slice(before)).toEqual([])
    await hiring.resultStatus().getByRole("link", { name: COPY.hiddenView, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/postings/${stored[0]!.id}$`))
    await expect(page.getByText(COPY.detailHiddenUndated, { exact: true })).toBeVisible()
  })
})

test.describe("Check this job: hidden result (r3, EPIC-0006 AC-5.5/5.7, owner decision D10)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context, ADA.email)
  })

  for (const row of HIDDEN_CASES) {
    test(`CTJ-20 (CTJ:92) ${row.link} shows "${COPY.hiddenCreated(row.reason)}" with "View it", stored not_checked, no toast, field cleared, no AI call`, async ({ page }) => {
      const hiring = new HiringPage(page)
      await hiring.open()
      await hiring.submit(row.link)
      await expectHiddenLine(hiring, COPY.hiddenCreated(row.reason))
      const stored = await postingsWithUrl(row.link)
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ origin: "pasted_link", status: "not_checked", candidateEmail: ADA.email })
      await expect(hiring.resultStatus().getByRole("link", { name: COPY.hiddenView, exact: true })).toHaveAttribute("href", `/postings/${stored[0]!.id}`)
      await expect(hiring.urlField()).toHaveValue("")
      await page.waitForTimeout(500)
      expect(await aiCallsForUrl(stored[0]!.applicationUrl)).toBe(0)
    })
  }

  test("CTJ-21 (CTJ:112) a known undated link shows the existing hidden line, stores nothing new and calls no Lever API", async ({ page }) => {
    const url = "https://jobs.lever.co/acme/fe-undated-1"
    const id = await insertPastedPosting(ADA.email, url, { postedAt: null, applicationSystem: "lever", requisitionId: "fe-undated-1" })
    const before = outboundRequests().length
    const requests = recordRequests(page)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(url)
    await expectHiddenLine(hiring, COPY.hiddenExisting(COPY.hiddenUndated))
    await expect(hiring.resultStatus().getByRole("link", { name: COPY.hiddenView, exact: true })).toHaveAttribute("href", `/postings/${id}`)
    const response = await pasteRequests(requests)[0]!.response()
    expect(((await response!.json()) as { created: boolean }).created).toBe(false)
    expect(await postingsWithUrl(url)).toHaveLength(1)
    expect(outboundRequests().slice(before).filter((r) => r.url.includes("lever"))).toEqual([])
  })

  test("CTJ-22 (CTJ:217) sending a stored linkedin.com URL again shows the existing hidden line", async ({ page }) => {
    const url = "https://www.linkedin.com/jobs/view/3999999999"
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(url)
    await hiring.saveAnyway().click()
    await expectHiddenLine(hiring, COPY.hiddenCreated(COPY.hiddenUndated))
    await hiring.submit(url)
    await expect(hiring.warning()).toBeVisible()
    await hiring.saveAnyway().click()
    await expectHiddenLine(hiring, COPY.hiddenExisting(COPY.hiddenUndated))
    expect(await postingsWithUrl(url)).toHaveLength(1)
  })
})

test.describe("Check this job: same behaviour as the existing form (r3 CTJ:260, CTJ:269, D11)", () => {
  test("CTJ-23 (CTJ:260) the same visible URL pasted by Ada through /postings, removed, then through Check this job gives the same stored result", async ({ page, context }) => {
    await signIn(context, ADA.email)
    await page.goto("/postings")
    const legacy = page.getByRole("region", { name: COPY.addJobLinkTitle })
    await legacy.getByRole("textbox").fill(GREENHOUSE_JOB_URL)
    await legacy.getByRole("button", { name: COPY.submit, exact: true }).click()
    await expect(page.getByRole("region", { name: "Messages" }).getByText(COPY.linkAccepted, { exact: true })).toBeVisible()
    await expect(legacy.getByText(/Saved, but hidden/)).toHaveCount(0)
    const settle = async () => {
      await expect.poll(async () => (await postingsWithUrl(GREENHOUSE_JOB_URL))[0]?.status, { timeout: 15_000 }).not.toBe("checking")
      const [row] = await postingsWithUrl(GREENHOUSE_JOB_URL)
      return { origin: row!.origin, status: row!.status, skipReason: row!.skipReason, dated: row!.postedAt !== null, candidateEmail: row!.candidateEmail }
    }
    const recorded = await settle()
    await resetPostings()

    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(GREENHOUSE_JOB_URL)
    await expect(hiring.resultStatus().getByText(COPY.created, { exact: true })).toBeVisible()
    await expect(hiring.toasts().getByText(COPY.linkAccepted, { exact: true })).toBeVisible()
    await expect(page.getByText(/Saved, but hidden/)).toHaveCount(0)
    expect(await settle()).toEqual(recorded)
  })

  test("CTJ-24 (CTJ:269) Bola (invitee) pasting the URL Ada pasted sees \"Job Posting saved.\" with \"Waiting to be checked\"; nothing of Ada's row reaches her", async ({ browser }) => {
    const adaContext = await browser.newContext()
    await signIn(adaContext, ADA.email)
    const adaPage = await adaContext.newPage()
    await adaPage.goto("/postings")
    const legacy = adaPage.getByRole("region", { name: COPY.addJobLinkTitle })
    await legacy.getByRole("textbox").fill(GREENHOUSE_JOB_URL)
    await legacy.getByRole("button", { name: COPY.submit, exact: true }).click()
    await expect(adaPage.getByRole("region", { name: "Messages" }).getByText(COPY.linkAccepted, { exact: true })).toBeVisible()
    await adaContext.close()

    const bolaContext = await browser.newContext()
    await signIn(bolaContext, BOLA.email)
    const page = await bolaContext.newPage()
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(GREENHOUSE_JOB_URL)
    const status = hiring.resultStatus()
    await expect(status.getByText(COPY.created, { exact: true })).toBeVisible()
    await expect(page.getByText(COPY.alreadySaved)).toHaveCount(0)
    await expect.poll(async () => (await postingsWithUrl(GREENHOUSE_JOB_URL)).find((row) => row.candidateEmail === BOLA.email)?.status).toBe("waiting_to_be_checked")
    const rows = await postingsWithUrl(GREENHOUSE_JOB_URL)
    expect(rows.map((row) => row.candidateEmail).sort()).toEqual([ADA.email, BOLA.email].sort())
    expect(rows.every((row) => row.origin === "pasted_link")).toBe(true)
    // CTJ:269 "she sees 'Job Posting saved.' with the 'Waiting to be checked' status badge" (asserted last, as r3 states it).
    await expect(status.getByText(COPY.statusWaiting, { exact: true })).toBeVisible()
    await bolaContext.close()
  })
})

test.describe("Check this job: linkedin.com warning (AC 5.5, 5.7, D7)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context, ADA.email)
  })

  const linkedIn = [
    "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000000-abcd",
    "https://linkedin.com/jobs/view/3999999999",
    "https://ng.linkedin.com/posts/acme_hiring-activity-7250000000000000001-wxyz",
    "  https://WWW.LinkedIn.com/feed/update/urn:li:activity:7250000000000000002  ",
    "http://www.linkedin.com/posts/acme_x-activity-7250000000000000003-aaaa",
  ]
  for (const url of linkedIn) {
    test(`CTJ-12 ${JSON.stringify(url)} shows the warning with "Save it anyway" and sends nothing`, async ({ page }) => {
      const requests = recordRequests(page)
      const hiring = new HiringPage(page)
      await hiring.open()
      await hiring.submit(url)
      await expect(hiring.warning()).toBeVisible()
      await expect(hiring.saveAnyway()).toBeVisible()
      await expect(hiring.urlField()).not.toHaveAttribute("aria-invalid", "true")
      await expectNoPasteRequest(requests)
    })
  }

  test("CTJ-13 \"Save it anyway\" sends the link; it is stored as pasted_link, skipped as unsupported and hidden as undated (CTJ:208 r3)", async ({ page }) => {
    const url = "https://www.linkedin.com/jobs/view/3999999999"
    const requests = recordRequests(page)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(url)
    await expect(hiring.warning()).toBeVisible()
    await hiring.saveAnyway().click()
    await expectHiddenLine(hiring, COPY.hiddenCreated(COPY.hiddenUndated))
    expect(pasteRequests(requests)).toHaveLength(1)
    expect(pasteRequests(requests)[0]!.postDataJSON()).toEqual({ url })
    const stored = await postingsWithUrl(url)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system", postedAt: null })
  })

  test("CTJ-14 pressing Check link again with the same LinkedIn value also sends it", async ({ page }) => {
    const requests = recordRequests(page)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit("https://www.linkedin.com/jobs/view/3999999999")
    await expect(hiring.warning()).toBeVisible()
    await hiring.submitButton().click()
    await expect.poll(() => pasteRequests(requests).length).toBe(1)
    // Repair wave 1b: wait for the stored row before the next test's resetPostings.
    expect((await pasteRequests(requests)[0]!.response())?.ok()).toBe(true)
  })

  test("CTJ-15 editing the field instead removes the warning, sends nothing and keeps focus in the field", async ({ page }) => {
    const url = "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000000-abcd"
    const requests = recordRequests(page)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(url)
    await expect(hiring.warning()).toBeVisible()
    await hiring.urlField().focus()
    await page.keyboard.press("End")
    await page.keyboard.type("x")
    await page.keyboard.press("Backspace")
    await expect(hiring.urlField()).toHaveValue(url)
    await expect(hiring.urlField()).toBeFocused()
    await expect(hiring.warning()).toHaveCount(0)
    await expectNoPasteRequest(requests)
  })

  for (const url of [
    "https://notlinkedin.com/jobs/1",
    "https://linkedin.com.evil.example/jobs/1",
    "https://boards.greenhouse.io/linkedin/jobs/4012345",
    "https://careers.example.org/?ref=linkedin.com",
  ]) {
    test(`CTJ-16 ${JSON.stringify(url)} only looks like LinkedIn: no warning, the paste request is sent`, async ({ page }) => {
      const requests = recordRequests(page)
      const hiring = new HiringPage(page)
      await hiring.open()
      await hiring.submit(url)
      await expect.poll(() => pasteRequests(requests).length).toBe(1)
      await expect(hiring.warning()).toHaveCount(0)
      // Repair wave 1b: wait for the paste response (the row is stored) so the next test's resetPostings does not race the insert.
      expect((await pasteRequests(requests)[0]!.response())?.ok()).toBe(true)
    })
  }

  test("CTJ-17 sending a linkedin.com URL anyway makes no request to any linkedin.com or google.com host (browser or api)", async ({ page }) => {
    const requests = recordRequests(page)
    const apiBefore = outboundRequests().length
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit("https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000000-abcd")
    await hiring.saveAnyway().click()
    await expectHiddenLine(hiring, COPY.hiddenCreated(COPY.hiddenUndated))
    await page.waitForTimeout(1000)
    const forbidden = (url: string) => /(^|\.)linkedin\.com$|(^|\.)google\.com$/i.test(new URL(url).hostname)
    expect(requests.map((r) => r.url()).filter(forbidden)).toEqual([])
    expect(outboundRequests().slice(apiBefore).map((r) => r.url).filter(forbidden)).toEqual([])
  })
})

test.describe("Check this job: tenancy (AC 1.3, 5.2, 5.3)", () => {
  test("CTJ-18 a paste from the Hiring view is stored for the session Candidate only", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(GREENHOUSE_JOB_URL)
    await expect(hiring.resultStatus().getByText(COPY.created, { exact: true })).toBeVisible()
    const stored = await postingsWithUrl(GREENHOUSE_JOB_URL)
    expect(stored.map((row) => row.candidateEmail)).toEqual([BOLA.email])
  })

  test("CTJ-19 another Candidate's stored URL is not reported as already stored", async ({ page, context }) => {
    await insertPastedPosting(ADA.email, GREENHOUSE_JOB_URL)
    await signIn(context, BOLA.email)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(GREENHOUSE_JOB_URL)
    await expect(hiring.resultStatus().getByText(COPY.created, { exact: true })).toBeVisible()
    await expect(page.getByText(COPY.alreadySaved)).toHaveCount(0)
    const stored = await postingsWithUrl(GREENHOUSE_JOB_URL)
    expect(stored.map((row) => row.candidateEmail).sort()).toEqual([ADA.email, BOLA.email].sort())
  })
})

test.describe("Check this job: refused writes (AC 1.3)", () => {
  test("HV-T1 a paste without a valid CSRF token is refused with csrf_invalid and stores nothing", async ({ context }) => {
    await signIn(context, ADA.email)
    const response = await context.request.post("/v1/job-postings/links", { data: { url: GREENHOUSE_JOB_URL }, headers: { [CSRF_HEADER]: "not-the-token" } })
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "csrf_invalid", message: COPY.csrfInvalid } })
    expect(await postingCount()).toBe(0)
  })

  test("HV-T2 a paste with no session is refused with unauthenticated before the CSRF check", async ({ playwright }) => {
    const { baseURL } = test.info().project.use
    const anonymous = await playwright.request.newContext({ baseURL })
    const response = await anonymous.post("/v1/job-postings/links", { data: { url: GREENHOUSE_JOB_URL }, headers: { [CSRF_HEADER]: "a".repeat(43) } })
    expect(response.status()).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unauthenticated")
    expect(await postingCount()).toBe(0)
    await anonymous.dispose()
  })

  test("HV-T3 a refused write shows the API message and keeps the input", async ({ page, context }) => {
    await signIn(context, ADA.email)
    const hiring = new HiringPage(page)
    await hiring.open()
    // "not a link" is refused before sending; the server refusal is covered by CTJ-07 and the api tests.
    await hiring.submit("not a link")
    await expect(hiring.dialog().getByText(COPY.linkInvalid, { exact: true })).toBeVisible()
    await expect(hiring.urlField()).toHaveValue("not a link")
  })

  test("HV-T4 a successful paste shows the existing paste success toast", async ({ page, context }) => {
    await signIn(context, ADA.email)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.submit(GREENHOUSE_JOB_URL)
    await expect(hiring.toasts().getByText(COPY.linkAccepted, { exact: true })).toBeVisible()
  })

  test("HV-T5 a network failure shows the retry error and keeps the input", async ({ page, context }) => {
    await signIn(context, ADA.email)
    const hiring = new HiringPage(page)
    await hiring.open()
    await hiring.openCheck()
    await hiring.urlField().fill(GREENHOUSE_JOB_URL)
    // QA-G-02: the network fails while the browser stays online. context.setOffline flips
    // navigator.onLine, and TanStack Query then pauses the mutation instead of failing it
    // (the existing /postings form does the same). This is the suite's only route use:
    // failure injection, not a canned response. It aborts exactly one POST at the network layer
    // (net::ERR_INTERNET_DISCONNECTED, so fetch rejects) and lets every other request through.
    let aborted = 0
    // eslint-disable-next-line no-restricted-properties -- single request-abort failure injection (QA-G-02)
    await page.route("**/v1/job-postings/links", async (route) => {
      if (route.request().method() !== "POST" || aborted > 0) return route.fallback()
      aborted += 1
      await route.abort("internetdisconnected")
    })
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    await hiring.submitButton().click()
    await expect(hiring.toasts().getByText(COPY.checkFailed, { exact: true })).toBeVisible()
    expect(aborted).toBe(1)
    await page.unrouteAll()
    await expect(hiring.urlField()).toHaveValue(GREENHOUSE_JOB_URL)
    await expect(hiring.submitButton()).toHaveText(COPY.submit)
    expect(await postingCount()).toBe(0)
  })
})
