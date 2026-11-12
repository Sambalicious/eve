import { type Lead, LEADS_PATH, leadPath, leadsResponseSchema, leadSchema, type LeadStage } from "@eve/contracts"

import { apiRequest } from "@/shared/api"

/** v1.29.0: every lead, newest change first. */
export async function fetchLeads(): Promise<Lead[]> {
  const response = await apiRequest(LEADS_PATH)
  return leadsResponseSchema.parse(await response.json()).leads
}

/** Creates or moves the lead. CSRF is required by the api on PUT and DELETE. */
export async function setLeadStage(jobPostingId: string, stage: LeadStage, csrf: string): Promise<Lead> {
  const response = await apiRequest(leadPath(jobPostingId), { method: "PUT", json: { stage }, csrfToken: csrf })
  return leadSchema.parse(await response.json())
}

export async function removeLead(jobPostingId: string, csrf: string): Promise<void> {
  await apiRequest(leadPath(jobPostingId), { method: "DELETE", csrfToken: csrf })
}
