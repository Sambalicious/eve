import { type Transaction, sql } from "kysely"

import type { Database } from "./schema.js"

/**
 * A transaction's lock wait bound and the statement bound in force around it.
 *
 * QA-G5-2: the pool sets a per-process `statement_timeout` (api 5 s, worker 60 s;
 * SEC-803 in create-database.ts). A `lock_timeout` equal to or longer than the
 * statement_timeout in force never fires: Postgres cancels the waiting statement
 * first with query_canceled (57014), and a caller that retries or maps
 * lock_not_available (55P03) sees an unknown error instead. So every transaction
 * that waits on a row lock sets both, locally, with the lock bound strictly
 * shorter. The local statement_timeout still bounds a stuck transaction, which
 * is what SEC-803 asks of every pooled connection.
 */
export type TransactionTimeouts = Readonly<{ lockTimeoutMs: number; statementTimeoutMs: number }>

export function transactionTimeouts(lockTimeoutMs: number, statementTimeoutMs: number): TransactionTimeouts {
  for (const value of [lockTimeoutMs, statementTimeoutMs]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`lock_timeout and statement_timeout must be positive whole milliseconds, got ${value}`)
  }
  if (lockTimeoutMs >= statementTimeoutMs) {
    throw new Error(`lock_timeout (${lockTimeoutMs} ms) must be shorter than statement_timeout (${statementTimeoutMs} ms)`)
  }
  return Object.freeze({ lockTimeoutMs, statementTimeoutMs })
}

/** `set local` both bounds; they end with the transaction. Call first, before any locking statement. */
export async function applyTransactionTimeouts(trx: Transaction<Database>, timeouts: TransactionTimeouts): Promise<void> {
  await sql`set local statement_timeout = ${sql.lit(timeouts.statementTimeoutMs)}`.execute(trx)
  await sql`set local lock_timeout = ${sql.lit(timeouts.lockTimeoutMs)}`.execute(trx)
}

/** Postgres `lock_not_available` (55P03): a `lock_timeout` expired. */
export function isLockTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "55P03"
}
