import { type Page, expect, test } from "@playwright/test"

import { CSRF_HEADER, signIn } from "../support/db.ts"
import { databaseFingerprint, restoreHiringInputs, setHiringInputs, setPauses, snapshotHiringInputs, clearAlertFeedVerification } from "../support/hiring-db.ts"
import { HiringLinksPage } from "../support/hiring-links-page.ts"
import { JOB_CRITERIA_HREF, LINKS_COPY } from "../support/hiring-links-copy.ts"
import { recordRequests } from "../support/hiring-page.ts"
import {
  AC34_ALERTS,
  AC34_GOOGLE,
  AC34_KEYWORDS,
  AC34_LINKEDIN,
  ALL_HINTS,
  FAMILIES,
  type Family,
  GOOGLE_ALERTS,
  GOOGLE_BASE,
  HIRING_CLAUSE,
  LINKEDIN_BASE,
  ROLE_PHRASES,
  clause,
  decodedParam,
  expectedHiringGroups,
  expectedStackGroups,
  hintTerms,
  rawParam,
  terms,
} from "../support/hiring-oracle.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * EPIC-0007 Phase 1, hiring-search-links.feature r2 (@phase1 scenarios a browser
 * can exercise). Ship state: Phases 1, 2 and 3 (Gherkin r5 point 1; originally written for Phases 2 and 1, D3). Every Candidate's Job criteria
 * and Job Preferences are seeded in the isolated Postgres; links are read from
 * the rendered page and compared with support/hiring-oracle.ts (independent of
 * @eve/contracts) and the contract's literal AC 3.4 example. No first-party
 * response is stubbed; nothing is clicked that would leave Eve.
 */
let saved: Awaited<ReturnType<typeof snapshotHiringInputs>>
test.beforeAll(async () => {
  saved = await snapshotHiringInputs()
})
test.afterAll(async () => {
  await restoreHiringInputs(saved)
  await setPauses({ global: false, cost: false })
})

const FRONTEND = clause(ROLE_PHRASES.senior_frontend)
const BACKEND = clause(ROLE_PHRASES.backend)
const FULLSTACK = clause(ROLE_PHRASES.fullstack)

async function openAs(page: Page, email: string, params: Record<string, string> = {}): Promise<HiringLinksPage> {
  await signIn(page.context(), email)
  const hiring = new HiringLinksPage(page)
  await hiring.openWith(params)
  await expect(hiring.linksSection()).toBeVisible()
  return hiring
}

test.describe("PRD example (AC 3.2, 3.4, 3.5, 3.6)", () => {
  test.beforeEach(async () => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], technologies: ["TypeScript"], prefs: ALL_HINTS })
  })

  test("HSL-01 the LinkedIn link is the AC 3.4 example: base, decoded keywords, sortBy and datePosted with quotes", async ({ page }) => {
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    const [href] = await hiring.linkedinHrefs()
    expect(href!.startsWith(`${LINKEDIN_BASE}?`)).toBe(true)
    expect(decodedParam(href!, "keywords")).toBe(AC34_KEYWORDS)
    expect(decodedParam(href!, "sortBy")).toBe('"date_posted"')
    expect(decodedParam(href!, "datePosted")).toBe('"past-week"')
    expect(href).toBe(AC34_LINKEDIN)
  })

  test("HSL-02 the Google link is the AC 3.5 example: base, decoded q and tbs=qdr:w", async ({ page }) => {
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    const [href] = await hiring.googleHrefs()
    expect(href!.startsWith(`${GOOGLE_BASE}?`)).toBe(true)
    expect(decodedParam(href!, "q")).toBe(AC34_ALERTS)
    expect(decodedParam(href!, "tbs")).toBe("qdr:w")
    expect(href).toBe(AC34_GOOGLE)
  })

  test("HSL-03 one Google link per group and nothing points at linkedin.com/pulse", async ({ page }) => {
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    await expect(hiring.googleLinks(hiring.groups().first())).toHaveCount(1)
    const queries = await hiring.alertsQueries()
    const all = [...(await hiring.linkedinHrefs()), ...(await hiring.googleHrefs()), ...queries]
    for (const value of all) {
      expect(value).not.toContain("linkedin.com/pulse")
      expect(decodeURIComponent(value)).not.toContain("linkedin.com/pulse")
    }
  })

  test("HSL-04 exactly one plain-text query string, equal to the decoded Google q, with no https://, tbs or qdr:w", async ({ page }) => {
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    const queries = await hiring.alertsQueries()
    expect(queries).toEqual([AC34_ALERTS])
    expect(queries[0]).toBe(decodedParam((await hiring.googleHrefs())[0]!, "q"))
    for (const banned of ["https://", "tbs", "qdr:w"]) expect(queries[0]).not.toContain(banned)
  })
})

test.describe("Copy and Google Alerts (AC 3.6, 1.3)", () => {
  test("HSL-05 copying puts exactly the query on the clipboard and announces C-HP-LIVE-COPIED", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    await hiring.alertsToggles().first().click()
    const copy = hiring.copyButtons().first()
    await expect(copy).toHaveAccessibleName(LINKS_COPY.copySr("React"))
    await copy.click()
    const expected = `site:linkedin.com/posts ${HIRING_CLAUSE} ${FRONTEND} ("React")`
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected)
    await expect(hiring.linksSection().getByRole("status").filter({ hasText: LINKS_COPY.liveCopied })).toHaveCount(1)
    await expect(copy).toContainText(LINKS_COPY.copied)
  })

  test("HV-C2 a refused copy announces C-SP-COPY-ERR as an alert, selects the query and never says copied", async ({ page }) => {
    // Declared double: the browser's clipboard API is made to refuse (a browser capability, not a first-party response).
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) } })
    })
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    await hiring.alertsToggles().first().click()
    await hiring.copyButtons().first().click()
    await expect(hiring.linksSection().getByRole("alert").filter({ hasText: LINKS_COPY.copyErr })).toBeVisible()
    await expect(hiring.linksSection().getByText(LINKS_COPY.liveCopied)).toHaveCount(0)
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(`site:linkedin.com/posts ${HIRING_CLAUSE} ${FRONTEND} ("React")`)
  })

  // HSL-06 retired in Phase 3 repair wave 1 (G-05, QA-P3-T-01): Gherkin r5 point 1 removed the old
  // HSL:96 "Before Phase 3 ships…" and C-HP-ALERTQ-HOWTO is not shown in this build. The instruction
  // text (C-HP-ALERTQ-HOWTO-FEEDS and its in-page link, HSL:89 r5) is OUT3-02 in
  // tests/outbound-and-separation.phase3.spec.ts. HSL-06b keeps the link check of HSL:82 r5.
  test("HSL-06b (HSL:82 r5) the disclosure has \"Open Google Alerts\" to google.com/alerts in a new tab with noopener noreferrer", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await hiring.alertsToggles().first().click()
    const open = hiring.linksSection().getByRole("link", { name: new RegExp(`^${LINKS_COPY.alertsOpen}`) })
    await expect(open).toHaveAttribute("href", GOOGLE_ALERTS)
    await expect(open).toHaveAttribute("target", "_blank")
    await expect(open).toHaveAttribute("rel", "noopener noreferrer")
  })
})

test.describe("Role title phrases (AC 2.1)", () => {
  for (const [family, label] of FAMILIES.filter(([key]) => key !== "other")) {
    test(`HSL-07 ${label} uses its fixed phrases as the role clause`, async ({ page }) => {
      await setHiringInputs(ADA.email, { families: [family], frameworks: ["React"], prefs: null })
      const hiring = await openAs(page, ADA.email)
      await hiring.waitForGroups(1)
      expect(await hiring.alertsQueries()).toEqual([`site:linkedin.com/posts ${HIRING_CLAUSE} ${clause(ROLE_PHRASES[family])} ("React")`])
    })
  }

  test("HSL-08 the phrase table is shared: Ada and Bola targeting Fullstack get the same role clause", async ({ page, browser }) => {
    await setHiringInputs(ADA.email, { families: ["fullstack"], frameworks: ["React"], prefs: null })
    await setHiringInputs(BOLA.email, { families: ["fullstack"], frameworks: ["Django"], prefs: null })
    const ada = await openAs(page, ADA.email, { family: "fullstack" })
    const bolaPage = await (await browser.newContext()).newPage()
    const bola = await openAs(bolaPage, BOLA.email, { family: "fullstack" })
    for (const view of [ada, bola]) {
      const keywords = decodedParam((await view.linkedinHrefs())[0]!, "keywords")!
      expect(keywords.split(" AND ")[1]).toBe(FULLSTACK)
    }
    await bolaPage.context().close()
  })

  test("HSL-09 the Hiring view offers no control to change a role title phrase", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.linksSection().getByRole("textbox")).toHaveCount(0)
    await expect(hiring.linksSection().getByRole("button", { name: /phrase|title/i })).toHaveCount(0)
  })
})

test.describe("Family choice (AC 2.2)", () => {
  test("HSL-10 the choice lists target families with phrases in EPIC-0006 order; Other is not offered", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["backend", "senior_frontend", "other", "fullstack"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    expect(await hiring.familyOptions()).toEqual(["Frontend", "Fullstack", "Backend"])
  })

  test("HSL-11 with no family value the first family in display order is selected", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["backend", "fullstack"], frameworks: ["React"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.familySelect()).toHaveValue("fullstack")
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!.split(" AND ")[1]).toBe(FULLSTACK)
  })

  test("HSL-12 choosing a family sets family=<key> with history replace, keeps view=hiring, rebuilds the groups and sends no request", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "backend"], frameworks: ["React"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    await page.waitForLoadState("networkidle")
    const historyBefore = await page.evaluate(() => history.length)
    const requests = recordRequests(page)
    await hiring.familySelect().selectOption("backend")
    await expect(page).toHaveURL(/[?&]family=backend(&|$)/)
    // EPIC-0011 FJ: Find jobs is one screen with no tabs, so no view param; the family choice keeps the page.
    expect(new URL(page.url()).pathname).toBe("/find-jobs")
    await expect.poll(async () => decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!.split(" AND ")[1]).toBe(BACKEND)
    for (const href of await hiring.linkedinHrefs()) expect(decodedParam(href, "keywords")).toContain(BACKEND)
    await expect(page.getByRole("status").filter({ hasText: LINKS_COPY.liveFamily("Backend") })).toHaveCount(1)
    await page.waitForTimeout(500)
    expect(requests.map((r) => r.url())).toEqual([])
    expect(await page.evaluate(() => history.length)).toBe(historyBefore)
  })

  test("HSL-13 opening ?family=fullstack shows Fullstack", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "fullstack"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email, { family: "fullstack" })
    await expect(hiring.familySelect()).toHaveValue("fullstack")
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")).toContain(FULLSTACK)
  })

  test("HSL-14 switching families twice makes no request to the Eve API or to any other host", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "fullstack", "backend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    await page.waitForLoadState("networkidle")
    const requests = recordRequests(page)
    await hiring.familySelect().selectOption("fullstack")
    await expect(page).toHaveURL(/family=fullstack/)
    await hiring.familySelect().selectOption("backend")
    await expect(page).toHaveURL(/family=backend/)
    await page.waitForTimeout(500)
    expect(requests.map((r) => `${r.method()} ${r.url()}`)).toEqual([])
  })

  test("HSL-15 the family choice is not saved: opening the view from the view choice selects the first family", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "backend"], frameworks: ["React"] })
    const before = await databaseFingerprint()
    const hiring = await openAs(page, ADA.email)
    await hiring.familySelect().selectOption("backend")
    await expect(page).toHaveURL(/family=backend/)
    // Leaving and returning to Find jobs without the query forgets the choice (the Role family lives in the URL only).
    await page.goto("/find-jobs")
    await hiring.waitUntilReady()
    await expect(hiring.familySelect()).toHaveValue("senior_frontend")
    expect(new URL(page.url()).searchParams.get("family")).toBeNull()
    expect(await databaseFingerprint()).toEqual(before)
  })

  for (const raw of ["", "mobile", "other", "Fullstack", "frontend_senior", "senior_frontend%20", "%3Cscript%3E"]) {
    test(`HSL-16 family=${raw === "" ? '""' : raw} falls back to Fullstack with no error`, async ({ page }) => {
      await setHiringInputs(ADA.email, { families: ["fullstack", "backend", "other"], frameworks: ["React"] })
      await signIn(page.context(), ADA.email)
      const hiring = new HiringLinksPage(page)
      await hiring.openRaw(`view=hiring&family=${raw}`)
      await expect(hiring.familySelect()).toHaveValue("fullstack")
      await expect(page.getByRole("alert")).toHaveCount(0)
    })
  }

  test("HSL-17 a single target family with phrases is shown as a static line, not a select", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "other"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.familySelect()).toHaveCount(0)
    await expect(hiring.linksSection().getByText(LINKS_COPY.familySingle("Frontend"), { exact: true })).toBeVisible()
  })

  test("HSL-18 all 13 targeted: 12 families offered in display order, Other not offered", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: FAMILIES.map(([key]) => key), frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    expect(await hiring.familyOptions()).toEqual(FAMILIES.filter(([key]) => key !== "other").map(([, label]) => label))
  })

  test("HSL-19 a bookmarked family that is no longer targeted falls back on the next load", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "backend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email, { family: "backend" })
    await expect(hiring.familySelect()).toHaveValue("backend")
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    await hiring.openWith({ family: "backend" })
    await expect(hiring.linksSection().getByText(LINKS_COPY.familySingle("Frontend"), { exact: true })).toBeVisible()
    for (const href of await hiring.linkedinHrefs()) expect(decodedParam(href, "keywords")).not.toContain("backend engineer")
  })
})

test.describe("Technology groups of 4 (AC 2.3, D4)", () => {
  test("HSL-20 terms are Frameworks then Technologies in saved order and entered form", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["nestjs", "React"], technologies: ["postgreSQL", "AWS"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!.split(" AND ")[2]).toBe('("nestjs" OR "React" OR "postgreSQL" OR "AWS")')
  })

  test("HSL-21 a group is labelled by its terms joined with \", \"", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React", "Next.js"], technologies: ["TypeScript"] })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    await expect(hiring.groups().first()).toContainText("React, Next.js, TypeScript")
    await expect(hiring.linkedinLinks().first()).toHaveAccessibleName(LINKS_COPY.linkLiSr("Frontend", "React, Next.js, TypeScript"))
    await expect(hiring.googleLinks().first()).toHaveAccessibleName(LINKS_COPY.linkGSr("Frontend", "React, Next.js, TypeScript"))
  })

  test("HSL-22 20 frameworks + 5 technologies: 7 hiring groups (6×4 + 1) while the Stack posts view keeps 4 groups of 8", async ({ page }) => {
    const frameworks = terms("F", 20)
    const technologies = terms("T", 5)
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks, technologies, prefs: null })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(7)
    const expected = expectedHiringGroups({ family: "senior_frontend", frameworks, technologies, hints: [] })
    expect(expected.map((g) => g.terms.length)).toEqual([4, 4, 4, 4, 4, 4, 1])
    expect(await hiring.linkedinHrefs()).toEqual(expected.map((g) => g.linkedin))
    await hiring.open(null)
    const stack = page.getByRole("region", { name: "Search links", exact: true })
    await expect(stack.getByRole("link", { name: /^LinkedIn posts/ })).toHaveCount(4)
  })

  const splits: [number, number, number, number][] = [
    [1, 0, 1, 1],
    [0, 1, 1, 1],
    [4, 0, 1, 4],
    [5, 0, 2, 1],
    [3, 2, 2, 1],
    [2, 2, 1, 4],
    [20, 19, 10, 3],
    [20, 20, 10, 4],
  ]
  for (const [nf, nt, groups, last] of splits) {
    test(`HSL-23 ${nf} frameworks + ${nt} technologies give ${groups} groups, the last holding ${last}`, async ({ page }) => {
      const frameworks = terms("F", nf)
      const technologies = terms("T", nt)
      await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks, technologies, prefs: ALL_HINTS })
      const hiring = await openAs(page, ADA.email)
      await hiring.waitForGroups(groups)
      const expected = expectedHiringGroups({ family: "senior_frontend", frameworks, technologies, hints: hintTerms(ALL_HINTS) })
      expect(expected.at(-1)!.terms).toHaveLength(last)
      for (let i = 0; i < groups; i += 1) {
        const row = hiring.groups().nth(i)
        await expect(hiring.linkedinLinks(row)).toHaveCount(1)
        await expect(hiring.googleLinks(row)).toHaveCount(1)
      }
      expect(await hiring.linkedinHrefs()).toEqual(expected.map((g) => g.linkedin))
      expect(await hiring.googleHrefs()).toEqual(expected.map((g) => g.google))
      expect(await hiring.alertsQueries()).toEqual(expected.map((g) => g.alertsQuery))
      if (groups > 1) await expect(hiring.groups().first()).toContainText(new RegExp(LINKS_COPY.groupN(1, groups), "i"))
    })
  }

  test("HSL-24 a group can span the Frameworks/Technologies boundary", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React", "Next.js", "Vue"], technologies: ["TypeScript", "GraphQL"] })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(2)
    await expect(hiring.groups().nth(0)).toContainText("React, Next.js, Vue, TypeScript")
    await expect(hiring.linkedinLinks(hiring.groups().nth(1))).toHaveAccessibleName(LINKS_COPY.linkLiSr("Frontend", "GraphQL"))
  })

  test("HSL-25 every group repeats the hiring, role and hint clauses", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: terms("F", 5), prefs: { remoteAccepted: true, relocationAccepted: false, sponsorshipNeededForRelocation: false } })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(2)
    for (const href of await hiring.linkedinHrefs()) {
      const keywords = decodedParam(href, "keywords")!
      expect(keywords.startsWith(`${HIRING_CLAUSE} AND ${FRONTEND}`)).toBe(true)
      expect(keywords.endsWith(' AND ("remote")')).toBe(true)
    }
  })

  test("HSL-26 a term with spaces stays one quoted term", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: [], technologies: ["Google Cloud", "React Native"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!.split(" AND ")[2]).toBe('("Google Cloud" OR "React Native")')
  })
})

test.describe("Hiring phrases and hint terms (AC 2.4, 2.5, 2.6)", () => {
  test("HSL-27 every expression starts with the hiring clause, for Frontend and Backend", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend", "backend"], frameworks: ["React"] })
    for (const family of ["senior_frontend", "backend"]) {
      const hiring = await openAs(page, ADA.email, { family })
      await hiring.waitForGroups(1)
      expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!.startsWith(`${HIRING_CLAUSE} AND `)).toBe(true)
      expect(decodedParam((await hiring.googleHrefs())[0]!, "q")!.startsWith(`site:linkedin.com/posts ${HIRING_CLAUSE} `)).toBe(true)
      expect((await hiring.alertsQueries())[0]!.startsWith(`site:linkedin.com/posts ${HIRING_CLAUSE} `)).toBe(true)
    }
  })

  test("HSL-28 no expression excludes hiring posts (NOT hiring, -hiring, -job, NOT) at 40 terms with all hints", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: terms("F", 20), technologies: terms("T", 20), prefs: ALL_HINTS })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(10)
    const values = [
      ...(await hiring.linkedinHrefs()).map((h) => decodedParam(h, "keywords")!),
      ...(await hiring.googleHrefs()).map((h) => decodedParam(h, "q")!),
      ...(await hiring.alertsQueries()),
    ]
    for (const value of values) for (const banned of ["NOT hiring", "-hiring", "-job", " NOT "]) expect(value).not.toContain(banned)
  })

  const outline: [boolean, boolean, boolean, string][] = [
    [true, true, true, ' ("React") ("remote" OR "relocation" OR "visa sponsorship")'],
    [true, true, false, ' ("React") ("remote" OR "relocation")'],
    [true, false, true, ' ("React") ("remote")'],
    [true, false, false, ' ("React") ("remote")'],
    [false, true, true, ' ("React") ("relocation" OR "visa sponsorship")'],
    [false, true, false, ' ("React") ("relocation")'],
    [false, false, true, ' ("React")'],
    [false, false, false, ' ("React")'],
  ]
  for (const [remote, relocation, sponsorship, ending] of outline) {
    test(`HSL-29 remote=${remote} relocation=${relocation} sponsorship=${sponsorship} ends the query with${ending}`, async ({ page }) => {
      await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: { remoteAccepted: remote, relocationAccepted: relocation, sponsorshipNeededForRelocation: sponsorship } })
      const hiring = await openAs(page, ADA.email)
      const [query] = await hiring.alertsQueries()
      expect(query).toBe(`site:linkedin.com/posts ${HIRING_CLAUSE} ${FRONTEND}${ending}`)
    })
  }

  test("HSL-30 the fact list shows the family's job titles and the hint terms; none is labelled as an Eligibility result", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: ALL_HINTS })
    const hiring = await openAs(page, ADA.email)
    const section = hiring.linksSection()
    await expect(section.getByText(LINKS_COPY.titlesLabel, { exact: true })).toBeVisible()
    await expect(section.getByText('"frontend engineer", "frontend developer", "front-end engineer"', { exact: true })).toBeVisible()
    await expect(section.getByText(LINKS_COPY.hintsLabel, { exact: true })).toBeVisible()
    await expect(section.getByText("remote, relocation, visa sponsorship", { exact: true })).toBeVisible()
    await expect(section).not.toContainText(/\b(eligible|met|unverified|violated)\b/i)
  })

  test("HSL-31 with no Job Preferences there is no hint clause and no \"Plus any of\" fact", async ({ page }) => {
    await setHiringInputs(BOLA.email, { families: ["backend"], frameworks: ["Django"], prefs: null })
    const hiring = await openAs(page, BOLA.email)
    const keywords = decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!
    expect(keywords.endsWith(' AND ("Django")')).toBe(true)
    const all = [keywords, decodedParam((await hiring.googleHrefs())[0]!, "q")!, ...(await hiring.alertsQueries())]
    for (const value of all) for (const word of ["remote", "relocation", "visa sponsorship"]) expect(value).not.toContain(word)
    await expect(hiring.linksSection().getByText(LINKS_COPY.hintsLabel, { exact: true })).toHaveCount(0)
  })

  test("HSL-32 pay floor, hours, excluded countries and industries, employment types and seniority add no terms", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: { remoteAccepted: false, relocationAccepted: false, sponsorshipNeededForRelocation: false } })
    // The other Job Preferences keys stay as migration 0018 stored them (pay floor, hours, excluded countries/industries, employment types incl. "contract").
    const hiring = await openAs(page, ADA.email)
    const [query] = await hiring.alertsQueries()
    expect(query).toBe(`site:linkedin.com/posts ${HIRING_CLAUSE} ${FRONTEND} ("React")`)
    const all = [query!, decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!, decodedParam((await hiring.googleHrefs())[0]!, "q")!]
    for (const value of all) for (const word of ["2000", "80000", "full-time", "Russia", "Gambling", "gambling", "contract", "senior", "intern", "junior"]) expect(value).not.toContain(word)
  })
})

test.describe("Clause rules and empty technology lists (AC 3.2, 3.3)", () => {
  test("HSL-33 clauses are in the order hiring, role, technology, hint", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["backend"], technologies: ["Go"], prefs: { remoteAccepted: false, relocationAccepted: true, sponsorshipNeededForRelocation: false } })
    const hiring = await openAs(page, ADA.email)
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")).toBe(`${HIRING_CLAUSE} AND ${BACKEND} AND ("Go") AND ("relocation")`)
  })

  test("HSL-34 a single-phrase family gives a quoted, parenthesised single-term clause", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["product_engineering"], frameworks: ["React"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")).toBe(`${HIRING_CLAUSE} AND ("product engineer") AND ("React")`)
  })

  test("HSL-35 both lists empty: exactly one \"Any technology\" group with no technology clause, and the C-HP-ANYTECH-NOTE linking to Settings", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: [], technologies: [], prefs: { remoteAccepted: true, relocationAccepted: false, sponsorshipNeededForRelocation: false } })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    await expect(hiring.groups().first()).toContainText(LINKS_COPY.groupAny)
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")).toBe(`${HIRING_CLAUSE} AND ${FRONTEND} AND ("remote")`)
    expect(await hiring.alertsQueries()).toEqual([`site:linkedin.com/posts ${HIRING_CLAUSE} ${FRONTEND} ("remote")`])
    // QA-P1-T-06: the note's paragraph also holds the C-HP-ANYTECH-NOTE-LINK link, so its text is note + " " + link.
    const note = hiring.linksSection().locator("p").filter({ hasText: LINKS_COPY.anyTechNote })
    await expect(note).toHaveCount(1)
    await expect(note).toHaveText(`${LINKS_COPY.anyTechNote} ${LINKS_COPY.anyTechLink}`)
    await expect(note.getByRole("link", { name: LINKS_COPY.anyTechLink, exact: true })).toHaveAttribute("href", JOB_CRITERIA_HREF)
  })

  test("HSL-36 no technologies and no Job Preferences: hiring and role clauses only", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: [], technologies: [], prefs: null })
    const hiring = await openAs(page, ADA.email)
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")).toBe(`${HIRING_CLAUSE} AND ${FRONTEND}`)
  })
})

test.describe("Encoding (AC 3.4, 3.5, 3.6, 3.9)", () => {
  for (const [term, rawChar, encoded] of [
    ["C#", "#", "%23"],
    ["C++", "+", "%2B"],
    ["CI/CD", "/", "%2F"],
    [".NET", '"', "%22"],
  ] as const) {
    test(`HSL-37 "${term}" survives encoding: raw keywords contain ${encoded} and no literal ${rawChar}`, async ({ page }) => {
      await setHiringInputs(ADA.email, { families: ["software_engineering"], frameworks: [], technologies: [term], prefs: null })
      const hiring = await openAs(page, ADA.email)
      const li = (await hiring.linkedinHrefs())[0]!
      const raw = rawParam(li, "keywords")!
      expect(raw).toContain(encoded)
      expect(raw).not.toContain(rawChar)
      const role = clause(ROLE_PHRASES.software_engineering)
      expect(decodedParam(li, "keywords")).toBe(`${HIRING_CLAUSE} AND ${role} AND ("${term}")`)
      expect(decodedParam((await hiring.googleHrefs())[0]!, "q")).toBe(`site:linkedin.com/posts ${HIRING_CLAUSE} ${role} ("${term}")`)
    })
  }

  test("HSL-38 the apostrophe in \"we're hiring\" is %27 in the raw keywords and q; decoded is a straight apostrophe", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    const li = (await hiring.linkedinHrefs())[0]!
    const g = (await hiring.googleHrefs())[0]!
    for (const raw of [rawParam(li, "keywords")!, rawParam(g, "q")!]) {
      expect(raw).not.toContain("'")
      expect(raw).toContain("%27")
    }
    expect(decodedParam(li, "keywords")).toContain("we're hiring")
    expect(decodedParam(g, "q")).toContain("we're hiring")
  })

  test("HSL-39 raw sortBy is %22date_posted%22 and raw datePosted is %22past-week%22", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    const li = (await hiring.linkedinHrefs())[0]!
    expect(rawParam(li, "sortBy")).toBe("%22date_posted%22")
    expect(rawParam(li, "datePosted")).toBe("%22past-week%22")
  })

  test("HSL-40 the Alerts query string shows terms unencoded", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["software_engineering"], frameworks: [], technologies: ["C#", "CI/CD"], prefs: null })
    const hiring = await openAs(page, ADA.email)
    expect(await hiring.alertsQueries()).toEqual([`site:linkedin.com/posts ${HIRING_CLAUSE} ${clause(ROLE_PHRASES.software_engineering)} ("C#" OR "CI/CD")`])
  })
})

test.describe("Stack posts unchanged (AC 3.1)", () => {
  test("HSL-41 Stack posts links equal the EPIC-0005 links byte for byte and keep NOT hiring / -hiring -job", async ({ page }) => {
    const frameworks = ["React", "Next.js"]
    const technologies = ["TypeScript"]
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks, technologies })
    await signIn(page.context(), ADA.email)
    const hiring = new HiringLinksPage(page)
    await hiring.open(null)
    const stack = page.getByRole("region", { name: "Search links", exact: true })
    const hrefs = (name: RegExp) => stack.getByRole("link", { name }).evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""))
    const [expected] = expectedStackGroups(frameworks, technologies)
    await expect(stack.getByRole("link", { name: /^LinkedIn posts/ })).toHaveCount(1)
    expect(await hrefs(/^LinkedIn posts/)).toEqual([expected!.linkedin])
    expect(await hrefs(/^Google posts/)).toEqual([expected!.googlePosts])
    expect(await hrefs(/^Google articles/)).toEqual([expected!.googleArticles])
    expect(decodedParam(expected!.linkedin, "keywords")!.endsWith("NOT hiring")).toBe(true)
    expect(decodedParam(expected!.googlePosts, "q")!.endsWith("-hiring -job")).toBe(true)
  })
})

test.describe("Freshness (AC 3.8)", () => {
  async function saveCriteria(page: Page, csrfToken: string, change: { frameworks?: string[]; targetRoleFamilies?: Family[] }): Promise<void> {
    const current = await (await page.request.get("/v1/candidate-settings/job-criteria")).json()
    const body = {
      minCoreMatchPercent: current.minCoreMatchPercent,
      frameworks: change.frameworks ?? current.frameworks,
      technologies: current.technologies,
      targetRoleFamilies: change.targetRoleFamilies ?? current.targetRoleFamilies,
      seniorityFloor: current.seniorityFloor,
    }
    const response = await page.request.put("/v1/candidate-settings/job-criteria", { data: body, headers: { [CSRF_HEADER]: csrfToken } })
    expect(response.status(), await response.text()).toBe(200)
  }

  const REMOTE_ONLY = { remoteAccepted: true, relocationAccepted: false, sponsorshipNeededForRelocation: false }

  test("HSL-42a after saving frameworks \"Vue\" the next load shows one group \"Vue\"", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: REMOTE_ONLY })
    const session = await signIn(page.context(), ADA.email)
    const hiring = new HiringLinksPage(page)
    await hiring.openWith()
    await hiring.waitForGroups(1)
    await saveCriteria(page, session.csrfToken, { frameworks: ["Vue"] })
    await hiring.openWith()
    await hiring.waitForGroups(1)
    await expect(hiring.linkedinLinks().first()).toHaveAccessibleName(LINKS_COPY.linkLiSr("Frontend", "Vue"))
  })

  test("HSL-42b after saving target families Backend only the role clause is the Backend clause", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: REMOTE_ONLY })
    const session = await signIn(page.context(), ADA.email)
    const hiring = new HiringLinksPage(page)
    await hiring.openWith()
    await hiring.waitForGroups(1)
    await saveCriteria(page, session.csrfToken, { targetRoleFamilies: ["backend"] })
    await hiring.openWith()
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!.split(" AND ")[1]).toBe(BACKEND)
  })

  test("HSL-42c after Job Preferences change to relocation only the hint clause is (\"relocation\")", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: REMOTE_ONLY })
    const hiring = await openAs(page, ADA.email)
    await hiring.waitForGroups(1)
    // No Job Preferences save route exists before EPIC-0002 B1; the change is written as that save would store it.
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], prefs: { remoteAccepted: false, relocationAccepted: true, sponsorshipNeededForRelocation: false } })
    await hiring.openWith()
    expect(decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")!.endsWith(' AND ("relocation")')).toBe(true)
  })

  test("HSL-43 an open tab keeps the values it loaded with until reloaded", async ({ page, context }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
    const session = await signIn(context, ADA.email)
    const tabA = new HiringLinksPage(page)
    await tabA.openWith()
    await expect(tabA.linkedinLinks().first()).toHaveAccessibleName(LINKS_COPY.linkLiSr("Frontend", "React"))
    const tabB = await context.newPage()
    await tabB.goto("/settings")
    await saveCriteria(tabB, session.csrfToken, { frameworks: ["Vue"] })
    await page.waitForTimeout(1000)
    await expect(tabA.linkedinLinks().first()).toHaveAccessibleName(LINKS_COPY.linkLiSr("Frontend", "React"))
    await page.reload()
    await tabA.waitUntilReady()
    await expect(tabA.linkedinLinks().first()).toHaveAccessibleName(LINKS_COPY.linkLiSr("Frontend", "Vue"))
  })

  test("HSL-44 a load during a save shows the old or the new values, never a mix", async ({ page, context }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React", "Vue"], prefs: null })
    const session = await signIn(context, ADA.email)
    const other = await context.newPage()
    await other.goto("/settings")
    const hiring = new HiringLinksPage(page)
    await Promise.all([saveCriteria(other, session.csrfToken, { frameworks: ["Svelte"], targetRoleFamilies: ["backend"] }), hiring.openWith()])
    await hiring.waitForGroups(1)
    const keywords = decodedParam((await hiring.linkedinHrefs())[0]!, "keywords")
    expect([`${HIRING_CLAUSE} AND ${FRONTEND} AND ("React" OR "Vue")`, `${HIRING_CLAUSE} AND ${BACKEND} AND ("Svelte")`]).toContain(keywords)
  })
})

test.describe("No-family empty state (AC 3.7)", () => {
  test("HSL-45 only Other targeted: title, body, \"Choose role families\" to Settings; no links, queries or family choice", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["other"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    const section = hiring.linksSection()
    await expect(section.getByText(LINKS_COPY.noFamilyTitle, { exact: true })).toBeVisible()
    await expect(section.getByText(LINKS_COPY.noFamilyBody, { exact: true })).toBeVisible()
    await expect(section.getByRole("link", { name: LINKS_COPY.noFamilyAction, exact: true })).toHaveAttribute("href", JOB_CRITERIA_HREF)
    await expect(hiring.linkedinLinks()).toHaveCount(0)
    await expect(hiring.googleLinks()).toHaveCount(0)
    await expect(hiring.alertsToggles()).toHaveCount(0)
    await expect(hiring.familySelect()).toHaveCount(0)
    await expect(section.getByText(LINKS_COPY.familySingle("Other"))).toHaveCount(0)
  })

  test("HSL-46 the empty-state link opens Settings at the Role families field of Job criteria", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["other"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await hiring.linksSection().getByRole("link", { name: LINKS_COPY.noFamilyAction, exact: true }).click()
    await expect(page).toHaveURL(JOB_CRITERIA_HREF)
    await expect(page.getByRole("group", { name: /^Role families/ })).toBeVisible()
  })

  test("HSL-47 a family in the URL does not override the empty state", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["other"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email, { family: "senior_frontend" })
    await expect(hiring.linksSection().getByText(LINKS_COPY.noFamilyTitle, { exact: true })).toBeVisible()
    await expect(hiring.linkedinLinks()).toHaveCount(0)
  })

  test("HSL-48 no family and no technologies shows only the no-family empty state, not C-HP-ANYTECH-NOTE", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["other"], frameworks: [], technologies: [] })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.linksSection().getByText(LINKS_COPY.noFamilyTitle, { exact: true })).toBeVisible()
    await expect(page.getByText(LINKS_COPY.anyTechNote)).toHaveCount(0)
  })

  test("HSL-49 the no-family empty state keeps \"Check this job\" and its URL field", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["other"], frameworks: ["React"] })
    const hiring = await openAs(page, ADA.email)
    await expect(hiring.checkSection()).toBeVisible()
    await hiring.openCheck()
    await expect(hiring.urlField()).toBeVisible()
  })
})

test.describe("Build, never fetch (AC 3.9)", () => {
  test("HSL-50 loading the Hiring view twice shows identical links and writes nothing", async ({ page }) => {
    await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"], technologies: ["TypeScript"] })
    await signIn(page.context(), ADA.email)
    const before = await databaseFingerprint()
    const hiring = new HiringLinksPage(page)
    const snapshots: string[][] = []
    for (let i = 0; i < 2; i += 1) {
      await hiring.openWith()
      await hiring.waitForGroups(1)
      snapshots.push([...(await hiring.linkedinHrefs()), ...(await hiring.googleHrefs()), ...(await hiring.alertsQueries())])
    }
    expect(snapshots[1]).toEqual(snapshots[0])
    expect(await databaseFingerprint()).toEqual(before)
  })

  for (const [name, arrange] of [
    ["without a recorded Alert feed verification", () => clearAlertFeedVerification()],
    ["during a cost-ceiling pause", () => setPauses({ global: false, cost: true })],
    ["during a global pause", () => setPauses({ global: true, cost: false })],
  ] as const) {
    test(`HSL-51 hiring links are shown ${name}`, async ({ page }) => {
      await setHiringInputs(ADA.email, { families: ["senior_frontend"], frameworks: ["React"] })
      await arrange()
      try {
        const hiring = await openAs(page, ADA.email)
        await hiring.waitForGroups(1)
        await expect(hiring.linkedinLinks()).toHaveCount(1)
        await expect(hiring.googleLinks()).toHaveCount(1)
        expect(await hiring.alertsQueries()).toHaveLength(1)
      } finally {
        await setPauses({ global: false, cost: false })
      }
    })
  }
})
