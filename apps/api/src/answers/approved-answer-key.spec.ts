import { describe, expect, it } from "vitest"

import { approvedAnswerKey } from "./approved-answer-key.js"

describe("approvedAnswerKey", () => {
  it("gives each standard topic one key", () => {
    expect(approvedAnswerKey({ group: "standard", topic: "notice_period", value: "4 weeks" })).toBe("standard:notice_period")
  })

  it("keys skill years per skill, ignoring case and spacing", () => {
    const a = approvedAnswerKey({ group: "standard", topic: "skill_years", skill: "React", value: "7" })
    const b = approvedAnswerKey({ group: "standard", topic: "skill_years", skill: "  react ", value: "3" })
    const c = approvedAnswerKey({ group: "standard", topic: "skill_years", skill: "TypeScript", value: "6" })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it("treats custom questions that differ only in case or spaces as the same question", () => {
    expect(approvedAnswerKey({ group: "custom", question: "Why  this role?", value: "x" })).toBe(
      approvedAnswerKey({ group: "custom", question: "why this role? ", value: "y" })
    )
  })

  it("keeps sensitive topics apart from standard ones", () => {
    expect(approvedAnswerKey({ group: "sensitive", topic: "disability", value: "x" })).toBe("sensitive:disability")
  })
})
