import { Body, Controller, Delete, Get, Header, HttpCode, Post, Put, UseGuards } from "@nestjs/common"
import {
  type HiringAlertFeedsResponse,
  type HiringPostsResponse,
  type RegisterAlertFeedResponse,
  type AlertFeedVerificationRequest,
  type RegisterAlertFeedRequest,
  registerAlertFeedRequestSchema,
} from "@eve/contracts"

import { JsonBodyGuard } from "../http/json-body.guard.js"
import { UuidParam } from "../http/uuid-param.js"
import { ParsedQuery, ZodBody } from "../http/zod-request.js"
import { HiringPostsService } from "./hiring-posts.service.js"
import { VerificationBodyPipe, pageOrRefuse, refuseRegistration } from "./stack-posts-request.js"

/**
 * EPIC-0007 Phase 3 routes (contract v1.20.0). The global guard requires the
 * Candidate's session on every route and the CSRF header on PUT, POST and
 * DELETE. There is no role check on any route (D14): every Candidate manages
 * their own record, feeds and posts. No route takes a Candidate id. Responses
 * are `no-store`: the registration response carries the full feed URL once.
 */
@Controller("v1/stack-posts")
export class HiringPostsController {
  constructor(private readonly service: HiringPostsService) {}

  @Get("hiring-feeds")
  @Header("cache-control", "no-store")
  feeds(): Promise<HiringAlertFeedsResponse> {
    return this.service.feeds()
  }

  /** The caller's own record. JSON only; every field error at once; a non-object body or an unknown key is a plain 400. */
  @Put("hiring-feeds/verification")
  @UseGuards(JsonBodyGuard)
  @Header("cache-control", "no-store")
  async saveVerification(@Body(VerificationBodyPipe) body: AlertFeedVerificationRequest): Promise<HiringAlertFeedsResponse> {
    return this.service.saveVerification(body)
  }

  @Post("hiring-feeds")
  @UseGuards(JsonBodyGuard)
  @HttpCode(201)
  @Header("cache-control", "no-store")
  async register(@ZodBody(registerAlertFeedRequestSchema, refuseRegistration) body: RegisterAlertFeedRequest): Promise<RegisterAlertFeedResponse> {
    return this.service.register(body)
  }

  @Delete("hiring-feeds/:id")
  @HttpCode(204)
  @Header("cache-control", "no-store")
  async remove(@UuidParam("id", "bad_request") id: string): Promise<void> {
    await this.service.remove(id)
  }

  @Get("hiring-posts")
  @Header("cache-control", "no-store")
  async posts(@ParsedQuery("page", pageOrRefuse) page: number): Promise<HiringPostsResponse> {
    return this.service.posts(page)
  }
}
