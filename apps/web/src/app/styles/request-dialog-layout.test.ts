import { readFileSync } from "node:fs"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

// F-QA-E3-01 (r3 recheck), request-access.feature:185 and 201. Vitest stubs CSS imports, so the real
// landing.css is loaded into jsdom. jsdom applies top-level rules (the >=640px
// path) and ignores @media blocks, so the media queries are checked as text.
const css = readFileSync(`${(import.meta as ImportMeta & { dirname: string }).dirname}/landing.css`, "utf8")

function dialogWith(attribute?: string) {
  const el = document.createElement("div")
  el.className = "request-dialog"
  if (attribute) el.setAttribute(attribute, "")
  document.body.append(el)
  return getComputedStyle(el)
}

/** The rule bodies for `selector` inside the first block that starts with `blockStart`. */
function ruleIn(blockStart: string, selector: string) {
  const start = css.indexOf(blockStart)
  expect(start, `${blockStart} missing`).toBeGreaterThan(-1)
  const block = css.slice(start)
  const match = new RegExp(`${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(block)
  expect(match, `${selector} missing in ${blockStart}`).not.toBeNull()
  return match![1]
}

describe("request dialog geometry (>= 640px, design-spec r3 grid centring)", () => {
  beforeAll(() => {
    const style = document.createElement("style")
    style.textContent = css
    document.head.append(style)
  })
  afterEach(() => document.querySelectorAll(".request-dialog, .request-dialog-viewport").forEach((el) => el.remove()))

  function viewport() {
    const el = document.createElement("div")
    el.className = "request-dialog-viewport"
    document.body.append(el)
    return getComputedStyle(el)
  }

  it("a fixed grid viewport centres the popup on both axes", () => {
    const style = viewport()
    expect(style.display).toBe("grid")
    expect(css).toMatch(/\.request-dialog-viewport \{[^}]*place-items: center;/)
  })

  it("rests with no transform, so the in-dialog toaster is placed against the viewport", () => {
    const style = dialogWith()
    expect(style.transform).toBe("none")
    expect(style.transformOrigin).toBe("center")
  })

  it("enters and exits by scale and opacity only, with no translate", () => {
    const enter = dialogWith("data-starting-style")
    expect(enter.transform).toBe("scale(0.97)")
    expect(enter.opacity).toBe("0")
    const exit = dialogWith("data-ending-style")
    expect(exit.transform).toMatch(/^scale\(0\.9\d\)$/)
    expect(exit.transitionDuration).toBe("var(--duration-dialog-out)")
  })

  it("caps its height to the viewport less the toast reserve and scrolls inside itself", () => {
    expect(dialogWith().maxHeight).toBe("calc(100dvh - 32px - var(--dialog-toast-reserve))")
    expect(dialogWith().overflow).toBe("hidden")
    expect(css).toMatch(/\.request-dialog:has\(\.request-toaster \[data-sonner-toast\]/)
  })
})

describe("request dialog media rules", () => {
  it("below 640px the viewport top-anchors the popup and no state translates it", () => {
    expect(ruleIn("@media (max-width: 639px) {\n  .request-dialog-viewport", ".request-dialog-viewport")).toContain("align-items: start")
    expect(css).not.toMatch(/\.request-dialog[^{]*\{[^}]*translate\(/)
  })

  it("on short viewports top-anchors the popup", () => {
    expect(ruleIn("@media (max-height: 479px) {\n  .request-dialog-viewport", ".request-dialog-viewport")).toContain("align-items: start")
  })

  it("turns the transition off under reduced motion", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.request-dialog,\s*\.request-dialog-backdrop,\s*\.request-swap\s*\{\s*transition: none;/
    )
  })

  it("the dialog toaster enters in 200ms and exits in 150ms", () => {
    expect(ruleIn(".request-toaster [data-sonner-toast]", ".request-toaster [data-sonner-toast]")).toContain("var(--duration-toast-in)")
    expect(ruleIn('.request-toaster [data-sonner-toast][data-removed="true"]', '.request-toaster [data-sonner-toast][data-removed="true"]')).toContain("var(--duration-toast-out)")
  })
})
