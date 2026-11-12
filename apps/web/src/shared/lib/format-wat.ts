/**
 * Dates in West Africa Time, as the design spec requires everywhere
 * ("20 Oct 2026", "20 Oct 2026, 10:15 WAT"). The cap counts WAT days, so the
 * dashboard never shows browser-local time.
 */
const WAT_TIME_ZONE = "Africa/Lagos"

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: WAT_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
})

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: WAT_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/**
 * "16 Oct 2026" for an ISO timestamp or a `YYYY-MM-DD` date. Some ICU builds
 * write September as "Sept" in en-GB; the design spec's month names are always
 * three letters ("24 Sep 2026", posting-age.feature AC-6.4).
 */
export function formatWatDate(value: string): string {
  return threeLetterMonth(dateFormat.format(toDate(value)))
}

function threeLetterMonth(text: string): string {
  return text.replace(/\bSept\b/, "Sep")
}

/** "20 Oct 2026, 10:15 WAT". */
export function formatWatDateTime(value: string): string {
  const date = toDate(value)
  return `${threeLetterMonth(dateFormat.format(date))}, ${timeFormat.format(date)} WAT`
}

/** A bare `YYYY-MM-DD` is a calendar date; read it at noon WAT so no zone moves it a day. */
function toDate(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+01:00`) : new Date(value)
}

const watDayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: WAT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })

/** Today's WAT calendar date as `YYYY-MM-DD`, to compare with the API's WAT dates (`expiresOn`). */
export function watToday(now: Date = new Date()): string {
  return watDayFormat.format(now)
}
