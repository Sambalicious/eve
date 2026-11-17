import { Controller, Get, Header, HttpCode, Param, Post, Put, Res } from "@nestjs/common"
import {
  type CheckAgainResponse,
  type EligibilitySettings,
  type JobPostingDetail,
  type JobPostingsResponse,
  type JobSourcesResponse,
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
import { ZodBody, ZodQuery } from "../http/zod-request.js"
import { DiscoveryService } from "./discovery.service.js"
import { OperatorOnly } from "../auth/operator-only.guard.js"

/** `null`, `[]` and `"x"` are bodies and are refused; only an absent body counts as `{}`. */
const checkAgainBodySchema = checkAgainRequestSchema.default({})

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
  verify(@Param("key") key: string, @ZodBody(verifyJobSourceRequestSchema) body: z.output<typeof verifyJobSourceRequestSchema>): Promise<JobSourcesResponse> {
    return this.service.verifyRemoteBoard(boardKey(key), body)
  }

  @OperatorOnly()
  @Put("remote-boards/:key/enabled")
  @Header("cache-control", "no-store")
  setEnabled(@Param("key") key: string, @ZodBody(setJobSourceEnabledRequestSchema) body: z.output<typeof setJobSourceEnabledRequestSchema>): Promise<JobSourcesResponse> {
    return this.service.setRemoteBoardEnabled(boardKey(key), body.enabled)
  }
}

@Controller("v1/job-postings")
export class JobPostingsController {
  constructor(private readonly service: DiscoveryService) {}

  @Get()
  @Header("cache-control", "no-store")
  list(@ZodQuery(jobPostingsQuerySchema) query: z.output<typeof jobPostingsQuerySchema>): Promise<JobPostingsResponse> {
    return this.service.listPostings(query)
  }

  /**
   * EPIC-0006 (v1.18.0): re-queue the session Candidate's visible failed and
   * not-checked postings. Session and CSRF (global guard). Body absent or
   * exactly `{}`; any key is a plain 400 and nothing is claimed.
   */
  @Post("check-again")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  checkAgain(@ZodBody(checkAgainBodySchema) _body: unknown): Promise<CheckAgainResponse> {
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
  async paste(@ZodBody(pasteJobLinkRequestSchema) body: z.output<typeof pasteJobLinkRequestSchema>, @Res({ passthrough: true }) reply: FastifyReply): Promise<PasteJobLinkResponse> {
    const result = await this.service.paste(body)
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
