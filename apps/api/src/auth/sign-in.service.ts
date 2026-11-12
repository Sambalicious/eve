import { Inject, Injectable, Logger } from "@nestjs/common"
import {
  DEFAULT_RETURN_PATH,
  type SignInError,
  toSafeReturnPath,
} from "@eve/contracts"

import { CLOCK, type Clock } from "../shared/clock.js"
import { CandidateIdentityRepository } from "./candidate-identity.repository.js"
import { SIGN_IN_ATTEMPT_TTL_MS } from "./cookies.js"
import { GoogleOidcClient } from "./google-oidc.client.js"
import { generateSecureToken, hashToken } from "./secure-token.js"
import { SessionService } from "./session.service.js"
import { SignInAttemptRepository } from "./sign-in-attempt.repository.js"
import { decideSignIn } from "./sign-in-decision.js"

export type StartOutcome =
  | { kind: "already-signed-in"; returnPath: string }
  | { kind: "redirect-to-google"; googleUrl: URL; attemptId: string }
  | { kind: "failed"; returnPath: string }

export type CallbackOutcome =
  | { kind: "signed-in"; sessionId: string; returnPath: string }
  | { kind: "not-signed-in"; error: SignInError; returnPath: string; email?: string }

const GOOGLE_CANCELLED_ERROR = "access_denied"

@Injectable()
export class SignInService {
  private readonly logger = new Logger(SignInService.name)

  constructor(
    private readonly google: GoogleOidcClient,
    private readonly attempts: SignInAttemptRepository,
    private readonly sessions: SessionService,
    private readonly candidates: CandidateIdentityRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async start(requestedPath: unknown, sessionId: string | undefined): Promise<StartOutcome> {
    const returnPath = toSafeReturnPath(requestedPath)
    const existing = await this.sessions.resume(sessionId)
    if (existing.kind === "active") return { kind: "already-signed-in", returnPath }

    try {
      const request = await this.google.createAuthorizationRequest()
      const attemptId = generateSecureToken()
      const now = this.clock.now()
      await this.attempts.deleteCreatedBefore(new Date(now.getTime() - SIGN_IN_ATTEMPT_TTL_MS))
      await this.attempts.insert(hashToken(attemptId), {
        state: request.state,
        nonce: request.nonce,
        codeVerifier: request.codeVerifier,
        returnPath,
        createdAt: now,
      })
      return { kind: "redirect-to-google", googleUrl: request.url, attemptId }
    } catch (error) {
      this.logFailure("start", error)
      return { kind: "failed", returnPath }
    }
  }

  async complete(
    callbackQuery: URLSearchParams,
    attemptId: string | undefined
  ): Promise<CallbackOutcome> {
    const attempt = attemptId ? await this.attempts.take(hashToken(attemptId)) : undefined
    if (!attempt || this.isStale(attempt.createdAt)) {
      return { kind: "not-signed-in", error: "failed", returnPath: DEFAULT_RETURN_PATH }
    }
    const { returnPath } = attempt

    const googleError = callbackQuery.get("error")
    if (googleError) {
      const error = googleError === GOOGLE_CANCELLED_ERROR ? "cancelled" : "failed"
      return { kind: "not-signed-in", error, returnPath }
    }

    try {
      const identity = await this.google.completeAuthorization(callbackQuery, attempt)
      const decision = decideSignIn(identity, await this.candidates.findBySub(identity.sub))
      if (decision.kind === "refused") {
        this.logger.warn("Refused sign-in from a Google account not bound to an active Candidate")
        return {
          kind: "not-signed-in",
          error: "account_refused",
          returnPath,
          ...(decision.displayEmail ? { email: decision.displayEmail } : {}),
        }
      }
      // decideSignIn accepts only a verified email, so the captured address is Google-verified.
      if (identity.email) await this.candidates.captureEmailIfMissing(decision.candidateId, identity.email)
      const sessionId = await this.sessions.start(decision.candidateId, decision.googleSub)
      return { kind: "signed-in", sessionId, returnPath }
    } catch (error) {
      this.logFailure("callback", error)
      return { kind: "not-signed-in", error: "failed", returnPath }
    }
  }

  private isStale(createdAt: Date): boolean {
    return this.clock.now().getTime() - createdAt.getTime() > SIGN_IN_ATTEMPT_TTL_MS
  }

  /** Logs the error class and code only: OIDC errors can quote token material. */
  private logFailure(step: string, error: unknown): void {
    const name = error instanceof Error ? error.name : "UnknownError"
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? ` (${error.code})`
        : ""
    this.logger.warn(`Google sign-in ${step} failed: ${name}${code}`)
  }
}
