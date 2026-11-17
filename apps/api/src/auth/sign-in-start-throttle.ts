import { Inject, Injectable } from "@nestjs/common"

import { APP_CONFIG } from "../config/config.module.js"
import type { AppConfig } from "../config/env.js"
import { SlidingWindowLimiter } from "../http/sliding-window-limiter.js"
import { CLOCK, type Clock } from "../shared/clock.js"

/**
 * `GET /v1/auth/google/start` is public and stores a row per call, so it is throttled. Behind a
 * trusted proxy each client address gets its own budget; with TRUST_PROXY=0 every visitor shares
 * the proxy's address, so one larger shared budget is used instead of locking everyone out together.
 */
@Injectable()
export class SignInStartThrottle {
  private readonly perAddress = new SlidingWindowLimiter(30, 60_000)
  private readonly shared = new SlidingWindowLimiter(300, 60_000)

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** True when this start may go ahead; records it. */
  allow(ip: string): boolean {
    const perIp = this.config.accessRequest.trustProxy > 0
    return (perIp ? this.perAddress : this.shared).take(perIp ? ip : "all", this.clock.now().getTime()).allowed
  }
}
