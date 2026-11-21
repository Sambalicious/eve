import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * v1.32.0 FEAT-0017 Application added facts (architecture "Data model and
 * migration", api-contract v1.32.0 A-6, A-7, A-8). One new table,
 * `application_added_fact`, and additive columns:
 *
 * - `application_added_fact`: one row per fact the Candidate added to one
 *   Application. Candidate data: forced RLS with the 0022-form `_candidate`
 *   policy. `text_key` is computed in SQL as `lower(btrim(text))` (see
 *   `added-facts.repository.ts`; the tests seed it), and the unique key
 *   `(candidate_id, application_id, text_key)` is the duplicate rule and the
 *   leading-`candidate_id` index ADR 0009 asks for.
 * - The kind carries its own shape: a skill-only fact has a term and no role,
 *   a one-liner has a role section and its snapshot, and a skill-only fact's
 *   text is its term byte for byte, so it can never carry a sentence.
 * - `application`: the counter, the confirmation pair and the Match audit
 *   snapshot (A-6). `(confirmed_version is null) = (confirmed_at is null)`.
 *   A unique index on `(id, candidate_id)` lets the fact's foreign key bind the
 *   fact's Candidate to the Application's owner (SEC-R02).
 * - `tailored_document`: the counter each document was generated against and
 *   the frozen snapshot of the added facts it had and cited (PRD 5.10).
 * - The blocked-claim cause check gains two values (`skill_only_in_bullet`,
 *   `added_fact_hedge`, A-8): nine in all, three of them terms causes.
 *
 * Additive and empty: no backfill. Existing documents read as version 0 against
 * Applications at 0, so nothing becomes stale on deploy. `down` is development
 * only.
 */
export const ADDED_FACTS_MARKER = "0042-added-facts"

/** Candidate data. Deleted with the Application's details through `deleteDetailsLocked` and, with the Candidate, by the foreign key cascade. */
export const ADDED_FACT_TABLES = ["application_added_fact"] as const

/** Copied from 0022-candidate-binding: the policy every Candidate table has after it. */
const BOUND_CANDIDATE = sql.raw("(select public.bound_candidate())")
const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

/**
 * The code points the write rules refuse: C0 and C1 controls, the bidi and
 * zero-width formatters, and the Unicode Default_Ignorable set. Written as one
 * Postgres class so the database refuses them even if a writer forgets.
 */
export const FORBIDDEN_CODE_POINTS = String.raw`[\u0001-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]`

/** The nine owner-visible blocked causes after 0042 (0039's seven plus the two FEAT-0017 causes). */
const CAUSES = sql.raw(
  `('unsupported_terms', 'number_order', 'no_fact', 'contact_detail', 'names_target', 'unknown_fact', 'not_confirmed', 'skill_only_in_bullet', 'added_fact_hedge')`
)
const CAUSES_BEFORE = sql.raw(`('unsupported_terms', 'number_order', 'no_fact', 'contact_detail', 'names_target', 'unknown_fact', 'not_confirmed')`)

/** Copied from 0033-simplify-eve: a migration is one transaction, so a forced-RLS table lifts FORCE for one statement and restores it. */
async function withoutForcedRls<T>(db: Kysely<unknown>, table: string, work: () => Promise<T>): Promise<T> {
  await sql`alter table ${sql.table(table)} no force row level security`.execute(db)
  try {
    return await work()
  } finally {
    await sql`alter table ${sql.table(table)} force row level security`.execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  // SEC-R02: the fact's candidate_id must be the Application's owner at the database level, not only in the api.
  // A composite foreign key needs a unique key on exactly these columns; `id` is already the primary key, but a
  // one-column key cannot satisfy a two-column reference, so this is the 0016 form `(candidate_id, id)` with the
  // column order the fact's foreign key names: `(id, candidate_id)`.
  await run(sql`create unique index application_candidate_id_idx on application (id, candidate_id)`)

  await run(sql`create table application_added_fact (
    id uuid primary key,
    candidate_id uuid not null references candidate(id) on delete cascade,
    application_id uuid not null,
    kind text not null,
    text text not null,
    -- lower(btrim(text)), computed in SQL by added-facts.repository.ts: the duplicate rule and the unique key.
    text_key text not null,
    term text null,
    role_section_id text null,
    -- The role as it read when it was picked: {title, employer, period} (A-7).
    role_snapshot jsonb null,
    -- The Career Profile version the role was picked from.
    role_profile_version integer null,
    affirmed_at timestamptz not null,
    save_to_profile boolean not null default false,
    -- The draft version the copy was appended to, for "also in Career Profile version n".
    profile_draft_version integer null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    -- SEC-R02: the fact's Candidate is the Application's Candidate (the plain application(id) key allowed a mismatch).
    constraint application_added_fact_application_fk foreign key (application_id, candidate_id)
      references application (id, candidate_id) on delete cascade,
    constraint application_added_fact_candidate_application_text_key unique (candidate_id, application_id, text_key),
    constraint application_added_fact_kind_check check (kind in ('skill_only', 'one_liner')),
    -- The text rules the API also enforces: 1 to 300 code points, trimmed, no control, bidi or default-ignorable code point.
    constraint application_added_fact_text_check check (
      char_length(text) between 1 and 300
      and text = btrim(text)
      and text !~ E'${sql.raw(FORBIDDEN_CODE_POINTS)}'),
    constraint application_added_fact_text_key_check check (text_key = lower(btrim(text)) and char_length(text_key) > 0),
    constraint application_added_fact_term_check check (term is null or (char_length(term) between 1 and 200 and term = btrim(term))),
    constraint application_added_fact_role_profile_version_check check (role_profile_version is null or role_profile_version > 0),
    constraint application_added_fact_profile_draft_version_check check (profile_draft_version is null or profile_draft_version > 0),
    -- Each kind has its own shape: skill-only has a term and no role; one-liner has a role and its snapshot.
    constraint application_added_fact_kind_shape check (
      (kind = 'skill_only' and term is not null and role_section_id is null and role_snapshot is null)
      or (kind = 'one_liner' and role_section_id is not null and role_snapshot is not null)),
    -- A skill-only fact's text is its term byte for byte, so it can never carry a claim.
    constraint application_added_fact_skill_only_text check (kind <> 'skill_only' or text = term)
  )`)

  await run(sql`alter table application_added_fact enable row level security`)
  await run(sql`alter table application_added_fact force row level security`)
  const admitted = sql`candidate_id = ${BOUND_CANDIDATE} and candidate_id = ${CURRENT_CANDIDATE}`
  await run(sql`create policy ${sql.id("application_added_fact_candidate")} on application_added_fact for all using (${admitted}) with check (${admitted})`)

  await run(sql`alter table application add column added_facts_version integer not null default 0`)
  await run(sql`alter table application add column added_facts_confirmed_version integer null`)
  await run(sql`alter table application add column added_facts_confirmed_at timestamptz null`)
  await run(sql`alter table application add column added_facts_match jsonb null`)
  await run(sql`alter table application add constraint application_added_facts_counter_check
    check (added_facts_version >= 0 and (added_facts_confirmed_version is null or added_facts_confirmed_version >= 0))`)
  await run(sql`alter table application add constraint application_added_facts_confirmation_pair
    check ((added_facts_confirmed_version is null) = (added_facts_confirmed_at is null))`)

  await run(sql`alter table tailored_document add column added_facts_version integer not null default 0`)
  await run(sql`alter table tailored_document add column added_facts jsonb not null default '{"available":[],"cited":[]}'::jsonb`)
  await run(sql`alter table tailored_document add constraint tailored_document_added_facts_check
    check (added_facts_version >= 0 and jsonb_typeof(added_facts) = 'object')`)

  // A-8: the two FEAT-0017 causes. NOT VALID then VALIDATE only avoids a long lock in its own transaction;
  // here the migration is one transaction and the ADD CONSTRAINT above already holds ACCESS EXCLUSIVE on
  // application, so validating later in the same transaction takes no extra lock.
  await run(sql`alter table application drop constraint application_blocked_claim_cause_check`)
  await run(sql`alter table application add constraint application_blocked_claim_cause_check
    check (blocked_claim_cause is null or blocked_claim_cause in ${CAUSES}) not valid`)
  await run(sql`alter table application validate constraint application_blocked_claim_cause_check`)

  await recordSchemaMarker(db, ADDED_FACTS_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${ADDED_FACTS_MARKER}`.execute(db)
  // The old 7-value check rejects the two new causes, so they are cleared first (they are not terms causes).
  // `application` has forced row security: one unbound `update` touches no row, and one Candidate's binding cannot
  // reach the others inside the migration's single transaction (bind_candidate binds it to one Candidate), so the
  // table drops FORCE RLS for this statement and restores it, as 0033 does for its seed and counts.
  await withoutForcedRls(db, "application", async () => {
    await sql`update application set blocked_claim_cause = null where blocked_claim_cause in ('skill_only_in_bullet', 'added_fact_hedge')`.execute(db)
  })
  await sql`alter table application drop constraint application_blocked_claim_cause_check`.execute(db)
  await sql`alter table application add constraint application_blocked_claim_cause_check
    check (blocked_claim_cause is null or blocked_claim_cause in ${CAUSES_BEFORE})`.execute(db)
  await sql`drop table if exists application_added_fact`.execute(db)
  await sql`drop index if exists application_candidate_id_idx`.execute(db)
  await sql`alter table tailored_document drop constraint if exists tailored_document_added_facts_check, drop column added_facts, drop column added_facts_version`.execute(db)
  await sql`alter table application
    drop constraint if exists application_added_facts_confirmation_pair,
    drop constraint if exists application_added_facts_counter_check,
    drop column added_facts_match,
    drop column added_facts_confirmed_at,
    drop column added_facts_confirmed_version,
    drop column added_facts_version`.execute(db)
}
