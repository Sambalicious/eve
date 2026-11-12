import {
  createExistingApplicationResponseSchema,
  EXISTING_APPLICATIONS_COMPLETE_PATH,
  EXISTING_APPLICATIONS_PATH,
  existingApplicationsResponseSchema,
  type ExistingApplication as ExistingApplicationBody,
  type ExistingApplicationsResponse,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type {
  AddExistingApplicationResult,
  ExistingApplication,
  ExistingApplications,
  NewExistingApplication,
} from "../model/existing-application"

export async function fetchExistingApplications(): Promise<ExistingApplications> {
  const response = await apiRequest(EXISTING_APPLICATIONS_PATH)
  return toExistingApplications(
    existingApplicationsResponseSchema.parse(await response.json())
  )
}

/** 201 `created: true`, or 200 `created: false` when the same URL and requisition ID is already recorded. */
export async function addExistingApplication(
  application: NewExistingApplication,
  csrfToken: string
): Promise<AddExistingApplicationResult> {
  const response = await apiRequest(EXISTING_APPLICATIONS_PATH, {
    method: "POST",
    csrfToken,
    json: application,
  })
  const body = createExistingApplicationResponseSchema.parse(
    await response.json()
  )
  return {
    created: body.created,
    application: toExistingApplication(body.application),
  }
}

/** Records the step's completion once; the backend keeps the first time. */
export async function completeExistingApplications(
  csrfToken: string
): Promise<ExistingApplications> {
  const response = await apiRequest(EXISTING_APPLICATIONS_COMPLETE_PATH, {
    method: "POST",
    csrfToken,
  })
  return toExistingApplications(
    existingApplicationsResponseSchema.parse(await response.json())
  )
}

function toExistingApplications(
  body: ExistingApplicationsResponse
): ExistingApplications {
  return {
    applications: body.applications.map(toExistingApplication),
    completedAt: body.completedAt,
  }
}

function toExistingApplication(
  body: ExistingApplicationBody
): ExistingApplication {
  return {
    id: body.id,
    company: body.company,
    roleTitle: body.roleTitle,
    applicationUrl: body.applicationUrl,
    requisitionId: body.requisitionId,
    appliedOn: body.appliedOn,
  }
}
