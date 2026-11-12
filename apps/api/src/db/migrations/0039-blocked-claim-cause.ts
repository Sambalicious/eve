import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * v1.30.0 EPIC-0009 (owner decision 2026-11-10): the blocked alert says what was blocked and why.
 * Three nullable columns next to `blocked_claim`, which keeps the paragraph:
 *
 * - `blocked_claim_cause`: one of the seven owner-visible causes (OD-1). Null on rows blocked
 *   before this release and on every row that is not blocked.
 * - `blocked_claim_terms`: the flagged words or numbers as written in the paragraph, in paragraph
 *   order, at most 20. Present exactly with a terms cause (`unsupported_terms`, `number_order`,
 *   `no_fact`); null otherwise, never an empty array.
 * - `blocked_claim_more_terms`: how many flagged terms are not in the list, either past the cap or
 *   longer than the contract's 120 characters (OD-4). Present exactly with `blocked_claim_terms`.
 *
 * Additive and empty: no backfill, because a blocked document's content and cited fact IDs were
 * never kept, so an old row's cause cannot be recovered (PRD 6.3). The `application` table's RLS
 * policy and its table-wide grants cover the new columns. `down` is development only.
 */
export const BLOCKED_CLAIM_CAUSE_MARKER = "0039-blocked-claim-cause"

const CAUSES = sql.raw(`('unsupported_terms', 'number_order', 'no_fact', 'contact_detail', 'names_target', 'unknown_fact', 'not_confirmed')`)
const TERMS_CAUSES = sql.raw(`('unsupported_terms', 'number_order', 'no_fact')`)

export async function up(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  await run(sql`alter table application add column blocked_claim_cause text`)
  await run(sql`alter table application add column blocked_claim_terms text[]`)
  await run(sql`alter table application add column blocked_claim_more_terms integer`)

  // One cause value, or none. A cause can only exist while a document is named, which is exactly the
  // blocked state (`application_blocked_pair`, migration 0005).
  await run(sql`alter table application add constraint application_blocked_claim_cause_check
    check (blocked_claim_cause is null or blocked_claim_cause in ${CAUSES})`)
  await run(sql`alter table application add constraint application_blocked_claim_cause_blocked
    check (blocked_claim_cause is null or blocked_document is not null)`)

  // Terms and their count are all present or all absent, and present exactly with a terms cause. The
  // database enforces the 20-term cap; the 120-character bound is the api's (contract D6, OD-4).
  await run(sql`alter table application add constraint application_blocked_claim_terms_pair
    check ((blocked_claim_terms is null) = (blocked_claim_more_terms is null))`)
  await run(sql`alter table application add constraint application_blocked_claim_terms_kind
    check ((blocked_claim_cause is not null and blocked_claim_cause in ${TERMS_CAUSES}) = (blocked_claim_terms is not null))`)
  await run(sql`alter table application add constraint application_blocked_claim_terms_bound
    check (blocked_claim_terms is null
      or (cardinality(blocked_claim_terms) <= 20 and array_position(blocked_claim_terms, null) is null))`)
  await run(sql`alter table application add constraint application_blocked_claim_more_terms_check
    check (blocked_claim_more_terms is null or blocked_claim_more_terms >= 0)`)

  await recordSchemaMarker(db, BLOCKED_CLAIM_CAUSE_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${BLOCKED_CLAIM_CAUSE_MARKER}`.execute(db)
  await sql`alter table application
    drop column blocked_claim_more_terms,
    drop column blocked_claim_terms,
    drop column blocked_claim_cause`.execute(db)
}
