import { apiRequest } from "@/shared/api"
import {
  HIRING_SEARCH_INPUTS_PATH,
  hiringSearchInputsResponseSchema,
  type HiringHintTerm,
} from "@/shared/lib/hiring-contracts"

/**
 * `GET /v1/stack-posts/hiring-search-inputs` (EPIC-0007 api-contract.md,
 * Phase 1): the session Candidate's hint terms, in AC 2.5 order. Read-only;
 * never carries the Role family choice.
 */
export async function fetchHiringHintTerms(): Promise<readonly HiringHintTerm[]> {
  const body = hiringSearchInputsResponseSchema.parse(await (await apiRequest(HIRING_SEARCH_INPUTS_PATH)).json())
  return body.hintTerms
}
