import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { type DatabaseRoles, ensureBackupRole, provisionDatabaseRoles } from "../src/db/database-roles.js"
import { migrateAndGrant } from "../src/db/migrate-and-grant.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { type TestDatabase, startMigratedDatabase, urlFor } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"

/**
 * F-QA-01 (fix-backup-role): the disaster runbook restores the dump as the
 * bootstrap superuser (the owner is bound by the restored FORCE RLS), then runs
 * provision-roles and migrate. pg-boss's partitioned tables, their partitions and
 * its enum stayed owned by the superuser, so migrate failed with "permission denied
 * for table job_common". This runs the runbook against a real dump: pg_dump and
 * pg_restore are the server's own (17), inside the cluster container.
 * Roles are cluster-wide, so this file uses its own names (see slice1-upgrade.int-spec.ts).
 */
const RUN = Date.now().toString(36)
const TARGET = `ja_restore_${RUN}`
const ROLES: DatabaseRoles = {
  database: TARGET,
  owner: { name: `ja_restore_owner_${RUN}`, password: "owner-password-for-tests" },
  runtime: { name: `ja_restore_runtime_${RUN}`, password: "runtime-password-for-tests" },
}
const BACKUP = { name: `ja_restore_backup_${RUN}`, password: "backup-password-for-tests" }

let source: TestDatabase
let clusterUrl: string
let superuser: string
let container: string
let cluster: Kysely<unknown>

function inContainer(args: string[], input?: Buffer): Buffer {
  return execFileSync("docker", ["exec", "-i", container, ...args], { input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] })
}

async function withDb<T>(url: string, work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const db = createDatabase(url)
  try {
    return await work(db)
  } finally {
    await db.destroy()
  }
}

/** Objects in the app schemas not owned by `owner`: relations (incl. partitions), types, routines, the pgboss schema. */
async function foreignOwned(db: Kysely<Database>, owner: string): Promise<string[]> {
  const { rows } = await sql<{ object: string }>`
    select 'relation ' || c.oid::regclass::text || ' (' || c.relkind::text || ')' as object
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'pgboss', 'tenant_binding') and c.relkind not in ('i', 'I', 't') and pg_get_userbyid(c.relowner) <> ${owner}
    union all
    select 'type ' || t.oid::regtype::text from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname in ('public', 'pgboss', 'tenant_binding') and pg_get_userbyid(t.typowner) <> ${owner}
    union all
    select 'routine ' || p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'pgboss', 'tenant_binding') and pg_get_userbyid(p.proowner) <> ${owner}
    union all
    select 'schema ' || nspname from pg_namespace where nspname in ('public', 'pgboss', 'tenant_binding') and pg_get_userbyid(nspowner) <> ${owner}
    order by 1`.execute(db)
  return rows.map((row) => row.object)
}

beforeAll(async () => {
  clusterUrl = inject("postgresAdminUrl")
  container = inject("postgresContainerId")
  superuser = decodeURIComponent(new URL(clusterUrl).username)
  cluster = createDatabase(clusterUrl) as unknown as Kysely<unknown>
  source = await startMigratedDatabase()
  const other = await insertSecondCandidate(source.db)
  await source.db.insertInto("approved_answer").values([
    { id: randomUUID(), candidate_id: source.operatorId, answer_key: "k-op", answer_group: "custom", topic: null, skill: null, question: "q", value: "v", created_at: new Date(), updated_at: new Date() },
    { id: randomUUID(), candidate_id: other, answer_key: "k-other", answer_group: "custom", topic: null, skill: null, question: "q", value: "v", created_at: new Date(), updated_at: new Date() },
  ]).execute()
  // EPIC-0007 (migration 0021-hiring-posts): one row per hiring table for each Candidate, so the dump and restore below carry forced-RLS rows of all four.
  for (const candidate of [source.operatorId, other]) {
    const feed = randomUUID()
    await sql`insert into hiring_alert_feed (candidate_id, id, url, created_at) values (${candidate}::uuid, ${feed}::uuid, ${`https://www.google.com/alerts/feeds/1/${Math.floor(Math.random() * 1e9)}`}, now())`.execute(source.db)
    await sql`insert into hiring_post (candidate_id, id, canonical_url, kind, source_feed_id, first_seen_at) values (${candidate}::uuid, ${randomUUID()}::uuid, ${`https://www.linkedin.com/posts/${candidate}`}, 'post', ${feed}::uuid, now())`.execute(source.db)
    await sql`insert into hiring_post_run (candidate_id, id, started_at, outcome) values (${candidate}::uuid, ${randomUUID()}::uuid, now(), 'completed')`.execute(source.db)
    await sql`insert into hiring_feed_verification (candidate_id, verified_on, verification_basis, updated_at) values (${candidate}::uuid, current_date, 'backup test', now())`.execute(source.db)
  }
})

const HIRING_TABLES = ["hiring_alert_feed", "hiring_feed_verification", "hiring_post", "hiring_post_run"] as const

afterAll(async () => {
  await source?.stop()
  await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${TARGET} and pid <> pg_backend_pid()`.execute(cluster)
  await sql`drop database if exists ${sql.id(TARGET)}`.execute(cluster)
  for (const role of [BACKUP.name, ROLES.runtime.name, ROLES.owner.name]) {
    await sql`drop owned by ${sql.id(role)}`.execute(cluster).catch(() => undefined)
    await sql`drop role if exists ${sql.id(role)}`.execute(cluster)
  }
  await cluster?.destroy()
})

describe("the disaster restore runbook brings the stack back (F-QA-01)", () => {
  it("restore as the superuser, then provision-roles and migrate succeed, hand everything to the owner and grant the backup role", async () => {
    const sourceName = new URL(source.adminUrl).pathname.slice(1)
    // The dump backup.sh takes (custom format), here as the superuser for the test.
    const dump = inContainer(["pg_dump", "-Fc", "-U", superuser, "-d", sourceName])

    // Runbook step 3: an empty database and the roles.
    await sql`create database ${sql.id(TARGET)}`.execute(cluster)
    const targetAdmin = urlFor(clusterUrl, undefined, TARGET)
    await withDb(targetAdmin, async (admin) => {
      await provisionDatabaseRoles(admin, ROLES)
      await ensureBackupRole(admin, BACKUP, { owner: ROLES.owner.name, runtime: ROLES.runtime.name })
    })

    // Step 5: restore.sh as the bootstrap superuser (--no-owner --no-acl).
    inContainer(["pg_restore", "--no-owner", "--no-acl", "--exit-on-error", "-U", superuser, "-d", TARGET], dump)
    const before = await withDb(targetAdmin, (db) => foreignOwned(db, ROLES.owner.name))
    expect(before.some((object) => object.includes("pgboss.job"))).toBe(true)
    // Run a2e: A2's binding schema (migration 0022) is restored as the superuser's too.
    expect(before).toContain("schema tenant_binding")

    // Step 7: provision-roles, then migrate.
    await withDb(targetAdmin, async (admin) => {
      await provisionDatabaseRoles(admin, ROLES)
      await ensureBackupRole(admin, BACKUP, { owner: ROLES.owner.name, runtime: ROLES.runtime.name })
    })
    expect(await withDb(targetAdmin, (db) => foreignOwned(db, ROLES.owner.name))).toEqual([])
    const ownerUrl = urlFor(clusterUrl, ROLES.owner, TARGET)
    expect(await migrateAndGrant(ownerUrl, ROLES.runtime.name, { operatorGoogleSub: undefined }, { backupRole: BACKUP.name })).toEqual([])

    // The backup role reads every Candidate's rows again; the runtime role is still scoped.
    const answers = await withDb(urlFor(clusterUrl, BACKUP, TARGET), (db) =>
      sql<{ n: number }>`select count(distinct candidate_id)::int as n from approved_answer`.execute(db))
    expect(answers.rows[0]?.n).toBe(2)
    const grants = await withDb(targetAdmin, (db) =>
      sql<{ n: number }>`select count(*)::int as n from information_schema.table_privileges where grantee = ${BACKUP.name} and table_schema = 'pgboss'`.execute(db))
    expect(grants.rows[0]?.n).toBeGreaterThan(0)
    const scoped = await withDb(urlFor(clusterUrl, ROLES.runtime, TARGET), (db) => sql<{ n: number }>`select count(*)::int as n from approved_answer`.execute(db))
    expect(scoped.rows[0]?.n).toBe(0)
    // Migration 0022's binding privileges are back after the --no-acl restore: the runtime role binds, but never reads the table.
    const binding = await withDb(targetAdmin, (db) =>
      sql<{ bind: boolean; schema: boolean; table: boolean }>`select has_function_privilege(${ROLES.runtime.name}, 'public.bind_candidate(uuid)', 'EXECUTE') as bind,
        has_schema_privilege(${ROLES.runtime.name}, 'tenant_binding', 'USAGE') as schema,
        has_table_privilege(${ROLES.runtime.name}, 'tenant_binding.candidate_binding', 'SELECT') as table`.execute(db))
    expect(binding.rows[0]).toEqual({ bind: true, schema: false, table: false })
  })

  it("running provision-roles and migrate again changes nothing", async () => {
    const targetAdmin = urlFor(clusterUrl, undefined, TARGET)
    await withDb(targetAdmin, (admin) => provisionDatabaseRoles(admin, ROLES))
    expect(await migrateAndGrant(urlFor(clusterUrl, ROLES.owner, TARGET), ROLES.runtime.name, undefined, { backupRole: BACKUP.name })).toEqual([])
    expect(await withDb(targetAdmin, (db) => foreignOwned(db, ROLES.owner.name))).toEqual([])
  })
})

/**
 * Run a2e repair wave 1 (F-DEV-01): on a database with 0022, backup.sh failed
 * (`reason=count`) because the backup role could not reach `tenant_binding`. This
 * runs backup.sh's own dump-and-count shell (scripts/backup/lib.sh) as the backup
 * role on a 0023 database with forced RLS, restores the dump as the runbook does,
 * and checks the api's Candidate scopes still bind on the restored database.
 */
describe("backup.sh's dump as the backup role on a 0023 database, then restore and migrate (F-DEV-01)", () => {
  const SECOND_TARGET = `${TARGET}_b`
  const LIB = fileURLToPath(new URL("../../../scripts/backup/lib.sh", import.meta.url))
  const shell = (name: string) => execFileSync("bash", ["-c", `source "$1"; printf '%s' "\${!2}"`, "_", LIB, name], { encoding: "utf8" })

  afterAll(async () => {
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${SECOND_TARGET} and pid <> pg_backend_pid()`.execute(cluster)
    await sql`drop database if exists ${sql.id(SECOND_TARGET)}`.execute(cluster)
  })

  it("dumps and counts as the backup role, leaves out the binding rows, and the restored database binds Candidates", async () => {
    const sourceName = new URL(source.adminUrl).pathname.slice(1)
    await withDb(source.adminUrl, (admin) => ensureBackupRole(admin, BACKUP, { owner: source.roles.owner.name, runtime: source.roles.runtime.name }))
    await migrateAndGrant(source.ownerUrl, source.roles.runtime.name, { operatorGoogleSub: undefined }, { backupRole: BACKUP.name })
    // A binding left by a finished transaction (bind_candidate removes these lazily), so the table is not empty at dump time.
    await sql`insert into tenant_binding.candidate_binding values ('1'::xid8, ${source.operatorId}::uuid)`.execute(source.db)
    const env = ["-e", `EVE_DB_NAME=${sourceName}`, "-e", `EVE_DB_USER=${BACKUP.name}`, "-e", `EVE_COUNT_SQL=${shell("EVE_COUNT_SQL")}`, "-e", `EVE_COUNT_SH=${shell("EVE_COUNT_SH")}`]
    const run = spawnSync("docker", ["exec", ...env, container, "sh", "-c", shell("EVE_DUMP_SH")], { maxBuffer: 256 * 1024 * 1024 })
    const stderr = run.stderr.toString()
    expect({ status: run.status, stderr: stderr.split("\n").filter((line) => !line.startsWith("EVECOUNTS")) }).toEqual({ status: 0, stderr: [""] })
    expect(stderr).toMatch(/^EVECOUNTS tables=\d+ rows=\d+ counts=[0-9a-f]{16}$/m)
    const dump = run.stdout

    const list = inContainer(["pg_restore", "--list"], dump).toString()
    expect(list).toMatch(/TABLE tenant_binding candidate_binding/)
    expect(list).not.toMatch(/TABLE DATA tenant_binding candidate_binding/)
    expect(list).toMatch(/TABLE DATA public approved_answer/)
    for (const table of HIRING_TABLES) expect(list).toMatch(new RegExp(`TABLE DATA public ${table} `))

    await sql`create database ${sql.id(SECOND_TARGET)}`.execute(cluster)
    const targetAdmin = urlFor(clusterUrl, undefined, SECOND_TARGET)
    const second = { ...ROLES, database: SECOND_TARGET }
    await withDb(targetAdmin, (admin) => provisionDatabaseRoles(admin, second))
    inContainer(["pg_restore", "--no-owner", "--no-acl", "--exit-on-error", "-U", superuser, "-d", SECOND_TARGET], dump)
    await withDb(targetAdmin, async (admin) => {
      await provisionDatabaseRoles(admin, second)
      await ensureBackupRole(admin, BACKUP, { owner: ROLES.owner.name, runtime: ROLES.runtime.name })
    })
    expect(await migrateAndGrant(urlFor(clusterUrl, ROLES.owner, SECOND_TARGET), ROLES.runtime.name, { operatorGoogleSub: undefined }, { backupRole: BACKUP.name })).toEqual([])

    const restored = await withDb(targetAdmin, (db) =>
      sql<{ rows: number; unlogged: boolean }>`select (select count(*)::int from tenant_binding.candidate_binding) as rows,
        (select relpersistence = 'u' from pg_class where oid = 'tenant_binding.candidate_binding'::regclass) as unlogged`.execute(db))
    expect(restored.rows[0]).toEqual({ rows: 0, unlogged: true })

    // The api's Candidate scope binds on the restored database and sees only its own rows.
    const seen = await withDb(urlFor(clusterUrl, ROLES.runtime, SECOND_TARGET), async (runtime) => {
      const tenant = new TenantDatabase(runtime)
      return tenant.forCandidate(source.operatorId, async (tx) => (await tx.selectFrom("approved_answer").select("answer_key").execute()).map((row) => row.answer_key))
    })
    expect(seen).toEqual(["k-op"])

    // EPIC-0007's hiring tables: the backup role's dump carried both Candidates' rows, the restore keeps forced RLS, and a Candidate scope sees only its own.
    const hiring = await withDb(urlFor(clusterUrl, BACKUP, SECOND_TARGET), async (db) => {
      const out: Record<string, number> = {}
      for (const table of HIRING_TABLES) out[table] = (await sql<{ n: number }>`select count(distinct candidate_id)::int as n from ${sql.table(table)}`.execute(db)).rows[0]!.n
      return out
    })
    expect(hiring).toEqual(Object.fromEntries(HIRING_TABLES.map((table) => [table, 2])))
    const forced = await withDb(targetAdmin, (db) =>
      sql<{ name: string }>`select relname as name from pg_class where relname = any(${[...HIRING_TABLES]}) and relrowsecurity and relforcerowsecurity order by 1`.execute(db))
    expect(forced.rows.map((row) => row.name)).toEqual([...HIRING_TABLES])
    const ownPosts = await withDb(urlFor(clusterUrl, ROLES.runtime, SECOND_TARGET), (runtime) =>
      new TenantDatabase(runtime).forCandidate(source.operatorId, async (tx) => (await tx.selectFrom("hiring_post").select("candidate_id").execute()).map((row) => row.candidate_id)))
    expect(ownPosts).toEqual([source.operatorId])

    // The runtime role still neither reads nor writes the binding table; the backup role reads it again after migrate.
    await withDb(urlFor(clusterUrl, ROLES.runtime, SECOND_TARGET), async (runtime) => {
      await expect(sql`select count(*) from tenant_binding.candidate_binding`.execute(runtime)).rejects.toThrow(/permission denied/)
      await expect(sql`insert into tenant_binding.candidate_binding values (pg_current_xact_id(), ${source.operatorId}::uuid)`.execute(runtime)).rejects.toThrow(/permission denied/)
    })
    const again = spawnSync("docker", ["exec", ...env.map((arg) => arg.replace(`EVE_DB_NAME=${sourceName}`, `EVE_DB_NAME=${SECOND_TARGET}`)), container, "sh", "-c", shell("EVE_DUMP_SH")], { maxBuffer: 256 * 1024 * 1024 })
    expect(again.status).toBe(0)
  })
})
