import {
  applicationOutcomesPath,
  outcomePath,
  outcomeSchema,
  outcomesResponseSchema,
  type Outcome as OutcomeBody,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { Outcome, OutcomeType } from "../model/outcome"

const enc = encodeURIComponent

export async function fetchOutcomes(applicationId: string): Promise<Outcome[]> {
  const response = await apiRequest(applicationOutcomesPath(enc(applicationId)))
  return outcomesResponseSchema.parse(await response.json()).outcomes.map(toOutcome)
}

export async function recordOutcome(applicationId: string, type: OutcomeType, csrfToken: string): Promise<Outcome> {
  const response = await apiRequest(applicationOutcomesPath(enc(applicationId)), { method: "POST", csrfToken, json: { type } })
  return toOutcome(outcomeSchema.parse(await response.json()))
}

/** Only the type changes; anything else stored with the Outcome is kept (AC 8.2). */
export async function editOutcome(outcomeId: string, type: OutcomeType, csrfToken: string): Promise<Outcome> {
  const response = await apiRequest(outcomePath(enc(outcomeId)), { method: "PATCH", csrfToken, json: { type } })
  return toOutcome(outcomeSchema.parse(await response.json()))
}

function toOutcome(body: OutcomeBody): Outcome {
  return { id: body.id, applicationId: body.applicationId, type: body.type, createdAt: body.createdAt, updatedAt: body.updatedAt }
}
