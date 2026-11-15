import { describe, expect, it } from "vitest"

import { isSensitiveLabel, maskedValue } from "./review.js"

describe("the review step's sensitive-value treatment (ADR 0016)", () => {
  it("marks the labelled classes of data the Candidate may not want on screen", () => {
    for (const label of [
      "Gender", "Sex", "Sexual orientation", "Pronouns", "Race", "Ethnicity", "Are you Hispanic or Latino?",
      "Religion", "Disability status", "Veteran status", "Citizenship", "Criminal history",
      "Social Security Number", "SSN", "Age", "Your age", "How old are you?", "Expected salary", "Current salary",
      "Date of birth", "Sponsorship required?", "Visa status",
    ]) {
      expect(isSensitiveLabel(label)).toBe(true)
    }
  })

  it("leaves an ordinary contact field unmasked", () => {
    for (const label of ["First name", "Email", "Location", "Years of experience", "Language", "Image upload", "Page number", "Manage alerts"]) {
      expect(isSensitiveLabel(label)).toBe(false)
    }
  })

  it("masks every value with the same eight dots, so the mask does not reveal its length", () => {
    expect(maskedValue("Ada")).toBe("•".repeat(8))
    expect(maskedValue("")).toBe("")
    expect(maskedValue("x".repeat(20))).toBe("•".repeat(8))
    expect(maskedValue("x")).toBe(maskedValue("x".repeat(200)))
  })
})
