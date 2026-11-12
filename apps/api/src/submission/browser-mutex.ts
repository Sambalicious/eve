import { Inject, Injectable } from "@nestjs/common"
import { type Kysely } from "kysely"
import { sql } from "../db/sql.js"

import { DATABASE } from "../db/database.module.js"
import type { Database } from "../db/schema.js"

/** Postgres advisory lock key for the one browser session at a time (SEC-503) and the worker's browser lease (SEC-508). */
export const BROWSER_MUTEX_KEY = 72_005_001

/**
 * One browser session at a time across every queue and process (SEC-503). A
 * session-level advisory lock is held on a dedicated pooled connection from
 * before the session opens until after it closes, so `submission.daily` and
 * `submission.sample` never overlap and the single egress allowlist file
 * belongs to the one active attempt. A held lock is also the live-attempt
 * lease crash recovery checks (SEC-508): Postgres frees it when the holder's
 * connection or process dies.
 */
@Injectable()
export class BrowserMutex {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Waits for the lock, runs `work`, and always releases it. */
  withLock<T>(work: () => Promise<T>): Promise<T> {
    return this.db.connection().execute(async (connection) => {
      // Slice 8d (D8d-4): waiting for another browser session can take minutes, longer than the worker's
      // statement_timeout. Lift it for this wait only; RESET restores the connection's startup value.
      await sql`set statement_timeout = 0`.execute(connection)
      try {
        await sql`select pg_advisory_lock(${BROWSER_MUTEX_KEY})`.execute(connection)
      } catch (error) {
        // SEC-8D-07 (8e.10): the lock error is the cause; a failed RESET still ends the session (CR8D-06)
        // but must not hide it.
        await restoreTimeoutOrEndSession(connection).catch(() => undefined)
        throw error
      }
      await restoreTimeoutOrEndSession(connection)
      try {
        return await work()
      } finally {
        await sql`select pg_advisory_unlock(${BROWSER_MUTEX_KEY})`.execute(connection)
      }
    })
  }

  /** Runs `work` only when no browser session holds the lock; otherwise returns "lease_held" without waiting. */
  ifFree<T>(work: () => Promise<T>): Promise<T | "lease_held"> {
    return this.db.connection().execute(async (connection) => {
      const { rows } = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${BROWSER_MUTEX_KEY}) as locked`.execute(connection)
      if (!rows[0]?.locked) return "lease_held" as const
      try {
        return await work()
      } finally {
        await sql`select pg_advisory_unlock(${BROWSER_MUTEX_KEY})`.execute(connection)
      }
    })
  }
}

/**
 * CR8D-06: restores the connection's startup `statement_timeout` after the
 * lease wait. If the RESET fails, the connection must not go back to the pool
 * holding the session lock with no timeout: the session is ended, which frees
 * the advisory lock, and pg-pool drops the dead client. The RESET error still
 * reaches the caller, so the attempt fails instead of running unbounded; after
 * a failed lock wait the caller sees the lock error instead (SEC-8D-07, 8e.10).
 */
async function restoreTimeoutOrEndSession(connection: Kysely<Database>): Promise<void> {
  try {
    await sql`reset statement_timeout`.execute(connection)
  } catch (error) {
    await sql`select pg_terminate_backend(pg_backend_pid())`.execute(connection).catch(() => undefined)
    throw error
  }
}
