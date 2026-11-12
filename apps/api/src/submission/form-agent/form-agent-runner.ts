import { Inject, Injectable } from "@nestjs/common"

import { APP_CONFIG } from "../../config/config.module.js"
import type { SharedRuntimeConfig } from "../../config/env.js"
import { AiProviderRepository } from "../../ai/ai-provider.repository.js"
import { ModelGateway } from "../../ai/model-gateway.js"
import { FORM_AGENT_LIMITS, FORM_AGENT_PURPOSE, type FormAgentInput, type FormAgentModel, type FormAgentResult, agentStepSchema, runFormAgent } from "./form-agent.js"

/**
 * Runs the form agent through ModelGateway (approval check, metering, one
 * provider request per step, Mastra structured output). With no approved
 * provider or no key it is unavailable, so leftover required fields block as
 * Missing Approved Answer before any slot is claimed (PRD 1.2 zero-call state).
 */
@Injectable()
export class FormAgentRunner {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly approvals: AiProviderRepository,
    @Inject(APP_CONFIG) private readonly config: SharedRuntimeConfig
  ) {}

  /** Off unless SUBMISSION_FORM_AGENT_ENABLED=1: no approval read, no model call (repair wave 3, SEC-515). */
  get enabled(): boolean {
    return this.config.formAgentEnabled === true
  }

  async available(): Promise<boolean> {
    if (!this.enabled) return false
    return this.config.anthropic.readApiKey() !== undefined && (await this.approvals.findApproval()) !== undefined
  }

  /**
   * Slice 7: every step reserves its estimated cost under the attempt's
   * USD 0.03 cap and the USD 5 monthly form-agent budget, and stops for the
   * global pause or the cost pause, before the provider call.
   */
  async run(applicationId: string, attemptId: string, input: Omit<FormAgentInput, "model">): Promise<FormAgentResult> {
    if (!this.enabled) return { stop: "unavailable", assigned: [], hints: [] }
    const model: FormAgentModel = {
      next: (request) =>
        this.gateway.generateObject({
          purpose: FORM_AGENT_PURPOSE,
          system: request.system,
          prompt: request.prompt,
          schema: agentStepSchema,
          maxOutputTokens: request.maxOutputTokens,
          timeoutMs: FORM_AGENT_LIMITS.stepTimeoutMs,
          applicationId,
          cost: { action: "form filling", haltOnGlobalPause: true, formAgentAttemptId: attemptId },
        }),
    }
    return runFormAgent({ ...input, model })
  }
}
