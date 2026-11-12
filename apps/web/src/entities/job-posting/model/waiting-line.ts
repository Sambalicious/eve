import { formatWatDate } from "@/shared/lib/format-wat"

/** Checking polls for at most 10 minutes, then shows C-ERR-4 (design-spec, Real-time updates). */
export const CHECKING_LIMIT_MS = 10 * 60 * 1000

export function isCheckingTooLong(discoveredAt: string, now: Date): boolean {
  return now.getTime() - new Date(discoveredAt).getTime() > CHECKING_LIMIT_MS
}

/**
 * C-LINK-10. The cost pause ends at 00:00 WAT on the 1st, so {1 Nov 2026} is
 * the first day of the month after `now` in WAT. The contract has no pause
 * state yet (slice 7), so C-LINK-10a, which needs to know the global pause
 * ended, isn't chosen here.
 */
export function waitingLine(savedAt: string, now: Date): string {
  return `Saved on ${formatWatDate(savedAt)} while paid automation was paused for cost. It hasn't been checked for Eligibility or Match yet. That happens on ${formatWatDate(firstOfNextMonthWat(now))}, or sooner if you raise this month's ceiling.`
}

function firstOfNextMonthWat(now: Date): string {
  const wat = new Date(now.getTime() + 60 * 60 * 1000)
  const year = wat.getUTCFullYear()
  const month = wat.getUTCMonth() + 1
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
  return `${next.y}-${String(next.m).padStart(2, "0")}-01`
}
