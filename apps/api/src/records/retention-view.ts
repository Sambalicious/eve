import type { ApplicationsRetentionFilter } from "@eve/contracts"
import { sql } from "../db/sql.js"

import type { CandidateTx } from "../db/tenant-database.js"
import { PENDING_DECISION, PENDING_SAMPLE, isBusy } from "./details-deletion.js"
import { addDays, effectiveExpiry, graceEndFrom, watDate, type LocalDate } from "./expiry-date.js"

/** E5.2: the due window is today to today + 30, inclusive. */
export const DUE_WINDOW_DAYS = 30
/** E5.5: a waiting record counts from 30 days past its expiry date. */
export const WAITING_AFTER_DAYS = 30

export type RetentionRow = Readonly<{ created_at: Date; state: string; submission_state: string | null; sample_state: string | null; details_deleted_at: Date | null }>

/** E3.6 (D-E9): waiting on a Candidate decision, and not busy. */
export function isWaiting(row: Pick<RetentionRow, "state" | "submission_state" | "sample_state">): boolean {
  if (isBusy(row)) return false
  return (row.submission_state !== null && (PENDING_DECISION as readonly string[]).includes(row.submission_state)) || row.sample_state === PENDING_SAMPLE
}

/**
 * The grace end the job will use (E4.6): 30 days after the earliest run's WAT
 * date. Before the first run it is 30 days after today, the earliest the first
 * run could make it, so the page never shows a date earlier than the job's.
 * EPIC-0002 A1 (merge 11): per Candidate, from that Candidate's own runs.
 */
export async function readGraceEnd(tx: CandidateTx, candidateId: string, now: Date): Promise<LocalDate> {
  const row = await tx.selectFrom("retention_run").select(sql<string | null>`min(wat_date)::text`.as("first")).where("candidate_id", "=", candidateId).executeTakeFirst()
  return graceEndFrom(row?.first ?? watDate(now))
}

/** The `expiresOn` of an Application: null once deleted (E5.6). */
export function expiresOn(row: Pick<RetentionRow, "created_at" | "details_deleted_at">, graceEnd: LocalDate | null): LocalDate | null {
  return row.details_deleted_at === null ? effectiveExpiry(row.created_at, graceEnd) : null
}

/**
 * Which retention counts a live Application is in, on `today`. The counts of
 * `GET /v1/retention` and the `?retention=` filters both use this, so a filtered
 * list holds exactly the Applications its count reports (E5.7).
 */
export function retentionClass(row: RetentionRow, today: LocalDate, graceEnd: LocalDate): "due" | "overdue" | "waiting" | null {
  if (row.details_deleted_at !== null) return null
  const expiry = effectiveExpiry(row.created_at, graceEnd)
  if (isWaiting(row)) return expiry <= addDays(today, -WAITING_AFTER_DAYS) ? "waiting" : null
  if (expiry >= today && expiry <= addDays(today, DUE_WINDOW_DAYS)) return "due"
  if (expiry < today && !isBusy(row)) return "overdue"
  return null
}

export function matchesRetentionFilter(row: RetentionRow, filter: ApplicationsRetentionFilter, today: LocalDate, graceEnd: LocalDate): boolean {
  return retentionClass(row, today, graceEnd) === filter
}
