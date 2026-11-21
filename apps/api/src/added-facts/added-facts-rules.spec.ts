import { describe, expect, it } from "vitest"

import { FORBIDDEN_CODE_POINTS } from "../db/migrations/0042-added-facts.js"
import { addedFactsState, codePoints, hasInvalidCharacters, isEditable, limitProblem, liveGapTerm, textProblem } from "./added-facts-rules.js"

const BASE = { state: "documents_ready", submission_state: null, sample_state: null, submit_clicked_at: null, manual_completed_at: null, details_deleted_at: null } as const

describe("FEAT-0017 addedFactsEditable", () => {
  it.each([
    ["prepared, nothing else", { ...BASE, state: "prepared" }, null, null],
    ["queued", { ...BASE, submission_state: "queued" }, null, null],
    ["not_submitted", { ...BASE, submission_state: "not_submitted" }, null, null],
    ["blocked before the click", { ...BASE, submission_state: "blocked" }, null, null],
    ["sample awaiting review", { ...BASE, sample_state: "awaiting_review" }, null, null],
    ["sample rejected", { ...BASE, sample_state: "rejected" }, null, null],
    ["details deleted", { ...BASE, details_deleted_at: new Date(0) }, "details_deleted", null],
    ["manual completion", { ...BASE, manual_completed_at: new Date(0) }, "manual", null],
    ["submission manual", { ...BASE, submission_state: "manual" }, "manual", null],
    ["confirmed", { ...BASE, submission_state: "confirmed" }, "submitted", null],
    ["uncertain", { ...BASE, submission_state: "uncertain" }, "uncertain", null],
    ["blocked after the click", { ...BASE, submission_state: "blocked", submit_clicked_at: new Date(0) }, "submitted", null],
    ["declined", { ...BASE, submission_state: "declined" }, "declined", null],
    ["sample approved", { ...BASE, sample_state: "approved" }, "sample_approved", null],
    ["submit_claimed", { ...BASE, submission_state: "submit_claimed" }, null, "submitting"],
    ["submitting", { ...BASE, submission_state: "submitting" }, null, "submitting"],
    ["generating", { ...BASE, state: "generating" }, null, "generating"],
  ] as const)("%s", (_case, row, frozen, busy) => {
    expect(addedFactsState(row)).toEqual({ frozenReason: frozen, busyReason: busy })
    expect(isEditable(row)).toBe(frozen === null && busy === null)
  })

  it("markNotSubmitted (uncertain to queued) re-opens editing", () => {
    expect(addedFactsState({ ...BASE, submission_state: "queued" }).frozenReason).toBeNull()
  })
})

describe("FEAT-0017 text rules, in the contract's order", () => {
  const contact = { name: "Ada", lines: ["Lagos, Nigeria", "ada@example.com"] }

  it.each([
    ["", "empty"],
    ["    ", "empty"],
    ["x".repeat(301), "too_long"],
    ["Set up CI/CD at Acme, write to ada@example.com", "contact_detail"],
    ["Set up CI/CD at Acme, call +234 801 234 5678", "contact_detail"],
    ["Set up CI/CD at Acme, see https://github.com/acme/pipelines", "contact_detail"],
    ["Learning Terraform at Acme", "aspiration_text"],
    ["Built a learning platform with React at Acme", "aspiration_text"],
    ["Had exposure to Storybook at Acme", "aspiration_text"],
    ["Set up\u200b CI/CD at Acme", "invalid_characters"],
    ["Ran CI\uFFF9 at Acme", "invalid_characters"],
    ["Ran CI\uFFFA at Acme", "invalid_characters"],
    ["Ran CI\uFFFB at Acme", "invalid_characters"],
  ] as const)("%j is %s", (text, problem) => {
    expect(textProblem(text, contact)).toBe(problem)
  })

  it.each([[1], [299], [300]])("accepts %i trimmed code points", (length) => {
    expect(textProblem(`a${"x".repeat(length - 1)}`, contact)).toBeNull()
  })

  it("counts code points, not UTF-16 units", () => {
    expect(codePoints("😀".repeat(300))).toBe(300)
    expect(textProblem("😀".repeat(300), contact)).toBeNull()
    expect(textProblem("😀".repeat(301), contact)).toBe("too_long")
  })

  it("learned and studied are real experience", () => {
    expect(textProblem("Learned Go at Acme", contact)).toBeNull()
    expect(textProblem("Studied distributed systems at Acme", contact)).toBeNull()
  })

  it("does not run the phrase check on a skill-only term", () => {
    expect(liveGapTerm("e-learning", ["e-learning", "Figma"])).toBe("e-learning")
  })
})

describe("FEAT-0017 live gaps and limits", () => {
  it("the invalid-character predicate is the one textProblem uses", () => {
    expect(hasInvalidCharacters("Figma\u200B")).toBe(true)
    expect(hasInvalidCharacters("Figma")).toBe(false)
  })

  it("refuses every code point the 0042 CHECK refuses, so the two lists cannot drift", () => {
    const refusedByDatabase: number[] = []
    for (const match of FORBIDDEN_CODE_POINTS.matchAll(/\\u([0-9A-Fa-f]{4})(?:-\\u([0-9A-Fa-f]{4}))?/g)) {
      const start = Number.parseInt(match[1]!, 16)
      const end = match[2] === undefined ? start : Number.parseInt(match[2], 16)
      for (let code = start; code <= end; code += 1) refusedByDatabase.push(code)
    }
    expect(refusedByDatabase.length).toBeGreaterThan(0)
    const missed = refusedByDatabase.filter((code) => !hasInvalidCharacters(`Ran CI${String.fromCodePoint(code)} at Acme`))
    expect(missed.map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)).toEqual([])
  })

  it("a live gap term matches case-insensitively and returns the posting's wording", () => {
    expect(liveGapTerm("figma", ["Figma", "design systems"])).toBe("Figma")
    expect(liveGapTerm("Kubernetes", ["Figma"])).toBeNull()
  })

  it("one-liners are checked first when both limits would pass", () => {
    expect(limitProblem({ oneLiner: 10, skillOnly: 40 }, { oneLiner: 1, skillOnly: 1 })).toBe("one_liner_limit")
    expect(limitProblem({ oneLiner: 0, skillOnly: 40 }, { oneLiner: 0, skillOnly: 1 })).toBe("skill_only_limit")
    expect(limitProblem({ oneLiner: 9, skillOnly: 39 }, { oneLiner: 1, skillOnly: 1 })).toBeNull()
  })
})
