import { useLayoutEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Navigate, useLocation } from "react-router-dom"
import { DEFAULT_RETURN_PATH } from "@eve/contracts"

import { readSessionHint, sessionQueryOptions } from "@/entities/session"
import { decideLanding, SESSION_HOLD_MS, type LandingPath, type SessionState } from "../model/landing-route"
import { LandingContent } from "./landing-content"

/**
 * `/` and `/about` (architecture r1 section 1). `/` sends a signed-in Candidate
 * to the dashboard by replace. With the session hint set, the page stays
 * blank for at most 2 s while the session is checked; any error shows the
 * page with no error UI.
 */
export function LandingPage() {
  const { pathname } = useLocation()
  const path: LandingPath = pathname === "/about" ? "/about" : "/"
  const session = useQuery(sessionQueryOptions())
  const [hint] = useState(readSessionHint)
  const holdExpired = useHoldExpired(hint)

  const state: SessionState = session.isSuccess ? "success" : session.isError ? "error" : "pending"
  const decision = decideLanding({ path, hint, session: state, heldMs: holdExpired ? SESSION_HOLD_MS : 0 })

  useLayoutEffect(() => {
    if (decision === "show") document.documentElement.classList.remove("session-pending")
  }, [decision])

  if (decision === "redirect") return <Navigate to={DEFAULT_RETURN_PATH} replace />
  if (decision === "hold") return <div data-landing-root className="min-h-svh bg-background" />
  return <LandingContent path={path} signedIn={session.isSuccess} />
}

function useHoldExpired(hint: boolean): boolean {
  const [expired, setExpired] = useState(!hint)
  useLayoutEffect(() => {
    if (expired) return
    const timer = window.setTimeout(() => setExpired(true), SESSION_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [expired])
  return expired
}
