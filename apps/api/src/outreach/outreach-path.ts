import { type PipeTransform, Param } from "@nestjs/common"
import { OUTREACH_KINDS, OUTREACH_KIND_SLUGS, type OutreachKind } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { parseUuid } from "../http/uuid-param.js"

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

/**
 * `@Param("kind")` read as an Outreach Kind. Synchronous like `UuidPipe`, so an unknown slug answers `404 not_found`
 * before the body pipe (which yields once) can answer a 400: the path is read before the body.
 */
class OutreachKindPipe implements PipeTransform<string, OutreachKind> {
  transform(slug: string): OutreachKind {
    return outreachKind(slug)
  }
}

export function OutreachKindParam(): ParameterDecorator {
  return Param("kind", new OutreachKindPipe())
}

/** The existing uuid rule: a malformed Application id is `404 not_found`, never a 400. */
export function outreachUuid(id: string): string {
  return parseUuid(id, "not_found")
}
