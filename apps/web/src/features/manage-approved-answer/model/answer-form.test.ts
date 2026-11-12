import { describe, expect, it } from "vitest"

import { emptyAnswerForm, toNewAnswer, validateAnswerForm } from "./answer-form"

describe("Approved Answer form", () => {
  it("asks for the value and, for a custom question, the question text", () => {
    expect(validateAnswerForm({ kind: "create", group: "custom" }, { ...emptyAnswerForm, value: "  " })).toEqual({
      question: "Enter the question as the form asks it.",
      value: "Enter an answer.",
    })
  })

  it("builds a skill-years answer with its skill and other topics without one", () => {
    expect(
      toNewAnswer("standard", { ...emptyAnswerForm, standardTopic: "skill_years", skill: " React ", value: "7" })
    ).toEqual({ group: "standard", topic: "skill_years", skill: "React", value: "7" })
    expect(toNewAnswer("standard", { ...emptyAnswerForm, standardTopic: "notice_period", skill: "x", value: "4 weeks" })).toEqual({
      group: "standard",
      topic: "notice_period",
      value: "4 weeks",
    })
  })
})
