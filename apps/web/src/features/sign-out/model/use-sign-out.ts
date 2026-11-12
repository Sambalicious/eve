import { SIGN_IN_PAGE_PATH } from "@eve/contracts"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"

import { clearSessionHint, sessionQueryOptions } from "@/entities/session"
import { isUnauthorizedError } from "@/shared/api"
import { toast } from "@/shared/ui/toast"
import { logout } from "../api/logout"

/** C-ERR-2 with the action name, design-spec.r1.md copy catalogue. */
const SIGN_OUT_FAILED = "Couldn't sign out. Nothing changed. Try again."

/**
 * Signs the Candidate out and lands on the sign-in page. A 401 means the
 * session had already ended, which is the outcome the Candidate asked for.
 * Any other failure keeps them signed in and says so.
 */
export function useSignOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const leaveDashboard = () => {
    queryClient.clear()
    clearSessionHint()
    void navigate(SIGN_IN_PAGE_PATH, { replace: true })
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const session = await queryClient.ensureQueryData(sessionQueryOptions())
      await logout(session.csrfToken)
    },
    meta: { handlesUnauthorized: true },
    onSuccess: leaveDashboard,
    onError: (error) => {
      if (isUnauthorizedError(error)) return leaveDashboard()
      toast.error(SIGN_OUT_FAILED)
    },
  })

  return {
    /** `onFailed` runs when the Candidate stays signed in, after the error toast. */
    signOut: (onFailed?: () => void) =>
      mutation.mutate(undefined, {
        onError: (error) => {
          if (!isUnauthorizedError(error)) onFailed?.()
        },
      }),
    isSigningOut: mutation.isPending,
  }
}
