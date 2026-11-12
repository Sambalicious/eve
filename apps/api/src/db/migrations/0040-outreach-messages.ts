import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * v1.31.0 EPIC-0014 Outreach messages (architecture r1 D1, D2, D13). One new
 * table, `outreach_message`: one row per (Candidate, Application, kind), holding
 * the Ready text, the Reader name, the run state, the last failure's cause and,
 * for a `blocked` Run, the first failed sentence.
 *
 * - Candidate data (ADR 0009): forced RLS with the 0022-form `<table>_candidate`
 *   policy. Grants come from `migrate-and-grant` on the next migrate step, as
 *   for 0033 and 0038.
 * - The unique key `(candidate_id, application_id, kind)` is the upsert conflict
 *   target, the leading-`candidate_id` index ADR 0009 asks for and the only
 *   index: at most three rows per Application.
 * - Checks. The text group `body`, `sentences`, `profile_version` and
 *   `written_at` is all four or none, so a half-written text cannot be observed
 *   (AC 7.1). `run_status = 'running'` exactly with a run token, so a Run in
 *   flight is always identifiable. A `first_failed_sentence` exists only with
 *   `last_failure = 'blocked'` on an `idle` row (r1): `finishReady` sets
 *   `last_failure` to null in the same update that writes the body, so a Ready
 *   text can never share an update with a sentence, and `claimRun` clears both.
 *   Its form is 1 to 400 code points (Postgres `char_length` is the code-point
 *   count the api and the contract use), trimmed, with none of the control
 *   characters the write schema already refuses (`CONTROL_CHARACTERS` in
 *   `documents/document-generation.ts`: C0 except tab, line feed and carriage
 *   return, and C1). U+0000 cannot be stored in a `text` column at all, so the
 *   class starts at U+0001 and is otherwise the same set.
 * - Additive and empty: no backfill. `down` is development only.
 */
export const OUTREACH_MESSAGES_MARKER = "0040-outreach-messages"

/**
 * Candidate data. Deleted with the Application's details through
 * `deleteDetailsLocked` and, with the Candidate, by the foreign key cascade.
 */
export const OUTREACH_TABLES = ["outreach_message"] as const

/** Copied from 0022-candidate-binding: the policy every Candidate table has after it. */
const BOUND_CANDIDATE = sql.raw("(select public.bound_candidate())")
const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

/** The control characters the write schema refuses, as one Postgres regular-expression class (tab, LF and CR stay allowed). */
const CONTROL_CHARACTERS = String.raw`[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`

export async function up(db: Kysely<unknown>): Promise<void> {
  const run = (statement: ReturnType<typeof sql>) => statement.execute(db)

  await run(sql`create table outreach_message (
    id uuid primary key,
    candidate_id uuid not null references candidate(id) on delete cascade,
    application_id uuid not null references application(id) on delete cascade,
    kind text not null,
    reader_name text null,
    body text null,
    sentences jsonb null,
    profile_version integer null,
    written_at timestamptz null,
    last_failure text null,
    first_failed_sentence text null,
    run_status text not null default 'idle',
    run_id uuid null,
    run_started_at timestamptz null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint outreach_message_candidate_application_kind_key unique (candidate_id, application_id, kind),
    constraint outreach_message_kind_check check (kind in ('referral_request', 'introduction', 'application_note')),
    constraint outreach_message_reader_name_check check (reader_name is null or char_length(reader_name) between 1 and 40),
    -- The body budgets (AC 4.1), in code points: 550, 750 and 450 per kind.
    constraint outreach_message_body_budget check (body is null or char_length(body) <= case kind
      when 'referral_request' then 550 when 'introduction' then 750 when 'application_note' then 450 end),
    constraint outreach_message_profile_version_check check (profile_version is null or profile_version > 0),
    -- A cause code, never text (the wire type is an open string with this shape).
    constraint outreach_message_last_failure_check check (last_failure is null or last_failure ~ '^[a-z][a-z_]{0,39}$'),
    constraint outreach_message_run_status_check check (run_status in ('idle', 'running')),
    -- A text is all four or none (AC 7.1); first_failed_sentence sits outside the group on purpose.
    constraint outreach_message_text_all_or_none check (
      (body is null) = (sentences is null) and (body is null) = (profile_version is null) and (body is null) = (written_at is null)),
    constraint outreach_message_run_pair check ((run_status = 'running') = (run_id is not null and run_started_at is not null)),
    -- A sentence exists only with the blocked cause on an idle row (D13). "is not
    -- distinct from", not "=": with a null cause last_failure = 'blocked' is null,
    -- which makes the whole check null, and a CHECK passes on null.
    constraint outreach_message_failed_sentence_blocked check (first_failed_sentence is null or (last_failure is not distinct from 'blocked' and run_status is not distinct from 'idle')),
    constraint outreach_message_failed_sentence_form check (first_failed_sentence is null or (
      char_length(first_failed_sentence) between 1 and 400
      and first_failed_sentence !~ '^\\s'
      and first_failed_sentence !~ '\\s$'
      and first_failed_sentence !~ E'${sql.raw(CONTROL_CHARACTERS)}'))
  )`)

  await run(sql`alter table outreach_message enable row level security`)
  await run(sql`alter table outreach_message force row level security`)
  const admitted = sql`candidate_id = ${BOUND_CANDIDATE} and candidate_id = ${CURRENT_CANDIDATE}`
  await run(sql`create policy ${sql.id("outreach_message_candidate")} on outreach_message for all using (${admitted}) with check (${admitted})`)

  await recordSchemaMarker(db, OUTREACH_MESSAGES_MARKER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${OUTREACH_MESSAGES_MARKER}`.execute(db)
  await sql`drop table if exists outreach_message`.execute(db)
}
