import type { DraftContent, ProfileSection } from "@/entities/career-profile"

/** A fact row in edit mode. `id` is absent for a fact added in this edit. */
export interface EditableFact {
  readonly key: string
  readonly id?: string
  readonly text: string
}

export interface EditableSection {
  readonly section: ProfileSection
  readonly facts: readonly EditableFact[]
}

export type DraftEditorAction =
  | { type: "edit"; sectionId: string; key: string; text: string }
  | { type: "add"; sectionId: string; key: string }
  | { type: "remove"; sectionId: string; key: string }

/** Edit mode starts from the draft when one exists, else from the version in use. */
export function startEditing(sections: readonly ProfileSection[]): EditableSection[] {
  return sections.map((section) => ({
    section,
    facts: section.facts.map((fact) => ({ key: fact.id, id: fact.id, text: fact.text })),
  }))
}

export function draftEditorReducer(state: EditableSection[], action: DraftEditorAction): EditableSection[] {
  return state.map((entry) => {
    if (entry.section.id !== action.sectionId) return entry
    switch (action.type) {
      case "edit":
        return {
          ...entry,
          facts: entry.facts.map((fact) => (fact.key === action.key ? { ...fact, text: action.text } : fact)),
        }
      case "add":
        return { ...entry, facts: [...entry.facts, { key: action.key, text: "" }] }
      case "remove":
        return { ...entry, facts: entry.facts.filter((fact) => fact.key !== action.key) }
      default: {
        const exhaustive: never = action
        return exhaustive
      }
    }
  })
}

/** The full list `PUT /v1/career-profile/draft` expects: existing ids kept, new facts without one. */
export function toDraftContent(state: readonly EditableSection[]): DraftContent {
  return {
    sections: state.map(({ section, facts }) => ({
      id: section.id,
      kind: section.kind,
      title: section.title,
      organization: section.organization,
      period: section.period,
      facts: facts.map((fact) => (fact.id === undefined ? { text: fact.text } : { id: fact.id, text: fact.text })),
    })),
  }
}
