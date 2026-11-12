/**
 * Automatic 12-month expiry copy: every `C-RET-*` slot of
 * `copy-deck-12-month-expiry.md` (r2), keyed by the deck key. Exact strings.
 * `copy.test.ts` checks each web slot against the deck itself.
 *
 * Count slots have `one` and `other` forms (pick with `plural`); `{n}` is
 * grouped the en-US way and `{date}` is `formatWatDate` of a WAT calendar
 * date (fill with `fillCopy`). The daily summary slots (`email.*`) belong to
 * the api and are not here.
 */
export interface PluralCopy {
  readonly one: string
  readonly other: string
}

export const retentionCopy = {
  /** C-RET-0 */ "privacy.retention.title": "Retention",
  /** C-RET-1, replaces C-DATA-1. */
  "privacy.retention.rule":
    "Detailed records are deleted automatically 12 months after creation, on the same date one year later. This covers documents, answers and Outcomes. Minimal records stay to block duplicates.",
  /** C-RET-2 */ "privacy.retention.due.label": "Due in the next 30 days",
  /** C-RET-3; the no-date forms are the contract-bug fallback (spec §5), never "on null". */
  "privacy.retention.due.value": {
    one: "1 Application, on {date}",
    other: "{n} Applications, the first on {date}",
    oneNoDate: "1 Application",
    otherNoDate: "{n} Applications",
  },
  /** C-RET-4 */ "privacy.retention.due.none": "No Applications are due in the next 30 days.",
  /** C-RET-5 */ "privacy.retention.due.link": { one: "Show this Application", other: "Show these Applications" },
  /** C-RET-6 */
  "privacy.retention.waiting.value": {
    one: "1 record is past 12 months and waits for your decision",
    other: "{n} records are past 12 months and wait for your decision",
  },
  /** C-RET-7 */ "privacy.retention.waiting.link": { one: "Review it", other: "Review them" },
  /** C-RET-8 */ "privacy.retention.minimalHelp": { text: "Minimal records stay until you clear them.", link: "See minimal records" },
  /** C-RET-9 */ "privacy.retention.runFailed": "Automatic deletion failed on {date}. It will try again tomorrow.",
  /** C-RET-10 */ "privacy.retention.paused": "Automatic deletion is paused with automation. It catches up after you resume.",
  /** C-RET-22 (r2): while `graceEndsOn` is set, whatever the due count. */
  "privacy.retention.graceStarts": "Automatic deletion starts on {date}.",
  /** C-RET-11 */ "privacy.retention.waiting.label": "Waiting for your decision",
  /** C-RET-12 */ "applications.retentionFilter.due": "Due in the next 30 days, earliest first.",
  /** C-RET-12w */
  "applications.retentionFilter.waiting": "Past 12 months, waiting for your decision, earliest first. Each is deleted after you decide.",
  /** C-RET-12a */ "applications.retentionFilter.showAll": "Show all Applications",
  /** C-RET-12e */ "applications.retentionFilter.empty": "No Applications match right now.",
  /** C-RET-13 */ "application.expiry.label": "Detailed records expire",
  /** C-RET-13s */ "applications.columns.expires": "Expires",
  /** C-RET-14 */ "application.expiry.value": "{date}",
  /** C-RET-14s */ "applications.row.expires": "Expires {date}",
  /** C-RET-15 */ "application.expiry.waiting": "Kept until you decide.",
  /** C-RET-15b */ "application.expiry.inFlight": "Deleted once the current step finishes.",
  /** C-RET-16h */ "privacy.records.columns.deletedBy": "Deleted by",
  /** C-RET-16 */ "privacy.records.deletedBy.candidate": "You",
  /** C-RET-17 */ "privacy.records.deletedBy.expiry": "Automatic, 12 months",
  /** C-RET-18 */ "privacy.records.row.meta": "{date} · {finalStatus} · {deletedBy}",
  /** C-RET-19 */
  "application.minimal.deletedAutomatically":
    "Detailed records were deleted automatically on {date}, after 12 months. This minimal record still blocks duplicate Applications.",
  /**
   * C-RET-A1 (r3): the accessible name of C-RET-5. It starts with the visible
   * text word for word (WCAG 2.5.3); render it with `linkNameSuffix`.
   */
  "privacy.retention.due.linkLabel": {
    one: "Show this Application, due in the next 30 days",
    other: "Show these Applications, {n} due in the next 30 days",
  },
  /** C-RET-A2 (r3): the accessible name of C-RET-7, likewise. */
  "privacy.retention.waiting.linkLabel": {
    one: "Review it, 1 record waiting for your decision",
    other: "Review them, {n} records waiting for your decision",
  },
  /** C-RET-A3 (r2): an Expires cell with no date. */
  "applications.row.expires.none": { visible: "—", srOnly: "No expiry date" },
} as const

export type RetentionCopyKey = keyof typeof retentionCopy

/** The `one` form for 1, else `other`. */
export function plural<T extends PluralCopy>(n: number, forms: T): string {
  return n === 1 ? forms.one : forms.other
}

/**
 * The sr-only part of a link name that starts with its visible text (deck r3
 * rendering rule for C-RET-A1/A2): `name` minus the `visible` prefix. Throws
 * if the name doesn't start with the visible text, so a copy change that
 * breaks WCAG 2.5.3 fails loudly instead of rendering a mismatched name.
 */
export function linkNameSuffix(visible: string, name: string): string {
  if (!name.startsWith(visible)) throw new Error(`Link name "${name}" must start with its visible text "${visible}"`)
  return name.slice(visible.length)
}

/** Fills `{name}` placeholders; numbers are grouped the en-US way ("1,250"). An unknown placeholder stays as written. */
export function fillCopy(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name]
    if (value === undefined) return whole
    return typeof value === "number" ? value.toLocaleString("en-US") : value
  })
}
