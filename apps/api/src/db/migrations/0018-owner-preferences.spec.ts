import { roleFamilySchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { ownerValues } from "./0018-owner-preferences.js"

/**
 * EPIC-0002 A1 (D16, architecture r4): the owner's stored role family keys are
 * the contracts `roleFamily` enum, `senior_frontend` included. No catalog
 * rename: the key slice B reads is the key ranking.ts and the API use.
 *
 * EPIC-0006 (architecture.r1 "Migration interplay"): 0018 is frozen and its
 * stored values are history, so it keeps the nine-family catalog and the tiers
 * of its own time. This spec reads that frozen catalog, defined here, instead
 * of the live 13-key enum and TIER. EPIC-0002 B1 ranks a family missing from
 * `roleFamilyTiers` in the last tier, which matches the live TIER for the four
 * new families.
 */
const CATALOG_0018 = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "backend", "mobile", "devops_platform", "people_management", "other"]
const TIER_0018: Readonly<Record<string, number>> = {
  senior_frontend: 0, technical_lead: 0, fullstack: 1, product_engineering: 1,
  backend: 2, mobile: 2, devops_platform: 2, people_management: 2, other: 2,
}

describe("migration 0018: owner role family tiers", () => {
  const tiers = ownerValues("Africa/Lagos", "23:00", { amount: "5000.00", currency: "USD" }).roleFamilyTiers

  it("keys every tier by a member of the contracts roleFamily enum", () => {
    for (const key of Object.keys(tiers)) expect(roleFamilySchema.options).toContain(key)
  })

  it("covers every 0018-era role family exactly once, with senior_frontend in tier 1", () => {
    expect(Object.keys(tiers).sort()).toEqual([...CATALOG_0018].sort())
    expect(tiers).toMatchObject({ senior_frontend: 1 })
  })

  it("keeps the 0018-era ranking tiers, shifted from 0..2 to 1..3", () => {
    const shifted = Object.fromEntries(Object.entries(TIER_0018).map(([family, tier]) => [family, tier + 1]))
    expect(tiers).toEqual(shifted)
  })
})
