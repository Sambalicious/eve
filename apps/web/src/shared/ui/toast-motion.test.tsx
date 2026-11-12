import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { Toaster, toast } from "./toast"

/**
 * EPIC-F2 design-spec.r2.md "Acceptance checks" > "Unit tests", matched on the
 * Sonner toaster (Candidate decision 2026-10-22 21:28). F2 asserted the
 * computed transition of the Base UI toast after compiling its Tailwind
 * classes; on Sonner the motion lives in app/styles/toast.css, so the plumbing
 * changes and the assertions stay:
 *
 * - toast.css and Sonner's injected stylesheet are loaded into jsdom. jsdom
 *   ignores @media blocks, so each block is kept only when the mocked
 *   matchMedia says it matches (prefers-reduced-motion follows the test).
 * - jsdom keeps `transition:` as a shorthand; it is expanded into the
 *   longhands a browser derives (property, duration, timing function).
 * - The exit attribute is Sonner's `data-removed="true"` (Base UI's was
 *   `data-ending-style`). Sonner removes the toast after its exit and jsdom
 *   never fires `transitionend`, so exit states are read on a clone placed in
 *   the same toaster list (the selectors need the toaster ancestor).
 * - Sonner has no `--enter-distance` variable; the enter offset is its `--y`
 *   start value on an unmounted toast, and "no slide" is read as the computed
 *   transform.
 */

const EASE = "cubic-bezier(0.25, 1, 0.5, 1)"
const MOBILE_QUERY = "(max-width: 767px)"

function mockMatchMedia({ width, reducedMotion }: { width: number; reducedMotion: boolean }) {
  window.matchMedia = (query: string): MediaQueryList => {
    let matches = false
    if (query === MOBILE_QUERY || query === "(max-width:600px)" || query === "(max-width: 600px)") matches = width <= (query === MOBILE_QUERY ? 767 : 600)
    if (query === "(min-width: 601px)") matches = width >= 601
    if (query === "(width: 600px)") matches = width === 600
    if (/prefers-reduced-motion/.test(query)) matches = reducedMotion
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }
  }
}

/** toast.css as written (Vitest's CSS handling returns "" for `?raw`). Node types stay out of the app program. */
async function toastCss(): Promise<string> {
  const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: string, encoding: "utf8"): string }
  return fs.readFileSync(`${decodeURIComponent(import.meta.url.replace(/^file:\/\//, "").replace(/[^/]+$/, ""))}../../app/styles/toast.css`, "utf8")
}

/** Splits on commas outside parentheses. */
function splitTopLevel(value: string) {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of value) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (ch === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
    } else current += ch
  }
  parts.push(current.trim())
  return parts
}

const TIME = /^[\d.]+m?s$/
const EASING = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\))$/

/** Rewrites each `transition:` shorthand into the longhands a browser would derive, in place. */
function expandTransitionShorthand(cssText: string) {
  return cssText.replace(/(^|[;{\s])transition:\s*([^;}]+)/g, (_, lead: string, declared: string) => {
    const important = /!\s*important\s*$/.test(declared) ? " !important" : ""
    const value = declared.replace(/!\s*important\s*$/, "").trim()
    const layers = splitTopLevel(value).map((layer) => {
      const tokens = layer.match(/[\w-]+\([^)]*\)|[^\s]+/g) ?? []
      const times = tokens.filter((t) => TIME.test(t))
      return {
        property: tokens.find((t) => !TIME.test(t) && !EASING.test(t)) ?? "all",
        duration: times[0] ?? "0s",
        easing: tokens.find((t) => EASING.test(t)) ?? "ease",
      }
    })
    return (
      `${lead}transition-property: ${layers.map((l) => l.property).join(", ")}${important}; ` +
      `transition-duration: ${layers.map((l) => l.duration).join(", ")}${important}; ` +
      `transition-timing-function: ${layers.map((l) => l.easing).join(", ")}${important}`
    )
  })
}

/** Flattens a stylesheet's rules for jsdom: matching @media blocks inlined, others dropped. */
function flatten(rules: CSSRuleList): string[] {
  const out: string[] = []
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSMediaRule) {
      if (window.matchMedia(rule.media.mediaText).matches) out.push(...flatten(rule.cssRules))
    } else if (rule instanceof CSSStyleRule) out.push(rule.cssText)
  }
  return out
}

/** Sonner's injected stylesheet, then toast.css, as a browser would cascade them for the mocked media. */
async function applyToastStyles() {
  const sonner = [...document.head.querySelectorAll("style")].find((s) => s.textContent?.includes("[data-sonner-toast]"))
  if (sonner && !sonner.hasAttribute("data-flattened")) {
    sonner.textContent = flatten(sonner.sheet!.cssRules).map(expandTransitionShorthand).join("\n")
    sonner.setAttribute("data-flattened", "")
  }
  const own = document.createElement("style")
  own.setAttribute("data-test-toast-css", "")
  own.textContent = await toastCss()
  document.head.append(own)
  own.textContent = flatten(own.sheet!.cssRules).map(expandTransitionShorthand).join("\n")
}

const toMs = (d: string) => (d.trim().endsWith("ms") ? parseFloat(d) : parseFloat(d) * 1000)

/**
 * Transition properties, per-layer durations in ms and easings, and the longest
 * duration, from the computed style. A shorter duration or easing list repeats
 * to cover every property (CSS Transitions §2).
 */
function computedTransition(el: Element) {
  const style = getComputedStyle(el)
  const properties = splitTopLevel(style.transitionProperty)
  const declared = splitTopLevel(style.transitionDuration).map(toMs)
  const easings = splitTopLevel(style.transitionTimingFunction)
  const durations = properties.map((_, i) => declared[i % declared.length])
  return {
    properties,
    durations,
    easings: properties.map((_, i) => easings[i % easings.length]),
    maxMs: Math.max(...durations),
  }
}

/** A copy of the toast with exit attributes set, in the same toaster list. */
function exitingClone(el: HTMLElement, attributes: Record<string, string>) {
  const clone = el.cloneNode(true) as HTMLElement
  clone.setAttribute("data-test-clone", "")
  for (const [name, value] of Object.entries(attributes)) clone.setAttribute(name, value)
  el.parentElement!.append(clone)
  return clone
}

function computedOpacity(el: Element) {
  const value = getComputedStyle(el).opacity.trim()
  return value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value)
}

function renderToaster() {
  render(
    <>
      <button type="button" onClick={() => toast.success("Saved.")}>
        Save changes
      </button>
      <Toaster />
    </>
  )
}

/** jsdom has no layout. Pins a button's centre y in the 375x812 viewport (mid = 434). */
function placeButton(name: string, centerY: number) {
  screen.getByRole("button", { name }).getBoundingClientRect = () =>
    ({ top: centerY - 16, bottom: centerY + 16, height: 32, left: 16, right: 130, width: 114, x: 16, y: centerY - 16 }) as DOMRect
}

afterEach(() => {
  toast.dismiss()
  document.querySelectorAll("[data-test-clone], style[data-test-toast-css]").forEach((el) => el.remove())
})

describe.each([
  { width: 375, saveY: 796, position: "top" },
  { width: 375, saveY: 88, position: "bottom" },
  { width: 1280, saveY: 88, position: "top" },
])("Toast motion timing at $width px, $position toast (F2 r2 on Sonner)", ({ width, saveY, position }) => {
  async function shownToast(reducedMotion: boolean) {
    mockMatchMedia({ width, reducedMotion })
    renderToaster()
    placeButton("Save changes", saveY)
    await userEvent.setup().click(screen.getByRole("button", { name: "Save changes" }))
    await screen.findByText("Saved.")
    const toastEl = screen.getByText("Saved.").closest<HTMLElement>("[data-sonner-toast]")!
    expect(toastEl).toHaveAttribute("data-y-position", position)
    expect(toastEl).toHaveAttribute("data-mounted", "true")
    await applyToastStyles()
    return toastEl
  }

  const content = (toastEl: HTMLElement) => toastEl.firstElementChild!

  it("resting, motion allowed: transform 200, opacity 200, height 150, on the DESIGN.md curve", async () => {
    const toastEl = await shownToast(false)
    const t = computedTransition(toastEl)
    expect(t.properties).toEqual(["transform", "opacity", "height"])
    expect(t.durations).toEqual([200, 200, 150])
    expect(t.maxMs).toBeGreaterThan(150)
    expect(t.maxMs).toBeLessThanOrEqual(220)
    expect(t.easings).toEqual([EASE, EASE, EASE])
    expect(t.durations).not.toContain(400)
    expect(t.durations).not.toContain(500)
    // The enter starts off-edge (Sonner's --y on an unmounted toast), toward the toast's own edge.
    const start = exitingClone(toastEl, { "data-mounted": "false" })
    expect(getComputedStyle(start).getPropertyValue("--y").trim()).toBe(position === "top" ? "translateY(-100%)" : "translateY(100%)")
  })

  it("exiting, motion allowed: every layer takes 150ms", async () => {
    const toastEl = await shownToast(false)
    const t = computedTransition(exitingClone(toastEl, { "data-removed": "true" }))
    expect(t.properties).toEqual(["transform", "opacity", "height"])
    expect(t.durations).toEqual([150, 150, 150])
    expect(t.easings).toEqual([EASE, EASE, EASE])
  })

  it("exiting from behind the stack: still 150ms (Sonner's own rule says 500ms)", async () => {
    const toastEl = await shownToast(false)
    const behind = exitingClone(toastEl, { "data-removed": "true", "data-front": "false", "data-expanded": "false" })
    expect(computedTransition(behind).durations).toEqual([150, 150, 150])
  })

  it("reduced motion, resting and exiting: opacity only, exactly 150ms, no slide", async () => {
    const toastEl = await shownToast(true)
    for (const el of [toastEl, exitingClone(toastEl, { "data-removed": "true" })]) {
      const t = computedTransition(el)
      expect(t.properties).toEqual(["opacity"])
      expect(t.durations).toEqual([150])
      expect(t.easings).toEqual([EASE])
      expect(getComputedStyle(el).transform).toBe("none")
    }
  })

  it.each([false, true])("orphaned (reduced motion %s): opacity 150ms, transform none, opacity 0", async (reducedMotion) => {
    const toastEl = await shownToast(reducedMotion)
    const orphan = exitingClone(toastEl, { "data-removed": "true", "data-orphaned": "" })
    const t = computedTransition(orphan)
    expect(t.properties).toEqual(["opacity"])
    expect(t.durations).toEqual([150])
    expect(t.easings).toEqual([EASE])
    expect(getComputedStyle(orphan).transform).toBe("none")
    expect(computedOpacity(orphan)).toBe(0)
  })

  it("content fade: opacity 200ms on the DESIGN.md curve", async () => {
    const t = computedTransition(content(await shownToast(false)))
    expect(t.properties).toEqual(["opacity"])
    expect(t.durations).toEqual([200])
    expect(t.easings).toEqual([EASE])
  })

  it("content fade with reduced motion: opacity 150ms", async () => {
    const t = computedTransition(content(await shownToast(true)))
    expect(t.properties).toEqual(["opacity"])
    expect(t.durations).toEqual([150])
  })

  it("swipe drag: no transition while the toast follows the finger", async () => {
    const toastEl = await shownToast(false)
    const dragging = exitingClone(toastEl, { "data-swiping": "true" })
    expect(computedTransition(dragging).durations).toEqual([0])
  })

  it("without reduce: the same toast slides (control, so the reduced checks can fail)", async () => {
    const toastEl = await shownToast(false)
    const t = computedTransition(toastEl)
    expect(t.properties).toContain("transform")
    expect(t.maxMs).toBeGreaterThan(150)
    expect(t.maxMs).toBeLessThanOrEqual(220)
    expect(getComputedStyle(toastEl).transform).not.toBe("none")
  })
})
