/** Africa/Lagos is UTC+1 all year (no daylight saving), so the WAT day is the UTC+1 calendar date. */
const WAT_OFFSET_MS = 60 * 60 * 1000

/** The WAT calendar day (YYYY-MM-DD) of an instant (AC 6.1, daily-cap boundary scenarios). */
export function watDay(at: Date): string {
  return new Date(at.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10)
}

/** The WAT day after `day`. */
export function nextWatDay(day: string): string {
  const next = new Date(`${day}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}
