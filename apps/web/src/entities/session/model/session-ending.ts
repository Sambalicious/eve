import { createContext, useContext } from "react"

import type { ApiError } from "@/shared/api"
import {
  buildSignInPath,
  signInPathAfterUnauthorized,
  type DashboardLocation,
} from "../lib/sign-in-path"

/**
 * The one place that decides where a 401 sends the Candidate (FU-1).
 *
 * The first 401 of an expired session is `session_expired`, and that response
 * clears the cookie, so the requests after it get `unauthenticated`
 * (api-contract.md:76). They all belong to the same session ending, so once one
 * 401 said `session_expired`, every sign-in redirect carries `reason=expired`
 * (C-AUTH-2, design-spec.r4.md:46), whichever redirect comes last. A confirmed
 * session starts over, so a later unrelated `unauthenticated` has no reason.
 */
export interface SessionEnding {
  /** Notes a 401 from any API call. */
  record(error: ApiError): void
  /** The session was confirmed again (`GET /v1/session` succeeded). */
  reset(): void
  /** The sign-in page URL for a 401, with `from` as `next`. */
  signInPath(error: ApiError, from: DashboardLocation): string
}

export function createSessionEnding(): SessionEnding {
  let expired = false
  return {
    record(error) {
      if (error.code === "session_expired") expired = true
    },
    reset() {
      expired = false
    },
    signInPath(error, from) {
      return expired ? buildSignInPath(from, "expired") : signInPathAfterUnauthorized(error, from)
    },
  }
}

export const SessionEndingContext = createContext<SessionEnding | null>(null)

export function useSessionEnding(): SessionEnding {
  const sessionEnding = useContext(SessionEndingContext)
  if (!sessionEnding) throw new Error("useSessionEnding needs a SessionEndingContext provider")
  return sessionEnding
}
