/**
 * A non-secret hint that this browser had a session, so the landing page at `/`
 * can stay hidden for one round trip instead of flashing the hero before the
 * redirect (architecture r1 section 1). The session cookie is `httpOnly`; this
 * key says only "probably signed in". The boot script in `index.html` reads the
 * same key and value.
 */
export const SESSION_HINT_KEY = "eve-session-hint"
const SIGNED_IN = "1"

export function readSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) === SIGNED_IN
  } catch {
    return false
  }
}

export function markSignedIn(): void {
  try {
    localStorage.setItem(SESSION_HINT_KEY, SIGNED_IN)
  } catch {
    // Blocked storage only costs the hint; the landing page shows once.
  }
}

export function clearSessionHint(): void {
  try {
    localStorage.removeItem(SESSION_HINT_KEY)
  } catch {
    // As above.
  }
}
