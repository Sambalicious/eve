import {
  DELETE_DETAILS_PATH,
  deleteDetailsResponseSchema,
  MINIMAL_RECORDS_PATH,
  minimalRecordPath,
  minimalRecordsResponseSchema,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { RequisitionRecord } from "../model/requisition-record"

export async function fetchRequisitionRecords(): Promise<RequisitionRecord[]> {
  const response = await apiRequest(MINIMAL_RECORDS_PATH)
  return minimalRecordsResponseSchema.parse(await response.json()).records.map((r) => ({ ...r, deletedBy: r.deletedBy }))
}

/** The server's `applicationIds` limit (`deleteDetailsRequestSchema` `.max(100)`). */
export const DELETE_DETAILS_BATCH = 100

/** A later batch failed after earlier batches deleted `deletedCount` Applications. */
export class PartialDeletionError extends Error {
  readonly deletedCount: number
  constructor(deletedCount: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Partial deletion", { cause })
    this.name = "PartialDeletionError"
    this.deletedCount = deletedCount
  }
}

/**
 * Deletes the detailed records of the given Applications in requests of at most
 * 100 IDs (the server limit), one after another. Returns how many were deleted
 * now in total (already-deleted ones don't count). If a batch fails after an
 * earlier one deleted something, throws `PartialDeletionError` with that count.
 */
export async function deleteDetailedRecords(applicationIds: readonly string[], csrfToken: string): Promise<number> {
  let deleted = 0
  for (let start = 0; start < applicationIds.length; start += DELETE_DETAILS_BATCH) {
    const batch = applicationIds.slice(start, start + DELETE_DETAILS_BATCH)
    try {
      const response = await apiRequest(DELETE_DETAILS_PATH, { method: "POST", csrfToken, json: { applicationIds: batch } })
      deleted += deleteDetailsResponseSchema.parse(await response.json()).deletedCount
    } catch (error) {
      if (deleted > 0) throw new PartialDeletionError(deleted, error)
      throw error
    }
  }
  return deleted
}

/** Removes a minimal record, so the requisition can be applied to again. */
export async function clearRequisitionRecord(applicationId: string, csrfToken: string): Promise<void> {
  await apiRequest(minimalRecordPath(encodeURIComponent(applicationId)), { method: "DELETE", csrfToken })
}
