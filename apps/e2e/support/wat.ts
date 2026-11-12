/** Calendar days in WAT (UTC+1, no DST), as the api's `verifiedOn` rule and the web's date input use. */
const WAT_OFFSET_MS = 60 * 60 * 1000
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

export function watDay(offsetDays = 0, now = new Date()): string {
  return new Date(now.getTime() + WAT_OFFSET_MS + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

/** "2026-10-21" → "21 Oct 2026" (formatWatDate). */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  return `${d} ${MONTHS[m - 1]} ${y}`
}
