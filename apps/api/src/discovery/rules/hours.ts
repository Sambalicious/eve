import { type RuleOutcome, sentenceAround } from "./rule-result.js"

/** Offsets in minutes east of UTC for zone abbreviations postings use. */
const ZONES: Readonly<Record<string, number>> = {
  wat: 60, cet: 60, bst: 60, cest: 120, eet: 120, eest: 180, sast: 120, eat: 180, ist: 330,
  utc: 0, gmt: 0, est: -300, edt: -240, et: -300, cst: -360, cdt: -300, ct: -360,
  mst: -420, mdt: -360, mt: -420, pst: -480, pdt: -420, pt: -480,
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`
const ZONE = String.raw`([A-Za-z]{2,4})(?:\s*([+−-]\s*\d{1,2})(?::?(\d{2}))?)?`
const HOURS_PATTERN = new RegExp(String.raw`${TIME}\s*(?:-|–|—|to)\s*${TIME}\s*\(?${ZONE}`, "gi")

/**
 * EPIC-0002 B1 (AC 5.10): the evaluated Candidate's latest work hour and time
 * zone from Job Preferences. No rule reads `evaluation_setting` after B1.
 * `timeZone` is null for a Candidate with no record: hours are then Unverified.
 */
export type HoursPreference = Readonly<{ latestWorkHour: string; timeZone: string | null }>

/**
 * AC 4.6 and 5.10, computed in code. Required regular work that runs past the
 * Candidate's latest work hour is violated: the shift is placed on the
 * Candidate's zone clock from its start, and it violates when its end is later
 * than that hour that day; ending exactly at the hour passes. A time range with
 * a zone this code doesn't know is not used; unstated hours are Unverified.
 */
export function evaluateHours(postingText: string, preference: HoursPreference, on: Date): RuleOutcome {
  if (preference.timeZone === null) return { result: "unverified", quote: null }
  const cutoffZoneOffset = zoneOffsetMinutes(preference.timeZone, on)
  const cutoff = minutesOf(preference.latestWorkHour)
  for (const match of postingText.matchAll(HOURS_PATTERN)) {
    const offset = offsetOf(match[7] as string, match[8], match[9])
    if (offset === null) continue
    const start = clock(match[1], match[2], match[3])
    const end = clock(match[4], match[5], match[6])
    if (start === null || end === null) continue
    const shift = cutoffZoneOffset - offset
    const localStart = mod(start + shift, 1440)
    const duration = mod(end - start, 1440)
    const quote = sentenceAround(postingText, match.index, match[0].length)
    return { result: runsPastCutoff(localStart, duration, cutoff) ? "violated" : "met", quote }
  }
  return { result: "unverified", quote: null }
}

function runsPastCutoff(start: number, duration: number, cutoff: number): boolean {
  return start + duration > cutoff
}

function offsetOf(zone: string, sign: string | undefined, minutes: string | undefined): number | null {
  const base = ZONES[zone.toLowerCase()]
  if (base === undefined) return null
  if (sign === undefined) return base
  const hours = Number.parseInt(sign.replace(/[\s−]/g, (c) => (c === "−" ? "-" : "")), 10)
  const extra = minutes === undefined ? 0 : Number.parseInt(minutes, 10)
  return base + hours * 60 + Math.sign(hours || 1) * extra
}

function clock(hour: string | undefined, minute: string | undefined, meridiem: string | undefined): number | null {
  let h = Number.parseInt(hour ?? "", 10)
  const m = minute === undefined ? 0 : Number.parseInt(minute, 10)
  if (Number.isNaN(h) || h > 24 || m > 59) return null
  const suffix = meridiem?.toLowerCase().replace(/\./g, "")
  if (suffix === "pm" && h < 12) h += 12
  if (suffix === "am" && h === 12) h = 0
  if (suffix === undefined && minute === undefined) return null
  return h * 60 + m
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((part) => Number.parseInt(part, 10))
  return (h ?? 0) * 60 + (m ?? 0)
}

/** The IANA zone's offset from UTC on `on`, in minutes. */
export function zoneOffsetMinutes(timeZone: string, on: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(on)
    .find((part) => part.type === "timeZoneName")?.value
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "")
  if (!match) return 0
  const minutes = Number.parseInt(match[2] as string, 10) * 60 + Number.parseInt(match[3] as string, 10)
  return match[1] === "-" ? -minutes : minutes
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by
}
