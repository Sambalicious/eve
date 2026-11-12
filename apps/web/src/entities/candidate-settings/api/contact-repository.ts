import { CANDIDATE_CONTACT_PATH, candidateContactSchema, type CandidateContact } from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { ContactDetails } from "../model/contact"

export async function fetchContactDetails(): Promise<ContactDetails> {
  return parseContact(await (await apiRequest(CANDIDATE_CONTACT_PATH)).json())
}

export async function saveContactDetails(contact: CandidateContact, csrfToken: string): Promise<ContactDetails> {
  const response = await apiRequest(CANDIDATE_CONTACT_PATH, { method: "PUT", csrfToken, json: contact })
  return parseContact(await response.json())
}

/**
 * GET answers `{ fullName: "", lines: [] }` until contact details are set, a
 * shape `candidateContactSchema` (fullName min 1) refuses. The contract has no
 * response schema for it (BLOCKER[backend-engineer] FE4-B1, frontend report),
 * so that exact unset body is accepted here and anything else must pass the schema.
 */
function parseContact(body: unknown): ContactDetails {
  if (isUnset(body)) return { fullName: "", lines: [] }
  const parsed = candidateContactSchema.parse(body)
  return { fullName: parsed.fullName, lines: [...parsed.lines] }
}

function isUnset(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false
  const { fullName, lines, ...rest } = body as Record<string, unknown>
  return fullName === "" && Array.isArray(lines) && lines.length === 0 && Object.keys(rest).length === 0
}
