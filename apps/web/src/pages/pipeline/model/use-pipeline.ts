import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ensureCsrfToken } from "@/entities/session"
import { leadsQueryKey, leadsQueryOptions, removeLead, setLeadStage, type Lead, type LeadStage } from "@/entities/lead"
import { toast } from "@/shared/ui/toast"
import { pipelineCopy } from "./pipeline-copy"

/** GET plus the two writes the board needs, each refreshing the list. */
export function usePipeline() {
  const queryClient = useQueryClient()
  const query = useQuery(leadsQueryOptions())
  const refresh = () => void queryClient.invalidateQueries({ queryKey: leadsQueryKey })

  const move = useMutation({
    mutationFn: async (input: { jobPostingId: string; stage: LeadStage }) =>
      setLeadStage(input.jobPostingId, input.stage, await ensureCsrfToken(queryClient)),
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: async (jobPostingId: string) => removeLead(jobPostingId, await ensureCsrfToken(queryClient)),
    onSuccess: (_data, jobPostingId) => {
      refresh()
      const lead = query.data?.find((candidate) => candidate.jobPostingId === jobPostingId)
      if (lead) toast.success(pipelineCopy.removed(lead.roleTitle ?? "Job"))
    },
  })

  /** One click, then an Undo toast: no dialog, and the previous stage comes back exactly. */
  const markApplied = (lead: Lead) => {
    move.mutate(
      { jobPostingId: lead.jobPostingId, stage: "applied" },
      {
        onSuccess: () => {
          refresh()
          toast.success(pipelineCopy.applied(lead.roleTitle ?? "Job"), {
            action: { label: pipelineCopy.undo, onClick: () => move.mutate({ jobPostingId: lead.jobPostingId, stage: lead.stage }) },
          })
        },
      }
    )
  }

  return { query, move, remove, markApplied }
}
