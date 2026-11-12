import { createDatabase } from "./create-database.js"
import { ensureBackupRole, provisionDatabaseRoles } from "./database-roles.js"

/**
 * One-time bootstrap, run with the superuser the Postgres image creates (SEC-001).
 * Creates the owner and runtime roles. Values come from the environment only.
 * fix-backup-role: also the read-only backup role (BYPASSRLS needs a superuser)
 * when DB_BACKUP_ROLE is set. Without DB_BACKUP_PASSWORD it is NOLOGIN.
 */
const required = [
  "ADMIN_DATABASE_URL",
  "POSTGRES_DB",
  "DB_OWNER_ROLE",
  "DB_OWNER_PASSWORD",
  "DB_RUNTIME_ROLE",
  "DB_RUNTIME_PASSWORD",
] as const
const missing = required.filter((key) => !process.env[key])
if (missing.length > 0) {
  process.stderr.write(`Missing environment variables: ${missing.join(", ")}\n`)
  process.exit(1)
}
const env = process.env as Record<(typeof required)[number], string>

const admin = createDatabase(env.ADMIN_DATABASE_URL)
try {
  await provisionDatabaseRoles(admin, {
    database: env.POSTGRES_DB,
    owner: { name: env.DB_OWNER_ROLE, password: env.DB_OWNER_PASSWORD },
    runtime: { name: env.DB_RUNTIME_ROLE, password: env.DB_RUNTIME_PASSWORD },
  })
  const backupRole = process.env.DB_BACKUP_ROLE
  if (backupRole) {
    // SEC-FBR-01: refuses the owner, runtime or bootstrap role, or any privileged existing role, before changing anything.
    await ensureBackupRole(admin, { name: backupRole, password: process.env.DB_BACKUP_PASSWORD }, { owner: env.DB_OWNER_ROLE, runtime: env.DB_RUNTIME_ROLE })
    if (!process.env.DB_BACKUP_PASSWORD) process.stderr.write(`Backup role ${backupRole} has no password: it cannot log in until DB_BACKUP_PASSWORD is set and provision-roles runs again\n`)
  } else {
    process.stderr.write("DB_BACKUP_ROLE is not set: no backup role, so scripts/backup/backup.sh cannot dump the database (docs/ops/backups.md)\n")
  }
  process.stdout.write("Database roles provisioned\n")
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Provisioning failed"}\n`)
  process.exitCode = 1
} finally {
  await admin.destroy()
}
