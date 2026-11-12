import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common"
import { PREFERENCES_SAVE_LIMIT, PREFERENCES_SAVE_WINDOW_SECONDS } from "@eve/contracts"
import type { FastifyRequest } from "fastify"

import { SESSION_COOKIE } from "../auth/cookies.js"
import { hashToken } from "../auth/secure-token.js"
import { ApiException } from "../http/api-exception.js"
import { SlidingWindowLimiter } from "../http/sliding-window-limiter.js"
import { CLOCK, type Clock } from "../shared/clock.js"

/** R6-AC6: one limiter per api process, separate from the job-criteria limiter. */
@Injectable()
export class PreferencesSaveLimiter extends SlidingWindowLimiter {
  constructor() {
    super(PREFERENCES_SAVE_LIMIT, PREFERENCES_SAVE_WINDOW_SECONDS * 1_000)
  }
}

/**
 * `PUT /v1/me/preferences`: 10 attempts per session in a sliding 60 s window
 * (contract v1.25.0 `PreferencesSaveLimiter`). Route guards run after the
 * global AuthGuard, so session and CSRF refusals are not counted. Every other
 * attempt counts, 400, 409 and 200 alike, before the body is read. The key is
 * the SHA-256 of the session ID.
 */
@Injectable()
export class PreferencesSaveLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: PreferencesSaveLimiter,
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
