import { JOB_CRITERIA_PATH, jobCriteriaResponseSchema, type JobCriteriaResponse } from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { JobCriteria, JobCriteriaInput } from "../model/job-criteria"

export async function fetchJobCriteria(): Promise<JobCriteria> {
  const response = await apiRequest(JOB_CRITERIA_PATH)
  return toJobCriteria(jobCriteriaResponseSchema.parse(await response.json()))
}

/**
 * `PUT` with the CSRF token. A 400 carries `fieldErrors` on the thrown
 * `ApiError`; the caller maps them to its fields.
 */
export async function saveJobCriteria(input: JobCriteriaInput, csrfToken: string): Promise<JobCriteria> {
  const response = await apiRequest(JOB_CRITERIA_PATH, {
    method: "PUT",
    csrfToken,
    json: {
      minCoreMatchPercent: input.minCoreMatchPercent,
      frameworks: [...input.frameworks],
      technologies: [...input.technologies],
      targetRoleFamilies: [...input.targetRoleFamilies],
      seniorityFloor: input.seniorityFloor,
    },
  })
  return toJobCriteria(jobCriteriaResponseSchema.parse(await response.json()))
}

function toJobCriteria(body: JobCriteriaResponse): JobCriteria {
  return {
    minCoreMatchPercent: body.minCoreMatchPercent,
    frameworks: [...body.frameworks],
    technologies: [...body.technologies],
    targetRoleFamilies: [...body.targetRoleFamilies],
    seniorityFloor: body.seniorityFloor,
    version: body.version,
  }
}
