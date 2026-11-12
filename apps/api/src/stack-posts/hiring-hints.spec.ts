import { Logger } from "@nestjs/common"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ownerValues } from "../db/migrations/0018-owner-preferences.js"
import type { CandidateTx } from "../db/tenant-database.js"
import { PREFERENCES_PARSE_FAILED, hiringHintsIn, parseHintPreferences } from "./hiring-hints.js"

/**
 * EPIC-0007 Phase 1 (contract v1.19.0, AC 2.5, 2.6; threat model P1-7). The 0018
 * owner values give all three terms: if EPIC-0002 slice B1 renames a key, this fails.
 */
const OWNER = ownerValues("Africa/Lagos", "23:00", { amount: "5000.00", currency: "USD" })

/** A CandidateTx stand-in that answers the one `job_preferences` select with `row`. */
function trxReturning(row: { values: unknown } | undefined): { trx: CandidateTx; wheres: unknown[][] } {
  const wheres: unknown[][] = []
  const query = {
    select: () => query,
    where: (...args: unknown[]) => {
      wheres.push(args)
      return query
    },
    executeTakeFirst: async () => row,
  }
  return { trx: { selectFrom: (table: string) => (table === "job_preferences" ? query : undefined) } as unknown as CandidateTx, wheres }
}

afterEach(() => vi.restoreAllMocks())

describe("parseHintPreferences", () => {
  it("reads the three 0018 booleans and ignores every other key", () => {
    expect(parseHintPreferences(OWNER)).toEqual({ remoteAccepted: true, relocationAccepted: true, sponsorshipNeededForRelocation: true })
  })

  it.each([[null], ["x"], [[]], [{}], [{ remoteAccepted: "true", relocationAccepted: true, sponsorshipNeededForRelocation: true }], [{ remoteAccepted: true, relocationAccepted: true }]])("is null for %j", (values) => {
    expect(parseHintPreferences(values)).toBeNull()
  })
})

describe("hiringHintsIn (AC 2.5, 2.6)", () => {
  it("the Operator's 0018 Job Preferences give all three hint terms", async () => {
    const { trx, wheres } = trxReturning({ values: OWNER })
    expect(await hiringHintsIn(trx, "candidate-a")).toEqual(["remote", "relocation", "visa sponsorship"])
    expect(wheres).toEqual([["candidate_id", "=", "candidate-a"]])
  })

  it("pay floor, hours, countries, industries, employment types and seniority add no term", async () => {
    const values = { ...OWNER, remoteAccepted: false, relocationAccepted: false, payFloor: { amount: "9999.00" }, employmentTypes: ["contract"], seniorityLevels: "senior", excludedIndustries: ["remote"] }
    expect(await hiringHintsIn(trxReturning({ values }).trx, "a")).toEqual([])
  })

  it("no Job Preferences row gives [] without a log", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn")
    expect(await hiringHintsIn(trxReturning(undefined).trx, "a")).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it("an unreadable row gives [] and logs the event with no value (P1-7)", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    const values = { remoteAccepted: "SECRET-VALUE", relocationAccepted: true, sponsorshipNeededForRelocation: true, payFloor: { amount: "4321.00" } }
    expect(await hiringHintsIn(trxReturning({ values }).trx, "a")).toEqual([])
    expect(warn.mock.calls).toEqual([[PREFERENCES_PARSE_FAILED]])
    expect(PREFERENCES_PARSE_FAILED).toBe("hiring.preferences_parse_failed")
  })
})
