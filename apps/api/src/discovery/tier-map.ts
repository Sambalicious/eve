import type { CandidateTx } from "../db/tenant-database.js"
import { readPreferences } from "../preferences/preferences-read.js"
import type { TierMap } from "./job-postings-query.js"
import { rankTiersOf } from "./rules/preference-rules.js"
import { TIER } from "./rules/ranking.js"

/**
 * EPIC-0002 B1: the Candidate's tier sort keys from their current Job
 * Preferences, read in the caller's transaction. The Ranked tab, `ranksOf`,
 * the cursor `tierHash`, the submission queue and samples all use it, so the
 * displayed rank is the submission order. With no record (an invitee before
 * wizard step 3) the built TIER applies, which equals `DEFAULT_ROLE_FAMILY_TIERS`.
 */
export async function tierMapIn(tx: CandidateTx, candidateId: string): Promise<TierMap> {
  const preferences = await readPreferences(tx, candidateId)
  return preferences === null ? TIER : rankTiersOf(preferences.values.roleFamilyTiers)
}
