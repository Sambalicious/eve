import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"

import { Toaster, toast } from "./toast"

/**
 * EPIC-F2 design-spec.r1.md, "Behaviour below 768px" and "Exact classes and props",
 * ported onto the Sonner toaster (EPIC-0003, Candidate decision 2026-10-22).
 *
 * jsdom does not lay out, so each toast's half is read from Sonner's
 * `data-y-position` (driven by the F2 placement rule), and the toaster's
 * offsets from its CSS variables. Real boxes are measured by `sweep:toast`.
 */

/** toast.css as written (Vitest's CSS handling returns "" for `?raw`). Node types stay out of the app program. */
async function toastCss(): Promise<string> {
  const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: string, encoding: "utf8"): string }
  return fs.readFileSync(`${decodeURIComponent(import.meta.url.replace(/^file:\/\//, "").replace(/[^/]+$/, ""))}../../app/styles/toast.css`, "utf8")
}

const MOBILE_QUERY = "(max-width: 767px)"

function mockMatchMedia({ width }: { width: number }) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: query === MOBILE_QUERY ? width < 768 : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })
}

function Trigger() {
  return (
    <>
      <button type="button" onClick={() => toast.success("Saved.")}>
        Save changes
      </button>
      <button type="button" onClick={() => toast.error("Couldn't save. Nothing changed. Try again.")}>
        Fail save
      </button>
    </>
  )
}

function renderToaster() {
  render(
    <>
      <Trigger />
      <Toaster />
    </>
  )
}

function toastOf(text: string) {
  const el = screen.getByText(text).closest<HTMLElement>("[data-sonner-toast]")
  if (!el) throw new Error("toast root not found")
  return el
}

async function showSaved() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Saved.")
  return { user, toastEl: toastOf("Saved.") }
}

/** jsdom has no layout. Pins a button's centre y in the 375x812 viewport (mid = 434). */
function placeButton(name: string, centerY: number) {
  screen.getByRole("button", { name }).getBoundingClientRect = () =>
    ({ top: centerY - 16, bottom: centerY + 16, height: 32, left: 16, right: 130, width: 114, x: 16, y: centerY - 16 }) as DOMRect
}

/** The Sonner list holding live toasts (one per position). */
function viewport(position?: "top" | "bottom") {
  const lists = [...document.querySelectorAll<HTMLElement>("[data-sonner-toaster]")]
  const el = position ? lists.find((l) => l.dataset.yPosition === position) : lists[0]
  if (!el) throw new Error("toast viewport not found")
  return el
}

const position = (el: HTMLElement) => el.getAttribute("data-y-position")

/** Drags the toast body by (dx, dy) with a primary pointer and releases it. */
function swipe(el: HTMLElement, dx: number, dy: number) {
  const start = { clientX: 100, clientY: 100 }
  fireEvent.pointerDown(el, { ...start, button: 0, pointerId: 1, pointerType: "touch" })
  const steps = 4
  for (let i = 1; i <= steps; i++) {
    fireEvent.pointerMove(el, { clientX: start.clientX + (dx * i) / steps, clientY: start.clientY + (dy * i) / steps, pointerId: 1, pointerType: "touch" })
  }
  fireEvent.pointerUp(el, { clientX: start.clientX + dx, clientY: start.clientY + dy, pointerId: 1, pointerType: "touch" })
}

function isClosing(el: HTMLElement) {
  return el.getAttribute("data-removed") === "true" || !el.isConnected
}

/** Longer than the toast's 150 ms exit (Sonner unmounts 200 ms after the dismiss) plus a frame. Negative asserts are only meaningful after it. */
const DISMISS_WINDOW_MS = 700

async function waitPastDismissWindow() {
  await act(() => new Promise((resolve) => setTimeout(resolve, DISMISS_WINDOW_MS)))
}

async function expectSwipeKeepsThenCloses(el: HTMLElement, wrongDy: number, rightDy: number) {
  swipe(el, 0, wrongDy)
  await waitPastDismissWindow()
  expect(el).toBeInTheDocument()
  expect(el).not.toHaveAttribute("data-removed", "true")
  swipe(el, 0, rightDy)
  await waitPastDismissWindow()
  expect(isClosing(el)).toBe(true)
}

describe("Toast placement at 375px (below 768px), Save in the lower half", () => {
  beforeEach(() => mockMatchMedia({ width: 375 }))

  it("marks each toast as top-positioned", async () => {
    renderToaster()
    placeButton("Save changes", 796)
    const { toastEl } = await showSaved()
    expect(position(toastEl)).toBe("top")
  })

  it("places the viewport under the sticky header and safe area, centred between safe-area gutters", async () => {
    renderToaster()
    placeButton("Save changes", 796)
    await showSaved()
    const v = viewport("top")
    expect(v).toHaveAttribute("data-x-position", "center")
    expect(v.style.getPropertyValue("--mobile-offset-top")).toBe("calc(var(--header-height, 3.5rem) + env(safe-area-inset-top, 0px) + 0.5rem)")
    expect(v.style.getPropertyValue("--mobile-offset-left")).toBe("16px")
    expect(v.style.getPropertyValue("--mobile-offset-right")).toBe("16px")
  })

  it("dismisses when swiped up", async () => {
    renderToaster()
    placeButton("Save changes", 796)
    const { toastEl } = await showSaved()
    swipe(toastEl, 0, -120)
    await waitFor(() => expect(isClosing(toastEl)).toBe(true))
  })

  it("does not dismiss when swiped down", async () => {
    renderToaster()
    placeButton("Save changes", 796)
    const { toastEl } = await showSaved()
    await expectSwipeKeepsThenCloses(toastEl, 120, -120)
  })
})

describe("Toast placement at 375px (below 768px), Save in the upper half (r1)", () => {
  beforeEach(() => mockMatchMedia({ width: 375 }))

  it("marks the toast and the viewport bottom-positioned, above the home indicator", async () => {
    renderToaster()
    placeButton("Save changes", 88)
    const { toastEl } = await showSaved()
    expect(position(toastEl)).toBe("bottom")
    expect(viewport("bottom").style.getPropertyValue("--mobile-offset-bottom")).toBe("max(1rem, calc(env(safe-area-inset-bottom, 0px) + 0.5rem))")
  })

  it("dismisses when swiped down", async () => {
    renderToaster()
    placeButton("Save changes", 88)
    const { toastEl } = await showSaved()
    swipe(toastEl, 0, 120)
    await waitFor(() => expect(isClosing(toastEl)).toBe(true))
  })
})

describe("Toast with no recent trigger at 375px (r1)", () => {
  beforeEach(() => mockMatchMedia({ width: 375 }))

  it("goes to the top", async () => {
    renderToaster()
    act(() => {
      toast.success("Saved.")
    })
    await screen.findByText("Saved.")
    expect(position(toastOf("Saved."))).toBe("top")
  })
})

describe("Pressing a submit button closes visible toasts (r1 rule 4)", () => {
  async function renderForm() {
    render(
      <>
        <form onSubmit={(e) => e.preventDefault()}>
          <button type="submit">Submit form</button>
        </form>
        <Toaster />
      </>
    )
    act(() => {
      toast.success("Saved.")
    })
    await screen.findByText("Saved.")
    return toastOf("Saved.")
  }

  it("closes them at 375px and keeps focus on the pressed button", async () => {
    mockMatchMedia({ width: 375 })
    const toastEl = await renderForm()
    const submit = screen.getByRole("button", { name: "Submit form" })
    await userEvent.setup().click(submit)
    await waitFor(() => expect(isClosing(toastEl)).toBe(true))
    expect(submit).toHaveFocus()
  })

  it("leaves them alone at 1280px", async () => {
    mockMatchMedia({ width: 1280 })
    const toastEl = await renderForm()
    await userEvent.setup().click(screen.getByRole("button", { name: "Submit form" }))
    await waitPastDismissWindow()
    expect(toastEl).toBeInTheDocument()
    expect(toastEl).not.toHaveAttribute("data-removed", "true")
  })
})

describe("One position at a time at 375px (r1 rule 3)", () => {
  beforeEach(() => mockMatchMedia({ width: 375 }))

  it("closes a top toast when a newer toast goes to the bottom", async () => {
    renderToaster()
    placeButton("Save changes", 796)
    const { toastEl: first } = await showSaved()
    expect(position(first)).toBe("top")
    placeButton("Fail save", 88)
    await userEvent.setup().click(screen.getByRole("button", { name: "Fail save" }))
    await screen.findByText("Couldn't save. Nothing changed. Try again.")
    await waitFor(() => expect(isClosing(first)).toBe(true))
    expect(position(toastOf("Couldn't save. Nothing changed. Try again."))).toBe("bottom")
  })

  it("fades the superseded toast in place instead of sliding it (r2 CR-03)", async () => {
    renderToaster()
    placeButton("Save changes", 796)
    const { toastEl: first } = await showSaved()
    placeButton("Fail save", 88)
    await userEvent.setup().click(screen.getByRole("button", { name: "Fail save" }))
    expect(first).toHaveAttribute("data-orphaned")
    expect(await toastCss()).toMatch(
      /\[data-sonner-toast\]\[data-orphaned\]\s*\{[^}]*transform:\s*none\s*!important;[^}]*opacity:\s*0\s*!important;[^}]*transition:\s*opacity 150ms/
    )
  })

  it("a submit press whose toast goes to the other half fades the toasts it closes in place (r2 CR-03)", async () => {
    render(
      <>
        <form onSubmit={(e) => e.preventDefault()}>
          <button type="submit" onClick={() => setTimeout(() => toast.error("Couldn't save. Nothing changed. Try again."), 100)}>
            Submit form
          </button>
        </form>
        <Trigger />
        <Toaster />
      </>
    )
    placeButton("Save changes", 796)
    const { user, toastEl: first } = await showSaved()
    expect(position(first)).toBe("top")
    placeButton("Submit form", 88)
    await user.click(screen.getByRole("button", { name: "Submit form" }))
    await waitFor(() => expect(first).toHaveAttribute("data-removed", "true"))
    expect(first).toHaveAttribute("data-orphaned")
    await screen.findByText("Couldn't save. Nothing changed. Try again.")
    expect(position(toastOf("Couldn't save. Nothing changed. Try again."))).toBe("bottom")
  })
})

describe("Toast placement at 1280px (768px and up), top right", () => {
  beforeEach(() => mockMatchMedia({ width: 1280 }))

  it("marks each toast as top-positioned", async () => {
    renderToaster()
    placeButton("Save changes", 88)
    const { toastEl } = await showSaved()
    expect(position(toastEl)).toBe("top")
    expect(toastEl).toHaveAttribute("data-x-position", "right")
  })

  it("keeps the viewport 16px from the top-right, 384px wide, from md", async () => {
    renderToaster()
    await showSaved()
    const v = viewport()
    expect(v.style.getPropertyValue("--offset-right")).toBe("16px")
    expect(v.style.getPropertyValue("--offset-top")).toBe("calc(var(--header-height, 3.5rem) + env(safe-area-inset-top, 0px) + 0.5rem)")
    expect(v.style.getPropertyValue("--width")).toBe("384px")
  })

  it("dismisses when swiped up", async () => {
    renderToaster()
    const { toastEl } = await showSaved()
    swipe(toastEl, 0, -120)
    await waitFor(() => expect(isClosing(toastEl)).toBe(true))
  })

  it("does not dismiss when swiped down", async () => {
    renderToaster()
    const { toastEl } = await showSaved()
    await expectSwipeKeepsThenCloses(toastEl, 120, -120)
  })

  it("turns text selection off from the press, so a mouse drag is not eaten by a selection", async () => {
    // Sonner ignores pointer moves while text is selected; a drag across the
    // toast text selects it before data-swiped is set (sweep S01).
    const css = await toastCss()
    expect(css).toMatch(/\[data-sonner-toast\]\[data-swiping="true"\][^{]*\{[^}]*(?<!-webkit-)user-select:\s*none/)
  })
})

describe("Reduced motion", () => {
  it("with reduce: every toast transitions opacity only, exactly 150ms, with no translate", async () => {
    const css = await toastCss()
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ""
    expect(block).toMatch(/\[data-sonner-toast\][^{]*\{[^}]*transform:\s*none\s*!important;/)
    expect(block).toMatch(/transition:\s*opacity 150ms cubic-bezier\(0\.25, 1, 0\.5, 1\)\s*!important;/)
    // Computed per-layer timing under reduced motion is asserted in toast-motion.test.tsx.
  })
})

describe.each([375, 1280])("Screen reader announcements at %ipx", (width) => {
  beforeEach(() => mockMatchMedia({ width }))

  it("puts 'Saved.' inside the polite live region and keeps focus on Save", async () => {
    renderToaster()
    const save = screen.getByRole("button", { name: "Save changes" })
    const { toastEl } = await showSaved()
    const region = screen.getByRole("region", { name: "Messages" })
    expect(region).toHaveAttribute("aria-live", "polite")
    expect(within(region).getByText("Saved.")).toBeInTheDocument()
    expect(region).toContainElement(toastEl)
    expect(save).toHaveFocus()
  })

  it("announces an error toast in the same polite region and keeps focus on the pressed button", async () => {
    renderToaster()
    await userEvent.setup().click(screen.getByRole("button", { name: "Fail save" }))
    const region = screen.getByRole("region", { name: "Messages" })
    expect(await within(region).findByText("Couldn't save. Nothing changed. Try again.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Fail save" })).toHaveFocus()
  })
})
