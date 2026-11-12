import { createDatabase } from "./create-database.js"
import { rebindOperatorSub } from "./operator-rebind.js"

/**
 * `pnpm --filter @eve/api operator:rebind-sub <google-sub>`, on the host, with
 * DATABASE_URL set to the migration owner role. Prints the Operator ID and the
 * number of sessions ended; never prints the sub or the connection string.
 */
const databaseUrl = process.env.DATABASE_URL
const sub = process.argv[2]
if (!databaseUrl || sub === undefined) {
  process.stderr.write("Usage: DATABASE_URL=<owner role url> operator:rebind-sub <google-sub>\n")
  process.exit(1)
}

const db = createDatabase(databaseUrl)
try {
  const result = await rebindOperatorSub(db, sub)
  process.stdout.write(`Operator ${result.operatorId} rebound; ${result.sessionsEnded} session(s) ended\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Rebind failed"}\n`)
  process.exitCode = 1
} finally {
  await db.destroy()
}
