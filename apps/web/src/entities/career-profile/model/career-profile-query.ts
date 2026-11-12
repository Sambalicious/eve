import { queryOptions } from "@tanstack/react-query"

import { fetchCareerProfile, fetchProfileVersion } from "../api/career-profile-repository"
import type { CareerProfile } from "./career-profile"

export const careerProfileQueryKey = ["career-profile"] as const

/** Polling interval while a resume is being drafted (design-spec, Real-time updates: 5 s). */
export const DRAFTING_POLL_MS = 5000

/** After this long in "Drafting", the page shows C-ERR-4 instead of waiting silently. */
export const DRAFTING_TIMEOUT_MS = 10 * 60 * 1000

/**
 * The Career Profile. Polls while drafting runs; React Query stops polling
 * while the tab is hidden.
 */
export function careerProfileQueryOptions() {
  return queryOptions({
    queryKey: careerProfileQueryKey,
    queryFn: fetchCareerProfile,
    refetchInterval: (query) => (isDraftingWithinTimeout(query.state.data) ? DRAFTING_POLL_MS : false),
  })
}

export function profileVersionQueryOptions(version: number) {
  return queryOptions({
    queryKey: [...careerProfileQueryKey, "version", version] as const,
    queryFn: () => fetchProfileVersion(version),
  })
}

function isDraftingWithinTimeout(profile: CareerProfile | undefined): boolean {
  const drafting = profile?.drafting
  return drafting?.status === "drafting" && !hasDraftingTimedOut(drafting.startedAt)
}

/** True once drafting has run longer than the polling limit (then the page shows C-ERR-4). */
export function hasDraftingTimedOut(startedAt: string, now: number = Date.now()): boolean {
  return now - new Date(startedAt).getTime() >= DRAFTING_TIMEOUT_MS
}
