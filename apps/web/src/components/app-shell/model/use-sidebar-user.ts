import { useQuery } from "@tanstack/react-query"

import { contactQueryOptions } from "@/entities/candidate-settings"

const FALLBACK_NAME = "Candidate"

export interface SidebarUser {
  name: string
  email: string
  avatar: string
}

/**
 * The sidebar footer shows the name from the Candidate's contact details.
 * Google sign-in asks only for `openid email`, so contact details are the
 * only stored name. Null while they load (the footer shows a skeleton);
 * without a saved name, or if the read fails, it falls back to "Candidate".
 */
export function useSidebarUser(): SidebarUser | null {
  const { data, isPending, isError } = useQuery(contactQueryOptions())
  if (isPending && !isError) return null
  const fullName = data?.fullName.trim() ?? ""
  return { name: fullName !== "" ? fullName : FALLBACK_NAME, email: "", avatar: "" }
}
