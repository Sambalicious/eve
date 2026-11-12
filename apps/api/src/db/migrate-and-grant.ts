import { grantBackupAccess, grantRuntimeAccess } from "./database-roles.js"
import { createDatabase } from "./create-database.js"
import { JOB_QUEUE_SCHEMA, installJobQueueSchema } from "./job-queue-schema.js"
import type { MultiCandidateContext } from "./migrations/0016-multi-candidate.js"
import { migrateToLatest } from "./migrator.js"

/**
 * The migration step, run as the owner role: application migrations, the pg-boss
 * schema, then DML grants for the runtime role on everything that exists, and
 * read-only grants for the backup role when one is configured (fix-backup-role).
 * Returns the application migrations applied.
 */
export async function migrateAndGrant(
  ownerDatabaseUrl: string,
  runtimeRole: string,
  context: MultiCandidateContext = { operatorGoogleSub: undefined },
  options: Readonly<{ backupRole?: string | undefined }> = {}
): Promise<string[]> {
  const db = createDatabase(ownerDatabaseUrl)
  try {
    const applied = await migrateToLatest(db, context)
    await installJobQueueSchema(ownerDatabaseUrl)
    await grantRuntimeAccess(db, runtimeRole, ["public", JOB_QUEUE_SCHEMA])
    if (options.backupRole) await grantBackupAccess(db, { backup: options.backupRole, runtime: runtimeRole }, ["public", JOB_QUEUE_SCHEMA])
    return applied
  } finally {
    await db.destroy()
  }
}
