import { type Kysely, sql } from "kysely"

/** Role and grant statements do not depend on the table schema, so any Kysely instance works. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDatabase = Kysely<any>

/**
 * SEC-001: the api and worker connect as a runtime role that can only read and
 * write application rows. Migrations run as a separate owner role. Neither is a
 * superuser, can create databases or roles, or holds pg_execute_server_program
 * or pg_read_server_files, so SQL cannot run OS commands or read server files.
 */
export type DatabaseRoles = Readonly<{
  database: string
  owner: Readonly<{ name: string; password: string }>
  runtime: Readonly<{ name: string; password: string }>
}>

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/** Run once by the bootstrap superuser. Safe to run again: it converges roles and grants. */
export async function provisionDatabaseRoles(admin: AnyDatabase, roles: DatabaseRoles): Promise<void> {
  await ensureLoginRole(admin, roles.owner.name, roles.owner.password)
  await ensureLoginRole(admin, roles.runtime.name, roles.runtime.password)
  await grantDatabaseAccess(admin, roles)
}

/**
 * The per-database part of provisioning: owner, schema, connect and default
 * privileges. `admin` must be connected to `roles.database` because schema and
 * default-privilege statements apply to the current database. Roles must exist.
 */
export async function grantDatabaseAccess(admin: AnyDatabase, roles: DatabaseRoles): Promise<void> {
  assertRoleName(roles.owner.name)
  assertRoleName(roles.runtime.name)
  assertRoleName(roles.database)
  const owner = sql.id(roles.owner.name)
  const runtime = sql.id(roles.runtime.name)
  const database = sql.id(roles.database)

  await sql`alter database ${database} owner to ${owner}`.execute(admin)
  await sql`alter schema public owner to ${owner}`.execute(admin)
  await transferExistingObjects(admin, roles.owner.name)
  await sql`revoke create on schema public from public`.execute(admin)
  await sql`revoke all on database ${database} from public`.execute(admin)
  // Run a2c repair wave 2 (F-SEC-14, migration 0023): no temporary tables, which would outlive a Candidate scope on its pooled connection.
  await sql`grant connect on database ${database} to ${runtime}`.execute(admin)
  await sql`revoke temporary on database ${database} from ${runtime}`.execute(admin)
  await sql`grant usage on schema public to ${runtime}`.execute(admin)

  // Every table, sequence, and schema the owner creates later (migrations, pg-boss)
  // is usable by the runtime role for DML only.
  await sql`alter default privileges for role ${owner} grant select, insert, update, delete on tables to ${runtime}`.execute(admin)
  await sql`alter default privileges for role ${owner} grant usage, select on sequences to ${runtime}`.execute(admin)
  await sql`alter default privileges for role ${owner} grant execute on functions to ${runtime}`.execute(admin)
}

/**
 * CR2-09: a slice 1 installation ran migrations as the image's superuser, so its
 * tables, sequences and functions (and `kysely_migration`) belong to that role and
 * the owner role could neither migrate nor grant on them. This hands every object
 * in the application schemas to the owner role. F-QA-01: the same is needed after
 * the disaster restore, which runs as the superuser, so partitions (pg-boss's
 * `job_common`, `queue_stats_*`) and types (`pgboss.job_state`) are included.
 * It is scoped to `public`, `pgboss` and `tenant_binding` (EPIC-0002 A2 migration
 * 0022's binding schema, run a2e: a restore as the superuser leaves it behind and
 * migrate then fails on its ACL) on purpose: `REASSIGN OWNED BY <superuser>` would also try to move
 * objects that role owns in other databases and system catalogs. A fresh database
 * has nothing to transfer, so this is safe to run every time.
 */
async function transferExistingObjects(admin: AnyDatabase, ownerName: string): Promise<void> {
  const owner = sql.id(ownerName)
  const relations = await sql<{ schema: string; name: string; kind: string }>`
    select n.nspname as schema, c.relname as name, c.relkind as kind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'pgboss', 'tenant_binding') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and pg_get_userbyid(c.relowner) <> ${ownerName}
      -- Extension members, and objects internal to another object, stay with their parent. A
      -- partitioned table has an internal dependency on itself, which must not exclude it.
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid
        and (d.deptype = 'e' or (d.deptype = 'i' and not (d.refclassid = 'pg_class'::regclass and d.refobjid = c.oid))))
      -- A sequence owned by a column moves with its table; ALTER SEQUENCE would be refused.
      and not (c.relkind = 'S' and exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'a'))`.execute(admin)
  for (const relation of relations.rows) {
    const target = sql.id(relation.schema, relation.name)
    const kind = relation.kind === "S" ? sql.raw("sequence") : relation.kind === "v" ? sql.raw("view") : relation.kind === "m" ? sql.raw("materialized view") : sql.raw("table")
    await sql`alter ${kind} ${target} owner to ${owner}`.execute(admin)
  }
  // F-QA-01: types a restore leaves behind (pg-boss's job_state enum). Row types and
  // array types move with their table or element type; extension members are left alone.
  const types = await sql<{ name: string }>`
    select t.oid::regtype::text as name
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname in ('public', 'pgboss', 'tenant_binding') and pg_get_userbyid(t.typowner) <> ${ownerName}
      and t.typtype in ('e', 'd', 'r', 'c')
      and (t.typrelid = 0 or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype in ('i', 'e'))`.execute(admin)
  for (const type of types.rows) {
    await sql`alter type ${sql.raw(type.name)} owner to ${owner}`.execute(admin)
  }
  const functions = await sql<{ signature: string }>`
    select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'pgboss', 'tenant_binding') and pg_get_userbyid(p.proowner) <> ${ownerName}
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`.execute(admin)
  for (const fn of functions.rows) {
    await sql`alter routine ${sql.raw(fn.signature)} owner to ${owner}`.execute(admin)
  }
  const schemas = await sql<{ name: string }>`
    select nspname as name from pg_namespace where nspname in ('pgboss', 'tenant_binding') and pg_get_userbyid(nspowner) <> ${ownerName}`.execute(admin)
  for (const schema of schemas.rows) await sql`alter schema ${sql.id(schema.name)} owner to ${owner}`.execute(admin)
}

/** Run by the owner after migrations: grants on objects that already existed, minus bookkeeping tables. */
export async function grantRuntimeAccess(owner: AnyDatabase, runtimeRole: string, schemas: readonly string[]): Promise<void> {
  assertRoleName(runtimeRole)
  const runtime = sql.id(runtimeRole)
  for (const schemaName of schemas) {
    assertRoleName(schemaName)
    const schema = sql.id(schemaName)
    await sql`grant usage on schema ${schema} to ${runtime}`.execute(owner)
    await sql`grant select, insert, update, delete on all tables in schema ${schema} to ${runtime}`.execute(owner)
    await sql`grant usage, select on all sequences in schema ${schema} to ${runtime}`.execute(owner)
    await sql`grant execute on all functions in schema ${schema} to ${runtime}`.execute(owner)
  }
  await sql`revoke all on table public.kysely_migration, public.kysely_migration_lock from ${runtime}`.execute(owner)
  // Migration 0023: re-applied on every migrate, as restoreCandidateBindingAcl is. PUBLIC too
  // (run a2d, F-QA-14): every role holds PUBLIC's privileges, and a new or restored database grants it TEMPORARY.
  const { rows: current } = await sql<{ name: string }>`select current_database() as name`.execute(owner)
  await sql`revoke temporary on database ${sql.id(current[0]!.name)} from public, ${runtime}`.execute(owner)
  await restoreCandidateBindingAcl(owner, runtimeRole)
}

/**
 * Migration 0022 (F-SEC-10) sets these privileges once. A restore with
 * `--no-acl` loses them: the restored `bind_candidate` falls back to the
 * default PUBLIC execute, and the owner's default privileges grant the runtime
 * role DML on the restored binding table. Re-applied on every `migrate`, so
 * the documented restore (restore, then `migrate`) ends with 0022's privileges.
 */
async function restoreCandidateBindingAcl(owner: AnyDatabase, runtimeRole: string): Promise<void> {
  const { rows } = await sql<{ n: number }>`select 1 as n from pg_namespace where nspname = 'tenant_binding'`.execute(owner)
  if (rows.length === 0) return
  const runtime = sql.id(runtimeRole)
  await sql`revoke all on schema tenant_binding from public, ${runtime}`.execute(owner)
  await sql`revoke all on table tenant_binding.candidate_binding from public, ${runtime}`.execute(owner)
  await sql`revoke all on function public.bind_candidate(uuid) from public`.execute(owner)
  await sql`grant execute on function public.bind_candidate(uuid) to ${runtime}`.execute(owner)
  await sql`grant execute on function public.bound_candidate() to public`.execute(owner)
}

/**
 * fix-backup-role: since 0017 every Candidate and installation table forces RLS,
 * so `pg_dump` as the owner fails. The backup role is the one role that bypasses
 * RLS, and it can only read: it gets SELECT and nothing else (grantBackupAccess).
 * BYPASSRLS can only be set by a superuser, so the role is created here, by the
 * bootstrap superuser. With no password it is NOLOGIN: never LOGIN without one.
 */
export type BackupRole = Readonly<{ name: string; password: string | undefined }>

/** The app's own roles, which the backup role must never be (SEC-FBR-01). */
export type BackupRoleContext = Readonly<{ owner: string; runtime: string }>

/** Set by ensureBackupRole: marks a role as the dedicated backup role this code created. */
export const BACKUP_ROLE_MARKER = "eve backup role (provision-roles, fix-backup-role); read-only, BYPASSRLS"

/**
 * SEC-FBR-01: BYPASSRLS on the wrong role removes A1's tenant isolation, so every
 * check runs before any CREATE or ALTER. Refused: the owner, runtime and bootstrap
 * (current) user by name, and any existing role that is privileged, owns objects
 * (in any database), has role memberships, or was not made by this function
 * (no marker and not exactly the backup attributes). Messages name only env keys.
 */
async function refuseUnsafeBackupRole(admin: AnyDatabase, name: string, context: BackupRoleContext): Promise<boolean> {
  const refuse = (reason: string): never => {
    throw new Error(`DB_BACKUP_ROLE ${reason}; choose a new, unused name for DB_BACKUP_ROLE (docs/ops/backups.md, "Backup role")`)
  }
  if (name === context.runtime) refuse("must not name DB_RUNTIME_ROLE")
  if (name === context.owner) refuse("must not name DB_OWNER_ROLE")
  const session = await sql<{ current: string; session: string }>`select current_user as current, session_user as session`.execute(admin)
  if (name === session.rows[0]!.current || name === session.rows[0]!.session) refuse("must not name the bootstrap user (POSTGRES_USER)")
  const found = await sql<{
    super: boolean; createrole: boolean; createdb: boolean; replication: boolean; inherit: boolean; bypass: boolean
    owns: boolean; memberships: boolean; marked: boolean
  }>`
    select r.rolsuper as super, r.rolcreaterole as createrole, r.rolcreatedb as createdb, r.rolreplication as replication,
      r.rolinherit as inherit, r.rolbypassrls as bypass,
      exists (select 1 from pg_shdepend d where d.refclassid = 'pg_authid'::regclass and d.refobjid = r.oid and d.deptype = 'o') as owns,
      exists (select 1 from pg_auth_members m where m.member = r.oid or m.roleid = r.oid) as memberships,
      coalesce(shobj_description(r.oid, 'pg_authid') = ${BACKUP_ROLE_MARKER}, false) as marked
    from pg_roles r where r.rolname = ${name}`.execute(admin)
  const role = found.rows[0]
  if (!role) return false
  if (role.super) refuse("names an existing superuser")
  if (role.createrole) refuse("names an existing role with CREATEROLE")
  if (role.createdb) refuse("names an existing role with CREATEDB")
  if (role.replication) refuse("names an existing role with REPLICATION")
  if (role.owns) refuse("names an existing role that owns objects")
  if (role.memberships) refuse("names an existing role with role memberships")
  // A role made before the marker existed (attempt 1) has exactly the backup attributes.
  const backupShaped = !role.inherit && role.bypass
  if (!role.marked && !backupShaped) refuse("names an existing role that is not a backup role created by provision-roles")
  return true
}

export async function ensureBackupRole(admin: AnyDatabase, role: BackupRole, context: BackupRoleContext): Promise<void> {
  assertRoleName(role.name)
  const login = role.password !== undefined && role.password !== ""
  if (login && role.password!.length < 12) throw new Error(`Password for role ${role.name} must be at least 12 characters`)
  const exists = await refuseUnsafeBackupRole(admin, role.name, context)
  const name = sql.id(role.name)
  const attributes = sql.raw(`${login ? "login" : "nologin"} nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls`)
  const password = login ? sql`password ${sql.lit(role.password!)}` : sql`password null`
  if (!exists) {
    await sql`create role ${name} with ${attributes} ${password}`.execute(admin)
  } else {
    await sql`alter role ${name} with ${attributes} ${password}`.execute(admin)
  }
  await sql`comment on role ${name} is ${sql.lit(BACKUP_ROLE_MARKER)}`.execute(admin)
  // SEC-FBR-02: every session starts read-only (pg_dump and the counts only read), so
  // the role cannot write even where PUBLIC can, for example large objects.
  await sql`alter role ${name} set default_transaction_read_only = on`.execute(admin)
  for (const powerful of ["pg_execute_server_program", "pg_read_server_files", "pg_write_server_files"]) {
    await sql`revoke ${sql.id(powerful)} from ${name}`.execute(admin)
  }
}

/**
 * Run by the owner in the migrate step, every time (converges like grantRuntimeAccess):
 * CONNECT, USAGE on the schemas, SELECT on every table and sequence, and the same
 * for every table and sequence the owner creates later. No INSERT, UPDATE,
 * DELETE, TRUNCATE, sequence USAGE (nextval) or TEMPORARY.
 */
export async function grantBackupAccess(owner: AnyDatabase, roles: Readonly<{ backup: string; runtime: string }>, schemas: readonly string[]): Promise<void> {
  assertRoleName(roles.backup)
  const current = await sql<{ owner: string }>`select current_user as owner`.execute(owner)
  const ownerName = current.rows[0]!.owner
  if (roles.backup === roles.runtime || roles.backup === ownerName) {
    throw new Error(`The backup role must differ from the owner and runtime roles (got ${roles.backup})`)
  }
  const found = await sql<{ bypass: boolean }>`select rolbypassrls as bypass from pg_roles where rolname = ${roles.backup}`.execute(owner)
  if (found.rows.length === 0) throw new Error(`Backup role ${roles.backup} does not exist; run provision-roles with DB_BACKUP_ROLE set first`)
  const backup = sql.id(roles.backup)
  const database = await sql<{ name: string }>`select current_database() as name`.execute(owner)
  await sql`grant connect on database ${sql.id(database.rows[0]!.name)} to ${backup}`.execute(owner)
  for (const schemaName of schemas) {
    assertRoleName(schemaName)
    const schema = sql.id(schemaName)
    await sql`grant usage on schema ${schema} to ${backup}`.execute(owner)
    await sql`grant select on all tables in schema ${schema} to ${backup}`.execute(owner)
    await sql`grant select on all sequences in schema ${schema} to ${backup}`.execute(owner)
  }
  await sql`alter default privileges grant select on tables to ${backup}`.execute(owner)
  await sql`alter default privileges grant select on sequences to ${backup}`.execute(owner)
  await grantBackupBindingRead(owner, backup)
  // EPIC-0002 A2 runtime-no-temporary migration (run a2e): no TEMPORARY for the backup role either. grantRuntimeAccess
  // has already revoked PUBLIC's; this removes a direct grant, so the role holds SELECT only.
  await sql`revoke temporary on database ${sql.id(database.rows[0]!.name)} from ${backup}`.execute(owner)
}

/**
 * Run a2e repair wave 1 (F-DEV-01): pg_dump locks every table it dumps, so it
 * needs SELECT on 0022's binding table even though backup.sh leaves out its rows
 * (unlogged, per-transaction: `--no-unlogged-table-data`). Migration 0022 revokes
 * every grant on that table but the owner's, and restoreCandidateBindingAcl keeps
 * PUBLIC and the runtime role out, so this grant is explicit and re-applied on
 * every migrate. Read only: no CREATE on the schema, no write on the table.
 */
async function grantBackupBindingRead(owner: AnyDatabase, backup: ReturnType<typeof sql.id>): Promise<void> {
  const { rows } = await sql<{ n: number }>`select 1 as n from pg_namespace where nspname = 'tenant_binding'`.execute(owner)
  if (rows.length === 0) return
  await sql`grant usage on schema tenant_binding to ${backup}`.execute(owner)
  await sql`grant select on all tables in schema tenant_binding to ${backup}`.execute(owner)
}

async function ensureLoginRole(admin: AnyDatabase, name: string, password: string): Promise<void> {
  assertRoleName(name)
  if (password.length < 12) throw new Error(`Password for role ${name} must be at least 12 characters`)
  const exists = await sql<{ n: number }>`select 1 as n from pg_roles where rolname = ${name}`.execute(admin)
  const role = sql.id(name)
  const attributes = sql.raw("login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls")
  if (exists.rows.length === 0) {
    await sql`create role ${role} with ${attributes} password ${sql.lit(password)}`.execute(admin)
  } else {
    await sql`alter role ${role} with ${attributes} password ${sql.lit(password)}`.execute(admin)
  }
  for (const powerful of ["pg_execute_server_program", "pg_read_server_files", "pg_write_server_files"]) {
    await sql`revoke ${sql.id(powerful)} from ${role}`.execute(admin)
  }
}

function assertRoleName(name: string): void {
  if (!ROLE_NAME.test(name)) throw new Error(`Not a safe identifier: ${name}`)
}
