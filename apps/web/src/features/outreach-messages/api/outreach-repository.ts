import {
  applicationOutreachPath,
  applicationOutreachReaderNamePath,
  applicationOutreachWritePath,
  outreachItemSchema,
  outreachResponseSchema,
  readerNameRequestSchema,
  type OutreachItem,
  type OutreachKind,
  type OutreachResponse,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"

/** `GET /v1/applications/:id/outreach` (`api-contract.md` 4.1). No CSRF, no body. */
export async function fetchOutreach(applicationId: string): Promise<OutreachResponse> {
  const response = await apiRequest(applicationOutreachPath(applicationId))
  return outreachResponseSchema.parse(await response.json())
}

/**
 * `POST …/outreach/:kind/write` (4.2). No body and no content-type. Never
 * retried automatically: one press is one paid Run.
 */
export async function startOutreachRun(applicationId: string, kind: OutreachKind, csrfToken: string): Promise<OutreachItem> {
  const response = await apiRequest(applicationOutreachWritePath(applicationId, kind), { method: "POST", csrfToken })
  return outreachItemSchema.parse(await response.json())
}

/** `PUT …/outreach/:kind/reader-name` (4.3). No model call; the text comes back recomposed. */
export async function saveOutreachReaderName(
  applicationId: string,
  kind: OutreachKind,
  readerName: string | null,
  csrfToken: string
): Promise<OutreachItem> {
  const response = await apiRequest(applicationOutreachReaderNamePath(applicationId, kind), {
    method: "PUT",
    csrfToken,
    json: readerNameRequestSchema.parse({ readerName }),
  })
  return outreachItemSchema.parse(await response.json())
}
