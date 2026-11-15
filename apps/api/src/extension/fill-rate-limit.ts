/**
 * A small in-process throttle for `POST /v1/extension/fill` (LOW 3 in the
 * security review). It is keyed by Candidate id, is a fixed window, and lives in
 * one api process: with several api processes a Candidate gets one window per
 * process. That is deliberate for slice 1 (no shared store); the ADR says so.
 */
export const EXTENSION_FILL_LIMIT = 30
export const EXTENSION_FILL_WINDOW_MS = 60_000
/** Beyond this many Candidates the map is pruned of expired windows. */
const MAX_TRACKED_CANDIDATES = 1_000

type Window = { startedAt: number; count: number }

export class FillRateLimiter {
  private readonly windows = new Map<string, Window>()

  constructor(
    private readonly limit: number = EXTENSION_FILL_LIMIT,
    private readonly windowMs: number = EXTENSION_FILL_WINDOW_MS
  ) {}

  /** 0 when the request may run, or the whole seconds until the fixed window ends. */
  check(candidateId: string, now: number): number {
    this.prune(now)
    const window = this.windows.get(candidateId)
    if (window === undefined || now - window.startedAt >= this.windowMs) {
      this.windows.set(candidateId, { startedAt: now, count: 1 })
      return 0
    }
    if (window.count >= this.limit) return Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1_000))
    window.count += 1
    return 0
  }

  private prune(now: number): void {
    if (this.windows.size < MAX_TRACKED_CANDIDATES) return
    for (const [candidateId, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(candidateId)
    }
  }
}
