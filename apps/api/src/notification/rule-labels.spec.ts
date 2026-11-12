import { ruleNameSchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { renderConfirmed } from "./email-content.js"
import { SKIP_LABEL } from "./notification-sender.js"
import { ruleInlineLabel } from "./rule-labels.js"

/**
 * EPIC-0002 B1 (D44, copy deck r6 `ruleInlineLabel`, commit 8f0eb00): emails
 * name a rule in the dashboard's inline words, never the raw key.
 */
describe("ruleInlineLabel", () => {
  it("has the copy deck's words for every rule name", () => {
    expect(Object.fromEntries(ruleNameSchema.options.map((rule) => [rule, ruleInlineLabel(rule)]))).toEqual({
      location: "location",
      sponsorship: "sponsorship",
      pay: "pay",
      hours: "hours",
      industry: "industry",
      seniority: "seniority",
      employment_type: "employment type",
    })
  })

  it("an unknown stored name falls back to itself", () => {
    expect(ruleInlineLabel("future_rule")).toBe("future_rule")
  })
})

describe("emails print the inline words", () => {
  it("daily summary: doesn't fit your employment type rule; the five EPIC-0001 rules read as before", () => {
    expect(SKIP_LABEL.violated_rule!("employment_type")).toBe("doesn't fit your employment type rule")
    expect(SKIP_LABEL.violated_rule!("industry")).toBe("doesn't fit your industry rule")
    expect(SKIP_LABEL.violated_rule!(null)).toBe("doesn't fit one of your rules")
  })

  it("E1 Unverified line: employment type, seniority", () => {
    const email = renderConfirmed(
      {
        applicationId: "00000000-0000-4000-8000-000000000001", role: "Engineer", company: "Acme", requisitionId: "R-1",
        submittedAt: new Date("2026-10-20T09:00:00Z"), evidence: { kind: "confirmation_page" } as never, sentAs: "automatic",
        employmentType: null, unverified: ["pay", "seniority", "employment_type"], coverLetterStatus: "uploaded", automaticToday: 1,
      } as never,
      "https://eve.test"
    )
    expect(email.text).toContain("Unverified: pay, seniority, employment type")
    expect(email.text).not.toContain("employment_type")
  })
})
