import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * Apply anyway, bounds and consent (api-contract.md v1.24.0 "Migration
 * 0026-apply-anyway-bounds", PRD AA-2.2, AA-2.7, AA-7.6). Numbered 0026, after
 * 0025-apply-anyway (D19: if another branch merges a 0026 first, renumber).
 *
 * - `application.override_created_at`, `override_status`,
 *   `override_skip_reason`, `override_skip_detail`, `override_violated_rules`:
 *   the time an override was recorded and the decision the Candidate saw. The
 *   submission checks compare the stored decision with the posting's current one.
 * - `application_override_decision_check`: either no stored decision, or status,
 *   violated rules and time all set. `application_override_decision_overridable`:
 *   a stored decision is an overridable one (TM-F-03).
 * - Legacy move: `candidate_override_at` is copied to `override_created_at` and
 *   cleared, with no decision backfilled. A v1.23.x image treats a non-null
 *   `candidate_override_at` as submittable for any skipped or excluded posting,
 *   so leaving it set would let a rolled-back or still-running old image submit
 *   overrides this release refuses. FORCE row-level security is lifted for that
 *   one update, since the owner role is bound to no Candidate (TM-F-01), and the
 *   migration fails if any `candidate_override_at` is left.
 *
 * No index: every read is by Application id or within the Candidate's list scan.
 * The existing grants and RLS policy on `application` cover the columns.
 * Frozen and pure SQL: imports nothing from the app. `down` drops the columns and
 * does not copy times back into `candidate_override_at` (fail-closed).
 */
export const APPLY_ANYWAY_BOUNDS_MARKER = "0026-apply-anyway-bounds"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table application
    add column override_created_at timestamptz,
    add column override_status text check (override_status in ('skipped', 'excluded')),
    add column override_skip_reason text,
    add column override_skip_detail text,
    add column override_violated_rules text[]`.execute(db)
  await sql`alter table application add constraint application_override_decision_check check (
    (override_status is null and override_skip_reason is null and override_skip_detail is null and override_violated_rules is null)
    or (override_status is not null and override_violated_rules is not null and override_created_at is not null))`.execute(db)
  // TM-F-03: a stored decision is always an overridable one (D1, D2, D7): a weak-Match skip with no violated rule,
  // or an exclusion for violated_rule with violated rules exactly {industry}.
  await sql`alter table application add constraint application_override_decision_overridable check (
    override_status is null
    or (override_status = 'skipped' and override_skip_reason in ('weak_core_match', 'uncovered_mandatory_prerequisite', 'no_core_responsibilities') and override_violated_rules = '{}'::text[])
    or (override_status = 'excluded' and override_skip_reason = 'violated_rule' and override_violated_rules = array['industry']::text[]))`.execute(db)
  // TM-F-01: row-level security on application is forced and admits only the bound Candidate (0016, 0022), so the
  // owner role would see no row here. Lift FORCE for this one statement (it is restored in the same transaction).
  await sql`alter table application no force row level security`.execute(db)
  await sql`update application set override_created_at = candidate_override_at, candidate_override_at = null where candidate_override_at is not null`.execute(db)
  await sql`alter table application force row level security`.execute(db)
  const left = await sql<{ n: number }>`select count(*)::int as n from application where candidate_override_at is not null`.execute(db)
  if ((left.rows[0]?.n ?? 0) > 0) throw new Error("0026-apply-anyway-bounds: candidate_override_at is still set on some Applications")
  await recordSchemaMarker(db, APPLY_ANYWAY_BOUNDS_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${APPLY_ANYWAY_BOUNDS_MARKER}`.execute(db)
  await sql`alter table application drop constraint application_override_decision_overridable`.execute(db)
  await sql`alter table application drop constraint application_override_decision_check`.execute(db)
  await sql`alter table application
    drop column override_created_at,
    drop column override_status,
    drop column override_skip_reason,
    drop column override_skip_detail,
    drop column override_violated_rules`.execute(db)
}
