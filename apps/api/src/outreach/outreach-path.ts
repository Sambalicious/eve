import { OUTREACH_KINDS, OUTREACH_KIND_SLUGS, type OutreachKind } from "@eve/contracts"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"

/**
 * The two Outreach routes that can carry a body, as Fastify's registered route
 * pattern. The pre-body gate (`outreach-path-gate.ts`, CR-6) resolves their path
 * before any parser; `GET …/outreach` has no body to parse.
 */
export const OUTREACH_WRITE_ROUTE = "/v1/applications/:id/outreach/:kind/write"
export const OUTREACH_READER_NAME_ROUTE = "/v1/applications/:id/outreach/:kind/reader-name"

/** The three path slugs, from the contract's closed list; any other segment is `404 not_found`. */
export function outreachKind(slug: string): OutreachKind {
  const kind = OUTREACH_KINDS.find((candidate) => OUTREACH_KIND_SLUGS[candidate] === slug)
  if (kind === undefined) throw new ApiException("not_found")
  return kind
}

/** The existing uuid rule: a malformed Application id is `404 not_found`, never a 400. */
export function outreachUuid(id: string): string {
  if (!z.uuid().safeParse(id).success) throw new ApiException("not_found")
  return id
}
