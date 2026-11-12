import { randomUUID } from "node:crypto"

import { Inject, Injectable } from "@nestjs/common"
import type { z } from "zod"

import { APP_CONFIG } from "../config/config.module.js"
import type { SharedRuntimeConfig } from "../config/env.js"

import { TenantDatabase } from "../db/tenant-database.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { SPEND_CONFIG } from "../spend/spend-config.js"
import { type CostAction, SpendLedger } from "../spend/spend-ledger.js"
import { type AiPrices, DEFAULT_DOCUMENTS_AI_PRICES, type SpendConfig, aiActualMicros, aiEstimateMicros, aiInputMicros, pricesForModel } from "../spend/spend-math.js"
import { AiCallRepository, NO_USAGE } from "./ai-call.repository.js"
import { AiProviderRepository } from "./ai-provider.repository.js"
import { INVALID_OUTPUT, MODEL_CLIENT, type ModelClient, type ModelEffort } from "./model-client.js"

export type GatewayRequest<Schema extends z.ZodType> = Readonly<{
  purpose: string
  system: string
  prompt: string
  schema: Schema
  maxOutputTokens: number
  timeoutMs: number
  /** "documents": the tailored-documents model and its prices. Default: the scoring model. */
  tier?: "default" | "documents"
  /** How much the model thinks. Thinking counts against maxOutputTokens. Unset: the model's own default. */
  effort?: ModelEffort
  resumeUploadId?: string
  jobPostingId?: string
  applicationId?: string
  /**
   * Slice 7 cost and pause rules for this call. Every call reserves its
   * estimated cost first. `haltOnGlobalPause`: discovery, document generation
   * and submission (AC 10.1) also refuse to start, and abort, while the global
   * pause is on. `formAgentAttemptId`: form-agent spend, checked against the
   * per-attempt and monthly caps.
   */
  cost?: Readonly<{ action: CostAction | null; haltOnGlobalPause?: boolean; formAgentAttemptId?: string }>
}>

/**
 * Why no object came back. Each value is safe to store and show. Slice 7:
 * `paused` (global pause), `cost_paused` (the reservation would cross the
 * ceiling, or paid automation is paused for cost), `budget_exhausted` (a
 * form-agent cap). None of these sends a request.
 */
export type GatewayFailure = "not_approved" | "not_configured" | "provider_error" | "invalid_output" | "timed_out" | "paused" | "cost_paused" | "budget_exhausted"

/** How often a running call re-reads the global pause; well inside AC 10.1's one minute. */
export const PAUSE_POLL_MS = 5_000

export type GatewayResult<T> =
  | Readonly<{ ok: true; object: T }>
  | Readonly<{ ok: false; failure: GatewayFailure }>

/**
 * The only way career data reaches a model (ADR 0006). Order matters: approval
 * check, key check, cost reservation (slice 7), metering row, one provider
 * request, metering update, settlement. With no approval or no room under the
 * ceiling the client is never called, so no request leaves the process.
 * The schema is re-checked here: backend code, not the model, decides validity.
 * The reserved estimate uses the whole output allowance and over-counts input;
 * the settled cost is never below the input sent, whatever usage is reported.
 */
@Injectable()
export class ModelGateway {
  constructor(
    private readonly approvals: AiProviderRepository,
    private readonly calls: AiCallRepository,
    @Inject(MODEL_CLIENT) private readonly client: ModelClient,
    @Inject(APP_CONFIG) private readonly config: SharedRuntimeConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: SpendLedger,
    @Inject(SPEND_CONFIG) private readonly spend: SpendConfig,
    private readonly tenant: TenantDatabase
  ) {}

  async generateObject<Schema extends z.ZodType>(
    request: GatewayRequest<Schema>
  ): Promise<GatewayResult<z.output<Schema>>> {
    if (!(await this.approvals.findApproval())) return { ok: false, failure: "not_approved" }
    const apiKey = this.config.anthropic.readApiKey()
    if (apiKey === undefined) return { ok: false, failure: "not_configured" }

    const { model, prices } = this.modelFor(request.tier ?? "default")
    const promptChars = request.system.length + request.prompt.length
    const estimate = aiEstimateMicros(prices, promptChars, request.maxOutputTokens)
    const inputCost = aiInputMicros(prices, promptChars)
    const reservation = await this.ledger.reserve({
      category: "ai",
      purpose: request.purpose,
      estimateMicros: estimate,
      action: request.cost?.action ?? null,
      applicationId: request.applicationId ?? null,
      attemptId: request.cost?.formAgentAttemptId ?? null,
      formAgent: request.cost?.formAgentAttemptId !== undefined,
      haltOnGlobalPause: request.cost?.haltOnGlobalPause === true,
    })
    if (!reservation.ok) return { ok: false, failure: reservation.refusal }

    const callId = randomUUID()
    await this.calls.start({
      id: callId,
      purpose: request.purpose,
      model,
      resumeUploadId: request.resumeUploadId ?? null,
      jobPostingId: request.jobPostingId ?? null,
      applicationId: request.applicationId ?? null,
      startedAt: this.clock.now(),
    })
    const abort = new AbortController()
    const call = this.client.generateObject({
      apiKey,
      model,
      system: request.system,
      prompt: request.prompt,
      schema: request.schema,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.effort !== undefined && { effort: request.effort }),
      abortSignal: abort.signal,
    })
    // The client may settle (or reject) after the deadline; that late result is
    // ignored on purpose so it can neither surface as an unhandled rejection nor
    // be used after the call was recorded as timed out.
    call.catch(() => undefined)
    const paused = request.cost?.haltOnGlobalPause === true ? this.watchGlobalPause() : undefined
    const outcome = await settleWithin(call, request.timeoutMs, paused?.promise).finally(() => paused?.stop())
    if (outcome.kind === "timed_out" || outcome.kind === "paused") {
      abort.abort()
      // The request was sent and may be billed in full: the whole reservation stands.
      await this.calls.finish(callId, "timed_out", NO_USAGE, this.clock.now())
      await this.ledger.settle(reservation.id, estimate)
      return { ok: false, failure: outcome.kind }
    }
    if (outcome.kind === "rejected") {
      // The error may quote the request or response; it is dropped, never logged.
      await this.calls.finish(callId, "provider_error", NO_USAGE, this.clock.now())
      await this.ledger.settle(reservation.id, inputCost)
      return { ok: false, failure: "provider_error" }
    }
    const result = outcome.value
    await this.ledger.settle(reservation.id, aiActualMicros(prices, result.usage, inputCost, estimate))
    const parsed = result.object === INVALID_OUTPUT ? undefined : request.schema.safeParse(result.object)
    const valid = parsed?.success === true
    await this.calls.finish(callId, valid ? "succeeded" : "invalid_output", result.usage, this.clock.now())
    return valid ? { ok: true, object: parsed.data } : { ok: false, failure: "invalid_output" }
  }

  /**
   * The model and prices for a tier. A documents model equal to the default model uses the default prices.
   * Either way the prices are never below the model's list price (pricesForModel).
   */
  private modelFor(tier: "default" | "documents"): Readonly<{ model: string; prices: AiPrices }> {
    const { model, documentsModel } = this.config.anthropic
    if (tier === "documents" && documentsModel !== undefined && documentsModel !== model) {
      return { model: documentsModel, prices: pricesForModel(documentsModel, this.spend.documentsAi ?? DEFAULT_DOCUMENTS_AI_PRICES) }
    }
    return { model, prices: pricesForModel(model, this.spend.ai) }
  }

  /** Resolves when the global pause turns on; polled every PAUSE_POLL_MS (AC 10.1: within one minute). */
  private watchGlobalPause(): { promise: Promise<void>; stop: () => void } {
    let timer: NodeJS.Timeout | undefined
    let stopped = false
    const promise = new Promise<void>((resolve) => {
      const check = async () => {
        if (stopped) return
        // control_state is shared: a shared transaction, no Candidate setting.
        const control = await this.tenant.forShared((tx) => tx.selectFrom("control_state").select("global_paused").executeTakeFirst()).catch(() => undefined)
        if (control?.global_paused === true) return resolve()
        if (!stopped) timer = setTimeout(() => void check(), PAUSE_POLL_MS)
      }
      timer = setTimeout(() => void check(), PAUSE_POLL_MS)
    })
    return {
      promise,
      stop: () => {
        stopped = true
        clearTimeout(timer)
      },
    }
  }
}

type Settled<T> = { kind: "value"; value: T } | { kind: "rejected" } | { kind: "timed_out" } | { kind: "paused" }

/** Waits for `promise` up to `timeoutMs` or until `paused` resolves, without ever rejecting. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, paused?: Promise<void>): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timed_out" }), timeoutMs)
  })
  try {
    return await Promise.race([
      promise.then(
        (value): Settled<T> => ({ kind: "value", value }),
        (): Settled<T> => ({ kind: "rejected" })
      ),
      deadline,
      ...(paused ? [paused.then((): Settled<T> => ({ kind: "paused" }))] : []),
    ])
  } finally {
    clearTimeout(timer)
  }
}
