import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { ensureCsrfToken } from "@/entities/session"
import { setAdvanced, useSetViewer } from "@/entities/viewer"

/** "Turn on Advanced" from a hidden route (AC-3.6). A failed write keeps the note and reports it. */
export function useTurnOnAdvanced() {
  const queryClient = useQueryClient()
  const setViewer = useSetViewer()
  const [failed, setFailed] = useState(false)
  const mutation = useMutation({
    mutationFn: async () => setAdvanced(true, await ensureCsrfToken(queryClient)),
    onMutate: () => setFailed(false),
    onSuccess: setViewer,
    onError: () => setFailed(true),
  })
  return { turnOn: () => mutation.mutate(), isPending: mutation.isPending, failed }
}
