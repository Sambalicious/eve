import { Inject, Injectable, Logger } from "@nestjs/common"
import { SESSION_IDLE_TIMEOUT_MS } from "@eve/contracts"

import { CLOCK, type Clock } from "../shared/clock.js"
import { swallowAndLog } from "../shared/swallow-and-log.js"
import { SIGN_IN_ATTEMPT_TTL_MS } from "./cookies.js"
import { SessionRepository } from "./session.repository.js"
import { SESSION_ABSOLUTE_LIFETIME_MS } from "./session.service.js"
import { SignInAttemptRepository } from "./sign-in-attempt.repository.js"

export type AuthCleanupCounts = Readonly<{ attempts: number; sessions: number }>

/**
 * Housekeeping for the two auth tables, run by the worker's hourly
 * `auth.cleanup` job. The request path no longer deletes old rows: a presented
 * attempt or session is still refused at use time, on the same TTLs (the
 * attempt TTL, the session's idle expiry and its 30 day absolute lifetime), so
 * this only stops abandoned rows accumulating.
 *
 * The tables carry no Candidate scope (no RLS policy, like the other identity
 * tables), and the runtime role holds DELETE on them, so one unscoped delete
 * per table reaches every row, as the request path's delete did.
 *
 * The two deletes are independent: a failure is logged through `swallowAndLog`
 * and the other table's delete still runs, so a stuck table cannot stop the
 * sweep; neither failure escapes the job.
 */
@Injectable()
export class AuthTableCleanup {
  private readonly logger = new Logger(AuthTableCleanup.name)

  constructor(
    private readonly attempts: SignInAttemptRepository,
    private readonly sessions: SessionRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async run(): Promise<AuthCleanupCounts> {
    const now = this.clock.now()
    const attempts =
      (await this.attempts
        .deleteCreatedBefore(new Date(now.getTime() - SIGN_IN_ATTEMPT_TTL_MS))
        .catch(swallowAndLog(this.logger, "auth.cleanup.sign_in_attempt"))) ?? 0
    const sessions =
      (await this.sessions
        .deleteExpired(new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS), new Date(now.getTime() - SESSION_ABSOLUTE_LIFETIME_MS))
        .catch(swallowAndLog(this.logger, "auth.cleanup.dashboard_session"))) ?? 0
    if (attempts + sessions > 0) this.logger.log(JSON.stringify({ event: "auth.cleanup", attempts, sessions }))
    return { attempts, sessions }
  }
}
