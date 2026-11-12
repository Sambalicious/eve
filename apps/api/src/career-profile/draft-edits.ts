import type { SaveCareerProfileDraftRequest } from "@eve/contracts"

import type { StoredSection } from "../db/schema.js"

/**
 * Builds the draft's sections from the Candidate's edit. A section or fact sent
 * with a known id keeps that id; it keeps its resume quote only while its text
 * is unchanged, because an edited fact is no longer what the resume says.
 * Unknown ids get new ones, so a client cannot claim a quote it did not have.
 */
export function applyDraftEdits(
  base: readonly StoredSection[],
  request: SaveCareerProfileDraftRequest,
  newId: () => string
): StoredSection[] {
  const baseSections = new Map(base.map((section) => [section.id, section]))
  return request.sections.map((edited) => {
    const original = edited.id === undefined ? undefined : baseSections.get(edited.id)
    const baseFacts = new Map((original?.facts ?? []).map((fact) => [fact.id, fact]))
    const headingUnchanged =
      original !== undefined &&
      original.title === edited.title &&
      original.organization === edited.organization &&
      original.period === edited.period
    return {
      id: original?.id ?? newId(),
      kind: edited.kind,
      title: edited.title,
      organization: edited.organization,
      period: edited.period,
      sourceQuote: headingUnchanged ? original.sourceQuote : null,
      facts: edited.facts.map((fact) => {
        const previous = fact.id === undefined ? undefined : baseFacts.get(fact.id)
        const text = fact.text.trim()
        return {
          id: previous?.id ?? newId(),
          text,
          sourceQuote: previous !== undefined && previous.text === text ? previous.sourceQuote : null,
        }
      }),
    }
  })
}
