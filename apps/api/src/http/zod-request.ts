import { Body, type PipeTransform, Query } from "@nestjs/common"
import type { z } from "zod"

import type { ApiException } from "./api-exception.js"
import { parseRequest } from "./parse-body.js"

/**
 * Builds the exception for a body or query a schema refused, from the raw value and the schema's issues.
 * Use it where the 400 carries field errors (`ApiException.badRequestWithFieldErrors`) or another code.
 */
export type RequestRefusal = (value: unknown, issues: readonly z.core.$ZodIssue[]) => ApiException

/**
 * Validates a request body or query with a contract schema. A mismatch is the same
 * `400 bad_request` envelope `parseRequest` throws, so a handler that takes its input
 * through `@ZodBody` / `@ZodQuery` answers exactly as one that called `parseRequest`.
 * With `refuse`, a mismatch throws what it builds instead, for a route whose 400 names the bad fields.
 */
export class ZodRequestPipe<Schema extends z.ZodType> implements PipeTransform<unknown, Promise<z.output<Schema>>> {
  constructor(
    readonly schema: Schema,
    readonly refuse?: RequestRefusal
  ) {}

  async transform(value: unknown): Promise<z.output<Schema>> {
    // Nest runs a handler's param pipes concurrently and the first rejection wins. Yielding once lets a
    // path-parameter pipe (`UuidParam`) reject first, so a bad id still answers before a bad body, as it did
    // when handlers checked the id and then parsed the body.
    await Promise.resolve()
    if (this.refuse === undefined) return parseRequest(this.schema, value)
    const result = this.schema.safeParse(value)
    if (!result.success) throw this.refuse(value, result.error.issues)
    return result.data
  }
}

/**
 * For input a schema cannot express (bounds before shape, a rule that reads the clock, a lenient default):
 * `parse` returns the value the handler takes, or throws the `ApiException` the route answers with.
 */
export class ParseRequestPipe<Output> implements PipeTransform<unknown, Promise<Output>> {
  constructor(readonly parse: (value: unknown) => Output) {}

  async transform(value: unknown): Promise<Output> {
    await Promise.resolve() // see ZodRequestPipe: a path-parameter pipe answers first
    return this.parse(value)
  }
}

/** `@Body()` validated by `schema`; type the parameter as `z.output<typeof schema>`. */
export function ZodBody<Schema extends z.ZodType>(schema: Schema, refuse?: RequestRefusal): ParameterDecorator {
  return Body(new ZodRequestPipe(schema, refuse))
}

/** `@Query()` (or `@Query(name)`) validated by `schema`; type the parameter as `z.output<typeof schema>`. */
export function ZodQuery<Schema extends z.ZodType>(schema: Schema, refuse?: RequestRefusal): ParameterDecorator
export function ZodQuery<Schema extends z.ZodType>(name: string, schema: Schema, refuse?: RequestRefusal): ParameterDecorator
export function ZodQuery<Schema extends z.ZodType>(first: string | Schema, second?: Schema | RequestRefusal, third?: RequestRefusal): ParameterDecorator {
  if (typeof first === "string") return Query(first, new ZodRequestPipe(second as Schema, third))
  return Query(new ZodRequestPipe(first, second as RequestRefusal | undefined))
}

/** `@Body()` turned into the handler's value by `parse`, which throws the route's own `ApiException`. */
export function ParsedBody<Output>(parse: (value: unknown) => Output): ParameterDecorator {
  return Body(new ParseRequestPipe(parse))
}

/** `@Query(name)` turned into the handler's value by `parse`; an absent parameter reaches `parse` as `undefined`. */
export function ParsedQuery<Output>(name: string, parse: (value: unknown) => Output): ParameterDecorator {
  return Query(name, new ParseRequestPipe(parse))
}
