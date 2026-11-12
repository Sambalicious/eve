import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * v1.29.0 lead pipeline, policy repair. 0038 created `lead_candidate` with the
 * 0017 form (the `eve.candidate_id` setting only). Every Candidate table since
 * 0022 also requires the transaction's Candidate binding, so this drops the
 * policy and recreates it with both. 0038 is left as it ran.
 *
 * - Same table, same policy name, same `for all`. Only the predicate changes.
 * - No data change. `down` restores the 0038 policy.
 */
export const LEAD_POLICY_BINDING_MARKER = "0041-lead-policy-binding"

/** Copied from 0022-candidate-binding: the policy every Candidate table has after it. */
const BOUND_CANDIDATE = sql.raw("(select public.bound_candidate())")
const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

export async function up(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  await run(sql`drop policy ${sql.id("lead_candidate")} on lead`)
  const admitted = sql`candidate_id = ${BOUND_CANDIDATE} and candidate_id = ${CURRENT_CANDIDATE}`
  await run(sql`create policy ${sql.id("lead_candidate")} on lead for all using (${admitted}) with check (${admitted})`)

  await recordSchemaMarker(db, LEAD_POLICY_BINDING_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${LEAD_POLICY_BINDING_MARKER}`.execute(db)
  await sql`drop policy ${sql.id("lead_candidate")} on lead`.execute(db)
  await sql`create policy ${sql.id("lead_candidate")} on lead for all
    using (candidate_id = ${CURRENT_CANDIDATE}) with check (candidate_id = ${CURRENT_CANDIDATE})`.execute(db)
}
