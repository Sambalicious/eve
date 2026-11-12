import { type Locator, type Page, expect, test } from "@playwright/test"

import { signIn } from "../support/db.ts"
import { EH, SURFACES, type Surface, forbiddenIn, ownershipClaimsIn } from "../support/explanatory-help-copy.ts"
import { HelpPage, contrastRatio, focusIsInside, hasHorizontalScroll, waitForSettled } from "../support/help-page.ts"
import { restoreHiringInputs, setHiringInputs, snapshotHiringInputs } from "../support/hiring-db.ts"
import { type BoardRow, restoreRemoteBoards, setDraftSources, snapshotRemoteBoards } from "../support/remote-board-db.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0009 QA test authoring: help-accessibility-and-invariants.feature
 * (HAI:<line>) for the three help surfaces, in the real browser on the real
 * stack. Surfaces as in the feature header: "verify" (Mark verified dialog for
 * We Work Remotely on /sources), "sources" (Remote-job boards) and "hiring"
 * (/find-jobs, the former /stack-posts?view=hiring; "sources" is Job boards in Set up alerts, Operator only). Coarse-pointer rows use a touch context
 * (hasTouch makes `(pointer: coarse)` match in Chromium). The AC-17 rows are in
 * outbound-and-separation.epic9.spec.ts. The repository rows (HAI:265-307)
 * are static checks on the candidate diff; see the QA report.
 */
const ALL: readonly Surface[] = ["verify", "sources", "hiring"]
const OUTSIDE: Readonly<Record<Exclude<Surface, "verify">, (page: Page) => Locator>> = {
  // A non-interactive spot outside the popover: the page h1 in the app shell.
  sources: (page) => page.getByRole("heading", { level: 1 }),
  hiring: (page) => page.getByRole("heading", { level: 1 }),
}

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

async function reach(page: Page, surface: Surface): Promise<HelpPage> {
  await signIn(page.context(), ADA.email)
  const help = new HelpPage(page)
  await help.reach(surface)
  return help
}

/** The help line that sits next to `surface`'s trigger. */
function lineOf(help: HelpPage, surface: Surface): Locator {
  return help.line(surface)
}

test.describe("Trigger semantics and activation (AC-13)", () => {
  for (const surface of ALL) {
    test(`AX9-01 (HAI:22 ${surface}) one button named "Why…", not "info", collapsed and announcing a popup`, async ({ page }) => {
      const help = await reach(page, surface)
      const trigger = help.trigger(surface)
      await expect(trigger).toHaveCount(1)
      const name = SURFACES[surface].trigger
      expect(name.startsWith("Why")).toBe(true)
      expect(["info", "Info", "More information"]).not.toContain(name)
      await expect(trigger).toHaveAccessibleName(name)
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await expect(trigger).toHaveAttribute("aria-haspopup", /^(true|dialog|menu|listbox|tree|grid)$/)
    })

    for (const activation of ["clicks", "focuses and presses Enter on", "focuses and presses Space on"] as const) {
      test(`AX9-02 (HAI:37 ${surface}) she ${activation} the trigger: the popover opens and the trigger reports expanded`, async ({ page }) => {
        const help = await reach(page, surface)
        if (activation === "clicks") await help.trigger(surface).click()
        else {
          await help.trigger(surface).focus()
          await page.keyboard.press(activation.includes("Enter") ? "Enter" : "Space")
        }
        await expect(help.popover(surface)).toBeVisible()
        await expect(help.trigger(surface)).toHaveAttribute("aria-expanded", "true")
      })
    }

    test(`AX9-03 (HAI:62 ${surface}) hovering the trigger and the help line for 2 seconds each opens nothing`, async ({ page }) => {
      const help = await reach(page, surface)
      await help.trigger(surface).hover()
      await page.waitForTimeout(2000)
      await lineOf(help, surface).hover()
      await page.waitForTimeout(2000)
      await expect(help.popover(surface)).toHaveCount(0)
      await expect(help.trigger(surface)).toHaveAttribute("aria-expanded", "false")
      await expect(page.getByRole("tooltip")).toHaveCount(0)
    })
  }

  test.describe("touch", () => {
    test.use({ hasTouch: true })
    for (const surface of ALL) {
      test(`AX9-02 (HAI:37 ${surface}) she taps the trigger: the popover opens and the trigger reports expanded`, async ({ page }) => {
        const help = await reach(page, surface)
        await help.trigger(surface).tap()
        await expect(help.popover(surface)).toBeVisible()
        await expect(help.trigger(surface)).toHaveAttribute("aria-expanded", "true")
      })
    }
  })

  test("AX9-04 (HAI:78) every help line is visible with no popover open", async ({ page }) => {
    const help = await reach(page, "sources")
    await expect(help.line("sources")).toBeVisible()
    await expect(help.anyPopover()).toHaveCount(0)
    const dialog = await help.openVerifyDialog("We Work Remotely")
    await expect(dialog.getByText(EH.verifyDesc, { exact: true })).toBeVisible()
    await expect(dialog.getByText(EH.verifyBasisHelp, { exact: true })).toBeVisible()
    await expect(help.anyPopover()).toHaveCount(0)
    await page.goto("/find-jobs")
    await expect(help.line("hiring")).toBeVisible()
    await expect(help.anyPopover()).toHaveCount(0)
  })
})

test.describe("Focus, closing and screen-reader structure (AC-14, AC-15)", () => {
  for (const surface of ALL) {
    test(`AX9-05 (HAI:86 ${surface}) Enter on the trigger moves focus into a dialog named by its title`, async ({ page }) => {
      const help = await reach(page, surface)
      await help.trigger(surface).focus()
      await page.keyboard.press("Enter")
      const popover = help.popover(surface)
      await expect(popover).toBeVisible()
      await expect(popover).toHaveAccessibleName(SURFACES[surface].title)
      await expect.poll(() => focusIsInside(popover)).toBe(true)
    })
  }

  for (const surface of ["sources", "hiring"] as const) {
    const actions = [
      ["pressing Escape", (h: HelpPage) => h.page.keyboard.press("Escape")],
      ["clicking outside the popover", (h: HelpPage) => OUTSIDE[surface](h.page).click()],
      ["activating the button named by C-EH-POPOVER-CLOSE", (h: HelpPage) => h.closeButton(surface).click()],
      ["activating the trigger again", (h: HelpPage) => h.trigger(surface).click()],
    ] as const
    for (const [label, close] of actions) {
      test(`AX9-06 (HAI:100 ${surface}) ${label} closes the popover and returns focus to the collapsed trigger`, async ({ page }) => {
        const help = await reach(page, surface)
        await help.open(surface)
        await close(help)
        await expect(help.popover(surface)).toHaveCount(0)
        await expect(help.trigger(surface)).toBeFocused()
        await expect(help.trigger(surface)).toHaveAttribute("aria-expanded", "false")
      })
    }
  }

  test.describe("touch", () => {
    test.use({ hasTouch: true })
    for (const surface of ["sources", "hiring"] as const) {
      test(`AX9-06 (HAI:100 ${surface}) tapping outside the popover closes it and returns focus to the collapsed trigger`, async ({ page }) => {
        const help = await reach(page, surface)
        await help.trigger(surface).tap()
        await expect(help.popover(surface)).toBeVisible()
        await OUTSIDE[surface](page).tap()
        await expect(help.popover(surface)).toHaveCount(0)
        await expect(help.trigger(surface)).toBeFocused()
        await expect(help.trigger(surface)).toHaveAttribute("aria-expanded", "false")
      })
    }
  })

  test("AX9-07 (HAI:124 sources) Tab from the opened popover reaches the Close help button", async ({ page }) => {
    const help = await reach(page, "sources")
    await help.openWithKeyboard("sources")
    await page.keyboard.press("Tab")
    await expect(help.closeButton("sources")).toBeFocused()
  })

  test("AX9-07 (HAI:124 hiring) Tab reaches Close help, then the three Go to links in order", async ({ page }) => {
    const help = await reach(page, "hiring")
    await help.hiring().waitUntilReady()
    await help.openWithKeyboard("hiring")
    const order = [help.closeButton("hiring"), help.goLink(EH.hiringLinksGo), help.goLink(EH.hiringCheckGo), help.goLink(EH.hiringFeedsGo)]
    for (const control of order) {
      await page.keyboard.press("Tab")
      await expect(control).toBeFocused()
    }
  })

  test("AX9-08 (HAI:136) the Mark verified popover exposes every body text to assistive tech, with the examples as a list of 3", async ({ page }) => {
    const help = await reach(page, "verify")
    const popover = await help.open("verify")
    for (const text of [EH.verifyP1, EH.verifyP2, EH.verifyEx1, EH.verifyEx2, EH.verifyEx3, EH.verifyNote]) {
      const node = popover.getByText(text, { exact: true })
      await expect(node).toBeVisible()
      expect(await node.evaluate((el) => Boolean(el.closest("[aria-hidden='true'], [hidden], [inert]")))).toBe(false)
    }
    await expect(popover.getByRole("list")).toHaveCount(1)
    await expect(popover.getByRole("list").getByRole("listitem")).toHaveCount(3)
  })

  test("AX9-09 (HAI:143) only one help popover is open at a time on Job Sources", async ({ page }) => {
    const help = await reach(page, "sources")
    await help.open("sources")
    await help.openVerifyDialog("We Work Remotely")
    await help.trigger("verify").click()
    await expect(help.anyPopover()).toHaveCount(1)
    await expect(help.popover("verify")).toBeVisible()
  })
})

test.describe("Viewport, targets, contrast and motion (AC-16)", () => {
  const rows = [
    [375, "verify", 343],
    [375, "sources", 343],
    [375, "hiring", 343],
    [1280, "verify", 352],
    [1280, "sources", 352],
    [1280, "hiring", 352],
  ] as const
  for (const [width, surface, popoverWidth] of rows) {
    test(`AX9-10 (HAI:152 ${width}px ${surface}) no horizontal scroll, the line wraps with the trigger on its first line, and a ${popoverWidth}px popover sits 16px inside the viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      const help = await reach(page, surface)
      await help.open(surface)
      // QA-G9-01: read geometry after the popover's enter (and, for verify, the Dialog's open) animation ends.
      await waitForSettled(help.popover(surface), help.trigger(surface))
      expect(await hasHorizontalScroll(page)).toBe(false)
      const line = help.line(surface)
      expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      const lineBox = (await line.boundingBox())!
      expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(width)
      // The trigger stays on the first line of the row: its top is within one line of the text's top.
      const triggerBox = (await help.trigger(surface).boundingBox())!
      const lineHeight = await line.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20)
      expect(Math.abs(triggerBox.y + triggerBox.height / 2 - (lineBox.y + lineHeight / 2))).toBeLessThanOrEqual(lineHeight)
      const box = (await help.popover(surface).boundingBox())!
      expect(Math.round(box.width)).toBe(popoverWidth)
      expect(box.x).toBeGreaterThanOrEqual(16 - 0.5)
      expect(box.x + box.width).toBeLessThanOrEqual(width - 16 + 0.5)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(800)
    })
  }

  test("AX9-11 (HAI:173) at 375x560 the Hiring popover fits, its body scrolls inside it, the page does not scroll, and the title and Close help stay visible", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 560 })
    const help = await reach(page, "hiring")
    const popover = await help.open("hiring")
    await waitForSettled(popover)
    const box = (await popover.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(560 + 0.5)
    const pageScroll = await page.evaluate(() => window.scrollY)
    const scrolled = await popover.evaluate((el) => {
      const body = Array.from(el.querySelectorAll<HTMLElement>("*")).find((n) => n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY))
      if (!body) return null
      body.scrollTop = body.scrollHeight
      return body.scrollTop
    })
    expect(scrolled, "the popover body must scroll inside itself at 560px").not.toBeNull()
    expect(scrolled!).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll)
    await expect(popover.getByText(EH.hiringTitle, { exact: true })).toBeInViewport()
    await expect(help.closeButton("hiring")).toBeInViewport()
  })

  // 320 CSS px at 200% zoom lays out like a 160 CSS px viewport.
  test("AX9-12 (HAI:183) at 320px and 200% zoom (160 CSS px) neither help line overflows its column or the viewport", async ({ page }) => {
    for (const width of [320, 160]) {
      await page.setViewportSize({ width, height: 800 })
      const help = await reach(page, "sources")
      for (const surface of ["sources", "hiring"] as const) {
        if (surface === "hiring") await page.goto("/find-jobs")
        const line = help.line(surface)
        await expect(line).toBeVisible()
        expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${surface} at ${width}px`).toBe(true)
        const box = (await line.boundingBox())!
        expect(box.x + box.width, `${surface} at ${width}px`).toBeLessThanOrEqual(width + 0.5)
      }
    }
  })

  test.describe("coarse pointer", () => {
    test.use({ hasTouch: true })
    for (const surface of ["sources", "hiring"] as const) {
      test(`AX9-13 (HAI:190 ${surface}) trigger and Close help are at least 40x40px, and every popover link is at least 40px tall`, async ({ page }) => {
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
        const help = await reach(page, surface)
        await help.trigger(surface).tap()
        await expect(help.popover(surface)).toBeVisible()
        // QA-G9-02: sizes from the settled layout, not a frame of the zoom-in-95 enter.
        await waitForSettled(help.popover(surface), help.trigger(surface))
        for (const control of [help.trigger(surface), help.closeButton(surface)]) {
          const box = (await control.boundingBox())!
          expect(box.width).toBeGreaterThanOrEqual(40)
          expect(box.height).toBeGreaterThanOrEqual(40)
        }
        for (const link of await help.popover(surface).getByRole("link").all()) {
          expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(40)
        }
      })
    }

    test("AX9-14 (HAI:204 coarse) the Mark verified trigger is at least 40x40px on a coarse pointer", async ({ page }) => {
      const help = await reach(page, "verify")
      // QA-G9-02: the Dialog's zoom-in-[0.97] open animation scales the trigger inside it; wait for it to end.
      await waitForSettled(help.trigger("verify"))
      const box = (await help.trigger("verify").boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(40)
      expect(box.height).toBeGreaterThanOrEqual(40)
    })
  })

  test("AX9-14 (HAI:204 fine) the Mark verified trigger is at least 24x24px on a fine pointer", async ({ page }) => {
    const help = await reach(page, "verify")
    expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true)
    await waitForSettled(help.trigger("verify"))
    const box = (await help.trigger("verify").boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(24)
    expect(box.height).toBeGreaterThanOrEqual(24)
  })

  for (const theme of ["light", "dark"] as const) {
    test(`AX9-15 (HAI:211 ${theme}) help text is at least 4.5:1 and each (i) icon at least 3:1 against its background`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("eve-theme", value), theme)
      const help = await reach(page, "sources")
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`))
      const checkText = async (target: Locator, label: string) => expect(await contrastRatio(target, "text"), label).toBeGreaterThanOrEqual(4.5)
      const checkIcon = async (surface: Surface) => expect(await contrastRatio(help.trigger(surface).locator("svg"), "icon"), `${surface} icon`).toBeGreaterThanOrEqual(3)

      await checkText(help.line("sources"), "C-EH-SRC-HELP")
      await checkIcon("sources")
      let popover = await help.open("sources")
      for (const text of [EH.srcP1, EH.srcP2, EH.srcNote]) await checkText(popover.getByText(text, { exact: true }), text)
      await page.keyboard.press("Escape")

      const dialog = await help.openVerifyDialog("We Work Remotely")
      await checkText(dialog.getByText(EH.verifyDesc, { exact: true }), "C-EH-VERIFY-DESC")
      await checkText(dialog.getByText(EH.verifyBasisHelp, { exact: true }), "C-EH-VERIFY-BASIS-HELP")
      await checkIcon("verify")
      popover = await help.open("verify")
      for (const text of [EH.verifyP1, EH.verifyP2, EH.verifyExamples, EH.verifyEx1, EH.verifyNote]) await checkText(popover.getByText(text, { exact: true }), text)

      await page.goto("/find-jobs")
      await checkText(help.line("hiring"), "C-EH-HIRING-LINE")
      await checkIcon("hiring")
      popover = await help.open("hiring")
      for (const text of [EH.hiringReason, EH.hiringWays]) await checkText(popover.getByText(text, { exact: true }), text)
      for (const link of [EH.hiringLinksGo, EH.hiringCheckGo, EH.hiringFeedsGo]) await checkText(help.goLink(link), link)
      // The "automated accessibility scan" step needs axe-core, which apps/e2e does not have (see QA report).
    })
  }

  test.describe("reduced motion", () => {
    test.use({ reducedMotion: "reduce" })
    test("AX9-16 (HAI:225) with prefers-reduced-motion: reduce the popover opens and closes with no animation or transition", async ({ page }) => {
      const help = await reach(page, "sources")
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true)
      // Open, then read the animations on the popup and its positioner in the same frame.
      const opened = await page.evaluate(async (name) => {
        const trigger = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === name)!
        trigger.click()
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        const popup = document.querySelector<HTMLElement>("[role='dialog'][aria-labelledby]")
        if (!popup) return { found: false, animations: [] as string[], durations: [] as string[] }
        const targets = [popup, popup.parentElement].filter((n): n is HTMLElement => n !== null)
        const animations = targets.flatMap((n) => n.getAnimations()).map((a) => `${a.constructor.name}:${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? ""}`)
        const durations = targets.map((n) => {
          const s = getComputedStyle(n)
          return `${s.animationName}|${s.animationDuration}|${s.transitionDuration}`
        })
        return { found: true, animations, durations }
      }, EH.srcTrigger)
      expect(opened.found).toBe(true)
      expect(opened.animations, `running on open; computed ${opened.durations.join(", ")}`).toEqual([])
      await expect(help.popover("sources")).toBeVisible()
      // Close with the button: the popup must be gone two frames later (no exit animation keeps it mounted).
      const goneQuickly = await page.evaluate(async (name) => {
        const close = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === name)!
        close.click()
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        const popup = document.querySelector<HTMLElement>("[role='dialog'][aria-labelledby]")
        return popup === null || popup.getAnimations().length === 0
      }, EH.popoverClose)
      expect(goneQuickly).toBe(true)
      await expect(help.popover("sources")).toHaveCount(0)
    })
  })
})

test.describe("Copy invariants as rendered (AC-19)", () => {
  test("AX9-17 (HAI:307, HAI:293 automated part) no rendered help line or popover contains a forbidden phrase or says who sees the basis", async ({ page }) => {
    const help = await reach(page, "sources")
    const texts: string[] = [await help.line("sources").innerText(), await (await help.open("sources")).innerText()]
    await page.keyboard.press("Escape")
    await help.rowSwitch("We Work Remotely").click()
    texts.push(await help.refusal("We Work Remotely").innerText())
    const dialog = await help.openVerifyDialog("We Work Remotely")
    texts.push(await dialog.getByText(EH.verifyDesc, { exact: true }).innerText(), await dialog.getByText(EH.verifyBasisHelp, { exact: true }).innerText())
    texts.push(await (await help.open("verify")).innerText())
    await page.goto("/find-jobs")
    texts.push(await help.line("hiring").innerText(), await (await help.open("hiring")).innerText())
    const all = texts.join("\n")
    expect(forbiddenIn(all)).toEqual([])
    expect(ownershipClaimsIn(all)).toEqual([])
  })
})

test.describe("Permission (AC-13)", () => {
  for (const path of ["/sources", "/stack-posts?view=hiring", "/find-jobs"]) {
    test(`AX9-18 (HAI:324) a signed-out visitor opening ${path} is sent to sign in and sees no help`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveURL(/\/sign-in\?/)
      for (const text of [EH.srcHelp, EH.hiringLine, EH.verifyDesc, EH.verifyBasisHelp]) await expect(page.getByText(text, { exact: true })).toHaveCount(0)
      for (const surface of ALL) await expect(page.getByRole("button", { name: SURFACES[surface].trigger })).toHaveCount(0)
    })
  }
})

