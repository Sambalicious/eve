import { Controller, Header, HttpCode, Post } from "@nestjs/common"
import { type ExtensionFillResponse, extensionFillRequestSchema } from "@eve/contracts"

import { CurrentSession } from "../auth/current-session.decorator.js"
import type { ActiveSession } from "../auth/session.service.js"
import type { z } from "zod"

import { ZodBody } from "../http/zod-request.js"
import { ExtensionService } from "./extension.service.js"

/**
 * ADR 0016: `POST /v1/extension/fill`, called by the content script in the
 * Candidate's own Eve tab. The global `AuthGuard` is the whole authentication:
 * the Eve session cookie, and `x-csrf-token` on this state-changing method. No
 * extension token exists. The route writes nothing, so it carries no
 * `@ConvertedFeature` gate: a draft Candidate may still fill a form.
 */
@Controller("v1")
export class ExtensionController {
  constructor(private readonly service: ExtensionService) {}

  @Post("extension/fill")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  fill(@CurrentSession() session: ActiveSession, @ZodBody(extensionFillRequestSchema) body: z.output<typeof extensionFillRequestSchema>): Promise<ExtensionFillResponse> {
    return this.service.fill(body, session.candidateId)
  }
}
