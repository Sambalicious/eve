import { Body, Controller, Delete, Get, Header, HttpCode, Post, Put, UseGuards } from "@nestjs/common"
import {
  type AlertFeedsResponse,
  type HiringSearchInputsResponse,
  type RegisterAlertFeedResponse,
  type StackPostsResponse,
  type AlertFeedVerificationRequest,
  type RegisterAlertFeedRequest,
  registerAlertFeedRequestSchema,
} from "@eve/contracts"

import { JsonBodyGuard } from "../http/json-body.guard.js"
import { UuidParam } from "../http/uuid-param.js"
import { ParsedQuery, ZodBody } from "../http/zod-request.js"
import { VerificationBodyPipe, pageOrRefuse, refuseRegistration } from "./stack-posts-request.js"
import { StackPostsService } from "./stack-posts.service.js"

/**
 * EPIC-0005 routes (contract v1.15.1) and EPIC-0007 Phase 1's hiring search inputs (v1.19.0). v1.22.0 (EPIC-0008):
 * every Candidate saves and reads their own Stack posts feed verification; no route checks a role. The global guard requires the
 * Candidate's session on every route and the CSRF header on PUT, POST and
 * DELETE. Responses are `no-store`: the registration response carries the
 * full feed URL once (D-E5-5).
 */
@Controller("v1/stack-posts")
export class StackPostsController {
  constructor(private readonly service: StackPostsService) {}

  @Get()
  @Header("cache-control", "no-store")
  posts(@ParsedQuery("page", pageOrRefuse) page: number): Promise<StackPostsResponse> {
    return this.service.posts(page)
  }

  /** v1.19.0: `{ hintTerms }` from the session Candidate's Job Preferences. Session only (safe method); no parameters. */
  @Get("hiring-search-inputs")
  @Header("cache-control", "no-store")
  hiringSearchInputs(): Promise<HiringSearchInputsResponse> {
    return this.service.hiringSearchInputs()
  }

  @Get("alert-feeds")
  @Header("cache-control", "no-store")
  feeds(): Promise<AlertFeedsResponse> {
    return this.service.feeds()
  }

  /**
   * SEC-E8-02 (v1.23.1): JSON only, as the Hiring verification PUT; a form or text body is a plain 400 with no write
   * (`JsonBodyGuard`). CR-E5-01: the future-date rule sits with the other field rules, so one 400 lists every bad field.
   */
  @Put("alert-feeds/verification")
  @UseGuards(JsonBodyGuard)
  @Header("cache-control", "no-store")
  async saveVerification(@Body(VerificationBodyPipe) body: AlertFeedVerificationRequest): Promise<AlertFeedsResponse> {
    return this.service.saveVerification(body)
  }

  /** SEC-E8-02b: JSON only, as the Hiring registration; a form body is a plain 400 before validation, no request, no write. */
  @Post("alert-feeds")
  @UseGuards(JsonBodyGuard)
  @HttpCode(201)
  @Header("cache-control", "no-store")
  register(@ZodBody(registerAlertFeedRequestSchema, refuseRegistration) body: RegisterAlertFeedRequest): Promise<RegisterAlertFeedResponse> {
    return this.service.register(body)
  }

  @Delete("alert-feeds/:id")
  @HttpCode(204)
  async remove(@UuidParam("id", "bad_request") id: string): Promise<void> {
    await this.service.remove(id)
  }
}
