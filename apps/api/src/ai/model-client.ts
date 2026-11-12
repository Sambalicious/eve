import type { z } from "zod"

import type { TokenUsage } from "./ai-call.repository.js"

export const MODEL_CLIENT = Symbol("MODEL_CLIENT")

/** Returned in place of an object when the model's output does not match the schema. */
export const INVALID_OUTPUT: unique symbol = Symbol("INVALID_OUTPUT")

/** Anthropic `output_config.effort`. Lower effort means less thinking, which shares the output allowance. */
export type ModelEffort = "low" | "medium" | "high"

export type ModelRequest<Schema extends z.ZodType> = Readonly<{
  apiKey: string
  model: string
  system: string
  prompt: string
  schema: Schema
  maxOutputTokens: number
  effort?: ModelEffort
  abortSignal: AbortSignal
}>

export type ModelResult<T> = Readonly<{ object: T | typeof INVALID_OUTPUT; usage: TokenUsage }>

/**
 * One structured-output request to the provider. Only ModelGateway calls it,
 * after the approval check. Implementations must make exactly one HTTP request
 * and never log prompts or outputs.
 */
export interface ModelClient {
  generateObject<Schema extends z.ZodType>(request: ModelRequest<Schema>): Promise<ModelResult<z.output<Schema>>>
}
