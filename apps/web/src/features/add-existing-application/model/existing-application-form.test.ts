import { describe, expect, it } from "vitest"

import {
  emptyExistingApplicationForm,
  toNewExistingApplication,
  validateExistingApplication,
} from "./existing-application-form"

const filled = {
  company: "Globex",
  roleTitle: "Frontend Lead",
  applicationUrl: "https://jobs.lever.co/globex/abc-123",
  requisitionId: "",
  appliedOn: "2026-09-30",
}

describe("existing application form (F1 step 6a.5)", () => {
  it("shows only the first empty field, in the contract's order (C-VAL-EXIST-1)", () => {
    expect(validateExistingApplication(emptyExistingApplicationForm)).toEqual({
      company: "Enter the company.",
    })
    expect(
      validateExistingApplication({
        ...filled,
        roleTitle: " ",
        applicationUrl: "",
      })
    ).toEqual({ roleTitle: "Enter the role." })
    expect(
      validateExistingApplication({ ...filled, applicationUrl: "" })
    ).toEqual({ applicationUrl: "Enter the employer application URL." })
    expect(validateExistingApplication({ ...filled, appliedOn: "" })).toEqual({
      appliedOn: "Enter the date you applied.",
    })
  })

  it("refuses a link that isn't absolute http(s) and a date that isn't real (C-VAL-EXIST-2)", () => {
    expect(
      validateExistingApplication({
        ...filled,
        applicationUrl: "jobs.lever.co/globex",
      })
    ).toEqual({
      applicationUrl: "Enter a full link that starts with https:// or http://.",
    })
    expect(
      validateExistingApplication({
        ...filled,
        applicationUrl: "ftp://example.com/x",
      }).applicationUrl
    ).toBeDefined()
    expect(
      validateExistingApplication({ ...filled, appliedOn: "2026-02-30" })
    ).toEqual({ appliedOn: "Enter a real date." })
    expect(validateExistingApplication(filled)).toEqual({})
  })

  it("trims values and sends an empty requisition ID as null", () => {
    expect(
      toNewExistingApplication({
        ...filled,
        company: " Globex ",
        requisitionId: "  ",
      })
    ).toEqual({
      company: "Globex",
      roleTitle: "Frontend Lead",
      applicationUrl: "https://jobs.lever.co/globex/abc-123",
      requisitionId: null,
      appliedOn: "2026-09-30",
    })
    expect(
      toNewExistingApplication({ ...filled, requisitionId: " L-77 " })
        .requisitionId
    ).toBe("L-77")
  })
})
