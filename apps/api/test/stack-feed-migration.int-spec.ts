import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { grantDatabaseAccess } from "../src/db/database-roles.js"
import { migrateAndGrant } from "../src/db/migrate-and-grant.js"
import { ALERT_FEED_CANDIDATE_VERIFICATION_MARKER, STACK_FEED_VERIFICATION_TABLES } from "../src/db/migrations/0024-alert-feed-candidate-verification.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { SCHEMA_MARKERS } from "../src/db/migrations/schema-markers.js"
import { CandidateScope } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { StackPostsRepository } from "../src/stack-posts/stack-posts.repository.js"
import { rolesFor, urlFor } from "./support/postgres-cluster.js"
import { LEGACY_ROW } from "./support/stack-feed-fixtures.js"

/**
 * EPIC-0008 migration 0024-alert-feed-candidate-verification (stack-feed-migration.feature
 * AC 5.1 to 5.7; stack-feed-copy-and-unchanged.feature:171; api-contract.md v1.22.0
 * "Migration"; numbered 0022 there, renumbered 0024 after EPIC-0002 A2's 0022
 * and 0023 merged first). Each case builds its own database at 0023, provisioned like
 * production (owner and runtime roles, `grantDatabaseAccess`), and runs 0024 as
 * the migration owner role, which FORCE RLS binds: so the copy's `set_config`
 * is exercised for real. Seeds and assertions use the bootstrap superuser.
 */
const OWNER_SUB = "google-sub-ada-0022"
// Through 0024 only: the apply-anyway migrations 0025 and 0026 and EPIC-0002 B1's 0027 merged later and have their own tests.
const ALL = Object.fromEntries(Object.entries(migrationsFor({ operatorGoogleSub: OWNER_SUB })).filter(([name]) => name <= "0024-alert-feed-candidate-verification"))
const THROUGH_0023 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name <= "0023-runtime-no-temporary"))
const TABLE = STACK_FEED_VERIFICATION_TABLES[0]

type Db = Kysely<unknown>
type Fresh = Readonly<{ admin: Db; owner: Db; ownerUrl: string; runtimeRole: string; runtimePassword: string; operatorId: string }>
let cluster: Db
const opened: { name: string; dbs: Db[] }[] = []

beforeAll(() => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
})

afterAll(async () => {
  for (const { name, dbs } of opened) {
    for (const db of dbs) await db.destroy()
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  }
  await cluster.destroy()
})

/** A database at 0023 (the migration before EPIC-0008), migrated by the owner role, with the Operator 0016 created. */
async function databaseAt0023(): Promise<Fresh> {
  const name = `ja_e8_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const clusterUrl = inject("postgresAdminUrl")
  const roles = rolesFor(name)
  const admin = createDatabase(urlFor(clusterUrl, undefined, name)) as unknown as Db
  await grantDatabaseAccess(admin, roles)
  const ownerUrl = urlFor(clusterUrl, roles.owner, name)
  const owner = createDatabase(ownerUrl) as unknown as Db
  opened.push({ name, dbs: [admin, owner] })
  const { error } = await new Migrator({ db: owner, provider: { getMigrations: async () => THROUGH_0023 } }).migrateToLatest()
  if (error) throw error
  const operatorId = (await sql<{ id: string }>`select id::text as id from candidate where role = 'operator'`.execute(admin)).rows[0]!.id
  return { admin, owner, ownerUrl, runtimeRole: roles.runtime.name, runtimePassword: roles.runtime.password, operatorId }
}

const migrator = (db: Db) => new Migrator({ db, provider: { getMigrations: async () => ALL } })

async function migrate0024(fresh: Fresh): Promise<void> {
  const { error, results } = await migrator(fresh.owner).migrateToLatest()
  expect(error).toBeUndefined()
  expect(results?.map((result) => result.migrationName)).toEqual(["0024-alert-feed-candidate-verification"])
}

async function seedLegacy(admin: Db): Promise<void> {
  await sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values (${LEGACY_ROW.verified_on}::date, ${LEGACY_ROW.verification_basis}, ${LEGACY_ROW.updated_at})`.execute(admin)
}

async function invitee(admin: Db, email: string, state = "active"): Promise<string> {
  return (await sql<{ id: string }>`insert into candidate (email, google_sub, role, state) values (${email}, ${`sub-${email}`}, 'candidate', ${state}) returning id::text as id`.execute(admin)).rows[0]!.id
}

type Row = { candidate_id: string; verified_on: string; verification_basis: string; updated_at: string }
const rows = async (admin: Db) =>
  (await sql<Row>`select candidate_id::text, verified_on::text, verification_basis, updated_at::text from ${sql.table(TABLE)} order by candidate_id`.execute(admin)).rows
const legacy = async (admin: Db) =>
  (await sql<{ verified_on: string; verification_basis: string; updated_at: string }>`select verified_on::text, verification_basis, updated_at::text from alert_feed_verification`.execute(admin)).rows
const tableExists = async (admin: Db, table: string) => (await sql<{ n: number }>`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = ${table}`.execute(admin)).rows[0]!.n === 1

describe("the copy into the single Operator's own record (AC 5.2, 5.3)", () => {
  it("MIG:21 the legacy row is copied byte-for-byte into the Operator's row; the table holds exactly one row", async () => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    await invitee(fresh.admin, "bola@example.com")
    await invitee(fresh.admin, "chidi@example.com")
    const before = await legacy(fresh.admin)
    await migrate0024(fresh)
    expect(await rows(fresh.admin)).toEqual([{ candidate_id: fresh.operatorId, verified_on: "2026-09-30", verification_basis: LEGACY_ROW.verification_basis, updated_at: before[0]!.updated_at }])
    // MIG:211 the legacy row is unchanged.
    expect(await legacy(fresh.admin)).toEqual(before)
  })

  it.each([
    ["bola@example.com", "active"],
    ["chidi@example.com", "revoked"],
  ])("MIG:30 %s (%s) gets no copied record", async (email, state) => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    const id = await invitee(fresh.admin, email, state)
    await migrate0024(fresh)
    expect((await rows(fresh.admin)).map((row) => row.candidate_id)).toEqual([fresh.operatorId])
    expect((await rows(fresh.admin)).find((row) => row.candidate_id === id)).toBeUndefined()
  })

  it("MIG:113 an Operator whose identity state is revoked still gets the copy (GH-3)", async () => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    await sql`update candidate set state = 'revoked' where id = ${fresh.operatorId}::uuid`.execute(fresh.admin)
    await migrate0024(fresh)
    expect((await rows(fresh.admin)).map((row) => [row.candidate_id, row.verified_on])).toEqual([[fresh.operatorId, "2026-09-30"]])
  })

  it("MIG:72, COPY:171 the migration changes no Hiring record, Hiring Alert feed, Hiring read run or Hiring post", async () => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    const bola = await invitee(fresh.admin, "bola@example.com")
    const ada = fresh.operatorId
    await sql`insert into hiring_feed_verification (candidate_id, verified_on, verification_basis, updated_at) values (${ada}::uuid, '2026-10-01', 'Hiring basis', now())`.execute(fresh.admin)
    for (const [who, n] of [
      [ada, 1],
      [ada, 2],
      [bola, 3],
    ] as const) {
      await sql`insert into hiring_alert_feed (candidate_id, id, url, created_at) values (${who}::uuid, ${randomUUID()}::uuid, ${`https://www.google.com/alerts/feeds/1/${n}`}, now())`.execute(fresh.admin)
    }
    for (let i = 0; i < 6; i++) {
      await sql`insert into hiring_post (candidate_id, id, canonical_url, kind, first_seen_at) values (${ada}::uuid, ${randomUUID()}::uuid, ${`https://www.linkedin.com/posts/h-${i}`}, 'post', now())`.execute(fresh.admin)
    }
    await sql`insert into hiring_post_run (candidate_id, id, started_at, outcome) values (${ada}::uuid, ${randomUUID()}::uuid, now(), 'completed')`.execute(fresh.admin)
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          ["hiring_feed_verification", "hiring_alert_feed", "hiring_post", "hiring_post_run"].map(async (table) => [table, (await sql`select * from ${sql.table(table)} order by 1, 2`.execute(fresh.admin)).rows])
        )
      )
    const before = await snapshot()
    await migrate0024(fresh)
    expect(await snapshot()).toEqual(before)
    expect((await sql<{ n: number }>`select count(*)::int as n from hiring_feed_verification where candidate_id = ${ada}::uuid`.execute(fresh.admin)).rows[0]!.n).toBe(1)
  })
})

describe("nothing to copy (AC 5.2, 5.7)", () => {
  it("MIG:82 with no legacy row the table is empty and the migration succeeds", async () => {
    const fresh = await databaseAt0023()
    await migrate0024(fresh)
    expect(await rows(fresh.admin)).toEqual([])
    expect((await sql<{ name: string }>`select name from migration_marker where name = ${ALERT_FEED_CANDIDATE_VERIFICATION_MARKER}`.execute(fresh.admin)).rows).toHaveLength(1)
  })

  it.each([
    ["no Candidate has role operator", async (fresh: Fresh) => void (await sql`update candidate set role = 'candidate' where id = ${fresh.operatorId}::uuid`.execute(fresh.admin))],
    [
      "two Candidates have role operator",
      async (fresh: Fresh) => {
        // candidate_one_operator (0016) forbids this in a real installation; dropped here to prove the guard holds on its own.
        await sql`drop index candidate_one_operator`.execute(fresh.admin)
        await sql`insert into candidate (email, google_sub, role) values ('bola@example.com', 'sub-bola-op', 'operator')`.execute(fresh.admin)
      },
    ],
    ["no Candidate exists", async (fresh: Fresh) => void (await sql`delete from candidate`.execute(fresh.admin))],
  ])("MIG:90 %s: nothing is copied and the migration completes", async (_name, arrange) => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    await arrange(fresh)
    await migrate0024(fresh)
    expect(await rows(fresh.admin)).toEqual([])
    expect(await legacy(fresh.admin)).toHaveLength(1)
  })

  it("MIG:201 the migration deletes no Alert feed, Stack post or read run", async () => {
    const fresh = await databaseAt0023()
    const ada = fresh.operatorId
    const bola = await invitee(fresh.admin, "bola@example.com")
    for (const [who, feeds, posts] of [
      [ada, 3, 40],
      [bola, 2, 5],
    ] as const) {
      for (let n = 0; n < feeds; n++) {
        await sql`insert into alert_feed (candidate_id, id, url, created_at) values (${who}::uuid, ${randomUUID()}::uuid, ${`https://www.google.com/alerts/feeds/2/${n}`}, now())`.execute(fresh.admin)
      }
      for (let i = 0; i < posts; i++) {
        await sql`insert into stack_post (candidate_id, id, canonical_url, kind, first_seen_at) values (${who}::uuid, ${randomUUID()}::uuid, ${`https://www.linkedin.com/posts/s-${who}-${i}`}, 'post', now())`.execute(fresh.admin)
      }
      await sql`insert into stack_post_run (candidate_id, id, started_at, finished_at, outcome) values (${who}::uuid, ${randomUUID()}::uuid, now(), now(), 'skipped_unverified')`.execute(fresh.admin)
    }
    const snapshot = async () =>
      Object.fromEntries(await Promise.all(["alert_feed", "stack_post", "stack_post_run"].map(async (table) => [table, (await sql`select * from ${sql.table(table)} order by 1, 2`.execute(fresh.admin)).rows])))
    const before = await snapshot()
    await migrate0024(fresh)
    expect(await snapshot()).toEqual(before)
    expect((before.alert_feed as unknown[]).length).toBe(5)
    expect((before.stack_post as unknown[]).length).toBe(45)
  })
})

describe("down migration (AC 5.6, development only)", () => {
  it("MIG:244 down drops the new table and the marker and leaves the legacy row as it was", async () => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    const bola = await invitee(fresh.admin, "bola@example.com")
    await migrate0024(fresh)
    await sql`insert into ${sql.table(TABLE)} (candidate_id, verified_on, verification_basis, updated_at) values (${bola}::uuid, '2026-10-21', 'Bola', now())`.execute(fresh.admin)
    const before = await legacy(fresh.admin)
    const down = await migrator(fresh.owner).migrateDown()
    expect(down.error).toBeUndefined()
    expect(down.results?.map((result) => result.migrationName)).toEqual(["0024-alert-feed-candidate-verification"])
    expect(await tableExists(fresh.admin, TABLE)).toBe(false)
    expect(await tableExists(fresh.admin, "alert_feed_verification")).toBe(true)
    expect(await legacy(fresh.admin)).toEqual(before)
    expect((await sql`select name from migration_marker where name = ${ALERT_FEED_CANDIDATE_VERIFICATION_MARKER}`.execute(fresh.admin)).rows).toEqual([])
  })

  it("MIG:252 up, down, up leaves the same copied record", async () => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    await migrate0024(fresh)
    const first = await rows(fresh.admin)
    expect((await migrator(fresh.owner).migrateDown()).error).toBeUndefined()
    await migrate0024(fresh)
    expect(await rows(fresh.admin)).toEqual(first)
    expect(first.map((row) => row.candidate_id)).toEqual([fresh.operatorId])
  })
})

describe("the normal deploy (AC 5.7)", () => {
  it("MIG:301 migrate-and-grant applies 0024 with no manual step, copies the Operator's record and grants the runtime role", async () => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    const applied = await migrateAndGrant(fresh.ownerUrl, fresh.runtimeRole, { operatorGoogleSub: OWNER_SUB })
    expect(applied).toEqual(["0024-alert-feed-candidate-verification", "0025-apply-anyway", "0026-apply-anyway-bounds", "0027-preferences-version", "0028-ats-skills", "0029-ats-fit", "0030-ats-minimum", "0031-pasted-description", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0036-retry-failed-checks", "0037-retry-backfill", "0038-lead-pipeline", "0039-blocked-claim-cause", "0040-outreach-messages", "0041-lead-policy-binding"])
    expect((await rows(fresh.admin)).map((row) => row.candidate_id)).toEqual([fresh.operatorId])
    const grants = await sql<{ privilege_type: string }>`
      select privilege_type from information_schema.role_table_grants where table_name = ${TABLE} and grantee = ${fresh.runtimeRole} order by privilege_type`.execute(fresh.admin)
    expect(grants.rows.map((row) => row.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"])
    // AR-5: the legacy table keeps its runtime grant for rollback path A.
    const legacyGrants = await sql<{ n: number }>`select count(*)::int as n from information_schema.role_table_grants where table_name = 'alert_feed_verification' and grantee = ${fresh.runtimeRole}`.execute(fresh.admin)
    expect(legacyGrants.rows[0]!.n).toBe(4)
    // MIG:43 (API half): the runtime role, in the Operator's scope, reads her original date and basis as her own record.
    const runtimeDb = createDatabase(fresh.ownerUrl.replace(/\/\/[^@]+@/, `//${fresh.runtimeRole}:${fresh.runtimePassword}@`))
    try {
      const read = await CandidateScope.run(fresh.operatorId, () => new StackPostsRepository(new TenantDatabase(runtimeDb)).verification())
      expect(read).toMatchObject({ verifiedOn: "2026-09-30", verificationBasis: LEGACY_ROW.verification_basis })
    } finally {
      await runtimeDb.destroy()
    }
  })

  it("MIG:309 running migrations again changes nothing: the Operator's later update stays and no one else gets a row", async () => {
    const fresh = await databaseAt0023()
    await seedLegacy(fresh.admin)
    await invitee(fresh.admin, "bola@example.com")
    await migrateAndGrant(fresh.ownerUrl, fresh.runtimeRole, { operatorGoogleSub: OWNER_SUB })
    await sql`update ${sql.table(TABLE)} set verified_on = '2026-10-28' where candidate_id = ${fresh.operatorId}::uuid`.execute(fresh.admin)
    expect(await migrateAndGrant(fresh.ownerUrl, fresh.runtimeRole, { operatorGoogleSub: OWNER_SUB })).toEqual([])
    expect((await rows(fresh.admin)).map((row) => [row.candidate_id, row.verified_on])).toEqual([[fresh.operatorId, "2026-10-28"]])
  })

  it("the 0024 marker is one the api and worker require at start-up", () => {
    expect(ALERT_FEED_CANDIDATE_VERIFICATION_MARKER).toBe("0024-alert-feed-candidate-verification")
    expect(SCHEMA_MARKERS).toContain(ALERT_FEED_CANDIDATE_VERIFICATION_MARKER)
  })
})

describe("the table (AC 5.1, 6.1)", () => {
  it("MIG:291 forced RLS with exactly one policy whose condition equals stack_post's and hiring_feed_verification's", async () => {
    const fresh = await databaseAt0023()
    await migrate0024(fresh)
    const security = await sql<{ enabled: boolean; forced: boolean }>`select relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where relname = ${TABLE}`.execute(fresh.admin)
    expect(security.rows).toEqual([{ enabled: true, forced: true }])
    const policies = await sql<{ table: string; name: string; cmd: string; using: string; check: string }>`
      select c.relname as table, p.polname as name, p.polcmd::text as cmd, pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
      from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname in (${TABLE}, 'stack_post', 'hiring_feed_verification') order by c.relname`.execute(fresh.admin)
    const mine = policies.rows.filter((row) => row.table === TABLE)
    expect(mine.map((row) => [row.name, row.cmd])).toEqual([[`${TABLE}_candidate`, "*"]])
    for (const other of policies.rows.filter((row) => row.table !== TABLE)) {
      expect(mine[0]!.using).toBe(other.using)
      expect(mine[0]!.check).toBe(other.check)
    }
  })

  it("has the hiring_feed_verification columns, types and checks; candidate_id is the primary key with cascade", async () => {
    const fresh = await databaseAt0023()
    await migrate0024(fresh)
    const columns = async (table: string) =>
      (await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>`
        select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = ${table} order by ordinal_position`.execute(fresh.admin)).rows
    expect(await columns(TABLE)).toEqual(await columns("hiring_feed_verification"))
    const constraints = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = ${TABLE}::regclass order by contype, conname`.execute(fresh.admin)
    expect(constraints.rows.map((row) => row.def).sort()).toEqual(
      ["CHECK (((char_length(verification_basis) >= 1) AND (char_length(verification_basis) <= 500)))", "FOREIGN KEY (candidate_id) REFERENCES candidate(id) ON DELETE CASCADE", "PRIMARY KEY (candidate_id)"].sort()
    )
  })
})
