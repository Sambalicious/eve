import type { PostedDateKind } from "@eve/contracts"

/**
 * EPIC-0006 (AC-5.2 to AC-5.4): a posting's posted date, parsed strictly from
 * its source's fields and bounded against the moment the source was read.
 * Source values are untrusted: anything that is not a real date or instant in
 * the expected shape is undated. The raw value is never stored or echoed.
 *
 * Bounds (AC-5.4): a WAT calendar date before 2000-01-01 is undated; more than
 * 24 h after the read moment is undated; up to 24 h after is stored as the read
 * moment. A date-only value means 00:00 WAT; a date-time with no offset is UTC.
 */
export type PostedDate = Readonly<{ postedAt: Date | null; postedDateKind: PostedDateKind | null }>

/** One source field, in preference order. `instant` is null when the value does not parse. */
export type DateCandidate = Readonly<{ kind: PostedDateKind; instant: Date | null }>

export const UNDATED: PostedDate = Object.freeze({ postedAt: null, postedDateKind: null })

const WAT_OFFSET_MS = 60 * 60 * 1000
/** 2000-01-01T00:00 WAT: the earliest valid posted instant. */
const EARLIEST = Date.UTC(2000, 0, 1) - WAT_OFFSET_MS
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

/** The first candidate whose value parses and is within bounds. */
export function resolvePostedDate(candidates: readonly DateCandidate[], readAt: Date): PostedDate {
  for (const candidate of candidates) {
    const bounded = candidate.instant === null ? null : bound(candidate.instant, readAt)
    if (bounded !== null) return { postedAt: bounded, postedDateKind: candidate.kind }
  }
  return UNDATED
}

function bound(instant: Date, readAt: Date): Date | null {
  const at = instant.getTime()
  // An epoch beyond the Date range is an Invalid Date (NaN); it must never reach toISOString.
  if (!Number.isFinite(at) || at < EARLIEST) return null
  if (at > readAt.getTime() + FUTURE_SLACK_MS) return null
  return at > readAt.getTime() ? new Date(readAt.getTime()) : instant
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** ISO-8601 text: date-only (00:00 WAT), date-time with an offset or `Z`, or date-time with no offset (UTC). */
export function isoCandidate(value: unknown, kind: PostedDateKind): DateCandidate {
  return { kind, instant: typeof value === "string" ? parseIso(value) : null }
}

function parseIso(value: string): Date | null {
  const match = ISO.exec(value)
  if (!match) return null
  const [, y, mo, d, h, mi, s, fraction, zone] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (h === undefined) return calendarInstant(year, month, day, 0, 0, 0, 0, WAT_OFFSET_MS)
  const millis = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000)
  return calendarInstant(year, month, day, Number(h), Number(mi), Number(s ?? 0), millis, zone === undefined ? 0 : offsetMs(zone))
}

/** `Z`, `+hh:mm`, `+hhmm`: milliseconds east of UTC. */
function offsetMs(zone: string): number {
  if (zone === "Z") return 0
  const sign = zone.startsWith("-") ? -1 : 1
  const digits = zone.slice(1).replace(":", "")
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2, 4))
  if (hours > 23 || minutes > 59) return Number.NaN
  return sign * (hours * 60 + minutes) * 60_000
}

/** The instant of a local calendar time at `offset`, or null when a field is out of range (no rollover). */
function calendarInstant(year: number, month: number, day: number, hour: number, minute: number, second: number, millis: number, offset: number): Date | null {
  if (!Number.isFinite(offset) || hour > 23 || minute > 59 || second > 59) return null
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millis)
  const check = new Date(local)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return new Date(local - offset)
}

/** A finite integer epoch in the source's unit (Himalayas and Remote OK: seconds; Lever: milliseconds). */
export function epochCandidate(value: unknown, unit: "seconds" | "milliseconds", kind: PostedDateKind): DateCandidate {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return { kind, instant: null }
  const millis = unit === "seconds" ? value * 1000 : value
  const instant = Number.isSafeInteger(millis) ? new Date(millis) : null
  return { kind, instant: instant !== null && Number.isFinite(instant.getTime()) ? instant : null }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const RFC822 = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|GMT|UTC|UT|Z)$/

/** RFC 822 text (We Work Remotely `pubDate`), with an explicit regex rather than `Date.parse`. */
export function rfc822Candidate(value: unknown, kind: PostedDateKind): DateCandidate {
  if (typeof value !== "string") return { kind, instant: null }
  const match = RFC822.exec(value.trim())
  if (!match) return { kind, instant: null }
  const [, d, mon, y, h, mi, s, zone] = match
  const month = MONTHS.indexOf((mon ?? "").toLowerCase()) + 1
  if (month === 0) return { kind, instant: null }
  const offset = zone === undefined || /^[A-Z]+$/.test(zone) ? 0 : offsetMs(zone)
  return { kind, instant: calendarInstant(Number(y), month, Number(d), Number(h), Number(mi), Number(s ?? 0), 0, offset) }
}
