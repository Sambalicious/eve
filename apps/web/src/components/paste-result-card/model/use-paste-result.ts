import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { checkAgain, jobPostingQueryOptions, jobPostingsQueryKey } from "@/entities/job-posting"
import { ensureCsrfToken } from "@/entities/session"

/** The pasted posting (polled while Checking) and the "Check again" request. */
export function usePasteResult(postingId: string) {
  const queryClient = useQueryClient()
  const posting = useQuery(jobPostingQueryOptions(postingId))
  const recheck = useMutation({
    mutationFn: async () => checkAgain(await ensureCsrfToken(queryClient)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: jobPostingsQueryKey }),
  })
  return { posting, recheck }
}
