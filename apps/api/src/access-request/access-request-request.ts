import { type NormalizedAccessRequest, normalizeAccessRequest } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"

/** A body that passed every field rule: trimmed, counted and keyed, with the silent-drop inputs (proof, honeypot) read. */
export type AcceptedAccessRequest = Extract<NormalizedAccessRequest, { ok: true }>

/**
 * Validation comes first and stores nothing (architecture.r1 7.4): a body that cannot pass is
 * `400 access_request_invalid` with the first problem of each field, in field order.
 */
export function accessRequestOrRefuse(body: unknown): AcceptedAccessRequest {
  const request = normalizeAccessRequest(body)
  if (!request.ok) throw ApiException.accessRequestInvalid(request.fields)
  return request
}
