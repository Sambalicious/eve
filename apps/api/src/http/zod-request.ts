import { Body, type PipeTransform, Query } from "@nestjs/common"
import type { z } from "zod"

import { parseRequest } from "./parse-body.js"

/**
 * Validates a request body or query with a contract schema. A mismatch is the same
 * `400 bad_request` envelope `parseRequest` throws, so a handler that takes its input
 * through `@ZodBody` / `@ZodQuery` answers exactly as one that called `parseRequest`.
 */
export class ZodRequestPipe<Schema extends z.ZodType> implements PipeTransform<unknown, Promise<z.output<Schema>>> {
  constructor(readonly schema: Schema) {}

  async transform(value: unknown): Promise<z.output<Schema>> {
    // Nest runs a handler's param pipes concurrently and the first rejection wins. Yielding once lets a
    // path-parameter pipe (`UuidParam`) reject first, so a bad id still answers before a bad body, as it did
    // when handlers checked the id and then parsed the body.
    await Promise.resolve()
    return parseRequest(this.schema, value)
  }
}

/** `@Body()` validated by `schema`; type the parameter as `z.output<typeof schema>`. */
export function ZodBody<Schema extends z.ZodType>(schema: Schema): ParameterDecorator {
  return Body(new ZodRequestPipe(schema))
}

/** `@Query()` (or `@Query(name)`) validated by `schema`; type the parameter as `z.output<typeof schema>`. */
export function ZodQuery<Schema extends z.ZodType>(schema: Schema): ParameterDecorator
export function ZodQuery<Schema extends z.ZodType>(name: string, schema: Schema): ParameterDecorator
export function ZodQuery<Schema extends z.ZodType>(nameOrSchema: string | Schema, schema?: Schema): ParameterDecorator {
  return typeof nameOrSchema === "string" ? Query(nameOrSchema, new ZodRequestPipe(schema as Schema)) : Query(new ZodRequestPipe(nameOrSchema))
}
