import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common"
import type { FastifyRequest } from "fastify"

import { SESSION_COOKIE } from "../auth/cookies.js"
import { hashToken } from "../auth/secure-token.js"
import { ApiException } from "../http/api-exception.js"
import { SlidingWindowLimiter } from "../http/sliding-window-limiter.js"
import { CLOCK, type Clock } from "../shared/clock.js"

/** SEC-006: each save re-decides every ranked or skipped posting in one transaction. */
export const JOB_CRITERIA_SAVES_PER_WINDOW = 10
export const JOB_CRITERIA_SAVE_WINDOW_MS = 60_000

/** One limiter per api process, shared by every request (Nest default singleton scope). */
@Injectable()
export class JobCriteriaSaveLimiter extends SlidingWindowLimiter {
  constructor() {
    super(JOB_CRITERIA_SAVES_PER_WINDOW, JOB_CRITERIA_SAVE_WINDOW_MS)
  }
}

/**
 * Limits `PUT /v1/candidate-settings/job-criteria` to 10 attempts per minute
 * per session (contract v1.15.0). Route guards run after the global AuthGuard,
 * so requests without a valid session or CSRF token are refused before they
 * are counted. Every authenticated attempt counts, valid or not. The key is the
 * SHA-256 of the session ID, the same hash the session table stores.
 */
@Injectable()
export class JobCriteriaSaveLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: JobCriteriaSaveLimiter,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const sessionId = context.switchToHttp().getRequest<FastifyRequest>().cookies[SESSION_COOKIE]
    if (!sessionId) throw new ApiException("unauthenticated")
    const decision = this.limiter.take(hashToken(sessionId), this.clock.now().getTime())
    if (!decision.allowed) throw ApiException.tooManyRequests(decision.retryAfterSeconds)
    return true
  }
}
