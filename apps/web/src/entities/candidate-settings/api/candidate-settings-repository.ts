import {
  CANDIDATE_SETTINGS_PATH,
  candidateSettingsResponseSchema,
  WORK_AUTHORIZATION_PATH,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { CandidateSettings } from "../model/candidate-settings"

export async function fetchCandidateSettings(): Promise<CandidateSettings> {
  const response = await apiRequest(CANDIDATE_SETTINGS_PATH)
  const body = candidateSettingsResponseSchema.parse(await response.json())
  return { workAuthorization: body.workAuthorization }
}

export async function setWorkAuthorization(workAuthorization: string, csrfToken: string): Promise<CandidateSettings> {
  const response = await apiRequest(WORK_AUTHORIZATION_PATH, {
    method: "PUT",
    csrfToken,
    json: { workAuthorization },
  })
  const body = candidateSettingsResponseSchema.parse(await response.json())
  return { workAuthorization: body.workAuthorization }
}
