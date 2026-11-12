import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { type BackupRoleContext, ensureBackupRole } from "../src/db/database-roles.js"
import { migrateAndGrant } from "../src/db/migrate-and-grant.js"
import { INSTALLATION_TABLES } from "../src/db/migrations/0017-row-level-security.js"
import type { Database } from "../src/db/schema.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { type TestDatabase, startMigratedDatabase, urlFor } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * fix-backup-role: since 0017 forces RLS on every Candidate and installation
 * table and no role bypasses it, `pg_dump` as the owner fails ("query would be
 * affected by row-level security policy"). The backup role is the one
 * read-only role that bypasses RLS. Roles are cluster-wide, so this file uses
 * its own role names (see slice1-upgrade.int-spec.ts on shared-role races).
 */
const RUN = Date.now().toString(36)
const BACKUP = { name: `ja_backup_${RUN}`, password: "backup-password-for-tests" }
const NOLOGIN_BACKUP = `ja_backup_nologin_${RUN}`
/** SEC-FBR-01 probes: pre-existing roles the backup role must never be. */
const PROBES = {
  superuser: `ja_fbr_super_${RUN}`,
  createrole: `ja_fbr_createrole_${RUN}`,
  createdb: `ja_fbr_createdb_${RUN}`,
  replication: `ja_fbr_replication_${RUN}`,
  owner: `ja_fbr_owns_${RUN}`,
  member: `ja_fbr_member_${RUN}`,
  hasMember: `ja_fbr_hasmember_${RUN}`,
  plain: `ja_fbr_plain_${RUN}`,
} as const

let database: TestDatabase
let backup: Kysely<Database>
let owner: Kysely<Database>
let runtime: Kysely<Database>
let otherId: string

async function seedApplication(candidateId: string, title: string): Promise<void> {
  const postingId = randomUUID()
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/backup/jobs/${id.slice(-6)}`
  await insertPostingFor(database.db, candidateId, { id: postingId, application_url: url, requisition_id: id.slice(-6), apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title, company: "Backup Co", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date("2026-10-01"), evaluated_at: new Date("2026-10-01") })
  await database.db
    .insertInto("application")
    .values({ id, candidate_id: candidateId, job_posting_id: postingId, application_url: url, requisition_id: id.slice(-6), company: "Backup Co", role_title: title, state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date("2026-10-01T10:00:00Z"), updated_at: new Date("2026-10-01T10:00:00Z") })
    .execute()
}

async function withAdmin<T>(work: (admin: Kysely<unknown>) => Promise<T>): Promise<T> {
  const admin = createDatabase(database.adminUrl) as unknown as Kysely<unknown>
  try {
    return await work(admin)
  } finally {
    await admin.destroy()
  }
}

/** Every table in public and pgboss with at least one row, as the superuser sees it. */
async function tablesWithRows(): Promise<{ table: string; n: number }[]> {
  const tables = await sql<{ schema: string; name: string }>`
    select schemaname as schema, tablename as name from pg_tables where schemaname in ('public', 'pgboss') order by 1, 2`.execute(database.db)
  const counts: { table: string; n: number }[] = []
  for (const t of tables.rows) {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(`${t.schema}.${t.name}`)}`.execute(database.db)
    if ((rows[0]?.n ?? 0) > 0) counts.push({ table: `${t.schema}.${t.name}`, n: rows[0]!.n })
  }
  return counts
}

async function count(db: Kysely<Database>, table: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db)
  return rows[0]!.n
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  otherId = await insertSecondCandidate(database.db)
  await seedApplication(database.operatorId, "Operator role")
  await seedApplication(otherId, "Second Candidate role")
  await seedApplication(otherId, "Second Candidate role 2")
  // Installation-only data (C36): visible to no application role without the installation scope.
  await sql`insert into access_request (id, email, email_key, note, created_at, window_id)
    values (${randomUUID()}, 'Someone@example.test', 'someone@example.test', '', now(), ${randomUUID()})`.execute(database.db)
  await withAdmin((admin) => ensureBackupRole(admin, BACKUP, context()))
  await migrateAndGrant(database.ownerUrl, database.roles.runtime.name, { operatorGoogleSub: undefined }, { backupRole: BACKUP.name })
  const clusterUrl = new URL(database.adminUrl)
  backup = createDatabase(urlFor(clusterUrl.toString(), BACKUP, clusterUrl.pathname.slice(1)))
  owner = createDatabase(database.ownerUrl)
  runtime = createDatabase(database.url)
})

afterAll(async () => {
  await backup?.destroy()
  await owner?.destroy()
  await runtime?.destroy()
  await database?.stop()
  await withAdminCluster(async (admin) => {
    for (const role of [BACKUP.name, NOLOGIN_BACKUP, ...Object.values(PROBES)]) {
      await sql`drop owned by ${sql.id(role)}`.execute(admin).catch(() => undefined)
      await sql`drop role if exists ${sql.id(role)}`.execute(admin)
    }
  })
})

function context(): BackupRoleContext {
  return { owner: database.roles.owner.name, runtime: database.roles.runtime.name }
}

/** Every attribute, membership and grant a role holds, to prove a refusal changed nothing. */
async function roleState(name: string): Promise<unknown> {
  const attributes = await sql`select a.rolsuper, a.rolinherit, a.rolcreaterole, a.rolcreatedb, a.rolcanlogin, a.rolreplication, a.rolbypassrls, a.rolconnlimit, a.rolpassword,
      (select array_agg(c order by c) from pg_db_role_setting s, unnest(s.setconfig) c where s.setrole = a.oid) as config,
      shobj_description(a.oid, 'pg_authid') as comment from pg_authid a where a.rolname = ${name}`.execute(database.db)
  const members = await sql`select roleid::regrole::text as role, member::regrole::text as member from pg_auth_members
      where roleid = ${name}::regrole or member = ${name}::regrole order by 1, 2`.execute(database.db)
  const grants = await sql`select table_schema, table_name, privilege_type from information_schema.table_privileges where grantee = ${name} order by 1, 2, 3`.execute(database.db)
  return { attributes: attributes.rows, members: members.rows, grants: grants.rows }
}

/** The database is dropped by then; `drop owned` and `drop role` need any database on the cluster. */
async function withAdminCluster(work: (admin: Kysely<unknown>) => Promise<void>): Promise<void> {
  const url = new URL(database.adminUrl)
  url.pathname = "/postgres"
  const admin = createDatabase(url.toString()) as unknown as Kysely<unknown>
  try {
    await work(admin)
  } finally {
    await admin.destroy()
  }
}

describe("backup role attributes (fix-backup-role)", () => {
  it("bypasses RLS but is not a superuser and cannot create databases, roles or replicate", async () => {
    const { rows } = await sql<Record<string, boolean>>`
      select rolbypassrls, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolinherit, rolcanlogin
      from pg_roles where rolname = current_user`.execute(backup)
    expect(rows[0]).toEqual({ rolbypassrls: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolinherit: false, rolcanlogin: true })
  })

  it("is a member of no role (no server program or file roles)", async () => {
    const { rows } = await sql<{ rolname: string }>`
      select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
      where m.member = (select oid from pg_roles where rolname = current_user)`.execute(backup)
    expect(rows).toEqual([])
  })

  it("without a password the role exists but cannot log in (never LOGIN with no password)", async () => {
    await withAdmin((admin) => ensureBackupRole(admin, { name: NOLOGIN_BACKUP, password: undefined }, context()))
    const { rows } = await sql<{ login: boolean; password: boolean; bypass: boolean }>`
      select rolcanlogin as login, rolpassword is not null as password, rolbypassrls as bypass from pg_authid where rolname = ${NOLOGIN_BACKUP}`.execute(database.db)
    expect(rows[0]).toEqual({ login: false, password: false, bypass: true })
  })

  it("refuses a short password, an unsafe name, and the owner or runtime role's name", async () => {
    await withAdmin(async (admin) => {
      await expect(ensureBackupRole(admin, { name: `ja_backup_short_${RUN}`, password: "short" }, context())).rejects.toThrow(/at least 12 characters/)
      await expect(ensureBackupRole(admin, { name: "Robert'); drop", password: BACKUP.password }, context())).rejects.toThrow(/Not a safe identifier/)
    })
    await expect(migrateAndGrant(database.ownerUrl, database.roles.runtime.name, undefined, { backupRole: database.roles.runtime.name })).rejects.toThrow(/must differ/)
    await expect(migrateAndGrant(database.ownerUrl, database.roles.runtime.name, undefined, { backupRole: `ja_backup_missing_${RUN}` })).rejects.toThrow(/does not exist.*provision-roles/)
  })
})

/**
 * SEC-FBR-01: DB_BACKUP_ROLE=ja_runtime must never give the runtime role BYPASSRLS.
 * Every refusal happens before any CREATE or ALTER, names only the env keys, and
 * leaves the role exactly as it was.
 */
describe("ensureBackupRole refuses any role that is not a dedicated backup role (SEC-FBR-01)", () => {
  beforeAll(async () => {
    await withAdmin(async (admin) => {
      await sql`create role ${sql.id(PROBES.superuser)} superuser nologin`.execute(admin)
      await sql`create role ${sql.id(PROBES.createrole)} createrole nologin`.execute(admin)
      await sql`create role ${sql.id(PROBES.createdb)} createdb nologin`.execute(admin)
      await sql`create role ${sql.id(PROBES.replication)} replication nologin`.execute(admin)
      await sql`create role ${sql.id(PROBES.owner)} nologin`.execute(admin)
      await sql`create table public.fbr_owned_probe (id int)`.execute(admin)
      await sql`alter table public.fbr_owned_probe owner to ${sql.id(PROBES.owner)}`.execute(admin)
      await sql`create role ${sql.id(PROBES.plain + "_g")} nologin`.execute(admin)
      await sql`create role ${sql.id(PROBES.member)} nologin in role ${sql.id(PROBES.plain + "_g")}`.execute(admin)
      await sql`create role ${sql.id(PROBES.hasMember)} nologin`.execute(admin)
      await sql`grant ${sql.id(PROBES.hasMember)} to ${sql.id(PROBES.createdb)}`.execute(admin)
      await sql`create role ${sql.id(PROBES.plain)} login password 'plain-role-password-0'`.execute(admin)
    })
  })

  afterAll(async () => {
    await withAdmin(async (admin) => {
      await sql`drop table if exists public.fbr_owned_probe`.execute(admin)
    })
    await withAdminCluster(async (admin) => {
      await sql`drop role if exists ${sql.id(PROBES.member)}`.execute(admin).catch(() => undefined)
      await sql`drop role if exists ${sql.id(PROBES.plain + "_g")}`.execute(admin).catch(() => undefined)
    })
  })

  it.each([
    ["the runtime role (the reproduction)", () => database.roles.runtime.name, /DB_BACKUP_ROLE must not name DB_RUNTIME_ROLE/],
    ["the owner role", () => database.roles.owner.name, /DB_BACKUP_ROLE must not name DB_OWNER_ROLE/],
    ["the provisioning (bootstrap) user", () => decodeURIComponent(new URL(database.adminUrl).username), /DB_BACKUP_ROLE must not name the bootstrap user/],
  ])("refuses %s by name, before any change", async (_label, name, message) => {
    const role = name()
    const before = await roleState(role)
    await withAdmin((admin) => expect(ensureBackupRole(admin, { name: role, password: BACKUP.password }, context())).rejects.toThrow(message))
    await withAdmin((admin) => expect(ensureBackupRole(admin, { name: role, password: undefined }, context())).rejects.toThrow(message))
    expect(await roleState(role)).toEqual(before)
  })

  it("after the refusal the runtime and owner roles still cannot bypass RLS and can still log in", async () => {
    const { rows } = await sql<{ name: string; bypass: boolean; login: boolean }>`
      select rolname as name, rolbypassrls as bypass, rolcanlogin as login from pg_roles where rolname in (${database.roles.owner.name}, ${database.roles.runtime.name}) order by 1`.execute(database.db)
    expect(rows).toEqual([{ name: database.roles.owner.name, bypass: false, login: true }, { name: database.roles.runtime.name, bypass: false, login: true }].sort((a, b) => a.name.localeCompare(b.name)))
    expect(await count(runtime, "application")).toBe(0)
    expect(await count(owner, "application")).toBe(0)
  })

  it.each([
    ["a superuser", () => PROBES.superuser, /superuser/],
    ["a CREATEROLE role", () => PROBES.createrole, /CREATEROLE/],
    ["a CREATEDB role", () => PROBES.createdb, /CREATEDB/],
    ["a REPLICATION role", () => PROBES.replication, /REPLICATION/],
    ["a role that owns objects", () => PROBES.owner, /owns objects/],
    ["a role that is a member of another role", () => PROBES.member, /role memberships/],
    ["a role that has members", () => PROBES.hasMember, /role memberships/],
    ["an ordinary login role this code did not create", () => PROBES.plain, /not a backup role created by provision-roles/],
  ])("refuses an existing role that is %s, and changes nothing", async (_label, name, reason) => {
    const role = name()
    const before = await roleState(role)
    const error = await withAdmin((admin) => ensureBackupRole(admin, { name: role, password: BACKUP.password }, context()).then(() => null, (e: Error) => e))
    expect(error?.message).toMatch(reason)
    expect(error?.message).toMatch(/^DB_BACKUP_ROLE /)
    expect(error?.message).not.toContain(role)
    expect(await roleState(role)).toEqual(before)
  })

  it("accepts the backup role it created before (COMMENT marker), and converges it", async () => {
    const before = await sql<{ comment: string | null }>`select shobj_description(oid, 'pg_authid') as comment from pg_roles where rolname = ${BACKUP.name}`.execute(database.db)
    expect(before.rows[0]?.comment).toMatch(/eve backup role/)
    await withAdmin((admin) => ensureBackupRole(admin, BACKUP, context()))
  })

  it("accepts a role with exactly the backup attributes and no marker (a role made by attempt 1), then marks it", async () => {
    const legacy = `ja_backup_legacy_${RUN}`
    await withAdmin((admin) => sql`create role ${sql.id(legacy)} login nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls password 'legacy-password-000'`.execute(admin))
    try {
      await withAdmin((admin) => ensureBackupRole(admin, { name: legacy, password: BACKUP.password }, context()))
      const { rows } = await sql<{ comment: string | null }>`select shobj_description(oid, 'pg_authid') as comment from pg_roles where rolname = ${legacy}`.execute(database.db)
      expect(rows[0]?.comment).toMatch(/eve backup role/)
    } finally {
      await withAdminCluster((admin) => sql`drop role ${sql.id(legacy)}`.execute(admin).then(() => undefined))
    }
  })

  it("SEC-FBR-02: the backup role's sessions are read-only by default", async () => {
    const { rows } = await sql<{ setting: string }>`select current_setting('default_transaction_read_only') as setting`.execute(backup)
    expect(rows[0]?.setting).toBe("on")
    await expect(sql`select lo_create(0)`.execute(backup)).rejects.toThrow(/read-only transaction/)
  })
})

describe("the backup role reads every row under forced RLS", () => {
  it("sees every row of every table, for both Candidates and the installation, with no scope set", async () => {
    const expected = await tablesWithRows()
    expect(expected.map((e) => e.table)).toEqual(expect.arrayContaining(["public.application", "public.candidate", "public.kysely_migration"]))
    for (const { table, n } of expected) expect({ table, n: await count(backup, table) }).toEqual({ table, n })
    const perCandidate = await sql<{ candidate_id: string; n: number }>`
      select candidate_id, count(*)::int as n from application group by candidate_id order by n`.execute(backup)
    expect(perCandidate.rows).toEqual([{ candidate_id: database.operatorId, n: 1 }, { candidate_id: otherId, n: 2 }])
  })

  it("the owner and runtime roles still see no Candidate rows without a scope (RLS is not weakened)", async () => {
    expect(await count(owner, "application")).toBe(0)
    expect(await count(runtime, "application")).toBe(0)
    for (const table of INSTALLATION_TABLES) expect(await count(owner, table)).toBe(0)
  })

  it("pg_dump's default row_security = off works for the backup role and errors for the owner", async () => {
    const read = await backup.transaction().execute(async (trx) => {
      await sql`set local row_security = off`.execute(trx)
      return count(trx as unknown as Kysely<Database>, "application")
    })
    expect(read).toBe(3)
    await expect(owner.transaction().execute(async (trx) => {
      await sql`set local row_security = off`.execute(trx)
      return count(trx as unknown as Kysely<Database>, "application")
    })).rejects.toThrow(/row-level security/)
  })

  it("can read the migration bookkeeping and the job queue (a restore needs them)", async () => {
    await expect(count(backup, "kysely_migration")).resolves.toBeGreaterThan(0)
    await expect(sql`select count(*) from pgboss.version`.execute(backup)).resolves.toBeTruthy()
  })
})

describe("the backup role cannot write", () => {
  /** Proves the grants, not only the read-only default: each statement runs in a read-write transaction. */
  async function asWriter(statement: ReturnType<typeof sql>): Promise<unknown> {
    return backup.transaction().execute(async (trx) => {
      await sql`set transaction read write`.execute(trx)
      return statement.execute(trx)
    })
  }

  it("is refused INSERT, UPDATE, DELETE and TRUNCATE even in a read-write transaction", async () => {
    await expect(asWriter(sql`insert into candidate (email, google_sub, role) values ('x@example.test', 'x', 'candidate')`)).rejects.toThrow(/permission denied/)
    await expect(asWriter(sql`update application set role_title = 'changed'`)).rejects.toThrow(/permission denied/)
    await expect(asWriter(sql`delete from application`)).rejects.toThrow(/permission denied/)
    await expect(asWriter(sql`truncate application`)).rejects.toThrow(/permission denied/)
    await expect(sql`update application set role_title = 'changed'`.execute(backup)).rejects.toThrow(/read-only transaction/)
    expect(await count(database.db, "application")).toBe(3)
  })

  it("cannot create objects or change policies", async () => {
    await expect(asWriter(sql`create table public.intruder (x int)`)).rejects.toThrow(/permission denied/)
    await expect(asWriter(sql`alter table application disable row level security`)).rejects.toThrow(/must be owner/)
  })

  it("holds only SELECT on application tables", async () => {
    const { rows } = await sql<{ privilege: string }>`
      select distinct privilege_type as privilege from information_schema.table_privileges
      where grantee = ${BACKUP.name} order by 1`.execute(database.db)
    expect(rows.map((r) => r.privilege)).toEqual(["SELECT"])
    const sequences = await sql<{ name: string; usage: boolean; select: boolean; update: boolean }>`
      select c.oid::regclass::text as name, has_sequence_privilege(${BACKUP.name}, c.oid, 'USAGE') as usage,
        has_sequence_privilege(${BACKUP.name}, c.oid, 'SELECT') as select, has_sequence_privilege(${BACKUP.name}, c.oid, 'UPDATE') as update
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and n.nspname in ('public', 'pgboss')`.execute(database.db)
    for (const seq of sequences.rows) expect(seq).toEqual({ name: seq.name, usage: false, select: true, update: false })
  })
})

/**
 * Run a2e repair wave 1 (F-DEV-01): pg_dump locks every table it dumps, including
 * 0022's `tenant_binding.candidate_binding`, so the backup role needs USAGE on the
 * schema and SELECT on its table. The runtime role keeps 0022's privileges: none.
 */
describe("the backup role and the binding schema (migration 0022, F-DEV-01)", () => {
  async function bindingPrivileges(role: string): Promise<Record<string, boolean>> {
    const { rows } = await sql<Record<string, boolean>>`
      select has_schema_privilege(${role}, 'tenant_binding', 'USAGE') as usage,
        has_schema_privilege(${role}, 'tenant_binding', 'CREATE') as "create",
        has_table_privilege(${role}, 'tenant_binding.candidate_binding', 'SELECT') as select,
        has_table_privilege(${role}, 'tenant_binding.candidate_binding', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as write`.execute(database.db)
    return rows[0]!
  }

  it("after migrate the backup role may use the schema and read the binding table, and nothing more", async () => {
    expect(await bindingPrivileges(BACKUP.name)).toEqual({ usage: true, create: false, select: true, write: false })
    await expect(sql`select count(*) from tenant_binding.candidate_binding`.execute(backup)).resolves.toBeTruthy()
  })

  it("the runtime role still has no access to the schema or the table", async () => {
    expect(await bindingPrivileges(database.roles.runtime.name)).toEqual({ usage: false, create: false, select: false, write: false })
    await expect(sql`select count(*) from tenant_binding.candidate_binding`.execute(runtime)).rejects.toThrow(/permission denied/)
  })

  it("the backup role cannot write the binding table, even in a read-write transaction", async () => {
    await expect(
      backup.transaction().execute(async (trx) => {
        await sql`set transaction read write`.execute(trx)
        await sql`insert into tenant_binding.candidate_binding values (pg_current_xact_id(), ${otherId}::uuid)`.execute(trx)
      })
    ).rejects.toThrow(/permission denied/)
    await expect(sql`select public.bind_candidate(${otherId}::uuid)`.execute(backup)).rejects.toThrow(/permission denied|read-only/)
  })
})

describe("the backup role and TEMPORARY (EPIC-0002 A2 runtime-no-temporary migration, run a2e)", () => {
  async function backupTemp(): Promise<{ temp: boolean; bypass: boolean }> {
    const { rows } = await sql<{ temp: boolean; bypass: boolean }>`
      select has_database_privilege(${BACKUP.name}, current_database(), 'TEMPORARY') as temp,
        (select rolbypassrls from pg_roles where rolname = ${BACKUP.name}) as bypass`.execute(database.db)
    return rows[0]!
  }

  it("holds no TEMPORARY after migrate and still bypasses RLS; it cannot create a temporary table", async () => {
    expect(await backupTemp()).toEqual({ temp: false, bypass: true })
    // In a read-write transaction, so the refusal is the missing privilege, not the read-only default (SEC-FBR-02).
    await expect(
      backup.transaction().execute(async (trx) => {
        await sql`set transaction read write`.execute(trx)
        await sql`create temporary table backup_probe_temp (x int)`.execute(trx)
      })
    ).rejects.toThrow(/permission denied/)
    expect(await count(backup, "application")).toBe(3)
  })

  it("migrate revokes TEMPORARY granted to the backup role directly or through PUBLIC", async () => {
    const { rows } = await sql<{ name: string }>`select current_database() as name`.execute(database.db)
    const db = sql.id(rows[0]!.name)
    try {
      await sql`grant temporary on database ${db} to public, ${sql.id(BACKUP.name)}`.execute(database.db)
      expect((await backupTemp()).temp).toBe(true)
      await migrateAndGrant(database.ownerUrl, database.roles.runtime.name, undefined, { backupRole: BACKUP.name })
      expect(await backupTemp()).toEqual({ temp: false, bypass: true })
    } finally {
      await sql`revoke temporary on database ${db} from public, ${sql.id(BACKUP.name)}`.execute(database.db)
    }
  })
})

describe("future tables and re-runs", () => {
  const asWriterFuture = (statement: ReturnType<typeof sql>) =>
    backup.transaction().execute(async (trx) => {
      await sql`set transaction read write`.execute(trx)
      return statement.execute(trx)
    })

  it("a table the owner creates later is readable by the backup role (default privileges)", async () => {
    await sql`create table public.backup_probe_future (id int)`.execute(owner)
    try {
      await sql`insert into public.backup_probe_future values (1)`.execute(owner)
      expect(await count(backup, "backup_probe_future")).toBe(1)
      await expect(asWriterFuture(sql`insert into public.backup_probe_future values (2)`)).rejects.toThrow(/permission denied/)
    } finally {
      await sql`drop table public.backup_probe_future`.execute(owner)
    }
  })

  it("provisioning and migrate are safe to run again", async () => {
    await withAdmin((admin) => ensureBackupRole(admin, BACKUP, context()))
    expect(await migrateAndGrant(database.ownerUrl, database.roles.runtime.name, undefined, { backupRole: BACKUP.name })).toEqual([])
    expect(await count(backup, "application")).toBe(3)
  })
})
