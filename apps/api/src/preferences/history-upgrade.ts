import { type PreferencesValues, preferencesValuesSchema } from "@eve/contracts"

import { rewriteOwnerValues } from "../db/migrations/0027-preferences-version.js"

/**
 * EPIC-0002 B1 F-QA-B1-01: reading an immutable `job_preferences_version` row
 * (D40) that predates the v1.25.0 shape. Migration 0018 wrote version 1 with
 * 18 keys (`excludedRoleFamilies`, `seniorityLevels: "all"`, nine tiers);
 * migration 0027 rewrote only the Operator's current value and kept the
 * history byte-equal. A row that already parses is returned as is. A row in
 * the 0018 shape is upgraded in memory with 0027's own mapping
 * (`rewriteOwnerValues`), so the history reads what 0027 would have written,
 * and the stored row is never changed. Anything else is corrupt data: null,
 * and the caller fails closed without naming a value.
 */
export function readHistoryValues(stored: unknown): PreferencesValues | null {
  const current = preferencesValuesSchema.safeParse(stored)
  if (current.success) return current.data
  if (!isShape0018(stored)) return null
  const upgraded = preferencesValuesSchema.safeParse(rewriteOwnerValues(stored))
  return upgraded.success ? upgraded.data : null
}

/** The 0018 markers: the removed `excludedRoleFamilies` key, or the string `seniorityLevels: "all"`. */
function isShape0018(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return "excludedRoleFamilies" in record || record.seniorityLevels === "all"
}
