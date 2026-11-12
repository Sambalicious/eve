import { type Page, expect, test } from "@playwright/test"

import { signIn } from "../support/db.ts"
import { E11, HIDDEN_ROUTES, SIDEBAR_NAV } from "../support/epic-0011-copy.ts"
import { ensureProfileInUse, countRows, deleteAdvanced, readAdvanced, readAutomatic, resetEpic11, seedApplication, setAdvanced, setAutomatic, setGlobalPause } from "../support/epic-0011-db.ts"
import { failRequests, holdRequests } from "../support/network-faults.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * QA test authoring, EPIC-0011 e2e: navigation and the Advanced switch.
 * Gherkin: navigation.r1.feature NAV:24 to NAV:177; advanced-switch.r1.feature ADV:17 to ADV:194.
 * Ada plays "tolu@example.com" (the Operator), Bola plays "bisi@example.com" (invited non-Operator).
 * Strings come from support/epic-0011-copy.ts only (the copy deck is a PROPOSAL until the owner reviews it).
 * Expected red until the feature is built.
 */
const sidebar = (page: Page) => page.locator(SIDEBAR_NAV).first()
const navLink = (page: Page, name: string) => sidebar(page).getByRole("link", { name: new RegExp(`^${name}`) })

async function navLabels(page: Page): Promise<string[]> {
  const labels = await sidebar(page).getByRole("link").allInnerTexts()
  return labels.map((text) => text.replace(/\s+\d+$/, "").trim()).filter(Boolean)
}

async function openHome(page: Page) {
  await page.goto("/dashboard")
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible()
}

test.beforeEach(async () => {
  await resetEpic11()
  await setGlobalPause(false)
  for (const email of [ADA.email, BOLA.email]) await setAutomatic(email, false)
  await setAdvanced(ADA.email, true)
  await setAdvanced(BOLA.email, false)
  await ensureProfileInUse(ADA.email)
  await ensureProfileInUse(BOLA.email)
})

test.afterAll(async () => {
  await resetEpic11()
  await setAutomatic(ADA.email, false)
  await setAdvanced(ADA.email, true)
})

test.describe("navigation (AC-3.2, AC-3.2a, OQ-8)", () => {
  test("NAV:24 Advanced off: the nav lists exactly the six items in order, with no group heading", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await openHome(page)
    await expect.poll(() => navLabels(page)).toEqual([...E11.navDefault])
    await expect(sidebar(page).getByText(E11.navGroup, { exact: true })).toHaveCount(0)
    await expect(sidebar(page).getByText(E11.needsYou)).toHaveCount(0)
  })

  test("NAV:33 Advanced on: the six items plus the Automatic applying group, at most 5 items, each opening its page", async ({ page, context }) => {
    await signIn(context, ADA.email)
    await openHome(page)
    await expect(sidebar(page).getByText(E11.navGroup, { exact: true })).toBeVisible()
    for (const label of E11.navDefault) await expect(navLink(page, label)).toBeVisible()
    const group = [E11.navGate, E11.navBlocked, E11.navUncertain, E11.navFormAnswers, E11.navPauseCost]
    for (const label of group) await expect(navLink(page, label)).toBeVisible()
    expect((await navLabels(page)).filter((l) => !(E11.navDefault as readonly string[]).includes(l))).toEqual(group)
    for (const [label, route] of [[E11.navGate, "/activation"], [E11.navBlocked, "/blocked"], [E11.navUncertain, "/uncertain"], [E11.navFormAnswers, "/answers"]] as const) {
      await navLink(page, label).click()
      await expect(page).toHaveURL(new RegExp(`${route}$`))
      await expect(page.getByText(E11.hiddenNote)).toHaveCount(0)
    }
    await navLink(page, E11.navPauseCost).click()
    await expect(page.getByRole("heading", { level: 1, name: E11.navPauseCost })).toBeVisible()
    await expect(page.getByText(/Monthly cost/i).first()).toBeVisible()
  })

  test("NAV:98 each default nav item opens its page", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await openHome(page)
    for (const [label, route] of [["Jobs", "/postings"], ["Applications", "/applications"], ["Profile", "/profile"], ["Settings", "/settings"], ["Home", "/dashboard"]] as const) {
      await navLink(page, label).click()
      await expect(page).toHaveURL(new RegExp(`${route}$`))
    }
    await navLink(page, "Find jobs").click()
    await expect(page.getByRole("heading", { level: 1, name: E11.findTitle })).toBeVisible()
  })

  for (const advanced of [false, true]) {
    test(`NAV:77 Documents, Job Sources, Stack posts and Existing applications are not in the nav with Advanced ${advanced ? "on" : "off"}`, async ({ page, context }) => {
      await setAdvanced(ADA.email, advanced)
      await signIn(context, ADA.email)
      await openHome(page)
      await expect.poll(() => navLabels(page)).not.toContain("Documents")
      for (const name of E11.navRemoved) await expect(sidebar(page).getByRole("link", { name: new RegExp(`^${name}$`, "i") })).toHaveCount(0)
    })
  }

  test("NAV:88 Data and privacy is in the account menu and on Settings, both linking to /privacy", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await openHome(page)
    // The account menu button is named by the user (here "Candidate"); it is the button in the sidebar footer.
    await page.locator('[data-sidebar="footer"]').getByRole("button").first().click()
    await expect(page.getByRole("menuitem", { name: E11.privacyLink }).or(page.getByRole("link", { name: E11.privacyLink }))).toHaveAttribute("href", /\/privacy$/)
    await page.keyboard.press("Escape")
    await page.goto("/settings")
    await expect(page.getByRole("link", { name: E11.privacyLink })).toHaveAttribute("href", /\/privacy$/)
  })

  test("NAV:177 a signed-out visitor to /dashboard is sent to sign in and sees no nav item", async ({ page }) => {
    await page.goto("/dashboard")
    await expect(page).not.toHaveURL(/\/dashboard$/)
    await expect(sidebar(page).getByRole("link", { name: "Applications" })).toHaveCount(0)
  })
})

test.describe("Needs you safety rule (AC-3.7)", () => {
  const kinds = [
    ["Blocked", { submissionState: "blocked", blockedReason: "captcha" }, "/blocked"],
    ["unsure (Uncertain)", { submissionState: "uncertain" }, "/uncertain"],
    ["a sample awaiting review", { sampleState: "awaiting_review" as const }, "/activation"],
  ] as const
  for (const [label, seed, route] of kinds) {
    test(`NAV:98 Advanced off + ${label}: the nav shows "Needs you" with count 1 and it reaches ${route}`, async ({ page, context }) => {
      await seedApplication(ADA.email, { company: "Needs", ...seed })
      await setAdvanced(ADA.email, false)
      // Samples awaiting review count toward Needs you only while the Activation Gate is pending (unchanged rule,
      // use-needs-you-badges.ts on main); beforeEach leaves the gate passed, so a sample row needs a pending gate.
      if ("sampleState" in seed) await setAutomatic(ADA.email, false, false)
      await signIn(context, ADA.email)
      await openHome(page)
      const entry = sidebar(page).getByRole("link", { name: new RegExp(E11.needsYou) })
      await expect(entry).toBeVisible()
      await expect(entry).toContainText("1")
      await entry.click()
      // NAV:177 / owner decision: Needs you opens the real page with its items visible. The page may also carry the
      // hidden-route note (Gherkin does not exclude it; ADV:148 shows the same page from an email link).
      await expect(page).toHaveURL(new RegExp(`${route}$`))
      await expect(page.getByText("E11 Needs").first()).toBeVisible()
      await expect.poll(() => navLabels(page).then((l) => l.filter((x) => !(E11.navDefault as readonly string[]).includes(x) && !x.startsWith(E11.needsYou)))).toEqual([])
      expect((await readAdvanced(ADA.email))?.advanced).toBe(false)
    })
  }

  test("NAV:122 Needs you counts every kind together and is absent when nothing needs the user", async ({ page, context }) => {
    await setAdvanced(ADA.email, false)
    await setAutomatic(ADA.email, false, false) // gate pending, so the sample counts (see NAV:98)
    await signIn(context, ADA.email)
    await openHome(page)
    await expect(sidebar(page).getByText(E11.needsYou)).toHaveCount(0)
    await seedApplication(ADA.email, { company: "A", submissionState: "blocked", blockedReason: "captcha" })
    await seedApplication(ADA.email, { company: "B", submissionState: "uncertain" })
    await seedApplication(ADA.email, { company: "C", sampleState: "awaiting_review" })
    await openHome(page)
    // With more than one kind the entry is a button that opens one row per kind (design-spec r1 shell); the count
    // is in its accessible name. NAV:114: the rows reach /blocked, /uncertain and /activation.
    const entry = sidebar(page).getByRole("button", { name: new RegExp(`^${E11.needsYou}\\b.*\\b3 items waiting`) })
    await expect(entry).toBeVisible()
    await expect.poll(() => navLabels(page).then((l) => l.length)).toBe(E11.navDefault.length)
    await entry.click()
    const hrefs = await sidebar(page).getByRole("link").evaluateAll((links) => links.map((a) => a.getAttribute("href")))
    for (const route of ["/blocked", "/uncertain", "/activation"]) expect(hrefs).toContain(route)
  })

  test("NAV:129x a Needs-you item that does not show for a non-Operator's ordinary Draft: a plain Draft never raises it", async ({ page, context }) => {
    await seedApplication(BOLA.email, { company: "Plain" })
    await signIn(context, BOLA.email)
    await openHome(page)
    await expect(sidebar(page).getByText(E11.needsYou)).toHaveCount(0)
  })
})

test.describe("first paint and read failure (AC-3.8)", () => {
  test("NAV:139 while the /v1/me read is held the nav never shows the Automatic applying group; after it, the six items", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    const held = await holdRequests(page, "/v1/me")
    await page.goto("/dashboard")
    await page.waitForTimeout(1_000)
    await expect(sidebar(page).getByText(E11.navGroup, { exact: true })).toHaveCount(0)
    await held.release()
    await expect.poll(() => navLabels(page)).toEqual([...E11.navDefault])
  })

  test("NAV:147 an Advanced-on user sees no item list until the flag is read, then the group", async ({ page, context }) => {
    await signIn(context, ADA.email)
    const held = await holdRequests(page, "/v1/me")
    await page.goto("/dashboard")
    await page.waitForTimeout(1_000)
    await expect(sidebar(page).getByRole("link", { name: "Applications" })).toHaveCount(0)
    await held.release()
    await expect(sidebar(page).getByText(E11.navGroup, { exact: true })).toBeVisible()
  })

  test("NAV:155 a failed /v1/me read falls back to the safe view with Needs you still shown", async ({ page, context }) => {
    await seedApplication(ADA.email, { company: "Safe", submissionState: "blocked", blockedReason: "captcha" })
    await signIn(context, ADA.email)
    const fault = await failRequests(page, "/v1/me", "GET")
    await page.goto("/dashboard")
    await expect.poll(() => fault.aborted()).toBeGreaterThan(0)
    await expect(sidebar(page).getByText(E11.navGroup, { exact: true })).toHaveCount(0)
    await expect(sidebar(page).getByRole("link", { name: "Applications" })).toBeVisible()
    await expect(sidebar(page).getByRole("link", { name: new RegExp(E11.needsYou) })).toContainText("1")
    await fault.stop()
  })
})

test.describe("the Advanced switch in Settings (AC-3.1, 3.4, 3.5, 3.8)", () => {
  const advancedSwitch = (page: Page) => page.getByRole("switch", { name: E11.switchLabel })

  test("ADV:17 Settings has the Advanced section with one switch, off for a new account", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await page.goto("/settings")
    await expect(page.getByRole("heading", { name: E11.advancedHeading })).toBeVisible()
    await expect(advancedSwitch(page)).toHaveAttribute("aria-checked", "false")
    await expect(page.getByRole("switch")).toHaveCount(1)
  })

  test("ADV:61 turning on reveals the group and persists on the server; turning off hides it again (visibility only)", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    const before = { applications: await countRows("application"), controls: await readAutomatic(BOLA.email) }
    await page.goto("/settings")
    await advancedSwitch(page).click()
    await expect(advancedSwitch(page)).toHaveAttribute("aria-checked", "true")
    await expect.poll(async () => (await readAdvanced(BOLA.email))?.advanced).toBe(true)
    await expect(sidebar(page).getByText(E11.navGroup, { exact: true })).toBeVisible()
    await page.reload()
    await expect(advancedSwitch(page)).toHaveAttribute("aria-checked", "true")
    await advancedSwitch(page).click()
    await expect(advancedSwitch(page)).toHaveAttribute("aria-checked", "false")
    await expect(sidebar(page).getByText(E11.navGroup, { exact: true })).toHaveCount(0)
    expect({ applications: await countRows("application"), controls: await readAutomatic(BOLA.email) }).toEqual(before)
  })

  test("ADV:154 the flag is per user on the server: a second browser context sees it on", async ({ page, context, browser }) => {
    await signIn(context, BOLA.email)
    await page.goto("/settings")
    await advancedSwitch(page).click()
    await expect.poll(async () => (await readAdvanced(BOLA.email))?.advanced).toBe(true)
    const other = await browser.newContext()
    await signIn(other, BOLA.email)
    const second = await other.newPage()
    await second.goto("/settings")
    await expect(second.getByRole("switch", { name: E11.switchLabel })).toHaveAttribute("aria-checked", "true")
    await other.close()
  })

  test("ADV:48 with automatic submission on, the Operator's switch is shown on, disabled, with the locked note and a link; off unlocks it", async ({ page, context }) => {
    await setAutomatic(ADA.email, true)
    await signIn(context, ADA.email)
    await page.goto("/settings")
    const toggle = advancedSwitch(page)
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await expect(toggle).toBeDisabled()
    await expect(page.getByText(E11.lockedNote)).toBeVisible()
    await page.getByRole("link", { name: E11.lockedLink }).click()
    await expect(page).toHaveURL(/\/pause-and-cost|\/activation|\/dashboard/)
    await setAutomatic(ADA.email, false)
    await page.goto("/settings")
    await expect(toggle).toBeEnabled()
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
  })

  test("ADV:86 / UPG:66 a non-Operator with automatic backend-seeded on is locked on the same way", async ({ page, context }) => {
    await setAdvanced(BOLA.email, true)
    await setAutomatic(BOLA.email, true)
    await signIn(context, BOLA.email)
    await page.goto("/settings")
    await expect(advancedSwitch(page)).toBeDisabled()
    await expect(advancedSwitch(page)).toHaveAttribute("aria-checked", "true")
    await expect(page.getByText(E11.lockedNote)).toBeVisible()
  })

  test("ADV:162 a failed write returns the switch to off and shows the could-not-save error", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    await page.goto("/settings")
    const fault = await failRequests(page, "/v1/me/advanced", "PUT")
    await advancedSwitch(page).click()
    await expect(page.getByText(E11.advancedError)).toBeVisible()
    await expect(advancedSwitch(page)).toHaveAttribute("aria-checked", "false")
    await fault.stop()
    expect((await readAdvanced(BOLA.email))?.advanced).toBe(false)
  })

  test("ADV:32 with Advanced off, none of the automation controls appear in the nav, Home or Settings", async ({ page, context }) => {
    await signIn(context, BOLA.email)
    for (const route of ["/dashboard", "/settings"]) {
      await page.goto(route)
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
      for (const text of E11.hiddenControls) await expect(page.getByText(new RegExp(text, "i")).filter({ visible: true })).toHaveCount(0)
      await expect(page.getByRole("switch", { name: /pause|automatic submission|sample/i })).toHaveCount(0)
    }
  })

  test("ADV:48 with Advanced on the controls are back: group, Pause and cost, Today's cap and Monthly cost are reachable", async ({ page, context }) => {
    await signIn(context, ADA.email)
    await openHome(page)
    await expect(navLink(page, E11.navPauseCost)).toBeVisible()
    await navLink(page, E11.navPauseCost).click()
    await expect(page.getByText(/Monthly cost/i).first()).toBeVisible()
    await expect(page.getByRole("switch", { name: /pause/i }).or(page.getByRole("button", { name: /pause/i })).first()).toBeVisible()
  })
})

test.describe("hidden routes (AC-3.6)", () => {
  for (const route of HIDDEN_ROUTES) {
    test(`ADV:125 ${route} loads with the note and Turn on Advanced while Advanced is off`, async ({ page, context }) => {
      await signIn(context, BOLA.email)
      const response = await page.goto(route)
      expect(response?.status()).toBeLessThan(400)
      await expect(page.getByText(E11.hiddenNote)).toBeVisible()
      await expect(page.getByRole("button", { name: E11.hiddenTurnOn })).toBeVisible()
    })
  }

  test("ADV:141 (Operator) Turn on Advanced from /blocked reveals the page content and turns the flag on", async ({ page, context }) => {
    await setAdvanced(ADA.email, false)
    await seedApplication(ADA.email, { company: "Hidden Blocked", submissionState: "blocked", blockedReason: "captcha" })
    await signIn(context, ADA.email)
    await page.goto("/blocked")
    await page.getByRole("button", { name: E11.hiddenTurnOn }).click()
    await expect(page.getByText(E11.hiddenNote)).toHaveCount(0)
    await expect(page.getByText("E11 Hidden Blocked").first()).toBeVisible()
    expect((await readAdvanced(ADA.email))?.advanced).toBe(true)
  })

  // F-02 decision (FE wave 3): a non-Operator cannot use automation pages yet, so after Turn on Advanced they see one plain
  // "isn't available on your account yet" note instead of the page content and no load error.
  test("ADV:141 (non-Operator) Turn on Advanced from /blocked turns the flag on and shows the single not-available note, no load error", async ({ page, context }) => {
    await seedApplication(BOLA.email, { company: "Hidden Blocked", submissionState: "blocked", blockedReason: "captcha" })
    await signIn(context, BOLA.email)
    await page.goto("/blocked")
    await page.getByRole("button", { name: E11.hiddenTurnOn }).click()
    await expect(page.getByText(E11.hiddenNote)).toHaveCount(0)
    await expect(page.getByText(E11.notAvailable)).toBeVisible()
    await expect(page.getByText(/couldn't load/i)).toHaveCount(0)
    expect((await readAdvanced(BOLA.email))?.advanced).toBe(true)
  })

  test("ADV:148 / AC-7.5 an email link to a Blocked item works with Advanced off for the Operator: items visible", async ({ page, context }) => {
    await seedApplication(ADA.email, { company: "Email Blocked", submissionState: "blocked", blockedReason: "captcha" })
    await setAdvanced(ADA.email, false)
    await signIn(context, ADA.email)
    await page.goto("/blocked")
    await expect(page.getByText("E11 Email Blocked").first()).toBeVisible()
  })
})

test.describe("Advanced and the rest of the world", () => {
  test("ADV:194 (AC-7.4) automatic submission on: Advanced cannot be switched off from the UI, the server refuses it, and automatic stays on", async ({ page, context }) => {
    await setAutomatic(ADA.email, true)
    const session = await signIn(context, ADA.email)
    await page.goto("/settings")
    await expect(page.getByRole("switch", { name: E11.switchLabel })).toBeDisabled()
    const refused = await page.evaluate(async (csrf) => {
      const r = await fetch("/v1/me/advanced", { method: "PUT", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ enabled: false }) })
      return { status: r.status, body: await r.json() }
    }, session.csrfToken)
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("advanced_locked")
    expect(await readAutomatic(ADA.email)).toBe(true)
    expect((await readAdvanced(ADA.email))?.advanced).toBe(true)
  })

  test("ADV:86 a flag never written reads as off for a brand new account (no row)", async ({ page, context }) => {
    await deleteAdvanced(BOLA.email)
    await signIn(context, BOLA.email)
    await page.goto("/settings")
    await expect(page.getByRole("switch", { name: E11.switchLabel })).toHaveAttribute("aria-checked", "false")
  })
})
