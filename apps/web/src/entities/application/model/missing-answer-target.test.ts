import { describe, expect, it } from "vitest"

import { missingAnswerTarget, type Submission } from "./submission"

type Blocked = NonNullable<Submission["blocked"]>
const block = (o: Partial<Blocked>): Blocked => ({ reason: "missing_approved_answer", subReason: null, detail: null, question: null, at: null, ...o })

describe("missingAnswerTarget (F6, FE5-4)", () => {
  it("a plain question is a Custom question from blockedQuestion", () => {
    expect(missingAnswerTarget(block({ detail: "anything", question: "Notice period?" }))).toEqual({ kind: "custom", question: "Notice period?" })
  })
  it("C-BLOCK-1a goes to Sensitive; C-BLOCK-1b and 1c go to Salary", () => {
    expect(missingAnswerTarget(block({ detail: 'The form asks a sensitive question, "Gender", and you have no Approved Answer for it. Nothing was inferred.', question: "Gender" }))).toEqual({ kind: "sensitive" })
    expect(missingAnswerTarget(block({ detail: "The form asks for your current salary and you haven't approved a current-salary answer.", question: "Current salary" }))).toEqual({ kind: "salary" })
    expect(missingAnswerTarget(block({ detail: 'The form asks "Expected pay", which your gross-salary policy doesn\'t cover.', question: "Expected pay" }))).toEqual({ kind: "salary" })
  })
  it("no question and no known form: no target; other reasons: no target", () => {
    expect(missingAnswerTarget(block({ detail: "x" }))).toBeNull()
    expect(missingAnswerTarget(block({ reason: "login", question: "q" }))).toBeNull()
  })
})
