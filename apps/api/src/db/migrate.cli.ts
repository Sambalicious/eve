import { migrateAndGrant } from "./migrate-and-grant.js"

/**
 * DATABASE_URL is the migration owner role; RUNTIME_DATABASE_ROLE receives DML grants (SEC-001).
 * CANDIDATE_GOOGLE_SUB is read here only, once: migration 0016 binds the existing data to that owner.
 * DB_BACKUP_ROLE (optional, created by provision-roles) receives SELECT on everything (fix-backup-role).
 */
const databaseUrl = process.env.DATABASE_URL
const runtimeRole = process.env.RUNTIME_DATABASE_ROLE
if (!databaseUrl || !runtimeRole) {
  process.stderr.write("DATABASE_URL and RUNTIME_DATABASE_ROLE are required\n")
  process.exit(1)
}

try {
  const applied = await migrateAndGrant(databaseUrl, runtimeRole, { operatorGoogleSub: process.env.CANDIDATE_GOOGLE_SUB }, { backupRole: process.env.DB_BACKUP_ROLE || undefined })
  process.stdout.write(
    applied.length > 0 ? `Applied migrations: ${applied.join(", ")}\n` : "No pending migrations\n"
  )
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Migration failed"}\n`)
  process.exitCode = 1
}
