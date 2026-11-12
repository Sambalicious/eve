import { Logger } from "@nestjs/common"
import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"

import type { Database } from "./schema.js"
import { extendedProtocolForScopes } from "./scoped-checkout.js"

const logger = new Logger("DatabasePool")

/**
 * Slice 8d (8d.9, 8d.10, D8d-4, SEC-803): `statement_timeout` is a per-process
 * connection setting, sent in each connection's startup packet, not a role
 * setting and not a migration. The api and the worker share one runtime role
 * but need different bounds:
 * - api 5 s: the slowest measured list query is about 50 ms at 60,000 postings;
 *   5 s still bounds a stuck request.
 * - worker 60 s: discovery stores, evaluation and submission run single-row or
 *   small statements well under a second at the Candidate's volume. The one
 *   statement that legitimately waits longer, the browser lease wait in
 *   BrowserMutex, lifts the timeout for that wait only.
 * - migrate (owner) and role provisioning (admin): none, so a long migration or
 *   backfill is never cut off. They call `createDatabase` without options.
 * pg-boss's own pools keep pg-boss's defaults.
 */
export { API_STATEMENT_TIMEOUT_MS, WORKER_STATEMENT_TIMEOUT_MS } from "./statement-timeouts.js"

export type DatabaseOptions = Readonly<{
  /** Milliseconds; omitted means Postgres's default (0, no timeout). */
  statementTimeoutMs?: number
  /** SEC-601: milliseconds a query waits for a free pooled connection before it fails; omitted means pg's default (wait forever). */
  connectionTimeoutMs?: number
}>

/** SEC-601: the api and worker pool wait. A starved pool fails the waiting query instead of hanging the process. */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000

/**
 * A Kysely instance over a pg pool. The server can end any pooled connection at
 * any time (restart, failover, admin terminate: FATAL 57P01), and pg reports it
 * as an `error` event. An EventEmitter `error` with no listener is thrown as an
 * uncaught exception, which would crash the api or worker. Two listeners cover it:
 * - on the pool, for idle clients (pg-pool forwards their errors and discards them);
 * - on every client when it connects (QA-O8), for a client checked out by a query or
 *   transaction, which pg-pool does not listen to. The query in flight rejects with
 *   the same error, so the caller still sees the failure; the pool drops the broken
 *   client on release.
 * Both log the code only, never the message.
 */
export function createDatabase(connectionString: string, options: DatabaseOptions = {}): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ...(options.statementTimeoutMs === undefined ? {} : { statement_timeout: options.statementTimeoutMs }),
    ...(options.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMillis: options.connectionTimeoutMs }),
  })
  pool.on("error", (error: Error & { code?: string }) => {
    logger.warn(`Idle database connection closed: ${error.code ?? error.name}`)
  })
  pool.on("connect", (client) => {
    client.on("error", (error: Error & { code?: string }) => {
      logger.warn(`Database connection closed while in use: ${error.code ?? error.name}`)
    })
  })
  // Run a2c: a TenantDatabase scope's connection sends every statement through the extended protocol (scoped-checkout.ts).
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: extendedProtocolForScopes(pool) }) })
}
