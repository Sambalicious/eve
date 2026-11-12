import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { ensureCsrfToken } from "@/entities/session"
import { dismissNote, useSetViewer } from "@/entities/viewer"
import { homeCopy } from "@/entities/job-posting"
import { toast } from "@/shared/ui/toast"

const UNDO_MS = 6000

/**
 * Dismiss "Improve your results" (AC-2.5). The list hides at once with an Undo toast; the contract has no
 * un-dismiss route, so the request goes when the toast closes without Undo, or when the page unmounts.
 */
export function useDismissImprove() {
  const queryClient = useQueryClient()
  const setViewer = useSetViewer()
  const [hidden, setHidden] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const send = async () => {
    timer.current = null
    try {
      setViewer(await dismissNote("improve_results", await ensureCsrfToken(queryClient)))
    } catch {
      // Not dismissed on the server: the list returns on the next load, which is the safe direction.
    }
  }

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        void send()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return {
    hidden,
    dismiss: () => {
      setHidden(true)
      timer.current = setTimeout(() => void send(), UNDO_MS)
      toast.info(homeCopy.improve.dismissed, {
        duration: UNDO_MS,
        action: {
          label: homeCopy.improve.undo,
          onClick: () => {
            if (timer.current) clearTimeout(timer.current)
            timer.current = null
            setHidden(false)
          },
        },
      })
    },
  }
}
