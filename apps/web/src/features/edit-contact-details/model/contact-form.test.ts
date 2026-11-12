import { describe, expect, it } from "vitest"

import { validateContact } from "./contact-form"

describe("validateContact (C-VAL-SET-3 to C-VAL-SET-5, contract candidateContactSchema)", () => {
  it("trims the name and lines and drops blank lines", () => {
    expect(validateContact("  Ada Okafor ", ["Lagos, Nigeria", "  ", "  ada@example.com  "])).toEqual({
      value: { fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] },
      errors: {},
    })
  })

  it("requires a name (C-VAL-SET-3)", () => {
    expect(validateContact("   ", []).errors).toEqual({ fullName: "Enter your name." })
  })

  it("allows 120 characters and refuses 121, for the name and per line (C-VAL-SET-4)", () => {
    expect(validateContact("a".repeat(120), ["b".repeat(120)]).value).not.toBeNull()
    expect(validateContact("a".repeat(121), []).errors.fullName).toBe("Use 120 characters or fewer for your name.")
    expect(validateContact("Ada", ["ok", "b".repeat(121)]).errors.lines).toEqual({ 1: "Use 120 characters or fewer on each line." })
  })

  it("allows 6 lines and refuses 7 (C-VAL-SET-5)", () => {
    expect(validateContact("Ada", ["1", "2", "3", "4", "5", "6"]).value?.lines).toHaveLength(6)
    expect(validateContact("Ada", ["1", "2", "3", "4", "5", "6", "7"]).errors.linesField).toBe("Use at most 6 lines.")
  })
})
