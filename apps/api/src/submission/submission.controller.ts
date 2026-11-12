import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common"
import {
  type ExistingApplicationsResponse,
  type SampleResult,
  type Submission,
  type SubmissionListResponse,
  type SubmissionStatus,
  createExistingApplicationRequestSchema,
  submissionListViewSchema,
  reasonRequestSchema,
  setAutomaticRequestSchema,
} from "@eve/contracts"
import type { FastifyReply } from "fastify"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { parseRequest } from "../http/parse-body.js"
import { SubmissionStateService } from "./submission-state.service.js"
import { ConvertedFeature } from "../auth/converted-feature.guard.js"

/** Every route is guarded by the global session and CSRF guard (single Candidate: being signed in is ownership). */
@Controller("v1")
export class SubmissionController {
  constructor(private readonly service: SubmissionStateService) {}

  @ConvertedFeature("submission")
  @Get("submission/status")
  @Header("cache-control", "no-store")
  status(): Promise<SubmissionStatus> {
    return this.service.status()
  }

  @ConvertedFeature("submission")
  @Put("submission/automatic")
  @Header("cache-control", "no-store")
  setAutomatic(@Body() body: unknown): Promise<SubmissionStatus> {
    return this.service.setAutomatic(parseRequest(setAutomaticRequestSchema, body).enabled)
  }

  @ConvertedFeature("submission")
  @Get("submissions")
  @Header("cache-control", "no-store")
  list(@Query("view") view: unknown): Promise<SubmissionListResponse> {
    return this.service.list(parseRequest(submissionListViewSchema, view))
  }

  @ConvertedFeature("submission")
  @Get("applications/:id/submission")
  @Header("cache-control", "no-store")
  submission(@Param("id") id: string): Promise<Submission> {
    return this.service.submission(uuid(id))
  }

  @ConvertedFeature("submission")
  @Post("applications/:id/sample")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  makeSample(@Param("id") id: string): Promise<Submission> {
    return this.service.makeSample(uuid(id))
  }

  @ConvertedFeature("submission")
  @Post("applications/:id/sample/approve")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  approveSample(@Param("id") id: string): Promise<SampleResult> {
    return this.service.approveSample(uuid(id))
  }

  @ConvertedFeature("submission")
  @Post("applications/:id/sample/reject")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  rejectSample(@Param("id") id: string, @Body() body: unknown): Promise<Submission> {
    return this.service.rejectSample(uuid(id), parseRequest(reasonRequestSchema, body).reason)
  }

  @ConvertedFeature("submission")
  @Post("applications/:id/queue")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  queue(@Param("id") id: string): Promise<Submission> {
    return this.service.queue(uuid(id))
  }

  @ConvertedFeature("submission")
  @Post("applications/:id/mark-confirmed")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  markConfirmed(@Param("id") id: string): Promise<Submission> {
    return this.service.markConfirmed(uuid(id))
  }

  @ConvertedFeature("submission")
  @Post("applications/:id/mark-not-submitted")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  markNotSubmitted(@Param("id") id: string): Promise<Submission> {
    return this.service.markNotSubmitted(uuid(id))
  }

  // EPIC-0011 C3: no @ConvertedFeature. The Draft path is open to every Candidate; the service checks the capability on the blocked path.
  @Post("applications/:id/manual-complete")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  manualComplete(@Param("id") id: string): Promise<Submission> {
    return this.service.manualComplete(uuid(id))
  }

  @ConvertedFeature("submission")
  @Post("applications/:id/same-company/approve")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  approveSameCompany(@Param("id") id: string): Promise<Submission> {
    return this.service.approveSameCompany(uuid(id))
  }

  @ConvertedFeature("submission")
  @Post("applications/:id/same-company/decline")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  declineSameCompany(@Param("id") id: string, @Body() body: unknown): Promise<Submission> {
    return this.service.declineSameCompany(uuid(id), parseRequest(reasonRequestSchema, body).reason)
  }

  /**
   * v1.24.0 (AA-5): not behind ConvertedFeatureGuard, so another Candidate's id
   * is 404 before anything else (R-4702). It only leaves the queue and starts nothing.
   * The body is absent or exactly `{}`.
   */
  @Post("applications/:id/remove-from-queue")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  removeFromQueue(@Param("id") id: string, @Body() body: unknown): Promise<Submission> {
    if (body !== undefined && body !== null) parseRequest(z.object({}).strict(), body)
    return this.service.removeFromQueue(uuid(id))
  }

  @Get("existing-applications")
  @Header("cache-control", "no-store")
  existingApplications(): Promise<ExistingApplicationsResponse> {
    return this.service.existingApplications()
  }

  /** 201 when recorded; 200 with `created: false` when the same URL and requisition is already recorded (C-EXIST-3). */
  @Post("existing-applications")
  @Header("cache-control", "no-store")
  async addExistingApplication(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.service.addExistingApplication(parseRequest(createExistingApplicationRequestSchema, body))
    reply.status(result.created ? 201 : 200)
    return result
  }

  @Post("existing-applications/complete")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  completeExistingApplications(): Promise<ExistingApplicationsResponse> {
    return this.service.completeExistingApplications()
  }
}

function uuid(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new ApiException("not_found")
  return value
}
