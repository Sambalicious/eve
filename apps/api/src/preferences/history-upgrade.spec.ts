import { DEFAULT_ROLE_FAMILY_TIERS, preferencesValuesSchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { ownerValues } from "../db/migrations/0018-owner-preferences.js"
import { rewriteOwnerValues } from "../db/migrations/0027-preferences-version.js"
import { readHistoryValues } from "./history-upgrade.js"

/** F-QA-B1-01: an immutable history row in the 0018 shape reads as the value 0027 would have written. */
const V1 = ownerValues("Africa/Lagos", "23:00", { amount: "5000.00", currency: "USD" }) as unknown as Record<string, unknown>

describe("readHistoryValues", () => {
  it("a 0018-shape row reads exactly as 0027's rewrite of it, and parses", () => {
    const read = readHistoryValues(V1)
    expect(read).toEqual(rewriteOwnerValues(V1))
    expect(preferencesValuesSchema.safeParse(read).success).toBe(true)
    expect(read?.roleFamilyTiers).toEqual({ ...DEFAULT_ROLE_FAMILY_TIERS })
  })

  it("a current-shape row is returned unchanged", () => {
    const current = rewriteOwnerValues(V1)
    expect(readHistoryValues(current)).toEqual(current)
  })

  it("does not change its input", () => {
    const before = JSON.stringify(V1)
    readHistoryValues(V1)
    expect(JSON.stringify(V1)).toBe(before)
  })

  it.each([
    ["a 0018 row with a bad field", { ...V1, dailyCap: "nine" }],
    ["a row with neither marker that does not parse", { ...rewriteOwnerValues(V1), leftover: 1 }],
    ["not an object", "x"],
    ["null", null],
  ])("%s is corrupt: null", (_label, value) => {
    expect(readHistoryValues(value)).toBeNull()
  })
})
