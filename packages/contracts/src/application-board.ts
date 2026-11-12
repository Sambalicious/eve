import { z } from "zod"

import { applicationSummarySchema } from "./documents.js"
import { outcomeTypeSchema } from "./records.js"
import { sampleStateSchema, submissionStateSchema } from "./submission.js"

/**
 * v1.28.0 (EPIC-0011 C4): the Outcome types that place a card on the board.
 * `request_for_action` never moves a card; it only sets `requestForAction`.
 */
export const boardOutcomeTypeSchema = outcomeTypeSchema.exclude(["request_for_action"])
export type BoardOutcomeType = z.infer<typeof boardOutcomeTypeSchema>

/**
 * One row of `GET /v1/applications`: the unchanged `ApplicationSummary` plus the
 * read-only board fields. v1.30.0 (EPIC-0009) adds the optional `blockedClaimCause`,
 * `blockedClaimTerms` and `blockedClaimMoreTerms` to `ApplicationSummary`, so every
 * route that embeds the summary (this list, the detail, create, submissions and
 * sample routes) carries them. Apart from those three fields the summary is unchanged
 * since v1.27.0.
 */
export const applicationListItemSchema = applicationSummarySchema.extend({
  submissionState: submissionStateSchema.nullable(),
  submissionKind: z.enum(["automatic", "sample"]).nullable(),
  sampleState: sampleStateSchema.nullable(),
  latestOutcome: z
    .object({
      id: z.uuid(),
      type: boardOutcomeTypeSchema,
      createdAt: z.iso.datetime({ offset: true }),
    })
    .strict()
    .nullable(),
  requestForAction: z.boolean(),
})
export type ApplicationListItem = z.infer<typeof applicationListItemSchema>

export const applicationsResponseSchema = z.object({ applications: z.array(applicationListItemSchema) }).strict()
export type ApplicationsResponse = z.infer<typeof applicationsResponseSchema>
