export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

export type PerIpLimits = Readonly<{ perHour: number; perDay: number }>

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * Per-IP rule (AC 11.8). `entries` are the creation times of accepted requests and
 * silent drops for one IP hash. Rolling windows: an entry exactly 1 h (or 24 h) old
 * no longer counts. When both rules fail, the larger Retry-After wins.
 */
export function decidePerIp(entries: readonly Date[], now: Date, limits: PerIpLimits): RateDecision {
  const nowMs = now.getTime()
  const times = entries.map((entry) => entry.getTime()).sort((a, b) => a - b)
  const day = times.filter((t) => t > nowMs - DAY_MS)
  const hour = day.filter((t) => t > nowMs - HOUR_MS)
  const waits: number[] = []
  if (hour.length >= limits.perHour) waits.push(hour[hour.length - limits.perHour]! + HOUR_MS - nowMs)
  if (day.length >= limits.perDay) waits.push(day[day.length - limits.perDay]! + DAY_MS - nowMs)
  return waits.length === 0 ? { allowed: true } : { allowed: false, retryAfterSeconds: toSeconds(Math.max(...waits)) }
}

/** Global rule (AC 11.9): `acceptedToday` counts accepted requests since 00:00 UTC. */
export function decideGlobal(acceptedToday: number, now: Date, perDay: number): RateDecision {
  return acceptedToday < perDay ? { allowed: true } : { allowed: false, retryAfterSeconds: secondsToNextUtcMidnight(now) }
}

export function secondsToNextUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return toSeconds(next - now.getTime())
}

/** Start of the current UTC day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function toSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}
