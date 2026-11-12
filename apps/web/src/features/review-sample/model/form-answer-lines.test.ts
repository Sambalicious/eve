import { describe, expect, it } from "vitest"

import type { FormAnswer } from "@/entities/application"
import { answerCell, firstMissingAnswer, sourceLabel } from "./form-answer-lines"

const answer = (o: Partial<FormAnswer>): FormAnswer => ({ question: "Q", source: "settings_contact", value: "v", redacted: false, blockedReason: null, manualOnly: false, ...o })

describe("answerCell", () => {
  it("never shows a redacted value, even if one arrived", () => {
    expect(answerCell(answer({ source: "approved_answer_sensitive", redacted: true, value: "secret" }))).toEqual({ kind: "hidden" })
  })
  it("a missing Approved Answer reads 'No Approved Answer'; other blocking fields name their Blocked reason", () => {
    expect(answerCell(answer({ source: "missing", value: null, blockedReason: "missing_approved_answer" }))).toEqual({ kind: "blocked", text: "No Approved Answer" })
    expect(answerCell(answer({ source: "missing", value: null, blockedReason: "declaration" }))).toEqual({ kind: "blocked", text: "Declaration" })
  })
  it("documents name the file; values pass through as text", () => {
    expect(answerCell(answer({ source: "document_cover_letter", value: null }))).toEqual({ kind: "text", text: "Cover letter (PDF)" })
    expect(answerCell(answer({ value: "<b>x</b>" }))).toEqual({ kind: "text", text: "<b>x</b>" })
  })
})

describe("firstMissingAnswer", () => {
  it("picks the first missing-answer question for C-SAMPLE-8, skipping other blocks", () => {
    const answers = [
      answer({ question: "Sign here", source: "missing", blockedReason: "declaration" }),
      answer({ question: "Years of Vue?", source: "missing", blockedReason: "missing_approved_answer" }),
    ]
    expect(firstMissingAnswer(answers)).toEqual({ question: "Years of Vue?", manualOnly: false })
    expect(firstMissingAnswer([answer({})])).toBeNull()
  })

  it("CR5E-01: carries the manual-only flag, so C-SAMPLE-8 can drop \"Add Approved Answer\"", () => {
    const answers = [answer({ question: "Will you require sponsorship?", source: "missing", value: null, blockedReason: "missing_approved_answer", manualOnly: true })]
    expect(firstMissingAnswer(answers)).toEqual({ question: "Will you require sponsorship?", manualOnly: true })
  })
})

describe("sourceLabel", () => {
  it("uses the design's labels for settings and the sponsorship rule", () => {
    expect(sourceLabel(answer({ source: "settings_work_authorization" }))).toBe("Settings: work authorization")
    expect(sourceLabel(answer({ source: "rule_sponsorship" }))).toBe("Rule: sponsorship is always Yes")
  })
})
