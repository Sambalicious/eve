import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ApiErrorCode } from "@eve/contracts"

import {
  careerProfileQueryKey,
  careerProfileQueryOptions,
  uploadRefusalProblem,
  uploadResume,
  type ResumeProblem,
  type UploadRefusal,
} from "@/entities/career-profile"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"
import { isAcceptableResume } from "./resume-file"

/** Contract error codes the drop zone explains with its own copy (design-spec.r3 F1). */
const REFUSAL_KINDS: Partial<Record<ApiErrorCode, UploadRefusal["kind"]>> = {
  resume_file_invalid: "wrong_file",
  payload_too_large: "wrong_file",
  unsupported_media_type: "wrong_file",
  resume_storage_unavailable: "storage_unavailable",
  ai_provider_not_approved: "not_approved",
  ai_provider_not_configured: "not_configured",
  resume_drafting_in_progress: "drafting_in_progress",
  career_profile_draft_exists: "draft_exists",
}

/**
 * Sends a resume for drafting. Every failure stays inline under the drop zone,
 * including 5xx (design-spec.r3 Errors, resume upload exception). The hook
 * keeps what was refused and turns it into copy against the latest profile, so
 * C-PROFILE-15 names the draft once the 409's refetch brings it in.
 */
export function useUploadResume(): { upload: (file: File) => void; isUploading: boolean; refusal: ResumeProblem | null } {
  const queryClient = useQueryClient()
  const [refusal, setRefusal] = useState<UploadRefusal | null>(null)
  const { data: profile } = useQuery(careerProfileQueryOptions())

  const mutation = useMutation({
    mutationFn: async (file: File) => uploadResume(file, await ensureCsrfToken(queryClient)),
    onMutate: () => setRefusal(null),
    onSuccess: (profile) => queryClient.setQueryData(careerProfileQueryKey, profile),
    onError: (error) => {
      setRefusal(toUploadRefusal(error))
      // A state refusal means the page is stale: refetch so C-PROFILE-14 and C-PROFILE-15 can name the filename or draft.
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: careerProfileQueryKey })
      }
    },
  })

  const upload = (file: File) => {
    if (!isAcceptableResume(file)) {
      setRefusal({ kind: "wrong_file" })
      return
    }
    mutation.mutate(file)
  }

  return {
    upload,
    isUploading: mutation.isPending,
    refusal: refusal && uploadRefusalProblem(refusal, profile),
  }
}

export function toUploadRefusal(error: unknown): UploadRefusal {
  if (!(error instanceof ApiError) || error.code === null) return { kind: "failed", action: "upload your resume" }
  if (error.code === "resume_unreadable") return { kind: "unreadable", reason: error.reason }
  const kind = REFUSAL_KINDS[error.code]
  return kind && kind !== "unreadable" && kind !== "failed" ? { kind } : { kind: "failed", action: "upload your resume" }
}
