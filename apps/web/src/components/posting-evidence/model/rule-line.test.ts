import { describe, expect, it } from "vitest"

import { jobPostingCopy, skipLine, type EligibilityRule } from "@/entities/job-posting"
import { ruleLine } from "./rule-line"

/** EPIC-0002 D44, copy-deck.r6 "Eligibility rules seniority and employment type" (copy-b1 keys 122-128). */
const r = (rule: EligibilityRule["rule"], result: EligibilityRule["result"], quote: string | null = null): EligibilityRule => ({ rule, result, quote })

describe("copy for the D44 rules", () => {
  it("labels seniority and employment type", () => {
    expect(jobPostingCopy.ruleLabel.seniority).toBe("Seniority")
    expect(jobPostingCopy.ruleLabel.employment_type).toBe("Employment type")
  })

  it("uses inline names in Unverified and violated lines, never the raw key", () => {
    expect(jobPostingCopy.unverified("employment_type")).toBe("Unverified: employment type")
    expect(jobPostingCopy.unverified("seniority")).toBe("Unverified: seniority")
    expect(jobPostingCopy.unverified("location")).toBe("Unverified: location")
    expect(skipLine({ skipReason: "violated_rule", skipDetail: "employment_type", applicationSystem: "", coverage: null })).toBe("This job doesn't fit your employment type rule.")
    expect(skipLine({ skipReason: "violated_rule", skipDetail: "pay", applicationSystem: "", coverage: null })).toBe("The pay is below your minimum.")
  })

  it("keeps an unknown detail as sent", () => {
    expect(skipLine({ skipReason: "violated_rule", skipDetail: "visa", applicationSystem: "", coverage: null })).toBe("This job doesn't fit your visa rule.")
  })
})

describe("ruleLine", () => {
  it("seniority: not applicable, no level, and the stored title quote", () => {
    expect(ruleLine(r("seniority", "not_applicable"), null)).toEqual({ kind: "text", text: "You accept every seniority level, so this doesn't apply." })
    expect(ruleLine(r("seniority", "unverified"), null)).toEqual({ kind: "text", text: "The job title doesn't state a level." })
    expect(ruleLine(r("seniority", "violated", "Junior Backend Engineer"), null)).toEqual({ kind: "quote", text: "Junior Backend Engineer" })
  })

  it("employment type: not applicable, stated type when the quote is null, unverified stays the built line", () => {
    expect(ruleLine(r("employment_type", "not_applicable"), "contract")).toEqual({ kind: "text", text: "You accept every employment type, so this doesn't apply." })
    expect(ruleLine(r("employment_type", "met"), "employer_of_record")).toEqual({ kind: "text", text: "Stated in the posting: Employer of record." })
    expect(ruleLine(r("employment_type", "violated"), "contract")).toEqual({ kind: "text", text: "Stated in the posting: Independent contractor." })
    expect(ruleLine(r("employment_type", "unverified"), null)).toEqual({ kind: "text", text: "The posting doesn't say." })
    expect(ruleLine(r("employment_type", "met", "Full-time, permanent"), "direct")).toEqual({ kind: "quote", text: "Full-time, permanent" })
  })

  it("the five built rules keep their lines", () => {
    expect(ruleLine(r("sponsorship", "not_applicable"), null)).toEqual({ kind: "text", text: jobPostingCopy.sponsorshipNotApplicable })
    expect(ruleLine(r("pay", "unverified"), null)).toEqual({ kind: "text", text: "The posting doesn't say." })
    expect(ruleLine(r("location", "met", "Remote, EMEA"), null)).toEqual({ kind: "quote", text: "Remote, EMEA" })
  })
})
