import { PgBoss } from "pg-boss"

/**
 * Installs or upgrades the pg-boss schema as the migration owner. The worker then
 * starts pg-boss with `migrate: false`, so the runtime role never needs DDL.
 */
export async function installJobQueueSchema(ownerDatabaseUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: ownerDatabaseUrl, supervise: false, schedule: false })
  const errors: Error[] = []
  boss.on("error", (error: Error) => errors.push(error))
  await boss.start()
  await boss.stop({ graceful: true, close: true })
  if (errors.length > 0) throw errors[0]
}

export const JOB_QUEUE_SCHEMA = "pgboss"
