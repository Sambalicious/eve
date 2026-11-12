import { describe, expect, it } from "vitest"

import type { ProfileSection } from "@/entities/career-profile"
import { draftEditorReducer, startEditing, toDraftContent } from "./draft-editor"

const section: ProfileSection = {
  id: "s1",
  kind: "experience",
  title: "Senior Frontend Engineer",
  organization: "Brightwave Ltd",
  period: "2021–2024",
  sourceQuote: "Brightwave Ltd, Senior Frontend Engineer, 2021–2024",
  facts: [
    { id: "f1", text: "Led a team of 4 frontend engineers at Brightwave Ltd, 2021–2024", sourceQuote: "q1" },
    { id: "f2", text: "Cut checkout page load time by 38%", sourceQuote: "q2" },
  ],
}

describe("draft editor", () => {
  it("sends edited facts with their ids, drops removed ones, and adds new ones without an id", () => {
    let state = startEditing([section])
    state = draftEditorReducer(state, {
      type: "edit",
      sectionId: "s1",
      key: "f1",
      text: "Led a team of 5 frontend engineers at Brightwave Ltd, 2021–2024",
    })
    state = draftEditorReducer(state, { type: "remove", sectionId: "s1", key: "f2" })
    state = draftEditorReducer(state, { type: "add", sectionId: "s1", key: "new-1" })
    state = draftEditorReducer(state, { type: "edit", sectionId: "s1", key: "new-1", text: "Mentored 3 juniors" })

    expect(toDraftContent(state)).toEqual({
      sections: [
        {
          id: "s1",
          kind: "experience",
          title: "Senior Frontend Engineer",
          organization: "Brightwave Ltd",
          period: "2021–2024",
          facts: [
            { id: "f1", text: "Led a team of 5 frontend engineers at Brightwave Ltd, 2021–2024" },
            { text: "Mentored 3 juniors" },
          ],
        },
      ],
    })
  })

  it("leaves other sections untouched", () => {
    const other: ProfileSection = { ...section, id: "s2", facts: [] }
    const state = draftEditorReducer(startEditing([section, other]), { type: "add", sectionId: "s2", key: "k" })
    expect(state[0].facts).toHaveLength(2)
    expect(state[1].facts).toEqual([{ key: "k", text: "" }])
  })
})
