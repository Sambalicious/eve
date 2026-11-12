import { z } from "zod"

import { jobPostingStatusSchema, roleFamilySchema, skipReasonSchema } from "./discovery.js"

/**
 * v1.29.0 lead pipeline (owner decision 2026-11-10, "all-in-one" job search).
 *
 * A lead is the Candidate's own progression through a posting they already
 * hold: `saved` → `applied` → `interviewing` → `offer`, or `rejected` from any
 * point. It is not an Application: Eve's documents and submissions stay in
 * `/v1/applications`, and a lead exists for jobs Eve can never submit for (the
 * manual lane).
 */
export const leadStageSchema = z.enum(["saved", "applied", "interviewing", "offer", "rejected"])
export type LeadStage = z.infer<typeof leadStageSchema>

/** Display order for the Pipeline page. */
export const LEAD_STAGES: readonly LeadStage[] = leadStageSchema.options

export const LEADS_PATH = "/v1/leads"
export const leadPath = (jobPostingId: string) => `${LEADS_PATH}/${jobPostingId}`

/** `PUT` body: the stage to move the lead to. */
export const leadRequestSchema = z.object({ stage: leadStageSchema }).strict()
export type LeadRequest = z.infer<typeof leadRequestSchema>

/** One lead with the posting facts the Pipeline page shows. */
export const leadSchema = z
  .object({
    jobPostingId: z.uuid(),
    stage: leadStageSchema,
    stageChangedAt: z.iso.datetime(),
    roleTitle: z.string().nullable(),
    company: z.string().nullable(),
    roleFamily: roleFamilySchema.nullable(),
    postingStatus: jobPostingStatusSchema,
    skipReason: skipReasonSchema.nullable(),
    applicationSystem: z.string(),
    /** Eve's Application for this posting, when one exists; null on a manual lead. */
    applicationId: z.uuid().nullable(),
  })
  .strict()
export type Lead = z.infer<typeof leadSchema>

export const leadsResponseSchema = z.object({ leads: z.array(leadSchema) }).strict()
export type LeadsResponse = z.infer<typeof leadsResponseSchema>

/** Whole-list read: one page, newest change first. No paging yet (the list is small). */
export const LEADS_LIMIT = 500
