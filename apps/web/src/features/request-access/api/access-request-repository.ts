import {
  ACCESS_REQUEST_HONEYPOT_FIELD,
  ACCESS_REQUEST_PATH,
  ACCESS_REQUEST_PROOF_PATH,
  accessRequestAcceptedSchema,
  accessRequestProofSchema,
  type AccessRequestBody,
} from "@eve/contracts"

import { publicRequest } from "@/shared/api"

/** `GET /v1/public/access-requests/proof` (v1.16.0): the server-signed fill-time proof. */
export async function fetchProof(): Promise<string> {
  const response = await publicRequest(ACCESS_REQUEST_PROOF_PATH)
  return accessRequestProofSchema.parse(await response.json()).proof
}

export interface AccessRequestInput {
  email: string
  note: string
  proof: string | null
  /** The honeypot's value; empty from a person. */
  honeypot: string
}

/**
 * `POST /v1/public/access-requests`. Resolves on the 202, which is identical
 * for real and silent outcomes; anything else rejects with an `ApiError`.
 */
export async function sendAccessRequest(input: AccessRequestInput): Promise<void> {
  const body: AccessRequestBody = {
    email: input.email,
    note: input.note,
    [ACCESS_REQUEST_HONEYPOT_FIELD]: input.honeypot,
    ...(input.proof === null ? {} : { proof: input.proof }),
  }
  const response = await publicRequest(ACCESS_REQUEST_PATH, { method: "POST", json: body })
  accessRequestAcceptedSchema.parse(await response.json())
}
