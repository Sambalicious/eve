import { Logger } from "@nestjs/common"
import { type HiringHintPreferences, type HiringHintTerm, hiringHintTerms } from "@eve/contracts"
import { z } from "zod"

import type { CandidateTx } from "../db/tenant-database.js"

/**
 * EPIC-0007 Phase 1 (contract v1.19.0, architecture r1 SA-4): the three Job
 * Preferences booleans the hiring search links read. Non-strict: every other
 * key (pay floor, hours, countries, industries, employment types, seniority)
 * is ignored, so none of them adds a term (AC 2.6). The keys are 0018's and
 * provisional until EPIC-0002 slice B1; a rename fails `hiring-hints.spec.ts`.
 */
const hintPreferencesSchema = z.object({
  remoteAccepted: z.boolean(),
  relocationAccepted: z.boolean(),
  sponsorshipNeededForRelocation: z.boolean(),
})

/** The event logged, with no values (threat model P1-7), when a stored row cannot be read. */
export const PREFERENCES_PARSE_FAILED = "hiring.preferences_parse_failed"

const logger = new Logger("HiringHints")

/** A stored `job_preferences.values`, or null when it lacks one of the three booleans. Pure. */
export function parseHintPreferences(values: unknown): HiringHintPreferences | null {
  const parsed = hintPreferencesSchema.safeParse(values)
  return parsed.success ? parsed.data : null
}

/**
 * AC 2.5: the scope Candidate's hint terms, read in the caller's `CandidateTx`
 * (forced RLS plus `candidate_id`). No row gives [] silently; an unreadable row
 * gives [] and logs `hiring.preferences_parse_failed` without any value. Reads only.
 */
export async function hiringHintsIn(trx: CandidateTx, candidateId: string): Promise<HiringHintTerm[]> {
  const row = await trx.selectFrom("job_preferences").select("values").where("candidate_id", "=", candidateId).executeTakeFirst()
  if (row === undefined) return []
  const preferences = parseHintPreferences(row.values)
  if (preferences === null) {
    logger.warn(PREFERENCES_PARSE_FAILED)
    return []
  }
  return hiringHintTerms(preferences)
}
