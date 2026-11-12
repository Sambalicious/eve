import type { Kysely } from "kysely"
import { Migrator } from "kysely/migration"

import type { MultiCandidateContext } from "./migrations/0016-multi-candidate.js"
import { migrationsFor } from "./migrations/index.js"
import type { Database } from "./schema.js"

export class MigrationFailedError extends Error {
  constructor(
    readonly migrationName: string | undefined,
    cause: unknown
  ) {
    super(`Migration ${migrationName ?? "(unknown)"} failed`, { cause })
    this.name = "MigrationFailedError"
  }
}

/**
 * Applies every pending migration in one run. Returns the names applied.
 * `context.operatorGoogleSub` binds existing data to its owner in 0016; it is
 * needed once, on the database that already holds the owner's data.
 */
export async function migrateToLatest(db: Kysely<Database>, context: MultiCandidateContext = { operatorGoogleSub: undefined }): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrationsFor(context) },
  })
  const { error, results = [] } = await migrator.migrateToLatest()
  if (error) {
    const failed = results.find((result) => result.status === "Error")
    throw new MigrationFailedError(failed?.migrationName, error)
  }
  return results.map((result) => result.migrationName)
}
