import { randomUUID } from "node:crypto"

import { Test } from "@nestjs/testing"
import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { ConfigModule } from "../src/config/config.module.js"
import { API_STATEMENT_TIMEOUT_MS, createDatabase } from "../src/db/create-database.js"
import { DatabaseModule } from "../src/db/database.module.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"

/**
 * EPIC-0002 A1 unit 4 (architecture r2 "Migration of the owner" step 8): the
 * api and the worker refuse to start unless `migration_marker('multi_candidate')`
 * exists. Both processes import DatabaseModule, so the check lives there.
 */
const opened: { name: string; db: Kysely<unknown> }[] = []
let cluster: Kysely<unknown>
let migrated: TestDatabase

beforeAll(async () => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
  migrated = await startMigratedDatabase()
})

afterAll(async () => {
  for (const { name, db } of opened) {
    await db.destroy()
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  }
  await migrated?.stop()
  await cluster?.destroy()
})

async function databaseBefore0016(): Promise<string> {
  const name = `ja_boot_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  const db = createDatabase(url.toString()) as unknown as Kysely<unknown>
  opened.push({ name, db })
  const before = Object.fromEntries(Object.entries(migrationsFor({ operatorGoogleSub: undefined })).filter(([n]) => n < "0016"))
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => before } }).migrateToLatest()
  if (error) throw error
  return url.toString()
}

/** A database migrated up to (not including) `stopBefore`: a run that stopped partway through 0016 to 0019. */
async function databaseStoppedBefore(stopBefore: string): Promise<string> {
  const name = `ja_boot_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  const db = createDatabase(url.toString()) as unknown as Kysely<unknown>
  opened.push({ name, db })
  const before = Object.fromEntries(Object.entries(migrationsFor({ operatorGoogleSub: undefined })).filter(([n]) => n < stopBefore))
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => before } }).migrateToLatest()
  if (error) throw error
  return url.toString()
}

async function boot(databaseUrl: string) {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ databaseUrl, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), statementTimeoutMs: API_STATEMENT_TIMEOUT_MS }), DatabaseModule],
  }).compile()
  try {
    await moduleRef.init()
  } finally {
    await moduleRef.close()
  }
}

describe("boot refusal without the multi-candidate marker", () => {
  it("starts on a migrated database (runtime role)", async () => {
    await expect(boot(migrated.url)).resolves.toBeUndefined()
  })

  it("refuses a database that has not run 0016 and names the step to run", async () => {
    const url = await databaseBefore0016()
    await expect(boot(url)).rejects.toThrow(/multi_candidate migration marker is missing; run the migrate step/)
  })

  it("keeps CR-04: an unreachable database does not block boot (health reports 503 instead)", async () => {
    await expect(boot("postgres://nobody:nothing@127.0.0.1:1/none")).resolves.toBeUndefined()
  })

  it("refuses when the marker row is gone", async () => {
    await migrated.db.deleteFrom("migration_marker").where("name", "=", "multi_candidate").execute()
    try {
      await expect(boot(migrated.url)).rejects.toThrow(/multi_candidate migration marker is missing/)
    } finally {
      await migrated.db.insertInto("migration_marker").values({ name: "multi_candidate" }).execute()
    }
  })
})

describe("boot refusal on a database stopped partway through 0016 to 0019 (architecture r4 step 8, F-CR-05)", () => {
  it.each(["0017-row-level-security", "0018-owner-preferences", "0019-candidate-posting", "0020-role-relevance", "0021-hiring-posts", "0022-candidate-binding", "0023-runtime-no-temporary", "0024-alert-feed-candidate-verification", "0025-apply-anyway", "0026-apply-anyway-bounds", "0027-preferences-version", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0038-lead-pipeline", "0038-lead-pipeline", "0038-lead-pipeline"])("refuses a database that has the marker but not %s, and names it", async (missing) => {
    const url = await databaseStoppedBefore(missing)
    await expect(boot(url)).rejects.toThrow(new RegExp(`schema is not at the version this build needs: missing ${missing}.*run the migrate step`))
  })

  it("refuses when the last migration's schema marker is gone", async () => {
    await migrated.db.deleteFrom("migration_marker").where("name", "=", "0038-lead-pipeline").execute()
    try {
      await expect(boot(migrated.url)).rejects.toThrow(/missing 0038-lead-pipeline/)
    } finally {
      await migrated.db.insertInto("migration_marker").values({ name: "0038-lead-pipeline" }).execute()
    }
  })
})
