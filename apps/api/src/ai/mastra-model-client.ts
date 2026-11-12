import "./mastra-telemetry-off.js"

import { createAnthropic } from "@ai-sdk/anthropic"
import { Injectable } from "@nestjs/common"
import { Agent } from "@mastra/core/agent"
import { noopLogger } from "@mastra/core/logger"
import type { z } from "zod"

import { NO_USAGE, type TokenUsage } from "./ai-call.repository.js"
import { INVALID_OUTPUT, type ModelClient, type ModelRequest, type ModelResult } from "./model-client.js"

type MastraUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
}

/**
 * ADR 0006 primary path, confirmed by spike S-1: a tool-less Mastra Agent whose
 * Anthropic model is built per call from the key. The fallback strategy returns
 * a sentinel object when the output fails the schema, so usage is still metered;
 * the gateway then rejects it. Mastra's logger is silenced because its error
 * details carry the raw model output.
 */
/** The only Anthropic endpoint career data may reach (approved terms, ADR 0006). Not configurable. */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com/v1"

@Injectable()
export class MastraModelClient implements ModelClient {
  async generateObject<Schema extends z.ZodType>(
    request: ModelRequest<Schema>
  ): Promise<ModelResult<z.output<Schema>>> {
    // The deadline aborts the HTTP request itself. Mastra's own abortSignal option
    // leaves an unhandled rejection behind (spike S-1g), so it is not used.
    const fetchWithDeadline: typeof fetch = (input, init) =>
      fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, request.abortSignal]) : request.abortSignal })
    // baseURL is explicit: without it @ai-sdk/anthropic reads ANTHROPIC_BASE_URL from the
    // environment, which would send the key and career data to any host it names (SEC-202).
    const model = createAnthropic({ apiKey: request.apiKey, baseURL: ANTHROPIC_API_BASE_URL, fetch: fetchWithDeadline })(
      request.model
    )
    // One request per call: Mastra's default StreamErrorRetryProcessor retries twice more
    // (spike S-1f), and a retry would re-send career data and spend unmetered tokens.
    const agent = new Agent({
      id: "structured-output",
      name: "structured-output",
      instructions: request.system,
      model,
      maxRetries: 0,
      errorProcessorDefaults: false,
    })
    agent.__setLogger(noopLogger)
    const fallback = Object.freeze({ [INVALID_OUTPUT]: true })
    const result = await agent.generate(request.prompt, {
      structuredOutput: { schema: request.schema, errorStrategy: "fallback", fallbackValue: fallback },
      modelSettings: { maxOutputTokens: request.maxOutputTokens, maxRetries: 0 },
      ...(request.effort !== undefined && { providerOptions: { anthropic: { effort: request.effort } } }),
    })
    const usage = toTokenUsage(result.usage as MastraUsage | undefined)
    if (result.object === fallback || result.object === undefined) return { object: INVALID_OUTPUT, usage }
    return { object: result.object as z.output<Schema>, usage }
  }
}

function toTokenUsage(usage: MastraUsage | undefined): TokenUsage {
  if (!usage) return NO_USAGE
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadInputTokens: usage.cachedInputTokens ?? null,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
  }
}
