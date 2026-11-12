/**
 * Which suffix the Application detail's "Detailed records expire" value gets
 * (design-spec-12-month-expiry feedback matrix). Only once the date is
 * reached (deletion runs from 00:00 WAT on it): "waiting" (C-RET-15, D-E9,
 * also 1 to 29 days past, E5.8) while a Candidate decision holds it, or
 * "inFlight" (C-RET-15b, E3.5) while it generates or submits. Else none.
 */
export type ExpiryNote = "waiting" | "inFlight" | null

export function expiryNote({ expiresOn, today, waiting, inFlight }: { expiresOn: string; today: string; waiting: boolean; inFlight: boolean }): ExpiryNote {
  if (expiresOn > today) return null
  if (inFlight) return "inFlight"
  if (waiting) return "waiting"
  return null
}
