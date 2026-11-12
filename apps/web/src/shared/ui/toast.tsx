import * as React from "react"
import { Toaster as SonnerToaster, toast as sonner, type ToasterProps as SonnerProps } from "sonner"
import { CircleAlert, CircleCheck, Info, TriangleAlert, XIcon } from "lucide-react"

import { createToastPlacement, type ToastPlacement } from "@/shared/lib/toast-placement"
import { Button } from "@/shared/ui/button"

/**
 * App-wide toasts (design-spec.r3 Interaction patterns > Toasts, DESIGN.md
 * rule 8). Sonner owns stacking, timers, swipe and the polite live region;
 * every toast renders headless through `EveToast`, a popover surface with a
 * tone edge and tone icon, never filled with status colour.
 */

/** copy-deck.r3 `app.toast.*`. Accessible names only. */
export const toastCopy = {
  regionLabel: "Messages",
  closeLabel: "Close message",
} as const

export type ToastTone = "error" | "success" | "warning" | "info"

/** Any icon component that takes SVG props (Lucide icons, or a local icon). */
export type ToastIcon = React.ComponentType<React.SVGProps<SVGSVGElement>>

export type ToastOptions = {
  /** Same id replaces the toast in place, so one form never stacks two. */
  id?: string
  /** Renders in the toaster with this `id` (a dialog's own toaster). */
  toasterId?: string
  action?: { label: string; onClick: () => void }
  /** Overrides the tone's default (`Infinity` persists). */
  duration?: number
  /** Overrides the tone's icon, for example `WifiOff` or `Clock`. */
  icon?: ToastIcon
  /** Called after the toast leaves by its close control, swipe or action. */
  onClose?: () => void
}

const TONE_ICON: Record<ToastTone, ToastIcon> = {
  error: CircleAlert,
  success: CircleCheck,
  warning: TriangleAlert,
  info: Info,
}

/** Design-spec r3 duration table. Errors with an action persist. */
export const TOAST_DURATION: Record<ToastTone, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
}

/**
 * EPIC-F2 mobile placement (design-spec.r1 "Behaviour below 768px"), on
 * Sonner's per-toast position. Below 768px an app toast goes to the half of
 * the content area opposite the control that triggered it (capture-phase
 * trigger record, content band from the header bottom to the bottom safe
 * area), decided once when the toast is raised and never changed. From 768px
 * every app toast is top right (owner decision 2026-11-10, replacing the
 * earlier bottom right). Dialog toasters keep their own position: the dialog
 * reserves room for its toast, so it never covers Send.
 */
const MOBILE_QUERY = "(max-width: 767px)"
type AppPosition = "top-center" | "bottom-center" | "top-right" | "bottom-right"
const DESKTOP_POSITION: AppPosition = "top-right"

let placement: ToastPlacement | null = null
function getPlacement(): ToastPlacement {
  placement ??= createToastPlacement()
  return placement
}

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches
}

function decidePosition(id: string | number): AppPosition {
  if (!isMobileViewport()) return DESKTOP_POSITION
  const p = getPlacement()
  const half = p.positionFor(String(id), true)
  p.retain([])
  return half === "top" ? "top-center" : "bottom-center"
}

type Entry = {
  render: (id: string | number) => React.ReactElement
  duration: number
  toasterId?: string
  /** App toasts only: Sonner position, decided once (F2 rule 2). */
  position?: AppPosition
}
const entries = new Map<string | number, Entry>()

function emit(id: string | number, entry: Entry, duration = entry.duration) {
  sonner.custom(entry.render, {
    id,
    duration,
    toasterId: entry.toasterId,
    position: entry.position,
    onDismiss: () => entries.delete(id),
    onAutoClose: () => entries.delete(id),
  })
}

let nextId = 0
const heldForModal = new Set<string | number>()

/** An open modal (Base UI dialog, alert dialog, sheet). */
function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]') !== null
}

let observer: MutationObserver | null = null
function releaseWhenModalCloses() {
  if (observer) return
  observer = new MutationObserver(() => {
    if (modalOpen()) return
    observer?.disconnect()
    observer = null
    for (const id of heldForModal) {
      const entry = entries.get(id)
      if (entry) emit(id, entry)
    }
    heldForModal.clear()
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-open"] })
}

/** An exiting toast on the other half fades in place instead of sliding (F2 r2 CR-03). */
function orphan(id: string | number) {
  if (typeof document === "undefined") return
  const item = document.querySelector(`[data-toast-id="${CSS.escape(String(id))}"]`)?.closest("[data-sonner-toast]")
  item?.setAttribute("data-orphaned", "")
}

/** F2 rule 3: one half at a time. Live app toasts on the other half are superseded. */
function supersedeOtherHalf(position: AppPosition) {
  for (const [id, entry] of [...entries]) {
    if (entry.toasterId || !entry.position || entry.position === position) continue
    orphan(id)
    toast.dismiss(id)
  }
}

/** F2 rule 4: below 768px a submit press closes the previous attempt's app toasts. */
function closeAppToastsOnSubmit() {
  if (!isMobileViewport()) return
  // The press is already recorded, so the half its toast will use is known
  // now. A closing toast on the other half fades in place (r2 CR-03).
  const next = decidePosition("eve-next-press")
  for (const [id, entry] of [...entries]) {
    if (entry.toasterId) continue
    if (entry.position && entry.position !== next) orphan(id)
    toast.dismiss(id)
  }
}

function show(tone: ToastTone, title: string, options: ToastOptions = {}): string | number {
  const id = options.id ?? `eve-toast-${++nextId}`
  const duration = options.duration ?? (tone === "error" && options.action ? Infinity : TOAST_DURATION[tone])
  const existing = entries.get(id)
  const position = options.toasterId ? undefined : (existing?.position ?? decidePosition(id))
  if (position) supersedeOtherHalf(position)
  const entry: Entry = {
    duration,
    toasterId: options.toasterId,
    position,
    render: (toastId) => (
      <EveToast
        id={toastId}
        tone={tone}
        title={title}
        Icon={options.icon ?? TONE_ICON[tone]}
        action={options.action}
        onClose={options.onClose}
        inDialog={options.toasterId !== undefined}
      />
    ),
  }
  entries.set(id, entry)
  // An app toast raised under an open modal sits below its scrim (toast.css)
  // and its timer waits, so it is still there when the modal closes
  // (design-spec r3 Stacking).
  if (!options.toasterId && typeof document !== "undefined" && modalOpen()) {
    heldForModal.add(id)
    emit(id, entry, Infinity)
    releaseWhenModalCloses()
  } else {
    emit(id, entry)
  }
  return id
}

/** Holds a toast's timer while focus is inside it; restores it on blur. */
function hold(id: string | number, held: boolean) {
  const entry = entries.get(id)
  if (!entry || entry.duration === Infinity || heldForModal.has(id)) return
  emit(id, entry, held ? Infinity : entry.duration)
}

/** Whether a node is inside a toast list (app or dialog toaster). */
export function isInToaster(node: Element | null): boolean {
  return node?.closest("[data-sonner-toaster]") != null
}

export const toast = {
  error: (title: string, options?: ToastOptions) => show("error", title, options),
  success: (title: string, options?: ToastOptions) => show("success", title, options),
  warning: (title: string, options?: ToastOptions) => show("warning", title, options),
  info: (title: string, options?: ToastOptions) => show("info", title, options),
  /** Dismisses one toast, or every toast (and anything waiting on a modal) without an id. */
  dismiss: (id?: string | number) => {
    if (id === undefined) {
      entries.clear()
      heldForModal.clear()
      observer?.disconnect()
      observer = null
    } else {
      entries.delete(id)
      heldForModal.delete(id)
    }
    sonner.dismiss(id)
  },
  /** Dismisses every toast shown in one dialog toaster (ids may differ per toast). */
  dismissToaster: (toasterId: string) => {
    for (const [id, entry] of [...entries]) if (entry.toasterId === toasterId) toast.dismiss(id)
  },
}

type EveToastProps = {
  id: string | number
  tone: ToastTone
  title: string
  Icon: ToastIcon
  action?: ToastOptions["action"]
  onClose?: () => void
  /** In a dialog's toaster: the toast's own controls are its only tab stops. */
  inDialog: boolean
}

function EveToast({ id, tone, title, Icon, action, onClose, inDialog }: EveToastProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    // Sonner makes each item a tab stop; inside a dialog the tab order is
    // Send, Cancel, close, then the toast's action and close (r3 Toasts).
    const item = ref.current?.closest<HTMLElement>("[data-sonner-toast]")
    if (inDialog && item) item.tabIndex = -1
  }, [inDialog])
  const close = () => {
    toast.dismiss(id)
    onClose?.()
  }
  return (
    <div
      ref={ref}
      className="eve-toast"
      data-tone={tone}
      data-toast-id={id}
      onFocus={(event) => {
        hold(id, true)
        // Sonner returns focus to where it came from when focus leaves its
        // list. Inside a dialog that would break the focus trap's wrap, so the
        // dialog toast handles focus itself (close and action go to Send).
        if (inDialog) event.stopPropagation()
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hold(id, false)
        if (inDialog) event.stopPropagation()
      }}
    >
      <Icon aria-hidden="true" className="eve-toast-icon" />
      <p className="eve-toast-text">{title}</p>
      <div className="eve-toast-actions">
        {action ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              toast.dismiss(id)
              action.onClick()
            }}
          >
            {action.label}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="icon-sm" aria-label={toastCopy.closeLabel} onClick={close}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

export type ToasterProps = {
  /** Resolved theme, so Sonner's container matches (Sonner defaults to light). */
  theme?: "light" | "dark"
  /** Set for a dialog-owned toaster; toasts target it with `toasterId`. */
  id?: string
  /** The region's accessible name (`app.toast.region_label` by default). */
  label?: string
  position?: SonnerProps["position"]
  visibleToasts?: number
  /** A dialog's toaster sits in the dialog's tab order, so it takes no hotkey. */
  hotkey?: string[]
  className?: string
}

/** Dialog toasts swipe down only (design-spec r3 Motion). App toasts swipe toward their edge (F2). */
const SWIPE: SonnerProps["swipeDirections"] = ["bottom"]
/** From 768px: 16px from the top right, under the sticky header, 384px wide (owner decision 2026-11-10). */
const APP_STYLE = { "--width": "384px" } as React.CSSProperties
const MOBILE_OFFSET = { bottom: "calc(16px + env(safe-area-inset-bottom))", left: "16px", right: "16px" }
/** App toaster below 768px (F2 classes): top under the sticky header, bottom above the home indicator. */
const APP_OFFSET = {
  top: "calc(var(--header-height, 3.5rem) + env(safe-area-inset-top, 0px) + 0.5rem)",
  bottom: "max(1rem, calc(env(safe-area-inset-bottom, 0px) + 0.5rem))",
  left: "16px",
  right: "16px",
}
const APP_MOBILE_OFFSET = { ...APP_OFFSET }

/**
 * Renders the toasts. The app root mounts one (top right from 768 px,
 * centred between the gutters above and below that); a dialog that needs
 * feedback mounts its own with an `id`. Escape on a focused app toast
 * dismisses it; inside a dialog toaster Escape is left to the dialog, which
 * closes and dismisses its toasts.
 */
export function Toaster({
  theme = "light",
  id,
  label = toastCopy.regionLabel,
  // Not the desktop position: every app toast passes its own (top right from
  // 768px). This is the resting anchor of the toaster Sonner mounts first, and
  // it must not sit on a mobile half, or that half's toast would inherit a
  // right-edge x instead of centring (toast-mobile.test.tsx).
  position = "bottom-right",
  visibleToasts = 3,
  hotkey,
  className,
}: ToasterProps) {
  const ref = React.useRef<HTMLElement>(null)

  React.useEffect(() => {
    if (id) return
    // The app toaster owns the F2 trigger record and the submit-press rule.
    return getPlacement().install(closeAppToastsOnSubmit)
  }, [id])

  React.useLayoutEffect(() => {
    // Clicks inside the toast region are not triggers (toast-placement.ts).
    if (!id) ref.current?.setAttribute("data-slot", "toast-viewport")
  }, [id])

  React.useEffect(() => {
    if (id) return
    // Where focus was before it entered the toaster, so Escape can return it.
    let before: HTMLElement | null = null
    const onFocusIn = (event: FocusEvent) => {
      const region = ref.current
      if (region && event.target instanceof HTMLElement && !region.contains(event.target)) before = event.target
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const region = ref.current
      const active = document.activeElement
      if (!region || !active || !region.contains(active)) return
      const item = active.closest("[data-sonner-toast]") ?? region.querySelector("[data-sonner-toast]")
      const toastId = item?.querySelector<HTMLElement>("[data-toast-id]")?.dataset.toastId
      if (toastId === undefined) return
      toast.dismiss(toastId)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [id])

  return (
    <SonnerToaster
      ref={ref}
      id={id}
      theme={theme}
      position={position}
      offset={id ? 24 : APP_OFFSET}
      mobileOffset={id ? MOBILE_OFFSET : APP_MOBILE_OFFSET}
      visibleToasts={visibleToasts}
      gap={8}
      swipeDirections={id ? SWIPE : undefined}
      style={id ? undefined : APP_STYLE}
      hotkey={hotkey}
      customAriaLabel={label}
      dir={typeof document === "undefined" ? "ltr" : (document.dir as "ltr" | "rtl") || "ltr"}
      className={className ?? (id ? "eve-toaster" : "eve-toaster eve-app-toaster")}
    />
  )
}
