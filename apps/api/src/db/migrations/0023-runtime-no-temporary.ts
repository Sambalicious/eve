import { type Kysely, sql } from "kysely"
import type { Migration } from "kysely/migration"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0002 A2 run a2c repair wave 2 (F-SEC-14): no role but the database's
 * owner may create temporary tables. A temporary table lives for the session,
 * so one made inside a Candidate scope would stay on the pooled connection and
 * be readable by the next Candidate's scope on it. The api, the worker and
 * pg-boss create none (checked for this migration: no `create temp` or
 * `select ... into` outside migrations and one test probe, none in pg-boss 12.38).
 *
 * Revokes TEMPORARY on the current database from PUBLIC and from every role
 * holding it other than the owner, so the migration needs no role name.
 * `grantDatabaseAccess` and `grantRuntimeAccess` no longer grant it and revoke
 * it again, so re-provisioning or a restore with ACLs cannot bring it back.
 */
export const up: Migration["up"] = async (db: Kysely<unknown>) => {
  await sql`do $$
    declare grantee text;
    begin
      execute format('revoke temporary on database %I from public', current_database());
      for grantee in
        select distinct a.grantee::regrole::text from pg_database d, aclexplode(d.datacl) a
        where d.datname = current_database() and a.privilege_type = 'TEMPORARY' and a.grantee <> d.datdba and a.grantee <> 0
      loop
        execute format('revoke temporary on database %I from %s', current_database(), grantee);
      end loop;
    end $$`.execute(db)
  await recordSchemaMarker(db, "0023-runtime-no-temporary")
}
