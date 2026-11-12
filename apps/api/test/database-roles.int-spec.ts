import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { grantDatabaseAccess } from "../src/db/database-roles.js"
import { migrateAndGrant } from "../src/db/migrate-and-grant.js"
import { up as migration0023 } from "../src/db/migrations/0023-runtime-no-temporary.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

let database: TestDatabase
let runtime: Kysely<unknown>

beforeAll(async () => {
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url) as unknown as Kysely<unknown>
})

afterAll(async () => {
  await runtime?.destroy()
  await database?.stop()
})

async function refusal(statement: ReturnType<typeof sql>): Promise<string> {
  try {
    await statement.execute(runtime)
  } catch (error) {
    return (error as { code?: string; message: string }).message
  }
  throw new Error("statement succeeded but should have been refused")
}

// SEC-001: the api and worker connect as a role that cannot reach the OS or server files.
describe("least-privilege runtime role (SEC-001)", () => {
  it("is not a superuser and cannot create databases or roles", async () => {
    const role = await sql<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname = current_user`.execute(runtime)
    expect(role.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false })
  })

  it("holds none of the server program or file roles", async () => {
    const memberships = await sql<{ rolname: string }>`
      select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
      where m.member = (select oid from pg_roles where rolname = current_user)`.execute(runtime)
    expect(memberships.rows).toEqual([])
  })

  it("is refused COPY ... FROM PROGRAM", async () => {
    // Run a2c repair wave 2 (migration 0023): the runtime role has no TEMPORARY, so the target is an application table it can write.
    expect(await refusal(sql`copy dashboard_session (id_hash) from program 'id'`)).toMatch(/permission denied|must be superuser|pg_execute_server_program/)
  })

  it("cannot create temporary tables (migration 0023)", async () => {
    expect(await refusal(sql`create temp table probe (line text)`)).toMatch(/permission denied to create temporary tables/)
  })

  it("is refused pg_read_file", async () => {
    expect(await refusal(sql`select pg_read_file('/etc/passwd')`)).toMatch(/permission denied/)
  })

  it("is refused COPY ... TO a server file", async () => {
    expect(await refusal(sql`copy (select 1) to '/tmp/ja-probe'`)).toMatch(/permission denied|must be superuser|pg_write_server_files/)
  })

  it("cannot create tables in public or alter application tables", async () => {
    expect(await refusal(sql`create table public.intruder (x int)`)).toMatch(/permission denied/)
    expect(await refusal(sql`alter table dashboard_session add column x int`)).toMatch(/must be owner|permission denied/)
    expect(await refusal(sql`drop table dashboard_session`)).toMatch(/must be owner|permission denied/)
  })

  it("cannot read or change migration bookkeeping", async () => {
    expect(await refusal(sql`select * from kysely_migration`)).toMatch(/permission denied/)
  })

  it("can read and write application rows", async () => {
    await sql`insert into dashboard_session (id_hash, csrf_token, google_sub, last_active_at, candidate_id) values ('h', 'c', 's', now(), (select id from candidate where role = 'operator'))`.execute(runtime)
    const rows = await sql<{ n: string }>`select count(*)::text as n from dashboard_session where id_hash = 'h'`.execute(runtime)
    expect(rows.rows[0]?.n).toBe("1")
    await sql`delete from dashboard_session where id_hash = 'h'`.execute(runtime)
  })

  it("can create a queue, send, and fetch a pg-boss job without DDL rights", async () => {
    const { PgBoss } = await import("pg-boss")
    const boss = new PgBoss({ connectionString: database.url, migrate: false, supervise: false, schedule: false })
    await boss.start()
    try {
      await boss.createQueue("role-probe")
      const id = await boss.send("role-probe", { n: 1 })
      const [job] = await boss.fetch("role-probe")
      expect(job?.id).toBe(id)
    } finally {
      await boss.stop({ graceful: false, close: true })
    }
  })

  it("the migration owner is not a superuser either", async () => {
    const owner = createDatabase(database.ownerUrl)
    try {
      const role = await sql<{ rolsuper: boolean }>`select rolsuper from pg_roles where rolname = current_user`.execute(owner)
      expect(role.rows[0]?.rolsuper).toBe(false)
      await expect(sql`copy (select 1) to program 'id'`.execute(owner)).rejects.toThrow(/permission denied|superuser|pg_execute/)
    } finally {
      await owner.destroy()
    }
  })

  it("provisioning and migration are safe to run again", async () => {
    // Database-level steps only. The shared ja_owner/ja_runtime roles are altered by
    // the cluster setup once; re-running ALTER ROLE here races other files' role
    // changes ("tuple concurrently updated"). Re-provisioning roles is covered with
    // file-owned roles in slice1-upgrade.int-spec.ts.
    const admin = createDatabase(database.adminUrl)
    try {
      await grantDatabaseAccess(admin, database.roles)
    } finally {
      await admin.destroy()
    }
    expect(await migrateAndGrant(database.ownerUrl, database.roles.runtime.name)).toEqual([])
  })

  // A restore with --no-acl drops 0022's privileges: PUBLIC executes bind_candidate again and
  // the owner's default privileges give the runtime role DML on the binding table. `migrate` re-applies them.
  it("migrate re-applies 0022's binding privileges after a restore loses them", async () => {
    const owner = createDatabase(database.ownerUrl)
    const runtimeRole = sql.id(database.roles.runtime.name)
    try {
      await sql`grant execute on function public.bind_candidate(uuid) to public`.execute(owner)
      await sql`grant usage on schema tenant_binding to ${runtimeRole}`.execute(owner)
      await sql`grant select, insert, update, delete on tenant_binding.candidate_binding to ${runtimeRole}`.execute(owner)
      expect(await migrateAndGrant(database.ownerUrl, database.roles.runtime.name)).toEqual([])
      const privileges = await sql<{ publicBind: boolean; runtimeBind: boolean; runtimeBound: boolean; schemaUsage: boolean; tableAny: boolean }>`
        select has_function_privilege('public', 'public.bind_candidate(uuid)', 'execute') as "publicBind",
          has_function_privilege(${database.roles.runtime.name}, 'public.bind_candidate(uuid)', 'execute') as "runtimeBind",
          has_function_privilege(${database.roles.runtime.name}, 'public.bound_candidate()', 'execute') as "runtimeBound",
          has_schema_privilege(${database.roles.runtime.name}, 'tenant_binding', 'usage') as "schemaUsage",
          has_table_privilege(${database.roles.runtime.name}, 'tenant_binding.candidate_binding', 'select,insert,update,delete') as "tableAny"`.execute(owner)
      expect(privileges.rows[0]).toEqual({ publicBind: false, runtimeBind: true, runtimeBound: true, schemaUsage: false, tableAny: false })
      expect(await refusal(sql`select count(*) from tenant_binding.candidate_binding`)).toMatch(/permission denied/)
    } finally {
      await owner.destroy()
    }
  })

  // F-QA-14: a new or restored database gives PUBLIC TEMPORARY, and the runtime role inherits it.
  it("migrate removes a TEMPORARY grant to PUBLIC, so the runtime role gets no temporary tables", async () => {
    const admin = createDatabase(database.adminUrl) as unknown as Kysely<unknown>
    try {
      await sql`grant temporary on database ${sql.id(database.roles.database)} to public`.execute(admin)
      expect(await temporaryPrivileges(admin)).toEqual({ publicTemp: true, runtimeTemp: true })
      expect(await migrateAndGrant(database.ownerUrl, database.roles.runtime.name)).toEqual([])
      expect(await temporaryPrivileges(admin)).toEqual({ publicTemp: false, runtimeTemp: false })
      expect(await refusal(sql`create temp table probe (line text)`)).toMatch(/permission denied to create temporary tables/)
    } finally {
      await sql`revoke temporary on database ${sql.id(database.roles.database)} from public`.execute(admin)
      await admin.destroy()
    }
  })
})

// F-QA-15: the template has already revoked TEMPORARY, so each case first grants it back as the superuser.
describe("TEMPORARY on the database (migration 0023, F-QA-15)", () => {
  const OTHER_ROLE = "pg_monitor"

  async function grantTemporary(admin: Kysely<unknown>, grantees: readonly string[]): Promise<void> {
    for (const grantee of grantees) {
      await sql`grant temporary on database ${sql.id(database.roles.database)} to ${grantee === "public" ? sql.raw("public") : sql.id(grantee)}`.execute(admin)
    }
  }

  async function holders(admin: Kysely<unknown>): Promise<Record<string, boolean>> {
    const { rows } = await sql<{ name: string; temp: boolean }>`
      select r.name, has_database_privilege(r.name, current_database(), 'temporary') as temp
      from unnest(array[${database.roles.owner.name}, ${database.roles.runtime.name}, ${OTHER_ROLE}]::text[]) as r(name)`.execute(admin)
    const result: Record<string, boolean> = Object.fromEntries(rows.map((row) => [row.name, row.temp]))
    result.public = (await temporaryPrivileges(admin)).publicTemp
    return result
  }

  it("migration 0023 revokes TEMPORARY from PUBLIC and every role but the owner", async () => {
    const admin = createDatabase(database.adminUrl) as unknown as Kysely<unknown>
    const owner = createDatabase(database.ownerUrl) as unknown as Kysely<unknown>
    try {
      await grantTemporary(admin, ["public", database.roles.runtime.name, OTHER_ROLE])
      expect(await holders(admin)).toEqual({ ja_owner: true, ja_runtime: true, pg_monitor: true, public: true })
      // 0023 records its marker as its last statement; the template already has it.
      await sql`delete from migration_marker where name = '0023-runtime-no-temporary'`.execute(admin)
      await owner.transaction().execute((trx) => migration0023(trx))
      expect(await holders(admin)).toEqual({ ja_owner: true, ja_runtime: false, pg_monitor: false, public: false })
    } finally {
      await sql`revoke temporary on database ${sql.id(database.roles.database)} from public, ${sql.id(database.roles.runtime.name)}, ${sql.id(OTHER_ROLE)}`.execute(admin)
      await sql`insert into migration_marker (name) values ('0023-runtime-no-temporary') on conflict do nothing`.execute(admin)
      await owner.destroy()
      await admin.destroy()
    }
  })

  it("migrate revokes a TEMPORARY grant to the runtime role again", async () => {
    const admin = createDatabase(database.adminUrl) as unknown as Kysely<unknown>
    try {
      await grantTemporary(admin, [database.roles.runtime.name])
      expect(await temporaryPrivileges(admin)).toEqual({ publicTemp: false, runtimeTemp: true })
      expect(await migrateAndGrant(database.ownerUrl, database.roles.runtime.name)).toEqual([])
      expect(await temporaryPrivileges(admin)).toEqual({ publicTemp: false, runtimeTemp: false })
      expect(await refusal(sql`create temp table probe (line text)`)).toMatch(/permission denied to create temporary tables/)
    } finally {
      await admin.destroy()
    }
  })
})

async function temporaryPrivileges(admin: Kysely<unknown>): Promise<{ publicTemp: boolean; runtimeTemp: boolean }> {
  const { rows } = await sql<{ publicTemp: boolean; runtimeTemp: boolean }>`
    select coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'TEMPORARY'), false) as "publicTemp",
      has_database_privilege(${database.roles.runtime.name}, current_database(), 'temporary') as "runtimeTemp"
    from pg_database d left join lateral aclexplode(d.datacl) a on true
    where d.datname = current_database()`.execute(admin)
  return rows[0]!
}
