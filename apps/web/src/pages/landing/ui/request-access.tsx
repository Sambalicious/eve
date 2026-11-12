import { useCallback, useRef, useState, type ComponentType } from "react"

import type { RequestAccessFormProps } from "@/features/request-access"
import { useResolvedDark } from "@/features/toggle-theme"
import { Button } from "@/shared/ui/button"
import { Dialog, DialogPortal, DialogTrigger } from "@/shared/ui/dialog"
import { OverlayHeader } from "@/shared/ui/overlay-header"
import { Toaster, toast } from "@/shared/ui/toast"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { landingCopy } from "../model/copy"
import { loadRequestAccessForm } from "../model/request-access-loader"
import { REQUEST_TOASTER, REQUEST_TOAST_IDS } from "../model/request-toasts"

const c = landingCopy.request
type Form = ComponentType<RequestAccessFormProps>
type Chunk = { status: "loading" } | { status: "ready"; Form: Form } | { status: "failed" }

/**
 * The section 6 "Request access" button and its dialog shell (design-spec r3
 * S2, architecture r1 8.1 to 8.4). The shell and header are in the landing
 * chunk; the form loads on hover, focus or press. While it loads the body is
 * a text-free skeleton; a failed load freezes it and raises a load-error
 * toast with Try again in the dialog's own toaster.
 *
 * The popup is grid-centred inside Base UI's viewport and has no resting
 * transform, so the in-dialog toaster (position: fixed) is placed against the
 * viewport, inside the focus trap, outside the inert page (r3 Toasts).
 */
export function RequestAccess() {
  const [open, setOpen] = useState(false)
  const [openCount, setOpenCount] = useState(0)
  const [openedAt, setOpenedAt] = useState(0)
  const [chunk, setChunk] = useState<Chunk>({ status: "loading" })
  const [announcement, setAnnouncement] = useState("")
  const panelRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(false)
  /** The 200 ms entrance; a toast raised during it waits for it to settle. */
  const settled = useRef<Promise<void>>(Promise.resolve())
  const settle = useRef<() => void>(() => undefined)
  const dark = useResolvedDark()

  const load = useCallback(function load() {
    loadRequestAccessForm().then(
      (module) => {
        toast.dismiss(REQUEST_TOAST_IDS.load)
        setChunk({ status: "ready", Form: module.RequestAccessForm })
      },
      () => {
        setChunk((current) => (current.status === "ready" ? current : { status: "failed" }))
        void settled.current.then(() => {
          if (!openRef.current) return
          toast.error(c.errorLoad, {
            id: REQUEST_TOAST_IDS.load,
            toasterId: REQUEST_TOASTER,
            duration: Infinity,
            action: {
              label: c.retry,
              onClick: () => {
                setChunk({ status: "loading" })
                load()
              },
            },
          })
        })
      }
    )
  }, [])

  const prefetch = useCallback(() => {
    void loadRequestAccessForm().catch(() => undefined)
  }, [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        openRef.current = next
        setOpen(next)
        if (next) {
          settled.current = new Promise((resolve) => (settle.current = resolve))
          setOpenCount((n) => n + 1)
          setOpenedAt(Date.now())
          setAnnouncement("")
          setChunk((current) => (current.status === "ready" ? current : { status: "loading" }))
          load()
        } else {
          // F9: a toast never outlives the form it is about.
          toast.dismissToaster(REQUEST_TOASTER)
        }
      }}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) settle.current()
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" />}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" && window.matchMedia("(hover: hover)").matches) prefetch()
        }}
        onFocus={prefetch}
      >
        {landingCopy.access.requestButton}
      </DialogTrigger>
      <DialogPortal>
        <DialogPrimitive.Backdrop className="request-dialog-backdrop fixed inset-0 isolate z-50 bg-(--scrim)" />
        <DialogPrimitive.Viewport className="request-dialog-viewport fixed inset-0 z-50">
          <DialogPrimitive.Popup
            ref={panelRef}
            initialFocus={panelRef}
            tabIndex={-1}
            aria-modal="true"
            className="request-dialog flex w-[min(440px,calc(100vw-32px))] flex-col rounded-2xl bg-popover text-sm text-popover-foreground shadow-overlay ring-1 ring-border outline-none"
          >
            <OverlayHeader title={c.title} closeLabel={c.closeLabel} closePlacement="end">
              {chunk.status === "ready" ? (
                <chunk.Form key={openCount} openedAt={openedAt} onAnnounce={setAnnouncement} toasterId={REQUEST_TOASTER} />
              ) : (
                <Skeleton frozen={chunk.status === "failed"} />
              )}
            </OverlayHeader>
            <div role="status" aria-live="polite" className="sr-only">
              {announcement}
            </div>
            <Toaster
              id={REQUEST_TOASTER}
              label={c.toastRegionLabel}
              theme={dark ? "dark" : "light"}
              position="bottom-center"
              visibleToasts={1}
              hotkey={[]}
              className="eve-toaster request-toaster"
            />
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    </Dialog>
  )
}

/** Three muted bars (label 80×12, field full×40, field full×100). No text, no spinner; still after a failed load. */
function Skeleton({ frozen }: { frozen: boolean }) {
  return (
    <div
      aria-busy={frozen ? "false" : "true"}
      data-frozen={frozen || undefined}
      data-testid="request-skeleton"
      className="request-skeleton grid gap-3 px-6 pt-5 pb-6"
    >
      <div className="h-3 w-20 rounded bg-muted" />
      <div className="h-10 rounded-lg bg-muted" />
      <div className="h-[100px] rounded-lg bg-muted" />
    </div>
  )
}
