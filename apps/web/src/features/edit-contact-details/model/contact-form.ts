import { CONTACT_LINE_MAX, CONTACT_LINES_MAX, CONTACT_NAME_MAX } from "@/entities/candidate-settings"

/** C-SET-3 to C-SET-6, C-VAL-SET-3 to C-VAL-SET-5 (design-spec.r4.md). Exact strings. */
export const contactFormCopy = {
  heading: "Contact details",
  help: "These appear at the top of every resume and cover letter. Eve adds them after writing, so they're never sent to Anthropic.",
  nameLabel: "Full name",
  required: "Required",
  linesLabel: "Contact lines",
  linesHelp: "Up to 6 lines, such as your job title, city, email, phone and a profile link.",
  addLine: "Add line",
  removeLine: (k: number) => `Remove line ${k}`,
  /** Accessible name of each line input. OPEN[designer] FE4-10: C-SET-6 names no per-line label. */
  lineLabel: (k: number) => `Contact line ${k}`,
  nameMissing: "Enter your name.",
  nameTooLong: "Use 120 characters or fewer for your name.",
  lineTooLong: "Use 120 characters or fewer on each line.",
  tooManyLines: "Use at most 6 lines.",
} as const

export interface ContactFormErrors {
  readonly fullName?: string
  /** Per-line message, by index. */
  readonly lines?: Readonly<Record<number, string>>
  /** Whole-field message (C-VAL-SET-5). */
  readonly linesField?: string
}

/**
 * Same rules as `candidateContactSchema`: trimmed name 1-120, 0-6 non-empty
 * lines of at most 120. Blank lines are dropped. "Add line" stops at 6, so
 * C-VAL-SET-5 shows only when more arrive (a backend refusal or a bug).
 */
export function validateContact(
  fullName: string,
  lineValues: readonly string[]
): { value: { fullName: string; lines: string[] } | null; errors: ContactFormErrors } {
  const name = fullName.trim()
  const trimmed = lineValues.map((l) => l.trim())
  const lines = trimmed.filter((l) => l !== "")
  const errors: { fullName?: string; lines?: Record<number, string>; linesField?: string } = {}
  if (name === "") errors.fullName = contactFormCopy.nameMissing
  else if (name.length > CONTACT_NAME_MAX) errors.fullName = contactFormCopy.nameTooLong
  const longLines = Object.fromEntries(
    trimmed.flatMap((l, i) => (l.length > CONTACT_LINE_MAX ? [[i, contactFormCopy.lineTooLong]] : []))
  )
  if (Object.keys(longLines).length > 0) errors.lines = longLines
  if (lines.length > CONTACT_LINES_MAX) errors.linesField = contactFormCopy.tooManyLines
  const ok = !errors.fullName && !errors.lines && !errors.linesField
  return { value: ok ? { fullName: name, lines } : null, errors }
}
