import { SIGN_IN_PAGE_PATH, toSafeReturnPath } from "@eve/contracts"

import type { ApiError } from "@/shared/api"

/** A dashboard location: path, query, and hash. */
export interface DashboardLocation {
  pathname: string
  search: string
  hash: string
}

/**
 * The sign-in page URL that returns the Candidate to `from` after sign-in.
 * `expired` makes the page show the session-ended message (C-AUTH-2).
 */
export function buildSignInPath(
  from: DashboardLocation,
  reason?: "expired"
): string {
  const params = new URLSearchParams({ next: toSafeReturnPath(toPath(from)) })
  if (reason) params.set("reason", reason)
  return `${SIGN_IN_PAGE_PATH}?${params.toString()}`
}

/** Where to send the Candidate after the API refused a request with 401. */
export function signInPathAfterUnauthorized(
  error: ApiError,
  from: DashboardLocation
): string {
  const reason = error.code === "session_expired" ? "expired" : undefined
  return buildSignInPath(from, reason)
}

function toPath({ pathname, search, hash }: DashboardLocation): string {
  return `${pathname}${search}${hash}`
}
