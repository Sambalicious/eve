import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * v1.28.0 manual apply lane (owner decision 2026-11-10). Numbered 0035: the
 * next free number after 0034-forward-statements (D19: merge order decides).
 *
 * `application_override_decision_overridable` (0026, TM-F-03) allowed a stored
 * decision only for the three weak-Match skip reasons. The manual lane reuses
 * the same consent record for `unsupported_application_system`: Eve cannot
 * submit through that employer's system, so the documents are prepared and the
 * Candidate applies by hand. The posting's `apply_mode` stays `manual`, so the
 * submission checks still refuse to queue or send the Application.
 *
 * DDL only, additive, and the previous image keeps working: it never writes
 * this reason into an override, and the widened CHECK accepts every row the old
 * constraint accepted. Frozen and pure SQL: imports nothing from the app.
 * `down` is development only and fails if a manual override already exists.
 */
export const MANUAL_APPLY_LANE_MARKER = "0035-manual-apply-lane"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table application drop constraint application_override_decision_overridable`.execute(db)
  await sql`alter table application add constraint application_override_decision_overridable check (
    override_status is null
    or (override_status = 'skipped' and override_skip_reason in ('weak_core_match', 'uncovered_mandatory_prerequisite', 'no_core_responsibilities', 'unsupported_application_system') and override_violated_rules = '{}'::text[])
    or (override_status = 'excluded' and override_skip_reason = 'violated_rule' and override_violated_rules = array['industry']::text[]))`.execute(db)
  await recordSchemaMarker(db, MANUAL_APPLY_LANE_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${MANUAL_APPLY_LANE_MARKER}`.execute(db)
  await sql`alter table application drop constraint application_override_decision_overridable`.execute(db)
  await sql`alter table application add constraint application_override_decision_overridable check (
    override_status is null
    or (override_status = 'skipped' and override_skip_reason in ('weak_core_match', 'uncovered_mandatory_prerequisite', 'no_core_responsibilities') and override_violated_rules = '{}'::text[])
    or (override_status = 'excluded' and override_skip_reason = 'violated_rule' and override_violated_rules = array['industry']::text[]))`.execute(db)
}
