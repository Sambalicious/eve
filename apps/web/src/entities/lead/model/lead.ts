import type { Lead as LeadBody, LeadStage } from "@eve/contracts"

/** One lead as the Pipeline page renders it (v1.29.0). */
export type Lead = LeadBody
export type { LeadStage }

export const LEAD_STAGE_LABEL: Readonly<Record<LeadStage, string>> = {
  saved: "Saved",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
}

/** The board's four columns: three active stages and one Closed column holding Offer and Rejected. */
export type PipelineColumn = "saved" | "applied" | "interviewing" | "closed"

export const PIPELINE_COLUMNS: readonly PipelineColumn[] = ["saved", "applied", "interviewing", "closed"]

export const PIPELINE_COLUMN_LABEL: Readonly<Record<PipelineColumn, string>> = {
  saved: "Saved",
  applied: "Applied",
  interviewing: "Interviewing",
  closed: "Closed",
}

export function columnOf(stage: LeadStage): PipelineColumn {
  if (stage === "offer" || stage === "rejected") return "closed"
  return stage
}
