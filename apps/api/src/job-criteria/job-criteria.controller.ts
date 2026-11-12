import { Body, Controller, Get, Header, Put, UseGuards } from "@nestjs/common"
import { type JobCriteriaResponse, jobCriteriaFieldErrors, jobCriteriaRequestSchema } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { JobCriteriaSaveLimitGuard } from "./job-criteria-save-limit.guard.js"
import { JobCriteriaService } from "./job-criteria.service.js"

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
  update(@Body() body: unknown): Promise<JobCriteriaResponse> {
    const parsed = jobCriteriaRequestSchema.safeParse(body)
    if (!parsed.success) throw ApiException.badRequestWithFieldErrors(jobCriteriaFieldErrors(body, parsed.error.issues))
    return this.service.save(parsed.data)
  }
}
