import { Controller, Get, Header, Put, UseGuards } from "@nestjs/common"
import { type JobCriteriaRequest, type JobCriteriaResponse, jobCriteriaFieldErrors, jobCriteriaRequestSchema } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { type RequestRefusal, ZodBody } from "../http/zod-request.js"
import { JobCriteriaSaveLimitGuard } from "./job-criteria-save-limit.guard.js"
import { JobCriteriaService } from "./job-criteria.service.js"

/** A 400 names each bad field; a body that cannot be named by field (not an object, an unknown key) is a plain 400. */
function refuseCriteria(...[body, issues]: Parameters<RequestRefusal>): ApiException {
  return ApiException.badRequestWithFieldErrors(jobCriteriaFieldErrors(body, issues))
}

/**
 * `GET`/`PUT /v1/candidate-settings/job-criteria` (contract v1.13.0). The
 * global guard requires the Candidate's session on both and the CSRF header on
 * PUT. No version precondition (AC 1.4). PUT is limited to 10 attempts per
 * minute per session (v1.15.0, SEC-006).
 */
@Controller("v1/candidate-settings/job-criteria")
export class JobCriteriaController {
  constructor(private readonly service: JobCriteriaService) {}

  @Get()
  @Header("cache-control", "no-store")
  read(): Promise<JobCriteriaResponse> {
    return this.service.read()
  }

  @Put()
  @UseGuards(JobCriteriaSaveLimitGuard)
  @Header("cache-control", "no-store")
  update(@ZodBody(jobCriteriaRequestSchema, refuseCriteria) criteria: JobCriteriaRequest): Promise<JobCriteriaResponse> {
    return this.service.save(criteria)
  }
}
