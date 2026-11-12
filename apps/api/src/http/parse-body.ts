import type { z } from "zod"

import { ApiException } from "./api-exception.js"

/** Parses a request body or path value with a contract schema; anything invalid is a 400. */
export function parseRequest<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiException("bad_request")
  return result.data
}
