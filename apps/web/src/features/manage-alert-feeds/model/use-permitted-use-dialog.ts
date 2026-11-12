import { useEffect, useRef, useState } from "react"

import type { RegisterFeedFormHandle } from "../ui/register-feed-form"

export type PermittedUseDialog = "closed" | "record" | "update"

/**
 * The permitted-use dialog's open state and focus rules, shared by the Stack
 * posts and Hiring Alert feeds sections (EPIC-0007 design-spec r2 H6b steps 6
 * and 9; EPIC-0008 design-spec S2 step 6). A first record goes to Feed URL, the
 * next step; an update, Cancel or Escape goes back to the opener, which is on
 * the page already. Feed URL only exists once the saved feeds reach the
 * section, and React Query delivers them on its own tick, which a browser may
 * run after the next frame (P3-G-06). So a first record waits for the render
 * that mounts the form instead of guessing a frame.
 */
export function usePermittedUseDialog(recorded: boolean) {
  const [dialog, setDialog] = useState<PermittedUseDialog>("closed")
  const recordRef = useRef<HTMLButtonElement>(null)
  const updateRef = useRef<HTMLButtonElement>(null)
  const formRef = useRef<RegisterFeedFormHandle>(null)
  /** Set by a first record; consumed once the recorded branch, and so Feed URL, has rendered. */
  const [focusUrlPending, setFocusUrlPending] = useState(false)

  const close = (saved: boolean) => {
    const opened = dialog
    setDialog("closed")
    if (saved && opened === "record") return setFocusUrlPending(true)
    requestAnimationFrame(() => (opened === "record" ? recordRef : updateRef).current?.focus())
  }

  useEffect(() => {
    if (!focusUrlPending || !recorded) return
    const input = formRef.current?.urlInput()
    if (!input) return
    input.focus()
    setFocusUrlPending(false)
  }, [focusUrlPending, recorded])

  return { dialog, open: setDialog, close, recordRef, updateRef, formRef }
}
