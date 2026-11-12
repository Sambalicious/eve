const monthFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", month: "long", year: "numeric" })

/** "October 2026" for a WAT month given as its first day (`YYYY-MM-01`). */
export function monthLabel(month: string): string {
  return monthFormat.format(new Date(`${month}T12:00:00+01:00`))
}

/** `YYYY-MM-01` of the month after `month`: the day the ceiling returns to its default. */
export function firstOfNextMonth(month: string): string {
  const [year, m] = month.split("-").map(Number)
  return m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, "0")}-01`
}
