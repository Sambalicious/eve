import { type Kysely, sql } from "kysely"

/**
 * Architecture r4 "Migration of the owner" step 8: the api and the worker
 * start only when the marker exists AND the schema version matches. The
 * runtime role cannot read `kysely_migration` (SEC-001 revokes it), so each
 * EPIC-0002 migration after 0016 records its own name in `migration_marker`
 * as its last statement, inside its own transaction. A run that stopped after
 * 0016 or 0017 therefore lacks the later names, and boot refuses (F-CR-05).
 *
 * Append the name of every later migration whose schema the code needs.
 */
export const MULTI_CANDIDATE_MARKER = "multi_candidate"
export const SCHEMA_MARKERS: readonly string[] = [MULTI_CANDIDATE_MARKER, "0017-row-level-security", "0018-owner-preferences", "0019-candidate-posting", "0020-role-relevance", "0021-hiring-posts", "0022-candidate-binding", "0023-runtime-no-temporary", "0024-alert-feed-candidate-verification", "0025-apply-anyway", "0026-apply-anyway-bounds", "0027-preferences-version", "0028-ats-skills", "0029-ats-fit", "0030-ats-minimum", "0031-pasted-description", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0036-retry-failed-checks", "0037-retry-backfill", "0038-lead-pipeline", "0039-blocked-claim-cause", "0040-outreach-messages", "0041-lead-policy-binding"]

export async function recordSchemaMarker(db: Kysely<unknown>, name: string): Promise<void> {
  if (!SCHEMA_MARKERS.includes(name)) throw new Error(`Unknown schema marker ${name}`)
  await sql`insert into migration_marker (name) values (${name})`.execute(db)
}
