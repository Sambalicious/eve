import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"

import { automationStateQueryOptions } from "@/entities/automation-state"
import { ensureCsrfToken } from "@/entities/session"
import { isAdvancedOn, setAdvanced, useSetViewer, useViewer } from "@/entities/viewer"

/** The pause on Home and the link to Pause and cost, which turns Advanced on first when it is off (AC-1.6). */
export function useHomePause() {
  const state = useQuery(automationStateQueryOptions()).data
  const viewer = useViewer()
  const setViewer = useSetViewer()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)
  const advanced = isAdvancedOn(viewer)
  return {
    state,
    advanced,
    failed,
    goToPauseAndCost: async () => {
      try {
        if (!advanced) setViewer(await setAdvanced(true, await ensureCsrfToken(queryClient)))
        void navigate("/pause-and-cost")
      } catch {
        setFailed(true)
      }
    },
  }
}
