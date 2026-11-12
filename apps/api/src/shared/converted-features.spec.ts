import { describe, expect, it } from "vitest"

import { CONVERTED, capabilityFor } from "./converted-features.js"

describe("capabilityFor (architecture r3: isOperator || CONVERTED[feature])", () => {
  it("is available for the Operator on every feature in slice A", () => {
    expect([capabilityFor("submission", true), capabilityFor("notifications", true), capabilityFor("spend", true)]).toEqual(["available", "available", "available"])
  })

  it("is not_yet for a non-Operator on every feature in slice A", () => {
    expect(CONVERTED).toEqual({ submission: false, notifications: false, spend: false })
    expect([capabilityFor("submission", false), capabilityFor("notifications", false), capabilityFor("spend", false)]).toEqual(["not_yet", "not_yet", "not_yet"])
  })

  it("is available for a non-Operator once the feature is converted", () => {
    expect(capabilityFor("spend", false, { submission: false, notifications: false, spend: true })).toBe("available")
    expect(capabilityFor("submission", false, { submission: false, notifications: false, spend: true })).toBe("not_yet")
  })
})
