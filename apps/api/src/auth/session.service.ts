import { Inject, Injectable } from "@nestjs/common"
import { SESSION_IDLE_TIMEOUT_MS } from "@eve/contracts"

import { CLOCK, type Clock } from "../shared/clock.js"
import { generateSecureToken, hashToken } from "./secure-token.js"
import { SessionRepository } from "./session.repository.js"

/** `candidateId` scopes every Candidate query of the request (architecture r2, Tenancy mechanism 4). */
export type ActiveSession = Readonly<{ csrfToken: string; candidateId: string }>

export type SessionLookup =
  | { kind: "active"; session: ActiveSession }
  | { kind: "missing" }
  | { kind: "expired" }

@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Creates a session bound to the Candidate's row and returns the raw ID for the cookie. */
  async start(candidateId: string, googleSub: string): Promise<string> {
    const sessionId = generateSecureToken()
    await this.sessions.insert({
      idHash: hashToken(sessionId),
      csrfToken: generateSecureToken(),
      candidateId,
      googleSub,
      lastActiveAt: this.clock.now(),
    })
    return sessionId
  }

  /**
   * Resolves the cookie to an active session and records the activity. A
   * session is valid while less than 14 days have passed since its last
   * activity; at exactly 14 days it has expired and is deleted.
   */
  async resume(sessionId: string | undefined): Promise<SessionLookup> {
    if (!sessionId) return { kind: "missing" }
    const now = this.clock.now()
    const cutoff = new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS)
    const idHash = hashToken(sessionId)
    const stored = await this.sessions.touchIfActive(idHash, now, cutoff)
    if (!stored) {
      await this.sessions.delete(idHash)
      return { kind: "expired" }
    }
    return { kind: "active", session: { csrfToken: stored.csrfToken, candidateId: stored.candidateId } }
  }

  async end(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.sessions.delete(hashToken(sessionId))
  }
}
