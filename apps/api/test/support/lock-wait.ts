import { type Kysely, sql } from "kysely"

import type { Database } from "../../src/db/schema.js"

/**
 * What a waiting backend waits on: "row" for a row lock (FOR UPDATE / FOR SHARE
 * conflicts wait on the holder's transaction id or on the tuple), "advisory" for
 * pg_advisory_lock / pg_advisory_xact_lock.
 */
export type LockWaitKind = "row" | "advisory"

const LOCKTYPES: Record<LockWaitKind, readonly string[]> = { row: ["transactionid", "tuple"], advisory: ["advisory"] }

/** The backend pid of `executor` (a transaction or a pinned connection): pass the holder's to `untilLockWait`. */
export async function backendPid(executor: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(executor)
  const pid = rows[0]?.pid
  if (pid === undefined) throw new Error("pg_backend_pid() returned no row")
  return pid
}

/**
 * Resolves once a backend waits on a lock of `kind` that the backend `holderPid`
 * blocks; throws when none does within `timeoutMs`. Replaces "sleep, then assert
 * the request is still pending": a fixed sleep passes when the request has not yet
 * reached the lock, so it cannot tell waiting apart from slow. Requiring
 * `pg_blocking_pids(waiter) @> [holderPid]` ties the wait to the lock the test
 * holds, so a stray waiter (an earlier test's leftover, another file's backend on
 * the shared cluster, a second request) does not satisfy it. `pg_locks` and
 * `pg_blocking_pids` are readable by every role.
 */
export async function untilLockWait(db: Kysely<Database>, what: string, kind: LockWaitKind, holderPid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n
      from pg_locks l
      where not l.granted and l.locktype in (${sql.join(LOCKTYPES[kind])})
        and pg_blocking_pids(l.pid) @> array[${holderPid}::int]`.execute(db)
    if ((rows[0]?.n ?? 0) > 0) return
    if (Date.now() > deadline) throw new Error(`${what} never waited on a lock (${kind}) held by pid ${holderPid} within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
