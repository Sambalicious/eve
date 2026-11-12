import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog"
import { ButtonSpinner } from "@/shared/ui/button-spinner"

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Empty for a confirmation whose title says everything. */
  body: string
  confirmLabel: string
  /** The cancel button's label; "Cancel" unless the copy names another (C-CONFIRM-E2-1 "Stay"). */
  cancelLabel?: string
  /** Shown on the confirm button while `isPending`, for example "Approving…". */
  pendingLabel: string
  isPending: boolean
  destructive?: boolean
  onConfirm: () => void
  /** Where focus goes on close, when the element that opened it is gone (for example a closed menu's item). */
  finalFocus?: React.RefObject<HTMLElement | null> | (() => HTMLElement | null | boolean)
  /** A failure shown inside the dialog above the footer, when the dialog stays open after a refused request. */
  alert?: React.ReactNode
  /**
   * While pending, keep both buttons focusable (`aria-disabled`, presses ignored)
   * instead of natively disabled, so focus never drops to <body> inside the open
   * modal (EPIC-0006 design-preview DP-1). The confirm button's ref is exposed for
   * focus after a refusal.
   */
  keepFocusWhilePending?: boolean
  confirmRef?: React.Ref<HTMLButtonElement>
  /**
   * A structured body between the header and the footer (apply-anyway design B2),
   * for content a plain `body` string can't hold. It is the dialog's description
   * (`aria-describedby`), so use it instead of `body`, not with it. It scrolls
   * inside the dialog while the footer stays visible.
   */
  children?: React.ReactNode
  /** 28rem from sm instead of 24rem, for a structured body (design B2). */
  wide?: boolean
}

/**
 * Confirmation for a consequential action (design-spec, Interaction patterns).
 * "Cancel" has initial focus; Escape counts as Cancel; outside clicks do not
 * close it. The dialog stays open while the request runs.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  pendingLabel,
  isPending,
  destructive = false,
  onConfirm,
  finalFocus,
  alert,
  keepFocusWhilePending = false,
  confirmRef,
  children,
  wide = false,
}: ConfirmDialogProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const nativeDisabled = isPending && !keepFocusWhilePending
  const ariaDisabled = isPending && keepFocusWhilePending ? true : undefined
  return (
    <AlertDialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <AlertDialogContent
        initialFocus={cancelRef}
        finalFocus={finalFocus}
        className={wide ? "data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-md" : undefined}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {body && !children && <AlertDialogDescription>{body}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children && (
          <AlertDialogDescription render={<div />} className="-mx-1 flex max-h-[50dvh] flex-col gap-3 overflow-y-auto px-1 text-left text-foreground">
            {children}
          </AlertDialogDescription>
        )}
        {alert}
        <AlertDialogFooter>
          <AlertDialogCancel
            ref={cancelRef}
            disabled={nativeDisabled}
            aria-disabled={ariaDisabled}
            onClick={(event) => {
              if (isPending) event.preventBaseUIHandler()
            }}
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            ref={confirmRef}
            variant={destructive ? "destructive" : "default"}
            aria-busy={isPending}
            disabled={nativeDisabled}
            aria-disabled={ariaDisabled}
            onClick={() => {
              if (!isPending) onConfirm()
            }}
          >
            {isPending && <ButtonSpinner />}
            {isPending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
