import { Body, Controller, Delete, Get, Header, HttpCode, Headers, Param, Post, Put, Query } from "@nestjs/common"
import {
  type AlertFeedsResponse,
  type HiringSearchInputsResponse,
  type RegisterAlertFeedResponse,
  type StackPostsResponse,
  alertFeedVerificationRequestSchema,
  registerAlertFeedRequestSchema,
} from "@eve/contracts"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { parsePage, registrationFieldErrors, verificationFieldErrors } from "./field-errors.js"
import { requireJson } from "./require-json.js"
import { StackPostsService } from "./stack-posts.service.js"

const uuid = z.uuid()

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
  posts(@Query("page") page: unknown): Promise<StackPostsResponse> {
    const parsed = parsePage(page)
    if (parsed === null) throw ApiException.badRequestWithFieldErrors([{ field: "page", position: null, problem: "invalid" }])
    return this.service.posts(parsed)
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

  @Put("alert-feeds/verification")
  @Header("cache-control", "no-store")
  async saveVerification(@Body() body: unknown, @Headers("content-type") contentType: string | undefined): Promise<AlertFeedsResponse> {
    // SEC-E8-02 (v1.23.1): JSON only, as the Hiring verification PUT; a form or text body is a plain 400 with no write.
    requireJson(contentType)
    // CR-E5-01: the future-date rule sits with the other field rules, so one 400 lists every bad field.
    const fieldErrors = verificationFieldErrors(body, this.service.today())
    const parsed = alertFeedVerificationRequestSchema.safeParse(body)
    if (!parsed.success || fieldErrors.length > 0) throw ApiException.badRequestWithFieldErrors(fieldErrors)
    return this.service.saveVerification(parsed.data)
  }

  @Post("alert-feeds")
  @HttpCode(201)
  @Header("cache-control", "no-store")
  register(@Body() body: unknown, @Headers("content-type") contentType: string | undefined): Promise<RegisterAlertFeedResponse> {
    // SEC-E8-02b: JSON only, as the Hiring registration; a form body is a plain 400 before validation, no request, no write.
    requireJson(contentType)
    const parsed = registerAlertFeedRequestSchema.safeParse(body)
    if (!parsed.success) throw ApiException.badRequestWithFieldErrors(registrationFieldErrors(body))
    return this.service.register(parsed.data)
  }

  @Delete("alert-feeds/:id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    if (!uuid.safeParse(id).success) throw new ApiException("bad_request")
    await this.service.remove(id)
  }
}
