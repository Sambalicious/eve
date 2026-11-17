import { type PipeTransform, Param } from "@nestjs/common"
import { z } from "zod"

import { ApiException } from "./api-exception.js"

/**
 * What a malformed id answers. A route keeps the status it already had: `not_found` where a malformed id
 * names nothing (the same as an unknown one), `bad_request` where the route has always refused it as a bad
 * request. The policy is a per-route contract (see the tests that pin each), not a default to pick freely.
 */
export type UuidPolicy = "not_found" | "bad_request"

const uuidSchema = z.uuid()

/** Returns `value` when it is a UUID; otherwise throws the policy's `ApiException`. */
export function parseUuid(value: unknown, policy: UuidPolicy): string {
  const result = uuidSchema.safeParse(value)
  if (!result.success) throw new ApiException(policy)
  return result.data
}

export class UuidPipe implements PipeTransform<unknown, string> {
  constructor(readonly policy: UuidPolicy) {}

  transform(value: unknown): string {
    return parseUuid(value, this.policy)
  }
}

/** `@Param(name)` checked as a UUID under `policy`. */
export function UuidParam(name: string, policy: UuidPolicy): ParameterDecorator {
  return Param(name, new UuidPipe(policy))
}
