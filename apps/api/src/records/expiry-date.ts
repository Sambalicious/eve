/**
 * The 12-month expiry date rule (PRD prd-12-month-expiry.md E1, D-E1), as pure
 * functions of the creation instant and a run date. Nothing here reads the
 * process time zone: WAT (Africa/Lagos) is UTC+1 all year, so the WAT calendar
 * date is the UTC+1 date. SQL never does date maths; it compares `created_at`
 * with the single bound `dueCreatedBefore` returns.
 *
 * A `LocalDate` is a WAT calendar date as `YYYY-MM-DD`.
 */
export type LocalDate = string

const WAT_OFFSET_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** E1.1: the WAT calendar date of an instant. */
export function creationDate(instant: Date): LocalDate {
  return new Date(instant.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10)
}

/** Today's WAT date at `now` (the run date). Same rule as `creationDate`. */
export const watDate = creationDate

/** E1.2, E1.3 (D-E1): the creation date with the year + 1; 29 February goes to 28 February. */
export function expiryDate(createdAt: Date): LocalDate {
  return plusYears(creationDate(createdAt), 1)
}

/** E1.5: due from 00:00 WAT on the expiry date. */
export function isDue(createdAt: Date, runDate: LocalDate): boolean {
  return expiryDate(createdAt) <= runDate
}

/**
 * The exclusive upper bound on `created_at` for Applications due on `runDate`:
 * 00:00 WAT of the day after the latest due creation date. The expiry date is
 * non-decreasing in the creation date, so every earlier creation is due too.
 * On 28 February after a leap year, 29 February of the leap year is due (D-E1).
 */
export function dueCreatedBefore(runDate: LocalDate): Date {
  const [year, month, day] = parts(runDate)
  let latest = plusYears(runDate, -1)
  if (month === 2 && day === 28 && isLeap(year - 1)) latest = `${pad(year - 1, 4)}-02-29`
  return watMidnight(addDays(latest, 1))
}

/** E4.6 (D-E5): the launch grace ends 30 days after the WAT date of the first run. */
export function graceEndFrom(firstRunDate: LocalDate): LocalDate {
  return addDays(firstRunDate, 30)
}

/** The date an Application is actually deleted on or after: its expiry date, or the grace end if later (E4.6). */
export function effectiveExpiry(createdAt: Date, graceEnd: LocalDate | null): LocalDate {
  const expiry = expiryDate(createdAt)
  return graceEnd !== null && graceEnd > expiry ? graceEnd : expiry
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/** 00:00 WAT on `date`, as an instant. */
export function watMidnight(date: LocalDate): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - WAT_OFFSET_MS)
}

function plusYears(date: LocalDate, years: number): LocalDate {
  const [year, month, day] = parts(date)
  const target = year + years
  const clamped = month === 2 && day === 29 && !isLeap(target) ? 28 : day
  return `${pad(target, 4)}-${pad(month, 2)}-${pad(clamped, 2)}`
}

function parts(date: LocalDate): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new Error("Expected a YYYY-MM-DD date")
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0")
}
