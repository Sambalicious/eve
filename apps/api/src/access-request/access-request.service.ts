import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import { normalizeAccessRequest } from "@eve/contracts"

import { APP_CONFIG } from "../config/config.module.js"
import type { AppConfig } from "../config/env.js"
import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { AccessRequestRepository, type SubmissionOutcome } from "./access-request.repository.js"
import { hashClientIp } from "./client-ip.js"
import { issueProof, verifyProof } from "./fill-proof.js"

/** At most this many access-request transactions in flight per process (pool protection, 7.5). */
export const ACCESS_REQUEST_CONCURRENCY = 2
/** Postgres `lock_not_available`, raised when the advisory lock wait passes `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03"

/**
 * Order of checks (architecture.r1 7.4). The transport gate already ran.
 * Validation comes before the limits and stores nothing; the limits come before
 * the silent checks, so a bot learns nothing from a drop. The mailer state is
 * never read here.
 */
@Injectable()
export class AccessRequestService implements OnModuleInit {
  private readonly logger = new Logger(AccessRequestService.name)
  private inFlight = 0

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly repository: AccessRequestRepository
  ) {}

  onModuleInit(): void {
    if (this.config.accessRequest.trustProxy === 0) {
      this.logger.warn("TRUST_PROXY is 0: access requests are limited by the global cap only")
    }
  }

  proof(): { proof: string } {
    return { proof: issueProof(this.clock.now().getTime(), this.config.accessRequest.keys.proofKey()) }
  }

  async submit(body: unknown, clientIp: string): Promise<void> {
    const request = normalizeAccessRequest(body)
    if (!request.ok) throw ApiException.accessRequestInvalid(request.fields)
    if (this.inFlight >= ACCESS_REQUEST_CONCURRENCY) throw new ApiException("service_unavailable")

    const { keys, limits, trustProxy } = this.config.accessRequest
    const now = this.clock.now()
    const proofOk = verifyProof(request.proof, now.getTime(), keys.proofKey())
    this.inFlight += 1
    let outcome: SubmissionOutcome
    try {
      outcome = await this.repository.submit({
        now,
        ipHash: hashClientIp(clientIp, keys.ipKey()),
        limits: { perIpHour: limits.perIpHour, perIpDay: limits.perIpDay, globalDay: limits.globalDay, perIpEnabled: trustProxy > 0 },
        drop: request.honeypot ? "honeypot" : proofOk ? null : "fill_time",
        email: request.email,
        emailKey: request.emailKey,
        note: request.note,
      })
    } catch (error) {
      if (isLockTimeout(error)) throw new ApiException("service_unavailable")
      throw error
    } finally {
      this.inFlight -= 1
    }

    if (outcome.kind === "rate_limited_ip" || outcome.kind === "rate_limited_global") {
      this.logger.log(`access request refused: ${outcome.kind}`)
      throw ApiException.rateLimited(outcome.kind, outcome.retryAfterSeconds)
    }
    this.logger.log(outcome.kind === "dropped" ? "access request dropped" : `access request accepted (${outcome.newWindow ? "new window" : "coalesced"})`)
  }
}

function isLockTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === LOCK_NOT_AVAILABLE
}
