import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { type ElementHandle, type Locator, type Page, expect, test } from "@playwright/test"

import { AddJobLinkDialog } from "../support/add-job-link.ts"
import { COPY } from "../support/copy.ts"
import { resetPostings, signIn } from "../support/db.ts"
import { resetEpic11, seedApplication, setAdvanced } from "../support/epic-0011-db.ts"
import { clearAlertFeedVerification, setPauses } from "../support/hiring-db.ts"
import { HelpPage } from "../support/help-page.ts"
import { HiringPage } from "../support/hiring-page.ts"
import { PD, description } from "../support/pasted-description.ts"
import { StackFeedPage } from "../support/stack-feed-page.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * Dialog polish (FEAT-0011 design review): the description panel's label row, the
 * textarea's cap against the visible viewport, and the title's reserved end beside
 * the corner Close. Real web, api and Postgres; no canned responses. Geometry is
 * read with getBoundingClientRect and computed styles, because the defects are
 * layout, not text.
 *
 * Captures for the design review run only with CAPTURE=1 (they write PNGs, they do
 * not assert).
 */
const CAPTURE = process.env.CAPTURE === "1"
const SHOTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../features/active/FEAT-0011-simplify-eve/design-review-screens/dialog-polish"
)

const ADD_BODY = "add-job-link-body"
const CHECK_BODY = "check-this-job-body"
/** Long enough to overflow the textarea's half-viewport cap. */
const LONG_DESCRIPTION = description("DIALOG-POLISH-E2E")
/** Short enough that the whole panel fits the capture viewport; the failure set uses the long one. */
const CAPTURE_DESCRIPTION = `Senior Frontend Engineer\n\n${"Build merchant dashboards in React and TypeScript. ".repeat(3)}`
/**
 * A long title built from whole words, filled to 140 characters. A hard cut at 140
 * would end mid-word ("...for the team f"), which reads as a clipped string in the
 * capture rather than a long title, so the phrase stops at its last full word.
 */
const PHRASE_WORDS = "Senior Frontend Engineer for a long employer name that keeps going past the corner close".split(" ")
const PHRASE = (() => {
  let title = ""
  for (let i = 0; title.length < 140; i += 1) {
    const next = title ? `${title} ${PHRASE_WORDS[i % PHRASE_WORDS.length]}` : (PHRASE_WORDS[0] as string)
    if (next.length > 140) break
    title = next
  }
  return title
})()
/** One unbroken token: only `overflow-wrap: anywhere` can break it. */
const UNBROKEN = "W".repeat(60)
/** The corner Close is 32px wide with a 16px inset; the title reserves 40px (pe-10). */
const RESERVED_PADDING = "40px"

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: "disabled" })
}

/** Sets the theme before the first paint, so the capture is not a light frame mid-switch. */
async function useTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("eve-theme", value), theme)
}

async function expectTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`))
}

/** `/postings`: opens the Add a job link dialog and its description panel. */
async function openAddPanel(page: Page): Promise<Locator> {
  await page.goto("/postings")
  const dialog = await new AddJobLinkDialog(page).open()
  await dialog.getByRole("button", { name: PD.toggle, exact: true }).click()
  await expect(dialog.getByRole("textbox", { name: PD.descriptionLabel })).toBeVisible()
  return dialog
}

/** Find jobs, Search tab: opens the Check this job dialog and its description panel. */
async function openCheckPanel(page: Page): Promise<Locator> {
  await page.goto("/find-jobs")
  const hiring = new HiringPage(page)
  await hiring.showTab(COPY.searchTab)
  const dialog = await hiring.openCheck()
  await dialog.getByRole("button", { name: PD.toggle, exact: true }).click()
  await expect(dialog.getByRole("textbox", { name: PD.descriptionLabel })).toBeVisible()
  return dialog
}

async function fillPanel(dialog: Locator, text: string): Promise<void> {
  await dialog.getByRole("textbox", { name: PD.descriptionLabel }).fill(text)
  await dialog.getByRole("textbox", { name: PD.titleLabel, exact: true }).fill("Senior Frontend Engineer")
  await dialog.getByRole("textbox", { name: PD.companyLabel, exact: true }).fill("Globex")
}

function bodyOf(dialog: Locator, slot: string): Locator {
  return dialog.locator(`[data-slot="${slot}"]`)
}

/** Scrolls the dialog's body to its end with a real wheel-less scroll, as a Candidate does. */
async function scrollBodyToEnd(dialog: Locator, slot: string): Promise<void> {
  await bodyOf(dialog, slot).evaluate((body) => {
    body.scrollTop = body.scrollHeight
  })
}

// ── the label row ─────────────────────────────────────────────

async function labelRowGeometry(dialog: Locator) {
  return await dialog.evaluate((root) => {
    // The description's own label, not the link field's above it.
    const label = root.querySelector('[data-slot="field-label"][for$="-description"]') as HTMLElement
    const row = label.parentElement as HTMLElement
    const optional = label.querySelector("span") as HTMLElement
    const remove = [...root.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Remove description"
    ) as HTMLElement
    const box = (el: Element) => {
      const rect = el.getBoundingClientRect()
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }
    }
    /** The text box's vertical centre: with items-center, a same-row pair centres together. */
    const textCentre = (el: HTMLElement) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()
      if (!node) throw new Error("no text")
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = Array.from(range.getClientRects())
      const rect = rects[0]!
      return (rect.top + rect.bottom) / 2
    }
    const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight)
    /** The theme's cobalt, resolved the way Remove would resolve it under `text-primary`. */
    const primaryColour = (() => {
      const probe = document.createElement("span")
      probe.className = "text-primary"
      row.append(probe)
      const colour = getComputedStyle(probe).color
      probe.remove()
      return colour
    })()
    return {
      lineHeight: Number.isFinite(lineHeight) ? lineHeight : Number.parseFloat(getComputedStyle(label).fontSize) * 1.4,
      label: box(label),
      optional: box(optional),
      remove: box(remove),
      row: box(row),
      labelTextCentre: textCentre(label),
      removeTextCentre: textCentre(remove),
      removeHasIcon: remove.querySelector("svg") !== null,
      // The muted label text and Remove must resolve to one colour: Remove is neutral,
      // and no cobalt (`--primary`) reaches it.
      optionalColour: getComputedStyle(optional).color,
      removeColour: getComputedStyle(remove).color,
      primaryColour,
    }
  })
}

test.describe("the description panel's label row", () => {
  test.beforeEach(async ({ context }) => {
    await resetPostings()
    await signIn(context, ADA.email)
  })

  for (const [width, height] of [
    [375, 812],
    [320, 640],
    [1280, 900],
  ] as const) {
    test(`stays legible at ${width}x${height}: one-line label with Optional on it, one-line Remove either beside it or below and right-aligned`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      const dialog = await openAddPanel(page)

      const g = await labelRowGeometry(dialog)

      // The label is one line and Optional sits on that line, at its end.
      expect(g.label.height, "label height (one line)").toBeLessThanOrEqual(g.lineHeight * 1.5)
      expect(g.optional.top, "Optional top within the label").toBeGreaterThanOrEqual(g.label.top - 0.5)
      expect(g.optional.bottom, "Optional bottom within the label").toBeLessThanOrEqual(g.label.bottom + 0.5)
      expect(g.optional.right, "Optional ends inside the label").toBeLessThanOrEqual(g.label.right + 0.5)

      // Remove is one line, and its icon is the ClipboardX, not a bare text link.
      expect(g.remove.height, "Remove height (one line)").toBeLessThanOrEqual(40)
      expect(g.removeHasIcon, "Remove has its icon").toBe(true)

      // Neutral: Remove resolves to the same muted colour as the label's "(Optional)",
      // so cobalt stays on the primary action, focus and the active nav item.
      expect(g.removeColour, "Remove is muted, not cobalt").toBe(g.optionalColour)
      expect(g.removeColour, "Remove is not the primary colour").not.toBe(g.primaryColour)

      const sameRow = Math.abs(g.labelTextCentre - g.removeTextCentre) <= 1
      if (width >= 1280) {
        expect(sameRow, `same row at ${width}: label ${g.labelTextCentre} vs remove ${g.removeTextCentre}`).toBe(true)
      } else if (sameRow) {
        // Same row: both text lines share one centre, so items-center did not drift them.
        expect(Math.abs(g.labelTextCentre - g.removeTextCentre)).toBeLessThanOrEqual(1)
      } else {
        // Wrapped: Remove goes under the label and hugs the row's right edge.
        expect(g.remove.top, "Remove below the label").toBeGreaterThanOrEqual(g.label.bottom - 1)
        expect(Math.abs(g.remove.right - g.row.right), "Remove right-aligned").toBeLessThanOrEqual(1)
      }
    })
  }
})

// ── the textarea's cap against the visible viewport ───────────

type CapMeasurement = Readonly<{
  maxHeight: string
  height: number
  scrolls: boolean
  bodyScrollTop: number
  bodyOverflows: boolean
  bodyOverflowY: string
  header: Readonly<{
    left: number
    right: number
    width: number
    borderBottomWidth: string
    borderBottomStyle: string
    borderBottomColour: string
  }>
  body: Readonly<{ left: number; width: number; paddingLeft: number; paddingRight: number }>
  viewport: Readonly<{ width: number; height: number }>
  popup: Readonly<{ top: number; right: number; bottom: number; left: number }>
  title: Readonly<{ top: number; right: number; bottom: number; left: number }>
  close: Readonly<{ top: number; right: number; bottom: number; left: number }>
}>

async function measureCap(dialog: Locator, slot: string): Promise<CapMeasurement> {
  return await dialog.evaluate((root, bodySlot) => {
    const textarea = root.querySelector('[data-slot="textarea"]') as HTMLTextAreaElement
    const body = root.querySelector(`[data-slot="${bodySlot}"]`) as HTMLElement
    const header = root.querySelector('[data-slot="dialog-header"]') as HTMLElement
    const box = (el: Element) => {
      const rect = el.getBoundingClientRect()
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }
    }
    const headerStyle = getComputedStyle(header)
    const bodyStyle = getComputedStyle(body)
    const headerRect = header.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    return {
      maxHeight: getComputedStyle(textarea).maxHeight,
      height: textarea.getBoundingClientRect().height,
      scrolls: textarea.scrollHeight > textarea.clientHeight + 1,
      bodyScrollTop: body.scrollTop,
      bodyOverflows: body.scrollHeight > body.clientHeight + 1,
      bodyOverflowY: bodyStyle.overflowY,
      header: {
        left: headerRect.left,
        right: headerRect.right,
        width: headerRect.width,
        borderBottomWidth: headerStyle.borderBottomWidth,
        borderBottomStyle: headerStyle.borderBottomStyle,
        borderBottomColour: headerStyle.borderBottomColor,
      },
      body: {
        left: bodyRect.left,
        width: bodyRect.width,
        paddingLeft: Number.parseFloat(bodyStyle.paddingLeft),
        paddingRight: Number.parseFloat(bodyStyle.paddingRight),
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      popup: box(root),
      title: box(root.querySelector('[data-slot="dialog-title"]') as HTMLElement),
      close: box(root.querySelector('[data-slot="dialog-close"]') as HTMLElement),
    }
  }, slot)
}

/** The pinned header's hairline is drawn, and it spans exactly the body's content width. */
function expectPinnedHeaderRule(m: CapMeasurement): void {
  expect(m.header.borderBottomWidth, "the header carries a hairline").toBe("1px")
  expect(m.header.borderBottomStyle, "the hairline is drawn").toBe("solid")
  expect(m.header.borderBottomColour, "the hairline is not transparent").not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  // The body pulls out to the popup's edge and re-insets itself, so the rule above it
  // lines up with the body's content rather than with the popup's edges.
  expect(m.header.left, "rule starts at the body's content").toBeCloseTo(m.body.left + m.body.paddingLeft, 0)
  expect(m.header.width, "rule spans the body's content").toBeCloseTo(
    m.body.width - m.body.paddingLeft - m.body.paddingRight,
    0
  )
  // And the body is still the one that scrolls, not the header or the popup.
  expect(m.bodyOverflowY, "the body is the scroll container").toBe("auto")
}

for (const [height, cap] of [
  [420, 210],
  [360, 180],
] as const) {
  test(`caps the description at half the visible viewport at 375x${height}: ${cap}px, it scrolls, the page does not`, async ({ page, context }) => {
    await resetPostings()
    await signIn(context, ADA.email)
    await page.setViewportSize({ width: 375, height })
    const dialog = await openAddPanel(page)

    // Opening the panel moves focus to the description, and it is in view.
    const field = dialog.getByRole("textbox", { name: PD.descriptionLabel })
    await expect(field).toBeFocused()
    await expect(field).toBeInViewport()

    await fillPanel(dialog, LONG_DESCRIPTION)
    const m = await measureCap(dialog, ADD_BODY)
    expect(m.maxHeight, "textarea max-height").toBe(`${cap}px`)
    expect(m.height, "textarea height at the cap").toBeGreaterThanOrEqual(cap - 1)
    expect(m.height, "textarea height at the cap").toBeLessThanOrEqual(cap + 1)
    expect(m.scrolls, "the textarea scrolls").toBe(true)
    // The pinned header keeps its hairline, so the cut is a visible edge.
    expectPinnedHeaderRule(m)

    // 16px gutters all round, with the title and the corner Close in view.
    expect(m.popup.left).toBeGreaterThanOrEqual(15.5)
    expect(m.popup.right).toBeLessThanOrEqual(m.viewport.width - 15.5)
    expect(m.popup.top).toBeGreaterThanOrEqual(15.5)
    expect(m.popup.bottom).toBeLessThanOrEqual(m.viewport.height - 15.5)
    for (const part of [m.title, m.close]) {
      expect(part.top).toBeGreaterThanOrEqual(m.popup.top - 0.5)
      expect(part.bottom).toBeLessThanOrEqual(m.popup.bottom + 0.5)
      expect(part.left).toBeGreaterThanOrEqual(m.popup.left - 0.5)
      expect(part.right).toBeLessThanOrEqual(m.popup.right + 0.5)
    }

    // The dialog's body carries the overflow, and the page behind stays put: the
    // send button is reachable at the body's end, in the viewport.
    await scrollBodyToEnd(dialog, ADD_BODY)
    await expect(dialog.getByRole("button", { name: PD.send })).toBeInViewport()
    const after = await measureCap(dialog, ADD_BODY)
    expect(after.bodyOverflows, "the dialog body carries the overflow").toBe(true)
    expect(after.bodyScrollTop, "the dialog body scrolled, not the popup").toBeGreaterThan(0)
    expect(after.popup.top, "the popup stays put").toBeCloseTo(m.popup.top, 0)
  })
}

test("the Check this job dialog caps its description the same way at 375x420", async ({ page, context }) => {
  await signIn(context, ADA.email)
  await page.setViewportSize({ width: 375, height: 420 })
  const dialog = await openCheckPanel(page)
  const field = dialog.getByRole("textbox", { name: PD.descriptionLabel })
  await expect(field).toBeFocused()
  await expect(field).toBeInViewport()

  await fillPanel(dialog, LONG_DESCRIPTION)
  const m = await measureCap(dialog, CHECK_BODY)
  expect(m.maxHeight, "textarea max-height").toBe("210px")
  expect(m.height, "textarea height at the cap").toBeGreaterThanOrEqual(209)
  expect(m.height, "textarea height at the cap").toBeLessThanOrEqual(211)
  expect(m.scrolls).toBe(true)
  // The pinned help is cut by the scroll edge at 375x420: the hairline is its divider.
  expectPinnedHeaderRule(m)

  await scrollBodyToEnd(dialog, CHECK_BODY)
  await expect(dialog.getByRole("button", { name: PD.send })).toBeInViewport()
  const after = await measureCap(dialog, CHECK_BODY)
  expect(after.bodyOverflows, "the dialog body carries the overflow").toBe(true)
  expect(after.bodyScrollTop, "the dialog body scrolled, not the popup").toBeGreaterThan(0)
  expect(after.popup.top, "the popup stays put").toBeCloseTo(m.popup.top, 0)
})

// ── the title's reserved end ──────────────────────────────────

type TitleMeasurement = Readonly<{
  hasCloseMark: boolean
  paddingEnd: string
  maxTextRight: number
  closeLeft: number | null
  titleRight: number
}>

/**
 * The popup's element handle. Mutating its title changes the dialog's accessible
 * name, so every measurement runs on this handle, never on the name-based locator.
 */
async function popupRoot(dialog: Locator): Promise<ElementHandle<Element>> {
  const root = await dialog.elementHandle()
  if (!root) throw new Error("the dialog is not open")
  return root
}

async function injectTitle(root: ElementHandle<Element>, text: string): Promise<void> {
  await root.evaluate((el, value) => {
    const title = el.querySelector('[data-slot="dialog-title"], [data-slot="alert-dialog-title"]') as HTMLElement
    title.textContent = value
  }, text)
}

async function measureTitle(root: ElementHandle<Element>): Promise<TitleMeasurement> {
  return (await root.evaluate((el) => {
    const title = el.querySelector('[data-slot="dialog-title"], [data-slot="alert-dialog-title"]') as HTMLElement
    const close = el.querySelector('[data-slot="dialog-close"]') as HTMLElement | null
    const range = document.createRange()
    range.selectNodeContents(title)
    const rects = Array.from(range.getClientRects())
    const titleRect = title.getBoundingClientRect()
    return {
      hasCloseMark: el.hasAttribute("data-has-close"),
      paddingEnd: getComputedStyle(title).paddingInlineEnd,
      maxTextRight: Math.max(...rects.map((rect) => rect.right)),
      closeLeft: close ? close.getBoundingClientRect().left : null,
      titleRight: titleRect.right,
    }
  })) as TitleMeasurement
}

/** The title never runs under the corner Close, and never overflows its own box. */
async function expectTitleClearsClose(dialog: Locator, label: string): Promise<void> {
  const root = await popupRoot(dialog)
  try {
    for (const [kind, text] of [
      ["a long phrase", PHRASE],
      ["an unbroken string", UNBROKEN],
    ] as const) {
      await injectTitle(root, text)
      const m = await measureTitle(root)
      expect(m.hasCloseMark, `${label}: popup marks its corner Close`).toBe(true)
      expect(m.closeLeft, `${label}: corner Close present`).not.toBeNull()
      expect(m.paddingEnd, `${label}: title reserves pe-10`).toBe(RESERVED_PADDING)
      expect(m.maxTextRight, `${label}: ${kind} stays clear of the Close`).toBeLessThanOrEqual(m.closeLeft! - 8)
      expect(m.maxTextRight, `${label}: ${kind} stays inside the title`).toBeLessThanOrEqual(m.titleRight + 0.5)
    }
  } finally {
    await root.dispose()
  }
}

test.describe("the title's reserved end at 375", () => {
  test("the injected long title ends on a whole word, so the capture is not a clipped string", () => {
    expect(PHRASE.length, "long enough to wrap past the corner Close").toBeGreaterThan(120)
    expect(PHRASE.length, "within the 140 it claims").toBeLessThanOrEqual(140)
    expect(PHRASE, "ends on a whole word").toMatch(/[a-z]$/)
    expect(PHRASE, "no trailing or doubled spaces").not.toMatch(/ {2}| $/)
  })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
  })

  test("Add a job link", async ({ page, context }) => {
    await resetPostings()
    await signIn(context, ADA.email)
    const dialog = await openAddPanel(page)
    await expectTitleClearsClose(dialog, "Add a job link")
  })

  test("Check this job", async ({ page, context }) => {
    await signIn(context, ADA.email)
    const dialog = await openCheckPanel(page)
    await expectTitleClearsClose(dialog, "Check this job")
  })

  test("Mark verified", async ({ page, context }) => {
    await signIn(context, ADA.email)
    const help = new HelpPage(page)
    await help.openSources()
    const dialog = await help.openVerifyDialog("We Work Remotely")
    await expectTitleClearsClose(dialog, "Mark verified")
  })

  test("Raise ceiling", async ({ page, context }) => {
    await setAdvanced(ADA.email, true)
    await signIn(context, ADA.email)
    await page.goto("/pause-and-cost#cost")
    const section = page.getByRole("region", { name: "Monthly cost" })
    await section.getByRole("button", { name: "Raise this month's ceiling" }).click()
    const dialog = page.getByRole("dialog", { name: "Raise this month's ceiling" })
    await expect(dialog).toBeVisible()
    await expectTitleClearsClose(dialog, "Raise ceiling")
  })

  test("Outcome", async ({ page, context }) => {
    const app = await seedApplication(BOLA.email, { company: "Dialog Outcome", submissionState: "manual" })
    await signIn(context, BOLA.email)
    await page.goto(`/applications/${app.id}`)
    const outcomes = page.getByRole("region", { name: "Outcomes" })
    await outcomes.getByRole("button", { name: "Record Outcome" }).click()
    const dialog = page.getByRole("dialog", { name: "Record Outcome" })
    await expect(dialog).toBeVisible()
    await expectTitleClearsClose(dialog, "Outcome")
    await resetEpic11()
  })

  test("Existing applications", async ({ page, context }) => {
    await signIn(context, ADA.email)
    await page.goto("/existing-applications")
    await page.getByRole("button", { name: "Add existing application" }).click()
    const dialog = page.getByRole("dialog", { name: "Add existing application" })
    await expect(dialog).toBeVisible()
    await expectTitleClearsClose(dialog, "Existing applications")
  })

  test("Verify alert source has no default Close, so its title reserves nothing", async ({ page, context }) => {
    await clearAlertFeedVerification()
    await signIn(context, ADA.email)
    const feeds = new StackFeedPage(page)
    await feeds.openAndWait()
    await feeds.confirmButton().click()
    const dialog = feeds.dialog()
    await expect(dialog).toBeVisible()

    const root = await popupRoot(dialog)
    try {
      for (const text of [PHRASE, UNBROKEN]) {
        await injectTitle(root, text)
        const m = await measureTitle(root)
        expect(m.hasCloseMark, "no corner Close is marked").toBe(false)
        expect(m.paddingEnd, "nothing reserved for an absent Close").not.toBe(RESERVED_PADDING)
      }
    } finally {
      await root.dispose()
    }
  })

  test("Confirm has no default Close either, so its title reserves nothing", async ({ page, context }) => {
    await setPauses({ global: true, cost: false })
    try {
      await signIn(context, ADA.email)
      await page.goto("/applications")
      await page.getByRole("button", { name: "Resume automation" }).first().click()
      const dialog = page.getByRole("alertdialog", { name: "Resume automation?" })
      await expect(dialog).toBeVisible()

      const root = await popupRoot(dialog)
      try {
        for (const text of [PHRASE, UNBROKEN]) {
          await injectTitle(root, text)
          const m = await measureTitle(root)
          expect(m.hasCloseMark, "no corner Close is marked").toBe(false)
          expect(m.closeLeft, "no corner Close").toBeNull()
          expect(m.paddingEnd, "nothing reserved for an absent Close").not.toBe(RESERVED_PADDING)
        }
      } finally {
        await root.dispose()
      }
    } finally {
      await setPauses({ global: false, cost: false })
    }
  })
})

// ── captures for the design review (CAPTURE=1) ────────────────

test.describe("captures", () => {
  test.skip(!CAPTURE, "screenshots: run with CAPTURE=1")

  for (const theme of ["light", "dark"] as const) {
    // 375 wide, with the tall viewport the whole panel needs: a shorter one cuts the
    // panel's own bottom off, and a fixed dialog cannot be captured beyond the viewport.
    // 940, not 900: the pinned header's `pb-3` costs 12px, and at 900 the Check panel's
    // send button fell the wrong side of the popup's `100dvh-2rem` cap.
    for (const [width, height] of [
      [375, 940],
      [1280, 900],
    ] as const) {
      test(`add panel ${width}-${theme}`, async ({ page, context }) => {
        await useTheme(page, theme)
        await resetPostings()
        await signIn(context, ADA.email)
        await page.setViewportSize({ width, height })
        const dialog = await openAddPanel(page)
        await fillPanel(dialog, CAPTURE_DESCRIPTION)
        // Fill scrolls the body to the last field; the capture shows the panel from its top.
        await bodyOf(dialog, ADD_BODY).evaluate((body) => (body.scrollTop = 0))
        await expectTheme(page, theme)
        await shot(page, `add-panel-${width}-${theme}`)
      })

      test(`check panel ${width}-${theme}`, async ({ page, context }) => {
        await useTheme(page, theme)
        await signIn(context, ADA.email)
        await page.setViewportSize({ width, height })
        const dialog = await openCheckPanel(page)
        await fillPanel(dialog, CAPTURE_DESCRIPTION)
        await bodyOf(dialog, CHECK_BODY).evaluate((body) => (body.scrollTop = 0))
        await expectTheme(page, theme)
        await shot(page, `check-panel-${width}-${theme}`)
      })
    }

    test(`failure alert with the body scrolled 375x420-${theme}`, async ({ page, context }) => {
      await useTheme(page, theme)
      await resetPostings()
      await signIn(context, ADA.email)
      await page.setViewportSize({ width: 375, height: 420 })

      for (const panel of ["add", "check"] as const) {
        const dialog = panel === "add" ? await openAddPanel(page) : await openCheckPanel(page)
        // A Greenhouse link the stack cannot read, with no names: the panel's own
        // C-PD-27 alert, at the end of the panel, above the send button.
        await dialog.getByRole("textbox", { name: /link/i }).fill("https://boards.greenhouse.io/unknown/jobs/999123")
        await dialog.getByRole("textbox", { name: PD.descriptionLabel }).fill(LONG_DESCRIPTION)
        await dialog.getByRole("button", { name: PD.send }).click()
        await expect(dialog.getByRole("alert")).toContainText("couldn't read the employer's page")
        await scrollBodyToEnd(dialog, panel === "add" ? ADD_BODY : CHECK_BODY)
        await expectTheme(page, theme)
        await shot(page, `${panel}-failure-375x420-${theme}`)
        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog")).toHaveCount(0)
      }
    })
  }

  test("title guard, 375 light", async ({ page, context }) => {
    await useTheme(page, "light")
    await signIn(context, ADA.email)
    await page.setViewportSize({ width: 375, height: 812 })

    const help = new HelpPage(page)
    await help.openSources()
    await expectTheme(page, "light")
    const verified = await help.openVerifyDialog("We Work Remotely")
    await injectTitle(await popupRoot(verified), PHRASE)
    await shot(page, "title-guard-mark-verified-375-light")
    await page.keyboard.press("Escape")

    await setAdvanced(ADA.email, true)
    await page.goto("/pause-and-cost#cost")
    const section = page.getByRole("region", { name: "Monthly cost" })
    await section.getByRole("button", { name: "Raise this month's ceiling" }).click()
    const ceiling = page.getByRole("dialog", { name: "Raise this month's ceiling" })
    await expect(ceiling).toBeVisible()
    await injectTitle(await popupRoot(ceiling), PHRASE)
    await shot(page, "title-guard-raise-ceiling-375-light")
    await page.keyboard.press("Escape")

    const app = await seedApplication(BOLA.email, { company: "Dialog Capture", submissionState: "manual" })
    await signIn(context, BOLA.email)
    await page.goto(`/applications/${app.id}`)
    const outcomes = page.getByRole("region", { name: "Outcomes" })
    await outcomes.getByRole("button", { name: "Record Outcome" }).click()
    const outcome = page.getByRole("dialog", { name: "Record Outcome" })
    await expect(outcome).toBeVisible()
    await injectTitle(await popupRoot(outcome), PHRASE)
    await shot(page, "title-guard-outcome-375-light")
    await page.keyboard.press("Escape")
    await resetEpic11()

    await signIn(context, ADA.email)
    await page.goto("/existing-applications")
    await page.getByRole("button", { name: "Add existing application" }).click()
    const existing = page.getByRole("dialog", { name: "Add existing application" })
    await expect(existing).toBeVisible()
    await injectTitle(await popupRoot(existing), PHRASE)
    await shot(page, "title-guard-existing-applications-375-light")
  })
})
