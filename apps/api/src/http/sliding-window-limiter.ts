export type LimitDecision = Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>

/**
 * In-process sliding-window counter (SEC-006). A key may make `limit` requests
 * in any `windowMs` span. Only allowed requests are recorded, so a client that
 * keeps retrying while refused does not push its own wait further out.
 *
 * State lives in this process only: a restart clears it, and two api replicas
 * would each allow `limit`. The api runs as one process (architecture), so that
 * is the intended scope.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()
  private lastSweep = Number.NEGATIVE_INFINITY

  constructor(
    readonly limit: number,
    readonly windowMs: number
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer")
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError("windowMs must be a positive integer")
  }

  /** Records a request for `key` at `now` (epoch ms) if it fits, otherwise refuses it. */
  take(key: string, now: number): LimitDecision {
    this.sweep(now)
    const recent = this.inWindow(key, now)
    if (recent.length < this.limit) {
      recent.push(now)
      this.hits.set(key, recent)
      return { allowed: true }
    }
    this.hits.set(key, recent)
    return { allowed: false, retryAfterSeconds: this.retryAfterSeconds(recent[0]!, now) }
  }

  /** Number of keys holding state; for tests and diagnostics. */
  trackedKeys(): number {
    return this.hits.size
  }

  /** The keys holding state; for tests that prove what is stored. */
  keys(): string[] {
    return [...this.hits.keys()]
  }

  reset(): void {
    this.hits.clear()
    this.lastSweep = Number.NEGATIVE_INFINITY
  }

  /** Requests in (now - window, now]. A request "in the future" (the clock moved back) is forgotten. */
  private inWindow(key: string, now: number): number[] {
    const cutoff = now - this.windowMs
    return (this.hits.get(key) ?? []).filter((time) => time > cutoff && time <= now)
  }

  /** Whole seconds until the oldest counted request leaves the window: at least 1, at most the window. */
  private retryAfterSeconds(oldest: number, now: number): number {
    const seconds = Math.ceil((oldest + this.windowMs - now) / 1000)
    return Math.min(Math.max(seconds, 1), Math.ceil(this.windowMs / 1000))
  }

  /** Drops keys with nothing left in the window, at most once per window, so memory stays bounded by active keys. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return
    this.lastSweep = now
    for (const key of [...this.hits.keys()]) {
      if (this.inWindow(key, now).length === 0) this.hits.delete(key)
    }
  }
}
