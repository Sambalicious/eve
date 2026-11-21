import {
  addAddedFactsResponseSchema,
  addedFactsViewSchema,
  applicationAddedFactPath,
  applicationAddedFactsConfirmPath,
  applicationAddedFactsPath,
  submissionSchema,
  type AddAddedFactsItem,
  type AddAddedFactsResponse,
  type AddedFactsView,
  type Submission,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"

/**
 * FEAT-0017 (api-contract v1.32.0): the five added-facts routes. Every write carries the Application's
 * `expectedVersion`; a mismatch is `409 added_facts_conflict` and the caller refetches this view.
 */

export async function fetchAddedFacts(applicationId: string): Promise<AddedFactsView> {
  const response = await apiRequest(applicationAddedFactsPath(encodeURIComponent(applicationId)))
  return addedFactsViewSchema.parse(await response.json())
}

export async function addAddedFacts(
  applicationId: string,
  csrfToken: string,
  expectedVersion: number,
  items: readonly AddAddedFactsItem[]
): Promise<AddAddedFactsResponse> {
  const response = await apiRequest(applicationAddedFactsPath(encodeURIComponent(applicationId)), {
    method: "POST",
    csrfToken,
    json: { expectedVersion, items: [...items] },
  })
  return addAddedFactsResponseSchema.parse(await response.json())
}

export async function editAddedFact(
  applicationId: string,
  factId: string,
  csrfToken: string,
  input: { expectedVersion: number; text: string; roleSectionId: string | null }
): Promise<AddedFactsView> {
  const response = await apiRequest(applicationAddedFactPath(encodeURIComponent(applicationId), encodeURIComponent(factId)), {
    method: "PATCH",
    csrfToken,
    json: { expectedVersion: input.expectedVersion, text: input.text, roleSectionId: input.roleSectionId },
  })
  return addedFactsViewSchema.parse(await response.json())
}

export async function removeAddedFact(
  applicationId: string,
  factId: string,
  csrfToken: string,
  expectedVersion: number
): Promise<AddedFactsView> {
  const path = `${applicationAddedFactPath(encodeURIComponent(applicationId), encodeURIComponent(factId))}?expectedVersion=${expectedVersion}`
  const response = await apiRequest(path, { method: "DELETE", csrfToken })
  return addedFactsViewSchema.parse(await response.json())
}

/** "Submit with your added skills" (OD-7, OD-17): records the confirmation and queues in one call. */
export async function confirmAddedFacts(applicationId: string, csrfToken: string, expectedVersion: number): Promise<Submission> {
  const response = await apiRequest(applicationAddedFactsConfirmPath(encodeURIComponent(applicationId)), {
    method: "POST",
    csrfToken,
    json: { expectedVersion },
  })
  return submissionSchema.parse(await response.json())
}
