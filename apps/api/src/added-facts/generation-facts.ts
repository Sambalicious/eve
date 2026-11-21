import type { Selectable } from "kysely"

import type { ApplicationAddedFactTable, StoredAddedFactUsed, StoredSection } from "../db/schema.js"
import { containsAddedFactContactDetail } from "./added-fact-contact-detail.js"
import type { AddedFactForPrompt } from "../documents/document-generation.js"
import type { ContactHeader } from "../documents/document-model.js"

/**
 * FEAT-0017 generation step 1 (architecture "How added facts enter generation"):
 * which of an Application's added facts a generation may use, and what the
 * document snapshot records.
 *
 * - A skill-only fact is always citable: its text is the posting's own gap term.
 * - A one-liner is citable only when its role is an `experience` section of the
 *   Career Profile version being used. One whose role is gone is **orphaned**: not
 *   in the prompt and not in the validation map, but recorded in `available` with
 *   `role: null` so the audit is true. The counter does not change.
 * - A fact whose text now holds a contact detail is left out of the prompt, the
 *   map and the snapshot entirely, as `withoutContactFacts` does for profile facts.
 */
export type AddedFactRow = Pick<Selectable<ApplicationAddedFactTable>, "id" | "kind" | "text" | "role_section_id" | "role_snapshot">

export type GenerationAddedFacts = Readonly<{
  /** What the prompt lists and the validation map holds (and what gets an alias). */
  citable: AddedFactForPrompt[]
  /** `tailored_document.added_facts.available`, with `role: null` for an orphaned one-liner. */
  available: StoredAddedFactUsed[]
}>

export function generationAddedFacts(rows: readonly AddedFactRow[], sections: readonly StoredSection[], contact: ContactHeader | null): GenerationAddedFacts {
  const experience = new Set(sections.filter((section) => section.kind === "experience").map((section) => section.id))
  const citable: AddedFactForPrompt[] = []
  const available: StoredAddedFactUsed[] = []
  for (const row of rows) {
    if (containsAddedFactContactDetail(row.text, contact)) continue
    const role = row.role_snapshot === null ? null : { title: row.role_snapshot.title, employer: row.role_snapshot.employer, period: row.role_snapshot.period }
    const usable = row.kind === "skill_only" || (row.role_section_id !== null && experience.has(row.role_section_id))
    if (usable) {
      citable.push({ id: row.id, kind: row.kind, text: row.text, role, roleSectionId: row.role_section_id })
    }
    available.push({ id: row.id, kind: row.kind, text: row.text, role: usable ? role : null })
  }
  return { citable, available }
}
