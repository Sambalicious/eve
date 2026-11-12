import { type PreferencesValues, preferencesValuesSchema } from "@eve/contracts"

import type { CandidateTx } from "../db/tenant-database.js"

/** One Job Preferences version as the rules read it. */
export type PreferencesSnapshot = Readonly<{ version: number; values: PreferencesValues }>

/**
 * The Candidate's current Job Preferences, read in the caller's `CandidateTx`
 * (forced RLS; the statement also names the Candidate), or null with no record
 * (an invitee before wizard step 3). `lock: "share"` takes `job_preferences`
 * FOR SHARE (B1 unit 7 lock order); no caller passes it before unit 7.
 *
 * A stored value that no longer parses is corrupt data: this throws, and the
 * caller's transaction fails closed with a log that names no stored value.
 */
export async function readPreferences(trx: CandidateTx, candidateId: string, lock: "none" | "share" = "none"): Promise<PreferencesSnapshot | null> {
  let query = trx.selectFrom("job_preferences").select(["version", "values"]).where("candidate_id", "=", candidateId)
  if (lock === "share") query = query.forShare()
  const row = await query.executeTakeFirst()
  if (!row) return null
  const parsed = preferencesValuesSchema.safeParse(row.values)
  if (!parsed.success) throw new Error("Stored Job Preferences do not match the v1.25.0 shape")
  return { version: row.version, values: parsed.data }
}
