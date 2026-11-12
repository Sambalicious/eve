/**
 * Mobile toast placement (EPIC-F2 design-spec.r1.md, "Behaviour below 768px").
 *
 * Below 768px a toast goes to the half of the content area opposite the
 * control that triggered it, so it never covers the button just pressed or
 * that button's inline error. With no recent trigger it goes to the top. The
 * position is decided once per toast and never changes. From 768px the
 * toaster is top right, which this mobile rule does not decide.
 */

export type ToastPosition = "top" | "bottom"

/** The visible content area in viewport px: below the sticky header, above the bottom safe area. */
export interface ContentBand {
  top: number
  bottom: number
}

export interface TriggerSnapshot {
  centerY: number
  activatedAt: number
  connected: boolean
}

export const TRIGGER_MAX_AGE_MS = 10_000

const FALLBACK_HEADER_PX = 56
const CONTROL_SELECTOR = 'button, [role="button"], a'
const TOAST_VIEWPORT_SELECTOR = '[data-slot="toast-viewport"]'

export function decideToastPosition({
  isMobile,
  trigger,
  now,
  band,
}: {
  isMobile: boolean
  trigger: TriggerSnapshot | null
  now: number
  band: ContentBand
}): ToastPosition {
  if (!isMobile) return "top"
  if (!trigger || !trigger.connected || now - trigger.activatedAt > TRIGGER_MAX_AGE_MS) return "top"
  const mid = (band.top + band.bottom) / 2
  return trigger.centerY >= mid ? "top" : "bottom"
}

/**
 * Resolves the header bottom (`--header-height` + top safe area) and the
 * bottom safe area with a fixed probe, then subtracts the bottom inset from
 * the visual viewport height. Falls back to a 56px header and no inset when
 * the styles do not resolve to px (no layout, as in jsdom).
 */
export function measureContentBand(doc: Document, win: Window): ContentBand {
  const probe = doc.createElement("div")
  probe.setAttribute("aria-hidden", "true")
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;left:0;width:0;height:0;" +
    "top:calc(var(--header-height, 3.5rem) + env(safe-area-inset-top, 0px));" +
    "bottom:env(safe-area-inset-bottom, 0px)"
  doc.body.appendChild(probe)
  const style = win.getComputedStyle(probe)
  const headerBottom = pxOr(style.top, FALLBACK_HEADER_PX)
  const bottomInset = pxOr(style.bottom, 0)
  probe.remove()
  const height = win.visualViewport?.height ?? win.innerHeight
  return { top: headerBottom, bottom: height - bottomInset }
}

function pxOr(value: string, fallback: number): number {
  if (!value.endsWith("px")) return fallback
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

export interface ToastPlacement {
  /**
   * Starts tracking presses on the document. `onSubmitPress` runs on a
   * submit-button press, before the form submits. Returns the uninstaller.
   * Reinstalling keeps the last recorded press.
   */
  install(onSubmitPress?: () => void): () => void
  /** The position of a toast. Decided on first call below 768px, then fixed. */
  positionFor(toastId: string, isMobile: boolean): ToastPosition
  /** Forgets decisions for toasts that are no longer rendered. */
  retain(toastIds: readonly string[]): void
}

export function createToastPlacement({
  doc = document,
  now = Date.now,
  measureBand = () => measureContentBand(document, window),
}: {
  doc?: Document
  now?: () => number
  measureBand?: () => ContentBand
} = {}): ToastPlacement {
  let lastTrigger: { element: Element; activatedAt: number } | null = null
  let onSubmitPress: (() => void) | undefined
  const decided = new Map<string, ToastPosition>()

  // Pointer, Enter and Space on a button, and implicit submission from a
  // field, all dispatch `click` on the control, so one listener covers them.
  function handleClick(event: MouseEvent) {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest(TOAST_VIEWPORT_SELECTOR)) return
    const control = target.closest(CONTROL_SELECTOR)
    if (!control) return
    lastTrigger = { element: control, activatedAt: now() }
    if (isSubmitButton(control)) onSubmitPress?.()
  }

  function snapshot(): TriggerSnapshot | null {
    if (!lastTrigger) return null
    const rect = lastTrigger.element.getBoundingClientRect()
    return {
      centerY: rect.top + rect.height / 2,
      activatedAt: lastTrigger.activatedAt,
      connected: lastTrigger.element.isConnected,
    }
  }

  return {
    install(handler) {
      onSubmitPress = handler
      doc.addEventListener("click", handleClick, true)
      return () => {
        doc.removeEventListener("click", handleClick, true)
        onSubmitPress = undefined
      }
    },
    // Called during render on purpose: the half must be known before the first paint so a toast
    // never moves. Idempotent: the first decision per id is cached, and a discarded render only
    // leaves a cached entry that retain() prunes.
    positionFor(toastId, isMobile) {
      if (!isMobile) return "top"
      const known = decided.get(toastId)
      if (known) return known
      const position = decideToastPosition({ isMobile, trigger: snapshot(), now: now(), band: measureBand() })
      decided.set(toastId, position)
      return position
    },
    retain(toastIds) {
      const keep = new Set(toastIds)
      for (const id of decided.keys()) if (!keep.has(id)) decided.delete(id)
    },
  }
}

function isSubmitButton(control: Element): boolean {
  return control instanceof HTMLButtonElement && control.type === "submit" && control.form !== null
}
