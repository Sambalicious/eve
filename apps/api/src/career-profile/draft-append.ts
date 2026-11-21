import type { StoredSection } from "../db/schema.js"

/**
 * FEAT-0017 "Save to Career Profile" (OD-1, OD-6): append one Candidate-authored
 * fact per entry to the draft's sections. Pure, so the homes and the limits are
 * testable without a database.
 *
 * The PRD fixes the homes: a skill-only fact goes to a `skills` section titled
 * "Skills from applications"; a one-liner to an `other` section titled "Added from
 * applications". Facts carry no source quote (they are Candidate-written, like
 * edited profile facts) and a new id.
 */

export type DraftFactEntry = Readonly<{ kind: "skill_only" | "one_liner"; text: string }>

export const ADDED_SKILLS_TITLE = "Skills from applications"
export const ADDED_FACTS_TITLE = "Added from applications"

/** The section a kind is appended to, created when absent. */
function targetOf(sections: readonly StoredSection[], kind: DraftFactEntry["kind"]): { index: number; title: string; sectionKind: StoredSection["kind"] } | null {
  const title = kind === "skill_only" ? ADDED_SKILLS_TITLE : ADDED_FACTS_TITLE
  const sectionKind: StoredSection["kind"] = kind === "skill_only" ? "skills" : "other"
  const index = sections.findIndex((section) => section.kind === sectionKind && section.title === title)
  return { index, title, sectionKind }
}

export class DraftAppendError extends Error {
  constructor(readonly reason: "draft_full") {
    super(`The Career Profile draft cannot hold another fact (${reason})`)
    this.name = "DraftAppendError"
  }
}

/**
 * Appends `entries` to a copy of `sections`. Throws `DraftAppendError` when a
 * limit would be passed (the caller keeps the Application's fact and reports
 * `draft_full`); a malformed section list throws a plain error, which the caller
 * reports as `failed` and leaves the draft unchanged.
 */
export function appendFactsToSections(
  sections: readonly StoredSection[],
  entries: readonly DraftFactEntry[],
  newId: () => string,
  limits: Readonly<{ sections: number; factsPerSection: number }>
): { sections: StoredSection[]; appended: number } {
  if (!Array.isArray(sections)) throw new Error("The draft's sections are not a list")
  const next = sections.map((section) => ({ ...section, facts: [...section.facts] }))
  let appended = 0
  for (const entry of entries) {
    const target = targetOf(next, entry.kind)
    if (target === null) throw new Error("Unreachable section target")
    let section = target.index === -1 ? undefined : next[target.index]
    if (section === undefined) {
      if (next.length >= limits.sections) throw new DraftAppendError("draft_full")
      section = { id: newId(), kind: target.sectionKind, title: target.title, organization: null, period: null, sourceQuote: null, facts: [] }
      next.push(section)
    }
    if (section.facts.length >= limits.factsPerSection) throw new DraftAppendError("draft_full")
    section.facts.push({ id: newId(), text: entry.text, sourceQuote: null })
    appended += 1
  }
  return { sections: next, appended }
}

/** Every fact's trimmed, lower-cased text in the version a save would read (draft first, else approved). */
export function factKeys(sections: readonly StoredSection[]): Set<string> {
  return new Set(sections.flatMap((section) => section.facts.map((fact) => fact.text.trim().toLowerCase())))
}
