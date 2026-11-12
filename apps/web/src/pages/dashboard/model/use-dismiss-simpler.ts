import { useMutation, useQueryClient } from "@tanstack/react-query"

import { ensureCsrfToken } from "@/entities/session"
import { dismissNote, useSetViewer } from "@/entities/viewer"

export function useDismissSimplerNote() {
  const queryClient = useQueryClient()
  const setViewer = useSetViewer()
  const dismiss = useMutation({
    mutationFn: async () => dismissNote("simpler_now", await ensureCsrfToken(queryClient)),
    onSuccess: setViewer,
  })
  return { dismiss: () => dismiss.mutate(), isPending: dismiss.isPending }
}
