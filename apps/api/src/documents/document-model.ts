/**
 * A Tailored Document as structured content (architecture r1: "Structured
 * sections with fact IDs, validated in code, rendered to PDF and DOCX").
 * Contact details are not part of what the model writes; the backend adds the
 * header from the profile after validation.
 */
export type DocumentKind = "resume" | "cover_letter"

/**
 * Resume sections in their fixed order. The order and the printed titles follow the owner's own resume
 * (2026-11-01): experience, then education, then skills; a summary comes first only when there is one.
 */
export const RESUME_HEADINGS = ["Summary", "Experience", "Education", "Skills"] as const
export type ResumeHeading = (typeof RESUME_HEADINGS)[number]
export const RESUME_SECTION_TITLES: Readonly<Record<ResumeHeading, string>> = {
  Summary: "SUMMARY",
  Experience: "PROFESSIONAL EXPERIENCE",
  Education: "EDUCATION",
  Skills: "SKILLS",
}

/**
 * A role's or a qualification's heading, copied by the backend from the approved Career Profile
 * section its lines cite. Never model text. Absent in documents stored before the layout change, and
 * when a line cites facts from several sections; the renderer then prints the line's own text.
 */
export type RoleHeading = Readonly<{ title: string; organization: string | null; period: string | null }>

export type DocumentLine = Readonly<{
  text: string
  /** Approved Career Profile fact IDs this line restates. Empty only for lines with no claim. */
  factIds: readonly string[]
}>

export type ExperienceEntry = Readonly<{
  /** Title, employer and dates, e.g. "Senior Frontend Engineer, Brightwave Ltd, 2021–2024". */
  heading: DocumentLine
  bullets: readonly DocumentLine[]
  /** How the heading is printed: employer and dates on one line, the title under them. */
  role?: RoleHeading
}>

export type ResumeContent = Readonly<{
  kind: "resume"
  /**
   * Rule 1 (EPIC-0012): the posting's role title, printed under the Candidate's name. Backend text, set
   * after generation and never written by the model, and only when the Career Profile supports it; see
   * `headline.ts`. Absent in documents stored before this field, which render as they did.
   */
  headline?: string | null
  summary: readonly DocumentLine[]
  experience: readonly ExperienceEntry[]
  skills: readonly DocumentLine[]
  education: readonly DocumentLine[]
  /** Per education line, in order: its qualification heading, or null to print the line's text. */
  educationRoles?: ReadonlyArray<RoleHeading | null>
  /** ATS match against the posting's keywords, scored by the backend after every check. Never printed. */
  ats?: Readonly<{ score: number; total: number; matched: string[]; missing: string[]; gaps: string[] }>
}>

/** "Testing: Cypress, React Testing Library" prints as a bold "Testing" over its list. Null: print as is. */
export function skillParts(text: string): Readonly<{ label: string; items: string }> | null {
  const match = /^([^:\d]{1,40}):\s+(\S.*)$/s.exec(text)
  return match ? { label: match[1]!.trim(), items: match[2]!.trim() } : null
}

/** "Technologies used: React, Next.js" prints with a bold label. Null: no label. */
export function bulletLabel(text: string): Readonly<{ label: string; rest: string }> | null {
  const match = /^(Technologies used:|Tech stack:|Tools:)\s+(\S.*)$/is.exec(text)
  return match ? { label: match[1]!, rest: match[2]! } : null
}

/** The lines a role heading prints, in reading order: employer, dates, then title. */
export function roleLines(role: RoleHeading): string[] {
  return [role.organization, role.period, role.title].filter((part): part is string => part !== null && part.trim() !== "")
}

/** The lines a qualification heading prints: institution, then the qualification. */
export function educationLines(role: RoleHeading): string[] {
  return [role.organization, role.title].filter((part): part is string => part !== null && part.trim() !== "")
}

/**
 * Every sentence that names the posting's employer or role is backend text
 * (SEC-403 r2): greeting, opening, closing line and sign-off are fixed
 * templates and are not validated as claims. `paragraphs` are the model's body
 * and must never name the employer or role. `opening`/`closingLine` are null
 * only in content stored before v1.5.2.
 */
export type CoverLetterContent = Readonly<{
  kind: "cover_letter"
  /** "Dear Hiring Team at Acme," style greeting. */
  greeting: string
  /** "I am applying for the {role} role at {employer}." */
  opening: string | null
  paragraphs: readonly DocumentLine[]
  /** "I would welcome the chance to discuss how I can contribute to {employer}." */
  closingLine: string | null
  /** "Kind regards," sign-off. The name is added from the contact header. */
  closing: string
}>

export type DocumentContent = ResumeContent | CoverLetterContent

/** Name and contact lines inserted by the backend after generation; never sent to the model. */
export type ContactHeader = Readonly<{
  name: string
  lines: readonly string[]
}>

/** The plain text a renderer must produce, in reading order. The PDF text check compares against this. */
export function plainTextOf(content: DocumentContent, contact: ContactHeader): string[] {
  const header = [contact.name, ...contact.lines]
  if (content.kind === "cover_letter") {
    const backend = (text: string | null | undefined) => (text ? [text] : [])
    return [
      ...header,
      content.greeting,
      ...backend(content.opening),
      ...content.paragraphs.map((line) => line.text),
      ...backend(content.closingLine),
      content.closing,
      contact.name,
    ]
  }
  const out = [...header]
  // Rule 1 (EPIC-0012): the backend's headline line sits under the contact lines, before the sections.
  const headline = content.headline?.trim()
  if (headline) out.push(headline)
  if (content.summary.length > 0) out.push(RESUME_SECTION_TITLES.Summary, ...content.summary.map((line) => line.text))
  if (content.experience.length > 0) {
    out.push(RESUME_SECTION_TITLES.Experience)
    for (const entry of content.experience) {
      out.push(...(entry.role ? roleLines(entry.role) : [entry.heading.text]))
      for (const bullet of entry.bullets) {
        const labelled = bulletLabel(bullet.text)
        out.push(...(labelled ? [labelled.label, labelled.rest] : [bullet.text]))
      }
    }
  }
  if (content.education.length > 0) {
    out.push(RESUME_SECTION_TITLES.Education)
    content.education.forEach((line, index) => {
      const role = content.educationRoles?.[index]
      out.push(...(role ? educationLines(role) : [line.text]))
    })
  }
  if (content.skills.length > 0) {
    out.push(RESUME_SECTION_TITLES.Skills)
    for (const line of content.skills) {
      const parts = skillParts(line.text)
      out.push(...(parts ? [parts.label, parts.items] : [line.text]))
    }
  }
  return out
}

/** Every claim-bearing line of a document, with where it is, for validation and error reporting. */
export function linesOf(content: DocumentContent): DocumentLine[] {
  if (content.kind === "cover_letter") return [...content.paragraphs]
  return [
    ...content.summary,
    ...content.experience.flatMap((entry) => [entry.heading, ...entry.bullets]),
    ...content.skills,
    ...content.education,
  ]
}
