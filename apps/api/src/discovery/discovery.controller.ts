import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common"
import {
  type CheckAgainResponse,
  type EligibilitySettings,
  type JobPostingDetail,
  type JobPostingsResponse,
  type JobSourcesResponse,
  type PasteJobLinkRequest,
  type PasteJobLinkResponse,
  checkAgainRequestSchema,
  jobPostingsQuerySchema,
  pasteJobLinkRequestSchema,
  remoteBoardKeySchema,
  setJobSourceEnabledRequestSchema,
  verifyJobSourceRequestSchema,
} from "@eve/contracts"
import type { FastifyReply } from "fastify"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { parseRequest } from "../http/parse-body.js"
import { DiscoveryService } from "./discovery.service.js"
import { OperatorOnly } from "../auth/operator-only.guard.js"

/** Every route is guarded by the global session and CSRF guard (Candidate only). */
@Controller("v1/job-sources")
export class JobSourcesController {
  constructor(private readonly service: DiscoveryService) {}

  @Get()
  @Header("cache-control", "no-store")
  read(): Promise<JobSourcesResponse> {
    return this.service.jobSources()
  }

  @OperatorOnly()
  @Post("employer-list/approve")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  approve(): Promise<JobSourcesResponse> {
    return this.service.approveEmployerList()
  }

  @OperatorOnly()
  @Put("remote-boards/:key/verification")
  @Header("cache-control", "no-store")
  verify(@Param("key") key: string, @Body() body: unknown): Promise<JobSourcesResponse> {
    return this.service.verifyRemoteBoard(boardKey(key), parseRequest(verifyJobSourceRequestSchema, body))
  }

  @OperatorOnly()
  @Put("remote-boards/:key/enabled")
  @Header("cache-control", "no-store")
  setEnabled(@Param("key") key: string, @Body() body: unknown): Promise<JobSourcesResponse> {
    return this.service.setRemoteBoardEnabled(boardKey(key), parseRequest(setJobSourceEnabledRequestSchema, body).enabled)
  }
}

@Controller("v1/job-postings")
export class JobPostingsController {
  constructor(private readonly service: DiscoveryService) {}

  @Get()
  @Header("cache-control", "no-store")
  list(@Query() query: unknown): Promise<JobPostingsResponse> {
    return this.service.listPostings(parseRequest(jobPostingsQuerySchema, query))
  }

  /**
   * EPIC-0006 (v1.18.0): re-queue the session Candidate's visible failed and
   * not-checked postings. Session and CSRF (global guard). Body absent or
   * exactly `{}`; any key is a plain 400 and nothing is claimed.
   */
  @Post("check-again")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  checkAgain(@Body() body: unknown): Promise<CheckAgainResponse> {
    // `null`, `[]` and `"x"` are bodies and are refused; only an absent body counts as `{}`.
    parseRequest(checkAgainRequestSchema, body === undefined ? {} : body)
    return this.service.checkAgain()
  }

  @Get(":id")
  @Header("cache-control", "no-store")
  read(@Param("id") id: string): Promise<JobPostingDetail> {
    if (!z.uuid().safeParse(id).success) throw new ApiException("not_found")
    return this.service.posting(id)
  }

  /**
   * 201 with `created: true` for a new posting; 200 with `created: false` when already stored (C-LINK-2).
   * v1.27.0 (EPIC-0010): an optional `description`, `title` and `company` beside `url`. The body is never logged.
   */
  @Post("links")
  @Header("cache-control", "no-store")
  async paste(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply): Promise<PasteJobLinkResponse> {
    const result = await this.service.paste(parsePaste(body))
    reply.status(result.created ? 201 : 200)
    return result
  }
}

/**
 * v1.25.0 (EPIC-0002 B1): only the read stays. It returns the installation row,
 * now frozen and read by no rule; `PUT` was removed (404) because the hours live
 * in each Candidate's Job Preferences (`/v1/me/preferences`).
 */
@Controller("v1/eligibility-settings")
export class EligibilitySettingsController {
  constructor(private readonly service: DiscoveryService) {}

  @Get()
  @Header("cache-control", "no-store")
  read(): Promise<EligibilitySettings> {
    return this.service.eligibilitySettings()
  }
}

function boardKey(key: string): string {
  if (!remoteBoardKeySchema.safeParse(key).success) throw new ApiException("not_found")
  return key
}

/** A body that does not fit the schema (no `url` or `description` key, unknown keys, non-strings, over the raw caps) is a 400. */
function parsePaste(body: unknown): PasteJobLinkRequest {
  return parseRequest(pasteJobLinkRequestSchema, body)
}
