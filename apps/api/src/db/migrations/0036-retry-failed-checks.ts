import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * v1.28.1 automatic retry (owner decision 2026-11-10, "Couldn't check" rows).
 *
 * `candidate_posting.evaluation_attempts` counts how many times an evaluation
 * failed for a row. The worker re-queues a failed row once, automatically, when
 * the failure was transient (`provider_error`, `not_configured`, `invalid_output`,
 * `timed_out`) — the 839 rows left over from the 21-28 Oct provider outage are
 * exactly that. A failure the Candidate must fix (`no_career_profile`,
 * `not_approved`) or that the source caused (`posting_unavailable`) is never
 * retried automatically; the Check again panel still covers those.
 *
 * Existing failed rows are stamped `1`, so they get one retry and no more.
 * DDL plus one UPDATE, additive; the previous image ignores the column.
 * `down` is development only.
 */
export const RETRY_FAILED_CHECKS_MARKER = "0036-retry-failed-checks"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table candidate_posting add column evaluation_attempts smallint not null default 0`.execute(db)
  // Rows that already failed once count as one attempt: the new retry gives them exactly one more, never a loop.
  await sql`update candidate_posting set evaluation_attempts = 1 where status = 'evaluation_failed'`.execute(db)
  await recordSchemaMarker(db, RETRY_FAILED_CHECKS_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${RETRY_FAILED_CHECKS_MARKER}`.execute(db)
  await sql`alter table candidate_posting drop column if exists evaluation_attempts`.execute(db)
}
