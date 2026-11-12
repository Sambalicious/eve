import { type Page, expect, test } from "@playwright/test"

import { COPY } from "../support/copy.ts"
import { signIn } from "../support/db.ts"
import { restoreHiringInputs, setHiringInputs, snapshotHiringInputs } from "../support/hiring-db.ts"
import { HiringLinksPage } from "../support/hiring-links-page.ts"
import { LINKS_COPY } from "../support/hiring-links-copy.ts"
import { ALL_HINTS, type Family, HIRING_CLAUSE, ROLE_PHRASES, clause, decodedParam, expectedHiringGroups, hintTerms, terms } from "../support/hiring-oracle.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * EPIC-0007 Phase 1, hiring-view.feature r2 (@phase1 scenarios). Written for the
 * Phases 2 and 1 ship state (D3); since Phase 3 shipped (Gherkin r5 point 1) the
 * Hiring view also holds the Phase 3 sections, covered in the *.phase3.spec.ts files. Hint terms come from each Candidate's own job_preferences.
 */
let saved: Awaited<ReturnType<typeof snapshotHiringInputs>>
test.beforeAll(async () => {
  saved = await snapshotHiringInputs()
})
test.afterAll(async () => {
  await restoreHiringInputs(saved)
})

async function openAs(page: Page, email: string, params: Record<string, string> = {}): Promise<HiringLinksPage> {
  await signIn(page.context(), email)
  const hiring = new HiringLinksPage(page)
  await hiring.openWith(params)
  await expect(hiring.linksSection()).toBeVisible()
  return hiring
}

test.describe("Sections and the search-hint statement (AC 1.2, 1.4)", () => {
  // HV1-01 retired in Phase 3 repair wave 1 (G-05, QA-P3-T-01): Gherkin r5 point 1 removed the
  // "Phases 2 and 1" row of the old HV:105 Outline; that state is unreachable once Phase 3 ships.
  // Replacement: HV:104 r5 "exactly four sections in order, no placeholder" is OUT3-01 in
  // tests/outbound-and-separation.phase3.spec.ts.

  test("HV1-02 the section shows C-HP-HINT ending with the link \"Paste job links in Check this job\", which moves to Check this job", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.hintNote()).toBeVisible()
    await expect(hiring.hintNote()).toContainText(LINKS_COPY.hint)
    await expect(hiring.hintLink()).toBeVisible()
    await hiring.hintLink().click()
    // QA-P1-T-02: HV:257 and design-spec B1 step 1 require the move and focus, not a URL change.
    await expect(hiring.heading(COPY.checkTitle)).toBeFocused()
    await expect(hiring.heading(COPY.checkTitle)).toBeInViewport()
  })

  test("HV1-03 with the hint note on screen, Check this job shows C-HP-CHECK-HELP and not the SOLO text", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.hintNote()).toBeVisible()
    await expect(hiring.checkSection().getByText(COPY.checkHelp, { exact: true })).toBeVisible()
    await expect(page.getByText(COPY.checkHelpSolo, { exact: true })).toHaveCount(0)
  })

  for (const width of [375, 1280]) {
    test(`HV1-04 at ${width}px with 40 terms the hint note comes before the first hiring link and is reached without scrolling past any link`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await setHiringInputs(ADA.email, { families: ["senior_frontend", "backend"], frameworks: terms("F", 20), technologies: terms("T", 20), prefs: ALL_HINTS })
      const hiring = await openAs(page, ADA.email)
      await hiring.waitForGroups(10)
      const note = hiring.linksSection().getByText(LINKS_COPY.hint, { exact: false }).first()
      const firstLink = hiring.linkedinLinks().first()
      // DOM order: the note precedes every hiring link and the family choice.
      const precedes = await note.evaluate((n, link) => Boolean(n.compareDocumentPosition(link as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await firstLink.elementHandle())
      expect(precedes).toBe(true)
      const precedesSelect = await note.evaluate((n, select) => Boolean(n.compareDocumentPosition(select as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await hiring.familySelect().elementHandle())
      expect(precedesSelect).toBe(true)
      // Visual order: the note's bottom is above the first link's top.
      const noteBox = (await note.boundingBox())!
      const linkBox = (await firstLink.boundingBox())!
      expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(linkBox.y)
      // Scrolling the section heading to the top puts the note on screen before any link.
      await hiring.heading(LINKS_COPY.title).scrollIntoViewIfNeeded()
      await expect(note).toBeInViewport()
    })
  }

  test("HV1-05 only Other targeted: the no-family empty state, no C-HP-HINT, and Check this job shows C-HP-CHECK-HELP-SOLO", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["other"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.linksSection().getByText(LINKS_COPY.noFamilyTitle, { exact: true })).toBeVisible()
    await expect(page.getByText(LINKS_COPY.hint, { exact: false })).toHaveCount(0)
    await expect(hiring.checkSection().getByText(COPY.checkHelpSolo, { exact: true })).toBeVisible()
    await expect(page.getByText(COPY.checkHelp, { exact: true })).toHaveCount(0)
  })

  for (const [families, hint] of [
    [["senior_frontend"], true],
    [["other"], false],
  ] as [Family[], boolean][]) {
    test(`HV1-06 (HV:291 r5, Phases 1, 2 and 3) targets ${families.join("+")}: C-HP-HINT ${hint ? "rendered" : "not rendered"}, help ${hint ? "C-HP-CHECK-HELP" : "C-HP-CHECK-HELP-SOLO"}`, async ({ page }) => {
      await setHiringInputs(ADA.email, { families, frameworks: ["React"] })
      const hiring = await openAs(page, ADA.email)
      await expect(page.getByText(LINKS_COPY.hint, { exact: false })).toHaveCount(hint ? 1 : 0)
      await expect(hiring.checkSection().getByText(hint ? COPY.checkHelp : COPY.checkHelpSolo, { exact: true })).toBeVisible()
      await expect(page.getByText(hint ? COPY.checkHelpSolo : COPY.checkHelp, { exact: true })).toHaveCount(0)
    })
  }
})

test.describe("External links (AC 1.3)", () => {
  test("HV1-07 every linkedin.com and google.com link opens in a new tab with rel \"noopener noreferrer\"", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: terms("F", 6), prefs: ALL_HINTS })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(2)
    await hiring.alertsQueries()
    const external = await hiring.linksSection().locator("a[href]").evaluateAll((links) =>
      links
        .map((a) => ({ href: a.getAttribute("href") ?? "", target: a.getAttribute("target"), rel: a.getAttribute("rel") }))
        .filter(({ href }) => /^https:\/\/([a-z0-9-]+\.)*(linkedin|google)\.com\//i.test(href))
    )
    // 2 groups × (LinkedIn + Google) + "Open Google Alerts" in each expanded panel.
    expect(external.length).toBeGreaterThanOrEqual(5)
    for (const link of external) {
      expect(link.target, link.href).toBe("_blank")
      expect(link.rel?.split(/\s+/).sort(), link.href).toEqual(["noopener", "noreferrer"])
    }
    for (const name of [LINKS_COPY.linkLi, LINKS_COPY.linkG]) {
      await expect(hiring.linksSection().getByRole("link", { name: new RegExp(`^${name} .*\\(opens in a new tab\\)$`) }).first()).toBeVisible()
    }
  })
})

test.describe("Copy announcements (AC 1.3)", () => {
  test("HV1-09 a successful copy announces \"Hiring query copied.\" in a polite live region", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await hiring.alertsToggles().first().click()
    await hiring.copyButtons().first().click()
    const live = hiring.linksSection().locator('[aria-live="polite"]').filter({ hasText: LINKS_COPY.liveCopied })
    await expect(live).toHaveCount(1)
  })
})

test.describe("Tenancy: each Candidate's own settings (AC 1.1, 2.2, 2.5)", () => {
  test("HV1-10 Bola (Backend, Django) sees Django and Backend phrases; nothing from Ada (Frontend, React)", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: ALL_HINTS })
    await setHiringInputs(BOLA.email, { families: ["backend"], frameworks: ["Django"], prefs: null })
    const hiring = await openAs(page, BOLA.email)
    await hiring.waitForGroups(1)
    const values = [...(await hiring.linkedinHrefs()).map((h) => decodedParam(h, "keywords")!), ...(await hiring.googleHrefs()).map((h) => decodedParam(h, "q")!), ...(await hiring.alertsQueries())]
    for (const value of values) {
      expect(value).toContain('"Django"')
      expect(value).toContain(clause(ROLE_PHRASES.backend))
      expect(value).not.toContain("React")
      for (const phrase of ROLE_PHRASES.senior_frontend) expect(value).not.toContain(phrase)
    }
  })

  test("HV1-11 Bola opening ?family=fullstack (a family only Ada targets) gets Backend and nothing of Ada's", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "fullstack"], frameworks: ["React"], prefs: ALL_HINTS })
    await setHiringInputs(BOLA.email, { families: ["backend"], frameworks: ["Django"], prefs: null })
    const hiring = await openAs(page, BOLA.email, { family: "fullstack" })
    await expect(hiring.linksSection().getByText(LINKS_COPY.familySingle("Backend"), { exact: true })).toBeVisible()
    const [keywords] = (await hiring.linkedinHrefs()).map((h) => decodedParam(h, "keywords")!)
    expect(keywords).toBe(`${HIRING_CLAUSE} AND ${clause(ROLE_PHRASES.backend)} AND ("Django")`)
    await expect(hiring.linksSection()).not.toContainText("React")
    await expect(hiring.linksSection()).not.toContainText("remote")
  })

  test("HV1-12 Ada vs Bola hint terms come from each one's own job_preferences, not the other's", async ({ page, browser }) => {
    const adaPrefs = ALL_HINTS
    const bolaPrefs = { remoteAccepted: false, relocationAccepted: true, sponsorshipNeededForRelocation: false }
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: adaPrefs })
    await setHiringInputs(BOLA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: bolaPrefs })
    const ada = await openAs(page, ADA.email)
    const bolaContext = await browser.newContext()
    const bola = await openAs(await bolaContext.newPage(), BOLA.email)
    const expectFor = (prefs: typeof adaPrefs) => expectedHiringGroups({ family: "senior_frontend", frameworks: ["React"], technologies: [], hints: hintTerms(prefs) })[0]!
    expect(await ada.alertsQueries()).toEqual([expectFor(adaPrefs).alertsQuery])
    expect(await ada.linkedinHrefs()).toEqual([expectFor(adaPrefs).linkedin])
    expect(await bola.alertsQueries()).toEqual([expectFor(bolaPrefs).alertsQuery])
    expect(await bola.linkedinHrefs()).toEqual([expectFor(bolaPrefs).linkedin])
    await expect(bola.linksSection()).not.toContainText("visa sponsorship")
    await expect(bola.linksSection().getByText("relocation", { exact: true })).toBeVisible()
    await bolaContext.close()
  })
})

test.describe("Keyboard and names (AC 1.3)", () => {
  test("HV1-13 the family choice, links, disclosure and copy are reachable and operable by keyboard and named", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "backend"], frameworks: ["React"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    // QA-P1-T-03: a native <select> is keyboard-operable by platform behaviour, but ArrowDown does not change it in
    // headless Chromium on macOS. Reach it by keyboard focus, then change it with selectOption (platform-independent).
    await hiring.familySelect().focus()
    await expect(hiring.familySelect()).toBeFocused()
    await hiring.familySelect().selectOption("backend")
    await expect(page).toHaveURL(/family=backend/)
    // The Tab walk starts from the select (focus it again in case the change moved focus).
    await hiring.familySelect().focus()
    const reached: string[] = []
    for (let i = 0; i < 12 && !reached.includes("toggle"); i += 1) {
      await page.keyboard.press("Tab")
      const name = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "")
      if (name.startsWith("LinkedIn posts")) reached.push("li")
      if (name.startsWith("Google posts")) reached.push("g")
      if (name.startsWith("Google Alerts query")) reached.push("toggle")
    }
    expect(reached).toEqual(["li", "g", "toggle"])
    await page.keyboard.press("Enter")
    await expect(hiring.copyButtons().first()).toBeVisible()
    await hiring.copyButtons().first().focus()
    await page.keyboard.press("Enter")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`site:linkedin.com/posts ${HIRING_CLAUSE} ${clause(ROLE_PHRASES.backend)} ("React")`)
    for (const control of await hiring.linksSection().getByRole("button").all()) await expect(control).toHaveAccessibleName(/\S/)
    for (const control of await hiring.linksSection().getByRole("link").all()) await expect(control).toHaveAccessibleName(/\S/)
  })
})
