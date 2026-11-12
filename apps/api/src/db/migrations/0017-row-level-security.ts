import { type Kysely, sql } from "kysely"
import type { Migration } from "kysely/migration"

import { recordSchemaMarker } from "./schema-markers.js"

import { CANDIDATE_TABLES } from "./0016-multi-candidate.js"

/**
 * EPIC-0002 A1 unit 3 (architecture r2, Tenancy and isolation enforcement 1-2).
 * Runs after the multi-candidate migration (numbering per D19: nothing reserved).
 * `job_criteria` (EPIC-0004) is in CANDIDATE_TABLES, so it gets
 * `job_criteria_candidate` like every other Candidate table, and so are three
 * EPIC-0005 Stack posts tables (`alert_feed`, `stack_post`, `stack_post_run`).
 * `alert_feed_verification` is shared (r5 K6): no RLS.
 *
 * 1. The 0016 owner default on `candidate_id` goes: every write names its
 *    Candidate, and a write that forgets is refused (not null, and the policy
 *    check) instead of landing on the owner.
 * 2. Every Candidate-data table gets RLS, enabled and forced, and the policy
 *    `<table>_candidate`: a row is visible and writable only when its
 *    `candidate_id` equals the transaction-local `eve.candidate_id`. An unset
 *    setting yields null, which matches nothing.
 * 3. `ai_call`, the one mixed table, also gets `ai_call_shared`: a row with no
 *    Candidate, only while `eve.scope = 'shared'` (set only by `forShared`).
 *
 * 4. (C36, architecture r4 Tenancy 2a) EPIC-0003's installation-only data:
 *    `access_request` and `access_request_drop` get forced RLS and one policy,
 *    `<table>_installation`, admitting rows only while `eve.scope =
 *    'installation'` (set only by `TenantDatabase.forInstallation`). The
 *    outbox's `access_request` and `access_request_cap` rows lose the owner
 *    0016 gave them (null `candidate_id`, tied to the kind by a check) and are
 *    admitted by `notification_outbox_installation`. No Candidate scope, the
 *    shared scope or an unscoped transaction reads any of them. This runs
 *    before RLS is forced on the outbox: the owner role obeys the policies too.
 *
 * FORCE makes the owner role obey the policies too, so no application role
 * bypasses them; only the bootstrap superuser does, and nothing at runtime
 * connects as it.
 */
export const RLS_TABLES: readonly string[] = [...CANDIDATE_TABLES, "ai_call"]

/** The one table with a second, shared-scope policy (architecture r2, mixed table rule). */
export const MIXED_TABLES: readonly string[] = ["ai_call"]

/** C36: installation-only tables (no `candidate_id`); visible only in `forInstallation`. */
export const INSTALLATION_TABLES: readonly string[] = ["access_request", "access_request_drop"]

/** C36: outbox kinds that are installation rows (null `candidate_id`). */
export const INSTALLATION_OUTBOX_KINDS = ["access_request", "access_request_cap"] as const

const INSTALLATION_SCOPE = sql.raw("current_setting('eve.scope', true) = 'installation'")

const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

export const up: Migration["up"] = async (db: Kysely<unknown>) => {
  const installationKinds = sql.join(INSTALLATION_OUTBOX_KINDS.map((kind) => sql.lit(kind)))
  await sql`alter table notification_outbox alter column candidate_id drop not null`.execute(db)
  await sql`update notification_outbox set candidate_id = null where kind in (${installationKinds})`.execute(db)
  await sql`alter table notification_outbox add constraint notification_outbox_installation_kind
    check ((candidate_id is null) = (kind in (${installationKinds})))`.execute(db)

  for (const table of RLS_TABLES) {
    const t = sql.table(table)
    await sql`alter table ${t} alter column candidate_id drop default`.execute(db)
    await sql`alter table ${t} enable row level security`.execute(db)
    await sql`alter table ${t} force row level security`.execute(db)
    await sql`create policy ${sql.id(`${table}_candidate`)} on ${t} for all
      using (candidate_id = ${CURRENT_CANDIDATE}) with check (candidate_id = ${CURRENT_CANDIDATE})`.execute(db)
  }
  for (const table of MIXED_TABLES) {
    const shared = sql.raw("candidate_id is null and current_setting('eve.scope', true) = 'shared'")
    await sql`create policy ${sql.id(`${table}_shared`)} on ${sql.table(table)} for all using (${shared}) with check (${shared})`.execute(db)
  }
  const installationRow = sql`candidate_id is null and ${INSTALLATION_SCOPE}`
  await sql`create policy notification_outbox_installation on notification_outbox for all using (${installationRow}) with check (${installationRow})`.execute(db)
  for (const table of INSTALLATION_TABLES) {
    const t = sql.table(table)
    await sql`alter table ${t} enable row level security`.execute(db)
    await sql`alter table ${t} force row level security`.execute(db)
    await sql`create policy ${sql.id(`${table}_installation`)} on ${t} for all using (${INSTALLATION_SCOPE}) with check (${INSTALLATION_SCOPE})`.execute(db)
  }
  await recordSchemaMarker(db, "0017-row-level-security")
}
