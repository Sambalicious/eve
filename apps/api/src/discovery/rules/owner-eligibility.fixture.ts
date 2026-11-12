import type { EligibilityPreferences } from "./eligibility.js"

/**
 * Test fixture: the Operator's migrated Job Preferences (0018 + 0027 v2) as the
 * Eligibility rules read them. Rule specs written against EPIC-0001's owner
 * values use it; production reads each Candidate's record. Values only, in one
 * place: `owner-eligibility.fixture.spec.ts` keeps them equal to migration
 * 0018's `ownerValues`.
 */
export const OWNER_ELIGIBILITY: EligibilityPreferences = {
  homeCountry: "NG",
  workAuthorizedCountries: ["NG"],
  remoteAccepted: true,
  relocationAccepted: true,
  sponsorshipNeededForRelocation: true,
  excludedRelocationCountries: ["OM", "TR", "JO", "LB", "TH"],
  excludedIndustries: ["adult_content", "video_games_and_gaming_platforms", "gambling", "betting"],
  payFloor: { amount: "2000.00", currency: "USD", period: "month" },
  timeZone: "Africa/Lagos",
  latestWorkHour: "23:00",
  seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
  employmentTypes: ["direct", "employer_of_record", "contract"],
}
