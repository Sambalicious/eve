import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { sql } from "kysely"

import { createDatabase } from "../../src/db/create-database.js"
import { type DatabaseRoles, provisionDatabaseRoles } from "../../src/db/database-roles.js"
import { migrateAndGrant } from "../../src/db/migrate-and-grant.js"

export const POSTGRES_IMAGE = "postgres:17-alpine"

/**
 * F-QA-13: about 13 test files run at once, each with pools of up to 10
 * connections (create-database.ts), which passed the image default of 100.
 * Test cluster only; the product pool size is unchanged.
 */
const TEST_POSTGRES_MAX_CONNECTIONS = 300

/** Migrated once per run; every test file's database is a copy of it. */
export const TEMPLATE_DATABASE = "ja_template"

const ROLE_PASSWORDS = {
  owner: { name: "ja_owner", password: "owner-password-for-tests" },
  runtime: { name: "ja_runtime", password: "runtime-password-for-tests" },
} as const

/**
 * Google `sub` of the test owner, bound to the Operator row by migration 0016 in
 * the template (as `CANDIDATE_GOOGLE_SUB` binds it once in production).
 */
export const TEMPLATE_OPERATOR_SUB = "100000000000000000001"

export function rolesFor(database: string): DatabaseRoles {
  return { database, ...ROLE_PASSWORDS }
}

export function urlFor(baseUrl: string, role: { name: string; password: string } | undefined, database?: string): string {
  const url = new URL(baseUrl)
  if (role) {
    url.username = role.name
    url.password = role.password
  }
  if (database) url.pathname = `/${database}`
  return url.toString()
}

/**
 * Starts the one Postgres container a test run uses, creates the roles once,
 * and builds the migrated template the way production is provisioned
 * (roles, migrations and pg-boss schema as the owner, runtime grants).
 */
export async function startCluster(): Promise<{ container: StartedPostgreSqlContainer; adminUrl: string }> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("postgres")
    .withCommand(["postgres", "-c", `max_connections=${TEST_POSTGRES_MAX_CONNECTIONS}`])
    .start()
  const adminUrl = container.getConnectionUri()
  const admin = createDatabase(adminUrl)
  try {
    await sql`create database ${sql.id(TEMPLATE_DATABASE)}`.execute(admin)
  } finally {
    await admin.destroy()
  }
  const templateAdmin = createDatabase(urlFor(adminUrl, undefined, TEMPLATE_DATABASE))
  try {
    await provisionDatabaseRoles(templateAdmin, rolesFor(TEMPLATE_DATABASE))
  } finally {
    await templateAdmin.destroy()
  }
  const roles = rolesFor(TEMPLATE_DATABASE)
  await migrateAndGrant(urlFor(adminUrl, roles.owner, TEMPLATE_DATABASE), roles.runtime.name, { operatorGoogleSub: TEMPLATE_OPERATOR_SUB })
  return { container, adminUrl }
}
