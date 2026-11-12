import type * as React from "react"

import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { useSignOut } from "../model/use-sign-out"

/**
 * Confirms sign-out. Rendered outside the account menu, which unmounts its
 * items when it closes. It stays open while the request runs; on failure it
 * closes, the error toast shows, and focus returns to `finalFocus`.
 */
export function SignOutDialog({
  open,
  onOpenChange,
  finalFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus?: React.RefObject<HTMLElement | null>
}) {
  const { signOut, isSigningOut } = useSignOut()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sign out?"
      body="You'll need to sign in with Google again to open your dashboard."
      confirmLabel="Sign out"
      pendingLabel="Signing out…"
      isPending={isSigningOut}
      onConfirm={() => signOut(() => onOpenChange(false))}
      finalFocus={finalFocus}
    />
  )
}
