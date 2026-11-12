/** The longest the page stays blank while a hinted session is checked (fail open). */
export const SESSION_HOLD_MS = 2000

export type LandingPath = "/" | "/about"
export type SessionState = "pending" | "success" | "error"
export type LandingDecision = "redirect" | "hold" | "show"

interface LandingInput {
  path: LandingPath
  /** The browser had a session last time (`eve-session-hint`). */
  hint: boolean
  session: SessionState
  /** How long the page has been holding for the session check. */
  heldMs: number
}

/**
 * Architecture r0 section 1: `/` sends a signed-in Candidate to the dashboard;
 * `/about` always shows the page. With the hint set, both hold for at most
 * {@link SESSION_HOLD_MS} so neither the hero (on `/`) nor "Sign in" turning
 * into "Open dashboard" (on `/about`) is seen. Any error shows the page.
 */
export function decideLanding({ path, hint, session, heldMs }: LandingInput): LandingDecision {
  if (path === "/" && session === "success") return "redirect"
  if (session === "pending" && hint && heldMs < SESSION_HOLD_MS) return "hold"
  return "show"
}
