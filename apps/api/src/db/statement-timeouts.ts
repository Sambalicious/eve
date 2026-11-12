/**
 * Slice 8d (8d.9): the per-process `statement_timeout` values (see
 * create-database.ts). Plain numbers in their own module, so config code reads
 * them without importing the raw database factory (EPIC-0002 A1 lint rule).
 */
export const API_STATEMENT_TIMEOUT_MS = 5_000
export const WORKER_STATEMENT_TIMEOUT_MS = 60_000
