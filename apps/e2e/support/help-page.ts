import { type Locator, type Page, expect } from "@playwright/test"

import { COPY } from "./copy.ts"
import { EH, SRC, SURFACES, type Surface } from "./explanatory-help-copy.ts"
import { HiringLinksPage } from "./hiring-links-page.ts"

/** api paths the EPIC-0009 journeys watch (`@eve/contracts`, retyped so a wrong product path fails). */
export const JOB_SOURCES_PATH = "/v1/job-sources"
export const JOB_CRITERIA_PATH = "/v1/candidate-settings/job-criteria"
export const HIRING_SEARCH_INPUTS_PATH = "/v1/stack-posts/hiring-search-inputs"
export const verificationPath = (key: string) => `/v1/job-sources/remote-boards/${key}/verification`
export const enabledPath = (key: string) => `/v1/job-sources/remote-boards/${key}/enabled`

/**
 * The EPIC-0009 help surfaces (design-spec S1-S3, HelpPopover), located by
 * role, accessible name and copy-deck text only. The popover is any element
 * with role "dialog" named by its *-WHY-TITLE; the (i) trigger is the button
 * named by its *-WHY-TRIGGER-SR.
 */
export class HelpPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  // ── Generic help parts ────────────────────────────────────────

  trigger(surface: Surface, scope: Locator | Page = this.page): Locator {
    return scope.getByRole("button", { name: SURFACES[surface].trigger, exact: true })
  }

  popover(surface: Surface): Locator {
    return this.page.getByRole("dialog", { name: SURFACES[surface].title, exact: true })
  }

  /** Every open help popover, whichever surface. */
  anyPopover(): Locator {
    return this.page.getByRole("dialog", { name: new RegExp(`^(${[EH.verifyTitle, EH.srcTitle, EH.hiringTitle].map(escapeRegExp).join("|")})$`) })
  }

  line(surface: Surface): Locator {
    return this.page.getByText(SURFACES[surface].line, { exact: true })
  }

  closeButton(surface: Surface): Locator {
    return this.popover(surface).getByRole("button", { name: EH.popoverClose, exact: true })
  }

  /** Opens the popover with a mouse click and waits for it. */
  async open(surface: Surface): Promise<Locator> {
    await this.trigger(surface).click()
    await expect(this.popover(surface)).toBeVisible()
    return this.popover(surface)
  }

  /** Opens the popover by focusing the trigger and pressing Enter. */
  async openWithKeyboard(surface: Surface): Promise<Locator> {
    await this.trigger(surface).focus()
    await this.page.keyboard.press("Enter")
    await expect(this.popover(surface)).toBeVisible()
    return this.popover(surface)
  }

  // ── Job Sources (S1, S2) ──────────────────────────────────────

  /**
   * EPIC-0011 R5: Job Sources is "Job boards" inside Find jobs > Set up alerts, for the Operator only. The
   * `#job-sources` hash selects the Set up alerts tab (EPIC-0015); `/sources` still redirects there
   * (find-upgrade spec).
   */
  async openSources(): Promise<void> {
    await this.page.goto("/find-jobs#job-sources")
    await expect(this.boardsSection()).toBeVisible()
    await expect(this.row("We Work Remotely")).toBeVisible()
  }

  boardsSection(): Locator {
    return this.page.getByRole("region", { name: SRC.sectionTitle, exact: true })
  }

  boardsHeading(): Locator {
    return this.page.getByRole("heading", { level: 2, name: SRC.sectionTitle, exact: true })
  }

  row(board: string): Locator {
    return this.boardsSection().getByRole("listitem", { name: board, exact: true })
  }

  rowSwitch(board: string): Locator {
    return this.row(board).getByRole("switch")
  }

  rowMarkVerified(board: string): Locator {
    return this.row(board).getByRole("button", { name: new RegExp(`^${SRC.markVerified}`) }).first()
  }

  refusal(board: string): Locator {
    return this.row(board).getByRole("alert")
  }

  refusalMarkVerified(board: string): Locator {
    return this.refusal(board).getByRole("button", { name: SRC.markVerified, exact: true })
  }

  verifyDialog(board: string): Locator {
    return this.page.getByRole("dialog", { name: SRC.dialogTitle(board), exact: true })
  }

  dateField(board: string): Locator {
    return this.verifyDialog(board).getByLabel(new RegExp(`^${SRC.dateLabel}`))
  }

  basisField(board: string): Locator {
    return this.verifyDialog(board).getByLabel(new RegExp(`^${SRC.basisLabel}`))
  }

  dialogSubmit(board: string): Locator {
    return this.verifyDialog(board).getByRole("button", { name: SRC.markVerified, exact: true })
  }

  dialogCancel(board: string): Locator {
    return this.verifyDialog(board).getByRole("button", { name: SRC.cancel, exact: true })
  }

  /** Opens Mark verified for `board` from its row button and waits for the dialog. */
  async openVerifyDialog(board = "We Work Remotely"): Promise<Locator> {
    await this.rowMarkVerified(board).click()
    await expect(this.verifyDialog(board)).toBeVisible()
    return this.verifyDialog(board)
  }

  toasts(): Locator {
    return this.page.getByRole("region", { name: "Messages" })
  }

  // ── Hiring view (S3) ──────────────────────────────────────────

  hiring(): HiringLinksPage {
    return new HiringLinksPage(this.page)
  }

  /** The Find jobs page heading: the anchor the lead line and (i) used to follow in the Hiring view frame. */
  pageHeading(): Locator {
    return this.page.getByRole("heading", { level: 1, name: COPY.findTitle })
  }

  heading(name: string): Locator {
    return this.page.getByRole("heading", { level: 2, name, exact: true })
  }

  goLink(name: string): Locator {
    return this.popover("hiring").getByRole("link", { name, exact: true })
  }

  // ── Reach a surface, as the Examples tables do ────────────────

  /** Navigates to the surface's page and, for "verify", opens the Mark verified dialog for We Work Remotely. */
  async reach(surface: Surface): Promise<void> {
    if (surface === "hiring") {
      await this.page.goto("/find-jobs")
      await expect(this.line("hiring")).toBeVisible()
      return
    }
    await this.openSources()
    if (surface === "verify") await this.openVerifyDialog("We Work Remotely")
  }
}

// ── Geometry and accessibility helpers ──────────────────────────

/** True when `later` comes after `earlier` in document (reading) order. */
export async function follows(earlier: Locator, later: Locator): Promise<boolean> {
  const handle = await later.elementHandle()
  return earlier.evaluate((a, b) => Boolean(a.compareDocumentPosition(b as Node) & Node.DOCUMENT_POSITION_FOLLOWING), handle)
}

export async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
}

/** The texts in `expected` appear in `root`'s text in this order. */
export async function expectInOrder(root: Locator, expected: readonly string[]): Promise<void> {
  const text = normalise(await root.innerText())
  let from = 0
  for (const part of expected) {
    const at = text.indexOf(normalise(part), from)
    expect(at, `"${part}" after offset ${from} in: ${text}`).toBeGreaterThanOrEqual(0)
    from = at + normalise(part).length
  }
}

export function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Waits two animation frames, so a would-be transition has had time to start. */
export async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

/** The accessible name of the focused element (aria-label, else its text). */
export async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement
    if (!el) return ""
    return (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim()
  })
}

/** True when the focused element is `root` or inside it. */
export async function focusIsInside(root: Locator): Promise<boolean> {
  return root.evaluate((el) => el === document.activeElement || el.contains(document.activeElement))
}

/**
 * WCAG 2.x contrast ratio between an element's text colour (or, for an svg, its
 * stroke colour) and the opaque background behind it. Colours are resolved by
 * painting them on a 1px canvas, so oklch(), color-mix() and alpha all composite
 * the way the browser draws them.
 */
export async function contrastRatio(target: Locator, kind: "text" | "icon" = "text"): Promise<number> {
  return target.evaluate((el, which) => {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    const paint = (color: string) => {
      ctx.fillStyle = "#000"
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
    }
    const read = () => Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
    // Background: the browser's white canvas, then every ancestor background from the root down.
    const chain: Element[] = []
    for (let node: Element | null = el; node; node = node.parentElement) chain.unshift(node)
    paint("#fff")
    for (const node of chain) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") paint(bg)
    }
    const background = read()
    const style = getComputedStyle(el)
    const fg = which === "icon" ? (style.stroke && style.stroke !== "none" ? style.stroke : style.color) : style.color
    paint(fg)
    const foreground = read()
    const lum = ([r, g, b]: number[]) => {
      const ch = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * ch(r!) + 0.7152 * ch(g!) + 0.0722 * ch(b!)
    }
    const [hi, lo] = [lum(foreground), lum(background)].sort((a, b) => b - a)
    return (hi! + 0.05) / (lo! + 0.05)
  }, kind)
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * QA-G9-01/02: waits until no finite CSS animation or transition is running on
 * any of `targets`, their ancestors or their descendants, so geometry is read
 * from the settled layout, not from a frame of the popover's zoom-in-95 enter or
 * the Dialog's zoom-in-[0.97] open. Ancestors matter: the Mark verified trigger
 * is scaled by the Dialog popup around it. Infinite animations (skeleton pulse,
 * spinners) are ignored because they never finish. Repeats until a pass finds
 * nothing to wait for, in case one animation starts another.
 */
export async function waitForSettled(...targets: Locator[]): Promise<void> {
  for (const target of targets) await target.waitFor({ state: "attached" })
  for (let pass = 0; pass < 5; pass += 1) {
    const handles = await Promise.all(targets.map((t) => t.elementHandle()))
    const waited = await targets[0]!.page().evaluate(async (elements) => {
      const nodes: Element[] = elements.filter((n) => n !== null)
      const related = (target: Element | null | undefined) =>
        target != null && nodes.some((n) => n === target || n.contains(target) || target.contains(n))
      const running = document.getAnimations().filter((a) => {
        const effect = a.effect as KeyframeEffect | null
        if (!effect || !related(effect.target)) return false
        if (a.playState === "finished" || a.playState === "idle") return false
        return Number.isFinite(effect.getComputedTiming().endTime as number)
      })
      await Promise.all(running.map((a) => a.finished.catch(() => undefined)))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return running.length
    }, handles)
    if (waited === 0) return
  }
  throw new Error("waitForSettled: animations kept starting after 5 passes")
}

/**
 * QA-G9-03: rendered line count of a block of text, from its content height
 * over its computed line-height. Not from client-rect tops, which differ by a
 * pixel for an inline button with an underline inside the same line.
 */
export async function lineCount(target: Locator): Promise<number> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
    const height = el.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
    return Math.round(height / lineHeight)
  })
}
