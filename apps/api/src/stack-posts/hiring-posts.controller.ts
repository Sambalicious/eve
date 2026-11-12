import { Body, Controller, Delete, Get, Header, HttpCode, Headers, Param, Post, Put, Query } from "@nestjs/common"
import {
  type HiringAlertFeedsResponse,
  type HiringPostsResponse,
  type RegisterAlertFeedResponse,
  alertFeedVerificationRequestSchema,
  registerAlertFeedRequestSchema,
} from "@eve/contracts"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { parsePage, registrationFieldErrors, verificationFieldErrors } from "./field-errors.js"
import { HiringPostsService } from "./hiring-posts.service.js"
import { requireJson } from "./require-json.js"

const uuid = z.uuid()

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

  /** The caller's own record. Every field error at once; a non-object body or an unknown key is a plain 400. */
  @Put("hiring-feeds/verification")
  @Header("cache-control", "no-store")
  async saveVerification(@Body() body: unknown, @Headers("content-type") contentType: string | undefined): Promise<HiringAlertFeedsResponse> {
    requireJson(contentType)
    const fieldErrors = verificationFieldErrors(body, this.service.today())
    const parsed = alertFeedVerificationRequestSchema.safeParse(body)
    if (!parsed.success || fieldErrors.length > 0) throw ApiException.badRequestWithFieldErrors(fieldErrors)
    return this.service.saveVerification(parsed.data)
  }

  @Post("hiring-feeds")
  @HttpCode(201)
  @Header("cache-control", "no-store")
  async register(@Body() body: unknown, @Headers("content-type") contentType: string | undefined): Promise<RegisterAlertFeedResponse> {
    requireJson(contentType)
    const parsed = registerAlertFeedRequestSchema.safeParse(body)
    if (!parsed.success) throw ApiException.badRequestWithFieldErrors(registrationFieldErrors(body))
    return this.service.register(parsed.data)
  }

  @Delete("hiring-feeds/:id")
  @HttpCode(204)
  @Header("cache-control", "no-store")
  async remove(@Param("id") id: string): Promise<void> {
    if (!uuid.safeParse(id).success) throw new ApiException("bad_request")
    await this.service.remove(id)
  }

  @Get("hiring-posts")
  @Header("cache-control", "no-store")
  async posts(@Query("page") page: unknown): Promise<HiringPostsResponse> {
    const parsed = parsePage(page)
    if (parsed === null) throw ApiException.badRequestWithFieldErrors([{ field: "page", position: null, problem: "invalid" }])
    return this.service.posts(parsed)
  }
}
