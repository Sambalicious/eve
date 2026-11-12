import { ATS_MINIMUM_PATH, atsMinimumSchema } from "@eve/contracts"

import { apiRequest } from "@/shared/api"

/** The minimum ATS match for automatic submission, 0 to 100; 0 turns the gate off. */
export async function fetchAtsMinimum(): Promise<number> {
  return atsMinimumSchema.parse(await (await apiRequest(ATS_MINIMUM_PATH)).json()).minAtsPercent
}

export async function saveAtsMinimum(minAtsPercent: number, csrfToken: string): Promise<number> {
  const response = await apiRequest(ATS_MINIMUM_PATH, { method: "PUT", csrfToken, json: { minAtsPercent } })
  return atsMinimumSchema.parse(await response.json()).minAtsPercent
}
