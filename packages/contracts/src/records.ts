import { z } from "zod"

/**
 * v1.11.0 (slice 7): manual Outcomes (AC 8, AC 9.3) and deleting detailed
 * records (AC 10.3, 10.4). design-spec r4 F9, F10, C-DATA-*, C-OUT-1.
 */
export const outcomeTypeSchema = z.enum(["confirmation", "rejection", "interview_invitation", "request_for_action", "offer"])
export type OutcomeTypeValue = z.infer<typeof outcomeTypeSchema>

export const outcomeSchema = z
  .object({
    id: z.uuid(),
    applicationId: z.uuid(),
    type: outcomeTypeSchema,
    /** Always "candidate" in the MVP: "Recorded by you". The assistant records no Outcome (AC 8.3). */
    source: z.literal("candidate"),
    /** Post-MVP Gmail Outcomes only; null in the MVP. Editing the type never changes it (OQ-D15). */
    excerpt: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type Outcome = z.infer<typeof outcomeSchema>

export const applicationOutcomesPath = (applicationId: string) => `/v1/applications/${applicationId}/outcomes`
export const outcomePath = (outcomeId: string) => `/v1/outcomes/${outcomeId}`

export const outcomesResponseSchema = z.object({ outcomes: z.array(outcomeSchema) }).strict()
export type OutcomesResponse = z.infer<typeof outcomesResponseSchema>

export const outcomeRequestSchema = z.object({ type: outcomeTypeSchema }).strict()
export type OutcomeRequest = z.infer<typeof outcomeRequestSchema>

/** Delete detailed records of up to 100 Applications at once (C-CONFIRM-11, C-CONFIRM-12). */
export const DELETE_DETAILS_PATH = "/v1/applications/delete-details"
export const MINIMAL_RECORDS_PATH = "/v1/minimal-records"
export const minimalRecordPath = (applicationId: string) => `/v1/minimal-records/${applicationId}`

export const deleteDetailsRequestSchema = z.object({ applicationIds: z.array(z.uuid()).min(1).max(100) }).strict()
export type DeleteDetailsRequest = z.infer<typeof deleteDetailsRequestSchema>

export const deleteDetailsResponseSchema = z
  .object({
    /** Applications whose detailed records were deleted by this request (C-DATA-4 `{n}`). Already-deleted ones are not counted. */
    deletedCount: z.int().min(0),
  })
  .strict()
export type DeleteDetailsResponse = z.infer<typeof deleteDetailsResponseSchema>

/** What remains after deletion (AC 10.4): it keeps blocking a second Application for the requisition. */
export const minimalRecordSchema = z
  .object({
    applicationId: z.uuid(),
    company: z.string().nullable(),
    /** v1.27.0: null for a description-only pasted Application (no link). */
    applicationUrl: z.string().nullable(),
    requisitionId: z.string(),
    /** When the Application was created ("date" in C-DATA-2). */
    createdAt: z.iso.datetime({ offset: true }),
    /** C-DATA-3 `{date}`. */
    detailsDeletedAt: z.iso.datetime({ offset: true }),
    /** The final status, kept for the record: the latest Outcome type if one existed, else the submission or documents state. */
    finalStatus: z.string(),
    /**
     * v1.17.0 (automatic expiry, E5.3, E6.1): who deleted the detailed records.
     * `candidate` shows "You", `expiry` shows "Automatic, 12 months". Always sent
     * from v1.17.0; optional only so an older api's response still parses.
     */
    deletedBy: z.enum(["candidate", "expiry"]).optional(),
  })
  .strict()
export type MinimalRecord = z.infer<typeof minimalRecordSchema>

export const minimalRecordsResponseSchema = z.object({ records: z.array(minimalRecordSchema) }).strict()
export type MinimalRecordsResponse = z.infer<typeof minimalRecordsResponseSchema>

/**
 * v1.17.0 (automatic expiry, PRD E5.2, E5.5, E5.6, E6.4, D-E13). Every date is a
 * WAT calendar date `YYYY-MM-DD`; format it as a calendar date, never through
 * the browser time zone.
 */
export const RETENTION_PATH = "/v1/retention"

export const retentionRunOutcomeSchema = z.enum(["completed", "skipped_global_paused", "skipped_launch_grace", "failed"])
export type RetentionRunOutcome = z.infer<typeof retentionRunOutcomeSchema>

export const retentionResponseSchema = z
  .object({
    /** Fixed: detailed records go 12 months after creation. */
    rule: z.object({ months: z.literal(12) }).strict(),
    /** E5.2: live Applications not waiting on a decision whose expiry date is today to today + 30. `earliestOn` null when `count` is 0. */
    dueNext30Days: z.object({ count: z.int().min(0), earliestOn: z.iso.date().nullable() }).strict(),
    /** Live, not busy, not waiting, expiry date before today: normally 0; above 0 when a run is behind or rows were locked. */
    overdueDue: z.object({ count: z.int().min(0) }).strict(),
    /** E5.5: waiting on a decision and 30 days or more past the expiry date (C-RET-6). */
    waitingForDecision: z.object({ count: z.int().min(0) }).strict(),
    /** E4.6: the launch grace end date while today is before it, else null. */
    graceEndsOn: z.iso.date().nullable(),
    /** The latest run (a run still `running` after 1 hour reads as `failed`); null before the first run. */
    lastRun: z.object({ watDate: z.iso.date(), outcome: retentionRunOutcomeSchema, deletedCount: z.int().min(0) }).strict().nullable(),
    /** E6.4 (C-RET-9): the latest failed run with no later completed run, else null. */
    lastFailure: z.object({ watDate: z.iso.date() }).strict().nullable(),
  })
  .strict()
export type RetentionResponse = z.infer<typeof retentionResponseSchema>

/** v1.17.0 (E5.7): `GET /v1/applications?retention=due|waiting`. Any other value is ignored (full list). */
export const applicationsRetentionFilterSchema = z.enum(["due", "waiting"])
export type ApplicationsRetentionFilter = z.infer<typeof applicationsRetentionFilterSchema>
