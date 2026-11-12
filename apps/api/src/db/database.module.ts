import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common"
import { type Kysely, sql } from "kysely"

import { APP_CONFIG } from "../config/config.module.js"
import type { SharedRuntimeConfig } from "../config/env.js"
import { POOL_CONNECTION_TIMEOUT_MS, createDatabase } from "./create-database.js"
import { DATABASE } from "./database-token.js"
import type { Database } from "./schema.js"
import { TenantDatabase } from "./tenant-database.js"

export { DATABASE }

import { MULTI_CANDIDATE_MARKER, SCHEMA_MARKERS } from "./migrations/schema-markers.js"

export { MULTI_CANDIDATE_MARKER }

export class MissingMigrationMarkerError extends Error {
  constructor() {
    super(`The ${MULTI_CANDIDATE_MARKER} migration marker is missing; run the migrate step before starting the api or worker`)
    this.name = "MissingMigrationMarkerError"
  }
}

export class SchemaVersionMismatchError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`The database schema is not at the version this build needs: missing ${missing.join(", ")}; run the migrate step before starting the api or worker`)
    this.name = "SchemaVersionMismatchError"
  }
}

/**
 * Architecture r2/r4 "Migration of the owner" step 8: the api and the worker
 * (both import this module) refuse to start on a database without the
 * multi-candidate marker, so no Candidate code runs on a single-tenant schema,
 * and (r4, F-CR-05) unless every later EPIC-0002 schema marker is present, so a
 * database stopped after 0016 or 0017 never runs without RLS or `candidate_posting`.
 * Runs in onModuleInit, before any bootstrap hook reads Candidate rows.
 */
export async function assertMigrationMarker(db: Kysely<Database>): Promise<void> {
  // Two statements: Postgres resolves every table name before it evaluates `and`.
  const table = await sql<{ present: boolean }>`select to_regclass('public.migration_marker') is not null as present`.execute(db)
  if (table.rows[0]?.present !== true) throw new MissingMigrationMarkerError()
  const { rows } = await sql<{ name: string }>`select name from migration_marker`.execute(db)
  const present = new Set(rows.map((row) => row.name))
  if (!present.has(MULTI_CANDIDATE_MARKER)) throw new MissingMigrationMarkerError()
  const missing = SCHEMA_MARKERS.filter((name) => !present.has(name))
  if (missing.length > 0) throw new SchemaVersionMismatchError(missing)
}

/** A connection that never reached Postgres (node socket/DNS errors), not an answer from the server (SQLSTATE). */
function isUnreachable(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : ""
  return /^E[A-Z_]+$/.test(code)
}

@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger("DatabaseLifecycle")

  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /**
   * A database that answers without the marker refuses boot. One that cannot be
   * reached keeps CR-04: the process starts and /v1/health reports 503 until it
   * returns (compose starts api and worker only after `migrate` completed).
   */
  async onModuleInit(): Promise<void> {
    try {
      await assertMigrationMarker(this.db)
    } catch (error) {
      if (!isUnreachable(error)) throw error
      this.logger.warn(`Migration marker not checked: database unreachable (${(error as { code: string }).code})`)
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy()
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [APP_CONFIG],
      useFactory: (config: SharedRuntimeConfig) => createDatabase(config.databaseUrl, { statementTimeoutMs: config.statementTimeoutMs, connectionTimeoutMs: POOL_CONNECTION_TIMEOUT_MS }),
    },
    DatabaseLifecycle,
    TenantDatabase,
  ],
  exports: [DATABASE, TenantDatabase],
})
export class DatabaseModule {}
