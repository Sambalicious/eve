import { PAY_CURRENCIES, preferencesValuesSchema, roleFamilySchema, seniorityLevelSchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { ownerValues } from "./0018-owner-preferences.js"
import { FROZEN_PAY_CURRENCIES, FROZEN_TIME_ZONES, ownerPreferencesRefusal, rewriteOwnerValues } from "./0027-preferences-version.js"

/**
 * EPIC-0002 B1 (architecture.r6 "B1 amendment (threat model F-TM-04): migration
 * 0025", renumbered 0026 after apply anyway's 0025 and 0027 after apply anyway
 * bounds' 0026 at the merges, D19; threat
 * model TM-B1-15): the Operator's 0018 value becomes version 2 in the v1.25.0
 * shape (contract v1.23.0 as developed), and a value it refuses stops the
 * migration. Its database half is test/preferences-version-migration.int-spec.ts.
 */
const V1 = ownerValues("Africa/Lagos", "23:00", { amount: "5000.00", currency: "USD" }) as unknown as Record<string, unknown>
const NEW_FAMILIES = ["software_engineering", "platform_engineering", "data_ml", "solutions_customer"]

function refusalOf(patch: Record<string, unknown>): string | null {
  return ownerPreferencesRefusal({ ...rewriteOwnerValues(V1), ...patch })
}

describe("migration 0027: the Operator v2 rewrite", () => {
  const v2 = rewriteOwnerValues(V1)

  it("parses with the v1.25.0 preferencesValuesSchema", () => {
    expect(preferencesValuesSchema.safeParse(v2).success).toBe(true)
  })

  it("removes excludedRoleFamilies and sets seniorityLevels to all five levels", () => {
    expect(v2).not.toHaveProperty("excludedRoleFamilies")
    expect(v2.seniorityLevels).toEqual([...seniorityLevelSchema.options])
  })

  it("adds the four EPIC-0006 families at tier 3 and keeps the nine 0018 tiers", () => {
    const tiers = v2.roleFamilyTiers as Record<string, unknown>
    expect(Object.keys(tiers).sort()).toEqual([...roleFamilySchema.options].sort())
    for (const family of NEW_FAMILIES) expect(tiers[family]).toBe(3)
    expect(tiers).toMatchObject(V1.roleFamilyTiers as Record<string, unknown>)
  })

  it("keeps every other key byte-equal", () => {
    const changed = new Set(["seniorityLevels", "roleFamilyTiers", "excludedRoleFamilies"])
    const rest = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).filter(([key]) => !changed.has(key)))
    expect(rest(v2)).toBe(rest(V1))
  })

  it("does not change its input (v1 stays as it is)", () => {
    const before = JSON.stringify(V1)
    rewriteOwnerValues(V1)
    expect(JSON.stringify(V1)).toBe(before)
  })

  it("passes the preflight", () => {
    expect(ownerPreferencesRefusal(v2)).toBeNull()
  })
})

describe("migration 0027: the preflight refuses a value v1.25.0 refuses", () => {
  const pay = (basis: "gross" | "net", patch: Record<string, unknown>) => ({ amount: "2000.00", currency: "USD", period: "month", basis, ...patch })
  const tiers = rewriteOwnerValues(V1).roleFamilyTiers as Record<string, unknown>

  it.each([
    ["keys", { excludedRoleFamilies: [] }],
    ["keys", { leftover: true }],
    ["roleFamilyTiers", { roleFamilyTiers: { ...tiers, unknown_family: 3 } }],
    ["roleFamilyTiers", { roleFamilyTiers: { ...tiers, other: 4 } }],
    ["roleFamilyTiers", { roleFamilyTiers: Object.fromEntries(Object.keys(tiers).map((key) => [key, "excluded"])) }],
    ["payFloor.currency", { payFloor: pay("gross", { currency: "NGN" }) }],
    ["preferredPay.currency", { preferredPay: pay("net", { currency: "NGN" }) }],
    ["payFloor.amount", { payFloor: pay("gross", { amount: "1234567890.00" }) }],
    ["preferredPay.amount", { preferredPay: pay("net", { amount: "1234567890.00" }) }],
    ["preferredPay.amount", { preferredPay: pay("net", { amount: "5000" }) }],
    ["latestWorkHour", { latestWorkHour: "00:30" }],
    ["latestWorkHour", { latestWorkHour: "24:00" }],
    ["timeZone", { timeZone: "Mars/Base" }],
    ["timeZone", { timeZone: "africa/lagos" }],
  ])("names %s", (field, patch) => {
    expect(refusalOf(patch)).toBe(field)
  })

  it("accepts UTC as the time zone", () => {
    expect(refusalOf({ timeZone: "UTC" })).toBeNull()
  })

  it("a refusal from the rewrite names the field and never the value", async () => {
    const { refuseUnlessConforming } = await import("./0027-preferences-version.js")
    const bad = { ...rewriteOwnerValues(V1), preferredPay: pay("net", { currency: "NGN" }), timeZone: "Mars/Base" }
    expect(() => refuseUnlessConforming(bad)).toThrow(/^owner_preferences_migration_refused: preferredPay\.currency$/)
    try {
      refuseUnlessConforming(bad)
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/NGN|Mars/)
    }
  })
})

describe("migration 0027: frozen lists", () => {
  it("the frozen currency list equals PAY_CURRENCIES (a later migration copies a new code; 0027 stays frozen)", () => {
    expect([...FROZEN_PAY_CURRENCIES]).toEqual([...PAY_CURRENCIES])
  })

  it("the frozen zone list is unique, has no UTC entry of its own and holds the Operator's zone", () => {
    expect(new Set(FROZEN_TIME_ZONES).size).toBe(FROZEN_TIME_ZONES.length)
    expect(FROZEN_TIME_ZONES).toContain("Africa/Lagos")
    expect(FROZEN_TIME_ZONES).not.toContain("Mars/Base")
  })
})
