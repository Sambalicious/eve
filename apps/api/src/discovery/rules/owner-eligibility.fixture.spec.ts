import { describe, expect, it } from "vitest"

import { ownerValues } from "../../db/migrations/0018-owner-preferences.js"
import { OWNER_ELIGIBILITY } from "./owner-eligibility.fixture.js"

describe("OWNER_ELIGIBILITY equals the Operator's migrated values", () => {
  it("every field the Eligibility rules read matches 0018 with the default hours setting (23:00 Africa/Lagos)", () => {
    const migrated = ownerValues("Africa/Lagos", "23:00", { amount: "5000.00", currency: "USD" })
    expect(OWNER_ELIGIBILITY).toEqual({
      homeCountry: migrated.homeCountry,
      workAuthorizedCountries: migrated.workAuthorizedCountries,
      remoteAccepted: migrated.remoteAccepted,
      relocationAccepted: migrated.relocationAccepted,
      sponsorshipNeededForRelocation: migrated.sponsorshipNeededForRelocation,
      excludedRelocationCountries: migrated.excludedRelocationCountries,
      excludedIndustries: migrated.excludedIndustries,
      payFloor: { amount: migrated.payFloor.amount, currency: migrated.payFloor.currency, period: migrated.payFloor.period },
      timeZone: migrated.timeZone,
      latestWorkHour: migrated.latestWorkHour,
      // 0027 v2 sets all five levels (0018 stored "all"); 0018's three employment types.
      seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
      employmentTypes: migrated.employmentTypes,
    })
  })
})
