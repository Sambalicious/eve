import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { inject } from "vitest"

import { createDatabase } from "../../src/db/create-database.js"
import { type DatabaseRoles, grantDatabaseAccess } from "../../src/db/database-roles.js"
import type { Database } from "../../src/db/schema.js"
import { TEMPLATE_DATABASE, rolesFor, urlFor } from "./postgres-cluster.js"

export { urlFor } from "./postgres-cluster.js"

export type TestDatabase = Readonly<{
  /** Roles and the database name this file's database was provisioned with. */
  roles: DatabaseRoles
  /** Least-privilege runtime role: what the api and worker use (SEC-001). */
  url: string
  /** Migration owner role. */
  ownerUrl: string
  /** Bootstrap superuser, connected to this file's database. Tests use it only to provision and inspect. */
  adminUrl: string
  /**
   * Bootstrap superuser on this file's database, for test setup and assertions.
   * EPIC-0002 A1 unit 3: every Candidate table forces RLS, which binds the owner
   * role too; only a superuser sees every Candidate's rows, as a fixture must.
   */
  db: Kysely<Database>
  /** The owner Candidate (the Operator) migration 0016 created; fixtures name it as `candidate_id`. */
  operatorId: string
  /** Empties every application table except the identity rows migration 0016 created (the owner Candidate and the marker). */
  truncateAll(): Promise<void>
  /** Closes the fixture pool and drops the database. Fails if a connection is still open. */
  stop(): Promise<void>
}>

/** Serialises CREATE DATABASE … TEMPLATE across test files sharing the cluster. */
const TEMPLATE_LOCK_KEY = 72_000_101

/**
 * A fresh, migrated database for one test file: a copy of the run's template
 * on the shared container (see postgres.global-setup.ts), with the same owner
 * and runtime roles and database-level grants as production.
 */
export async function startMigratedDatabase(): Promise<TestDatabase> {
  const clusterUrl = inject("postgresAdminUrl")
  const name = `ja_test_${randomUUID().replaceAll("-", "")}`
  const roles = rolesFor(name)
  await withAdmin(clusterUrl, async (admin) => {
    await sql`select pg_advisory_lock(${TEMPLATE_LOCK_KEY})`.execute(admin)
    try {
      await sql`create database ${sql.id(name)} template ${sql.id(TEMPLATE_DATABASE)}`.execute(admin)
    } finally {
      await sql`select pg_advisory_unlock(${TEMPLATE_LOCK_KEY})`.execute(admin)
    }
  })
  const adminUrl = urlFor(clusterUrl, undefined, name)
  await withAdmin(adminUrl, (admin) => grantDatabaseAccess(admin, roles))
  const ownerUrl = urlFor(clusterUrl, roles.owner, name)
  const db = createDatabase(adminUrl)
  const operator = await db.selectFrom("candidate").select("id").where("role", "=", "operator").executeTakeFirstOrThrow()
  let poolOpen = true
  return {
    roles,
    url: urlFor(clusterUrl, roles.runtime, name),
    ownerUrl,
    adminUrl,
    db,
    operatorId: operator.id,
    truncateAll: async () => {
      const tables = await sql<{ tablename: string }>`
        select tablename from pg_tables where schemaname = 'public' and tablename not like 'kysely_%'
          and tablename not in ('candidate', 'migration_marker')`.execute(db)
      const names = tables.rows.map((row) => sql.id(row.tablename))
      if (names.length > 0) await sql`truncate ${sql.join(names)} cascade`.execute(db)
    },
    stop: async () => {
      if (poolOpen) {
        poolOpen = false
        await db.destroy()
      }
      // Without FORCE: Postgres waits up to 5 s for closing sessions, then refuses
      // if any connection is still open, so a leaked pool fails the file loudly.
      await withAdmin(clusterUrl, (admin) => sql`drop database ${sql.id(name)}`.execute(admin))
    },
  }
}

async function withAdmin<T>(url: string, work: (admin: Kysely<unknown>) => Promise<T>): Promise<T> {
  const admin = createDatabase(url) as unknown as Kysely<unknown>
  try {
    return await work(admin)
  } finally {
    await admin.destroy()
  }
}
