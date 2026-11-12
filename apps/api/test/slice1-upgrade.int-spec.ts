import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { inject } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { type DatabaseRoles, provisionDatabaseRoles } from "../src/db/database-roles.js"
import { migrateAndGrant } from "../src/db/migrate-and-grant.js"
import * as dashboardAuth from "../src/db/migrations/0001-dashboard-auth.js"
import { urlFor } from "./support/postgres.js"

/**
 * CR2-09: a slice 1 installation ran migrations as the image's superuser, so its
 * tables and kysely_migration belong to that superuser. Upgrading must not need a
 * fresh volume: provision-roles hands everything in the database to the owner role,
 * then migrations and grants run as the owner as usual.
 */
const RUN = Date.now().toString(36)
const DATABASE = `ja_slice1_${RUN}`
const BOOTSTRAP = { name: `ja_slice1_bootstrap_${RUN}`, password: "bootstrap-password-for-tests" }
/**
 * Roles are cluster-wide and every integration file shares the cluster. This test
 * creates and alters roles, so it uses its own names: re-provisioning the shared
 * ja_owner/ja_runtime while another file does the same fails with "tuple
 * concurrently updated" (seen under the full suite).
 */
const ROLES: DatabaseRoles = {
  database: DATABASE,
  owner: { name: `ja_slice1_owner_${RUN}`, password: "owner-password-for-tests" },
  runtime: { name: `ja_slice1_runtime_${RUN}`, password: "runtime-password-for-tests" },
}

let clusterUrl: string
let admin: Kysely<unknown>

beforeAll(async () => {
  clusterUrl = inject("postgresAdminUrl")
  admin = createDatabase(clusterUrl) as unknown as Kysely<unknown>
  // The slice 1 compose file's POSTGRES_USER: a superuser that owns the database.
  await sql`create role ${sql.id(BOOTSTRAP.name)} with login superuser password ${sql.lit(BOOTSTRAP.password)}`.execute(admin)
  await sql`create database ${sql.id(DATABASE)} owner ${sql.id(BOOTSTRAP.name)}`.execute(admin)
  const slice1 = createDatabase(urlFor(clusterUrl, BOOTSTRAP, DATABASE))
  try {
    const migrator = new Migrator({ db: slice1, provider: { getMigrations: async () => ({ "0001-dashboard-auth": dashboardAuth }) } })
    const { error } = await migrator.migrateToLatest()
    if (error) throw error
    await sql`insert into dashboard_session (id_hash, csrf_token, google_sub, last_active_at) values ('slice1-session', 'c', 's', now())`.execute(slice1)
  } finally {
    await slice1.destroy()
  }
})

afterAll(async () => {
  await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${DATABASE} and pid <> pg_backend_pid()`.execute(admin)
  await sql`drop database if exists ${sql.id(DATABASE)}`.execute(admin)
  for (const role of [ROLES.runtime.name, ROLES.owner.name, BOOTSTRAP.name]) {
    // Default privileges and grants the roles hold elsewhere in the cluster go first.
    await sql`drop owned by ${sql.id(role)}`.execute(admin).catch(() => undefined)
    await sql`drop role if exists ${sql.id(role)}`.execute(admin)
  }
  await admin.destroy()
})

describe("upgrading a slice 1 database volume (CR2-09)", () => {
  it("provision-roles then migrate succeed as the owner role, keep slice 1 data, and leave the runtime role able to use it", async () => {
    const bootstrapAdmin = createDatabase(urlFor(clusterUrl, BOOTSTRAP, DATABASE))
    try {
      await provisionDatabaseRoles(bootstrapAdmin, ROLES)
    } finally {
      await bootstrapAdmin.destroy()
    }

    // The slice 1 session belongs to the bound Google account "s" (CANDIDATE_GOOGLE_SUB at migration).
    const applied = await migrateAndGrant(urlFor(clusterUrl, ROLES.owner, DATABASE), ROLES.runtime.name, { operatorGoogleSub: "s" })
    expect(applied).toEqual(["0002-career-profile", "0003-salary-amount-max", "0004-discovery", "0005-applications-documents", "0006-submission", "0007-submission-review", "0008-submission-repair", "0009-notification-sender", "0010-cost-ceiling", "0011-postings-paging-filter", "0012-job-criteria", "0013-stack-posts", "0014-access-request", "0015-retention", "0016-multi-candidate", "0017-row-level-security", "0018-owner-preferences", "0019-candidate-posting", "0020-role-relevance", "0021-hiring-posts", "0022-candidate-binding", "0023-runtime-no-temporary", "0024-alert-feed-candidate-verification", "0025-apply-anyway", "0026-apply-anyway-bounds", "0027-preferences-version", "0028-ats-skills", "0029-ats-fit", "0030-ats-minimum", "0031-pasted-description", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0036-retry-failed-checks", "0037-retry-backfill", "0038-lead-pipeline", "0039-blocked-claim-cause", "0040-outreach-messages", "0041-lead-policy-binding"])

    const runtime = createDatabase(urlFor(clusterUrl, ROLES.runtime, DATABASE))
    try {
      const { rows } = await sql<{ id_hash: string }>`select id_hash from dashboard_session`.execute(runtime)
      expect(rows.map((row) => row.id_hash)).toEqual(["slice1-session"])
      // Under RLS (0016) a Candidate write needs that Candidate's scope (setting and 0022 binding), as TenantDatabase.forCandidate sets it.
      await runtime.transaction().execute(async (trx) => {
        await sql`select set_config('eve.candidate_id', (select id::text from candidate where role = 'operator'), true), public.bind_candidate((select id from candidate where role = 'operator'))`.execute(trx)
        await sql`insert into career_profile_version (candidate_id, version, status, source, sections, created_at)
          values ((select id from candidate where role = 'operator'), 1, 'draft', 'edit', '[]', now())`.execute(trx)
      })
      await expect(sql`select * from kysely_migration`.execute(runtime)).rejects.toThrow(/permission denied/)
    } finally {
      await runtime.destroy()
    }

    const inspector = createDatabase(urlFor(clusterUrl, BOOTSTRAP, DATABASE))
    try {
      const owners = await sql<{ owner: string }>`
        select distinct tableowner as owner from pg_tables where schemaname in ('public', 'pgboss')`.execute(inspector)
      expect(owners.rows.map((row) => row.owner)).toEqual([ROLES.owner.name])
    } finally {
      await inspector.destroy()
    }
  })

  it("running provision-roles and migrate again changes nothing", async () => {
    const bootstrapAdmin = createDatabase(urlFor(clusterUrl, BOOTSTRAP, DATABASE))
    try {
      await provisionDatabaseRoles(bootstrapAdmin, ROLES)
    } finally {
      await bootstrapAdmin.destroy()
    }
    expect(await migrateAndGrant(urlFor(clusterUrl, ROLES.owner, DATABASE), ROLES.runtime.name)).toEqual([])
  })
})
