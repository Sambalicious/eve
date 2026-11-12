import { describe, expect, it } from "vitest"

import type { AnswerSources, FormField } from "./answer-assignment.js"
import { previewAnswers } from "./answer-preview.js"

const SOURCES: AnswerSources = {
  fullName: "Ada Okafor",
  contactLines: ["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"],
  work: { home: "NG", authorized: ["NG"], sponsorshipNeeded: true },
  roleLocation: { kind: "countries", codes: ["US"] },
  answers: [
    { group: "sensitive", topic: "veteran_status", skill: null, question: null, value: "I am not a veteran" },
    { group: "standard", topic: "notice_period", skill: null, question: null, value: "4 weeks" },
    { group: "standard", topic: "skill_years", skill: "React", question: null, value: "7" },
    { group: "custom", topic: null, skill: null, question: "Why Northwind?", value: "Weekly shipping." },
  ],
  grossSalaryPolicy: { amount: "48000.00", currency: "USD", period: "year" },
  currentSalary: null,
}

let n = 0
const field = (label: string, extra: Partial<FormField> = {}): FormField => ({ ref: `f${++n}`, label, kind: "text", required: true, ...extra })

describe("previewAnswers (sample form answers, AC 2.1, C-SAMPLE-14 to 17)", () => {
  it("lists every planned answer in form order with its source, from the same assignment code", () => {
    const rows = previewAnswers(
      [
        field("First name"),
        field("Email"),
        field("Where are you located?"),
        field("Work authorization", { fieldName: "q1", schemaQuestion: { text: "Are you authorized to work in the United States?", fieldName: "q1" } }),
        field("Will you require visa sponsorship?", { fieldName: "q2", schemaQuestion: { text: "Will you require visa sponsorship?", fieldName: "q2" } }),
        field("Are you legally authorized to work in Nigeria?"),
        field("What is your notice period?"),
        field("How many years of React experience do you have?"),
        field("Why Northwind?", { kind: "textarea" }),
        field("Expected annual salary (USD)"),
        field("Resume", { kind: "file" }),
        field("Cover letter", { kind: "file", required: false }),
      ],
      SOURCES
    )
    expect(rows).toEqual([
      { question: "First name", source: "settings_contact", value: "Ada", redacted: false, blockedReason: null },
      { question: "Email", source: "settings_contact", value: "ada@example.com", redacted: false, blockedReason: null },
      { question: "Where are you located?", source: "settings_location", value: "Lagos, Nigeria", redacted: false, blockedReason: null },
      { question: "Are you authorized to work in the United States?", source: "settings_work_authorization", value: "No", redacted: false, blockedReason: null },
      { question: "Will you require visa sponsorship?", source: "rule_sponsorship", value: "Yes", redacted: false, blockedReason: null },
      // CR5E-01: a page-read work question can never take an Approved Answer, so the row says manual only.
      { question: "Are you legally authorized to work in Nigeria?", source: "missing", value: null, redacted: false, blockedReason: "missing_approved_answer", manualOnly: true },
      { question: "What is your notice period?", source: "approved_answer_standard", value: "4 weeks", redacted: false, blockedReason: null },
      { question: "How many years of React experience do you have?", source: "approved_answer_skill", value: "7", redacted: false, blockedReason: null },
      { question: "Why Northwind?", source: "approved_answer_custom", value: "Weekly shipping.", redacted: false, blockedReason: null },
      { question: "Expected annual salary (USD)", source: "salary_gross_policy", value: "USD 48,000 per year", redacted: false, blockedReason: null },
      { question: "Resume", source: "document_resume", value: null, redacted: false, blockedReason: null },
      { question: "Cover letter", source: "document_cover_letter", value: null, redacted: false, blockedReason: null },
    ])
  })

  it("redacts a sensitive value: the response never carries it", () => {
    const rows = previewAnswers([field("Are you a protected veteran?", { required: false })], SOURCES)
    expect(rows).toEqual([{ question: "Are you a protected veteran?", source: "approved_answer_sensitive", value: null, redacted: true, blockedReason: null }])
    expect(JSON.stringify(rows)).not.toContain("not a veteran")
  })

  it("a required question with no Approved Answer is listed as missing, never guessed; rows after it still show", () => {
    const rows = previewAnswers([field("Describe a project you are proud of."), field("Email")], SOURCES)
    expect(rows).toEqual([
      { question: "Describe a project you are proud of.", source: "missing", value: null, redacted: false, blockedReason: "missing_approved_answer" },
      { question: "Email", source: "settings_contact", value: "ada@example.com", redacted: false, blockedReason: null },
    ])
  })

  it("hard blocks show their reason; optional unanswerable questions are left out (nothing is filled that isn't listed)", () => {
    const rows = previewAnswers([field("I certify the above and sign below"), field("Anything else?", { required: false }), field("Current salary")], SOURCES)
    expect(rows).toEqual([
      { question: "I certify the above and sign below", source: "missing", value: null, redacted: false, blockedReason: "declaration" },
      { question: "Current salary", source: "missing", value: null, redacted: false, blockedReason: "missing_approved_answer" },
    ])
  })

  it("no fields gives no rows (C-SAMPLE-17)", () => {
    expect(previewAnswers([], SOURCES)).toEqual([])
  })
})
