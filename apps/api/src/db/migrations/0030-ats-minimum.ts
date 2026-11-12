import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * ATS minimum (owner decision 2026-11-01: documents below a minimum ATS score aren't submitted
 * automatically). `candidate_setting.min_ats_percent` (0 to 100, default 40; 0 turns the gate off)
 * and a new blocked reason, `ats_below_minimum`, for an automatic submission held below it.
 * Both tables already have their forced `<table>_candidate` policy; no policy or grant of their own.
 *
 * Frozen: imports nothing from the app or `@eve/contracts`. The reason list is a copy.
 */
export const ATS_MINIMUM_MARKER = "0030-ats-minimum"

const REASONS_BEFORE = ["missing_approved_answer", "login", "email_verification", "captcha", "assessment", "same_company_review", "declaration", "personal_data_request", "automation_incomplete"]

function reasonCheck(reasons: readonly string[]) {
  return sql.raw(`check (blocked_reason = any (array[${reasons.map((reason) => `'${reason}'::text`).join(", ")}]))`)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table candidate_setting add column min_ats_percent smallint not null default 40`.execute(db)
  await sql`alter table candidate_setting add constraint candidate_setting_min_ats_percent_check check (min_ats_percent between 0 and 100)`.execute(db)
  await sql`alter table application drop constraint application_blocked_reason_check`.execute(db)
  await sql`alter table application add constraint application_blocked_reason_check ${reasonCheck([...REASONS_BEFORE, "ats_below_minimum"])}`.execute(db)
  await recordSchemaMarker(db, ATS_MINIMUM_MARKER)
}

/** Reverts 0030. Applications held below the minimum go back to queued first, as the old check doesn't allow the reason. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update application set submission_state = 'queued', blocked_reason = null, blocked_detail = null, blocked_at = null where blocked_reason = 'ats_below_minimum'`.execute(db)
  await sql`alter table application drop constraint application_blocked_reason_check`.execute(db)
  await sql`alter table application add constraint application_blocked_reason_check ${reasonCheck(REASONS_BEFORE)}`.execute(db)
  await sql`delete from migration_marker where name = ${ATS_MINIMUM_MARKER}`.execute(db)
  await sql`alter table candidate_setting drop constraint if exists candidate_setting_min_ats_percent_check`.execute(db)
  await sql`alter table candidate_setting drop column if exists min_ats_percent`.execute(db)
}
