import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0011 Simplify Eve (api-contract.md v1.28.0 "Migration 0033"). Numbered
 * 0033: the next free number after 0032-stuck-checking (D19: merge order decides).
 *
 * - `candidate_view_setting`: one row at most per Candidate. Forced RLS and one
 *   `<table>_candidate` policy whose text is the one 0022-candidate-binding
 *   gives every Candidate policy. Grants come from migrate-and-grant.
 * - Seed (AC-7.2, AC-7.3): the Operator gets Advanced on with no note; every
 *   other active Candidate gets Advanced off with the "simpler" note due. No
 *   automation detection. `on conflict do nothing`, so a rerun never overwrites
 *   a flag a user set. No other table's rows are touched (AC-7.1).
 * - Invariant check (log only): `activation_state` rows with automatic on whose
 *   Candidate is not an Operator are counted and noticed, never changed.
 * - `outcome.type` check widened with `offer` (C1).
 *
 * Frozen and pure SQL: imports nothing from the app. `down` is development only.
 */
export const SIMPLIFY_EVE_MARKER = "0033-simplify-eve"

/** Candidate data: deletion cascades from `candidate`. */
export const SIMPLIFY_EVE_TABLES = ["candidate_view_setting"] as const

/** Copied from 0022-candidate-binding: the policy every Candidate table has after it. */
const BOUND_CANDIDATE = sql.raw("(select public.bound_candidate())")
const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

const OUTCOME_TYPES_WITH_OFFER = "'confirmation', 'rejection', 'interview_invitation', 'request_for_action', 'offer'"
const OUTCOME_TYPES_BEFORE = "'confirmation', 'rejection', 'interview_invitation', 'request_for_action'"

/** The single check constraint on `outcome` that mentions column `type`. Fails when there is none or more than one. */
async function outcomeTypeConstraint(db: Kysely<unknown>): Promise<string> {
  const found = await sql<{ name: string }>`
    select c.conname as name
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'outcome'::regclass and c.contype = 'c' and a.attname = 'type'`.execute(db)
  if (found.rows.length !== 1) throw new Error(`Expected exactly one check constraint on outcome.type, found ${found.rows.length}`)
  return found.rows[0]!.name
}

/** Lifts FORCE RLS on `table` for the owner while `work` runs, then restores it. Same transaction, so nothing else sees the gap. */
async function withoutForcedRls<T>(db: Kysely<unknown>, table: string, work: () => Promise<T>): Promise<T> {
  await sql`alter table ${sql.table(table)} no force row level security`.execute(db)
  try {
    return await work()
  } finally {
    await sql`alter table ${sql.table(table)} force row level security`.execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table candidate_view_setting (
    candidate_id uuid primary key references candidate(id) on delete cascade,
    advanced_enabled boolean not null default false,
    simpler_note_due boolean not null default false,
    improve_list_dismissed_at timestamptz null,
    updated_at timestamptz not null
  )`.execute(db)
  for (const table of SIMPLIFY_EVE_TABLES) {
    const t = sql.table(table)
    await sql`alter table ${t} enable row level security`.execute(db)
    await sql`alter table ${t} force row level security`.execute(db)
    const admitted = sql`candidate_id = ${BOUND_CANDIDATE} and candidate_id = ${CURRENT_CANDIDATE}`
    await sql`create policy ${sql.id(`${table}_candidate`)} on ${t} for all using (${admitted}) with check (${admitted})`.execute(db)
  }

  // A migration is one transaction and `bind_candidate` binds it to one Candidate only, so the set-based seed and
  // the invariant count lift FORCE RLS on the table they read or write, inside this transaction, and restore it.
  await withoutForcedRls(db, "candidate_view_setting", async () => {
    await sql`insert into candidate_view_setting (candidate_id, advanced_enabled, simpler_note_due, updated_at)
      select id, role = 'operator', role <> 'operator', now() from candidate where role = 'operator' or state = 'active'
      on conflict (candidate_id) do nothing`.execute(db)
  })
  const strays = await withoutForcedRls(db, "activation_state", async () =>
    (await sql<{ n: number }>`select count(*)::int as n from activation_state a join candidate c on c.id = a.candidate_id where a.automatic_enabled and c.role <> 'operator'`.execute(db)).rows[0]?.n ?? 0
  )
  await sql`do $$ begin raise notice '0033-simplify-eve: % non-Operator Candidate(s) have automatic submission on (expected 0)', ${sql.raw(String(strays))}; end $$`.execute(db)

  const name = await outcomeTypeConstraint(db)
  await sql`alter table outcome drop constraint ${sql.id(name)}`.execute(db)
  await sql`alter table outcome add constraint outcome_type_check check (type in (${sql.raw(OUTCOME_TYPES_WITH_OFFER)}))`.execute(db)

  await recordSchemaMarker(db, SIMPLIFY_EVE_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${SIMPLIFY_EVE_MARKER}`.execute(db)
  const offers = await withoutForcedRls(db, "outcome", async () => (await sql<{ n: number }>`select count(*)::int as n from outcome where type = 'offer'`.execute(db)).rows[0]?.n ?? 0)
  if (offers > 0) throw new Error("Cannot roll back 0033-simplify-eve: outcome rows with type 'offer' exist")
  const name = await outcomeTypeConstraint(db)
  await sql`alter table outcome drop constraint ${sql.id(name)}`.execute(db)
  await sql`alter table outcome add constraint outcome_type_check check (type in (${sql.raw(OUTCOME_TYPES_BEFORE)}))`.execute(db)
  for (const table of [...SIMPLIFY_EVE_TABLES].reverse()) await sql`drop table ${sql.table(table)}`.execute(db)
}
