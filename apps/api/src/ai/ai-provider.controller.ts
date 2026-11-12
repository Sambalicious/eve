import { Body, Controller, Get, Header, HttpCode, Post } from "@nestjs/common"
import { type AiProviderResponse, approveAiProviderRequestSchema } from "@eve/contracts"

import { OperatorOnly } from "../auth/operator-only.guard.js"
import { parseRequest } from "../http/parse-body.js"
import { AiProviderService } from "./ai-provider.service.js"

@Controller("v1/ai-provider")
export class AiProviderController {
  constructor(private readonly service: AiProviderService) {}

  @Get()
  @Header("cache-control", "no-store")
  describe(): Promise<AiProviderResponse> {
    return this.service.describe()
  }

  /**
   * The body names the terms version shown; a stale dashboard gets 400.
   * Writes the installation-wide `ai_provider_approval` that gates every AI call,
   * so only the Operator may record it; anyone else gets 404 (F-SEC-01, r5 K6
   * precedent). Slice C replaces it with per-Candidate `ai_terms_approval`.
   */
  @OperatorOnly()
  @Post("approval")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  approve(@Body() body: unknown): Promise<AiProviderResponse> {
    parseRequest(approveAiProviderRequestSchema, body)
    return this.service.approve()
  }
}
