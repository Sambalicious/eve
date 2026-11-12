import { type Kysely, sql } from "kysely"
import type { Migration } from "kysely/migration"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0002 A2 repair wave 3 (F-SEC-10): a Candidate transaction stays bound to
 * its Candidate even if code inside it changes `eve.candidate_id`.
 *
 * 1. `tenant_binding.candidate_binding` records (transaction id -> Candidate).
 *    The schema and the table belong to the owner; the runtime role has no
 *    usage on the schema and no grant on the table. Unlogged: a binding only
 *    matters while its transaction runs, and a crash ends every transaction.
 * 2. `public.bind_candidate(uuid)`, security definer, is the only writer. It
 *    records the Candidate for the current top-level transaction and refuses a
 *    second, different Candidate in the same transaction (42501). Binding the
 *    same Candidate again is a no-op. It also removes up to 1,000 rows of
 *    finished transactions, skipping locked rows so callers never wait.
 * 3. `public.bound_candidate()`, security definer, reads the current
 *    transaction's Candidate, or null. Executable by every role, since every
 *    policy calls it; `bind_candidate` only by roles granted it.
 * 4. Every `<table>_candidate` policy now admits a row only when its
 *    `candidate_id` equals the bound Candidate AND `eve.candidate_id`. Changing
 *    the setting can only narrow what is visible, never switch Candidates;
 *    clearing it (operatorStepWithin) hides the Operator's rows again.
 */
export const BINDING_SCHEMA = "tenant_binding"

const BOUND_CANDIDATE = sql.raw("(select public.bound_candidate())")
const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

export const up: Migration["up"] = async (db: Kysely<unknown>) => {
  await sql`create schema tenant_binding`.execute(db)
  await sql`revoke all on schema tenant_binding from public`.execute(db)
  await sql`create unlogged table tenant_binding.candidate_binding (
    xact xid8 primary key,
    candidate_id uuid not null
  )`.execute(db)
  // The owner's default privileges grant DML on every new table to the runtime role: take back every grant but the owner's.
  await sql`do $$
    declare grantee text;
    begin
      revoke all on table tenant_binding.candidate_binding from public;
      for grantee in
        select distinct a.grantee::regrole::text from pg_class c, aclexplode(c.relacl) a
        where c.oid = 'tenant_binding.candidate_binding'::regclass and a.grantee <> c.relowner and a.grantee <> 0
      loop
        execute format('revoke all on table tenant_binding.candidate_binding from %s', grantee);
      end loop;
    end $$`.execute(db)

  await sql`create function public.bind_candidate(p_candidate uuid) returns void
    language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
    declare
      bound uuid;
    begin
      if p_candidate is null or not exists (select 1 from public.candidate c where c.id = p_candidate) then
        raise exception 'Refused: not a Candidate' using errcode = '42501';
      end if;
      delete from tenant_binding.candidate_binding where xact in (
        select b.xact from tenant_binding.candidate_binding b
        where b.xact < pg_snapshot_xmin(pg_current_snapshot())
        limit 1000 for update skip locked);
      insert into tenant_binding.candidate_binding (xact, candidate_id) values (pg_current_xact_id(), p_candidate)
        on conflict (xact) do nothing;
      select b.candidate_id into bound from tenant_binding.candidate_binding b where b.xact = pg_current_xact_id();
      if bound is distinct from p_candidate then
        raise exception 'Refused: this transaction is bound to another Candidate' using errcode = '42501';
      end if;
    end $$`.execute(db)
  await sql`create function public.bound_candidate() returns uuid
    language sql stable security definer set search_path = pg_catalog, pg_temp as $$
      select b.candidate_id from tenant_binding.candidate_binding b where b.xact = pg_current_xact_id_if_assigned()
    $$`.execute(db)
  // Only roles granted execute bind (the runtime role, by grantRuntimeAccess). Every role that queries a
  // Candidate table runs the policy, so it may read the binding; it only ever names its own transaction's.
  await sql`revoke all on function public.bind_candidate(uuid) from public`.execute(db)
  await sql`grant execute on function public.bound_candidate() to public`.execute(db)

  const { rows: policies } = await sql<{ table: string; policy: string }>`
    select c.relname as table, p.polname as policy from pg_policy p
    join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and p.polname = c.relname || '_candidate' order by 1`.execute(db)
  if (policies.length === 0) throw new Error("No Candidate policies: 0017 to 0019 have not run")
  const admitted = sql`candidate_id = ${BOUND_CANDIDATE} and candidate_id = ${CURRENT_CANDIDATE}`
  for (const { table, policy } of policies) {
    await sql`alter policy ${sql.id(policy)} on ${sql.table(table)} using (${admitted}) with check (${admitted})`.execute(db)
  }
  await recordSchemaMarker(db, "0022-candidate-binding")
}
