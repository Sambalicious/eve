import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0010 (architecture "Data model change", ADR 0013): Candidate-private pasted-description postings.
 *
 * `up`, one transaction:
 * 1. Both origin CHECKs (inline in 0004 and 0019, so named `<table>_origin_check`) gain
 *    `pasted_description`. The names are looked up first; a missing one fails loudly (risk R2).
 * 2. `job_posting.owner_candidate_id` (the one Candidate who may see a private row) and
 *    `job_posting.paste_fingerprint` (hex sha256, description-only rows).
 * 3. CHECKs: pasted ⇔ owner, pasted ⇒ manual, fingerprint ⇒ pasted.
 * 4. Partial unique indexes: one description-only row per (owner, fingerprint), one linked
 *    pasted row per (owner, normalised link).
 * 5. Forced RLS on `job_posting`, last: shared rows (no owner) are visible in every scope,
 *    owned rows only in their owner's scope, bound by bind_candidate as the 0022 policies are.
 *
 * `down` is lossless for documents: RLS goes first (the migration runs unscoped and must see
 * private rows), pasted rows become `pasted_link` (still `manual`, still keyed `pasted:<id>`),
 * then the columns, constraints and indexes go.
 *
 * Frozen: imports nothing from the app or `@eve/contracts`.
 */
export const PASTED_DESCRIPTION_MARKER = "0031-pasted-description"

const ORIGINS_BEFORE = ["employer_board", "remote_board", "pasted_link"]
const ORIGINS_AFTER = [...ORIGINS_BEFORE, "pasted_description"]
const ORIGIN_CHECKS = [
  { table: "job_posting", constraint: "job_posting_origin_check" },
  { table: "candidate_posting", constraint: "candidate_posting_origin_check" },
] as const

const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")
/** The Candidate bind_candidate recorded for this transaction (0022): re-pointing the setting cannot move it. */
const BOUND_CANDIDATE = sql.raw("(select public.bound_candidate())")
const OWNER_VISIBLE = sql`owner_candidate_id is null or (owner_candidate_id = ${BOUND_CANDIDATE} and owner_candidate_id = ${CURRENT_CANDIDATE})`

function originCheck(origins: readonly string[]) {
  return sql.raw(`check (origin = any (array[${origins.map((origin) => `'${origin}'::text`).join(", ")}]))`)
}

async function replaceOriginChecks(db: Kysely<unknown>, origins: readonly string[]): Promise<void> {
  for (const { table, constraint } of ORIGIN_CHECKS) {
    await sql`alter table ${sql.table(table)} drop constraint ${sql.id(constraint)}`.execute(db)
    await sql`alter table ${sql.table(table)} add constraint ${sql.id(constraint)} ${originCheck(origins)}`.execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const { table, constraint } of ORIGIN_CHECKS) {
    const found = await sql<{ n: number }>`select count(*)::int as n from pg_constraint where conname = ${constraint} and conrelid = ${table}::regclass and contype = 'c'`.execute(db)
    if (found.rows[0]?.n !== 1) throw new Error(`0031: expected CHECK ${constraint} on ${table}`)
  }
  await replaceOriginChecks(db, ORIGINS_AFTER)

  await sql`alter table job_posting add column owner_candidate_id uuid references candidate (id)`.execute(db)
  await sql`alter table job_posting add column paste_fingerprint text`.execute(db)
  await sql`alter table job_posting add constraint job_posting_pasted_owner_check check ((origin = 'pasted_description') = (owner_candidate_id is not null))`.execute(db)
  await sql`alter table job_posting add constraint job_posting_pasted_manual_check check (origin <> 'pasted_description' or apply_mode = 'manual')`.execute(db)
  await sql`alter table job_posting add constraint job_posting_pasted_fingerprint_check check (paste_fingerprint is null or origin = 'pasted_description')`.execute(db)

  await sql`create unique index job_posting_pasted_text_uq on job_posting (owner_candidate_id, paste_fingerprint) where paste_fingerprint is not null`.execute(db)
  await sql`create unique index job_posting_pasted_link_uq on job_posting (owner_candidate_id, application_url) where origin = 'pasted_description' and paste_fingerprint is null`.execute(db)

  await sql`alter table job_posting enable row level security`.execute(db)
  await sql`alter table job_posting force row level security`.execute(db)
  await sql`create policy job_posting_owner on job_posting for all
    using (${OWNER_VISIBLE})
    with check (${OWNER_VISIBLE})`.execute(db)
  await recordSchemaMarker(db, PASTED_DESCRIPTION_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists job_posting_owner on job_posting`.execute(db)
  await sql`alter table job_posting no force row level security`.execute(db)
  await sql`alter table job_posting disable row level security`.execute(db)

  // candidate_posting has forced RLS and this runs unscoped: lift FORCE for the one data step, as 0026 does.
  await sql`alter table candidate_posting no force row level security`.execute(db)
  await sql`update candidate_posting set origin = 'pasted_link' where origin = 'pasted_description'`.execute(db)
  await sql`alter table candidate_posting force row level security`.execute(db)
  await sql`alter table job_posting drop constraint if exists job_posting_pasted_owner_check`.execute(db)
  await sql`alter table job_posting drop constraint if exists job_posting_pasted_manual_check`.execute(db)
  await sql`alter table job_posting drop constraint if exists job_posting_pasted_fingerprint_check`.execute(db)
  await sql`update job_posting set origin = 'pasted_link' where origin = 'pasted_description'`.execute(db)

  await sql`drop index if exists job_posting_pasted_text_uq`.execute(db)
  await sql`drop index if exists job_posting_pasted_link_uq`.execute(db)
  await sql`alter table job_posting drop column if exists paste_fingerprint`.execute(db)
  await sql`alter table job_posting drop column if exists owner_candidate_id`.execute(db)
  await replaceOriginChecks(db, ORIGINS_BEFORE)
  await sql`delete from migration_marker where name = ${PASTED_DESCRIPTION_MARKER}`.execute(db)
}
