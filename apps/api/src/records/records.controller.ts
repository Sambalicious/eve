import { Controller, Delete, Get, Header, HttpCode, Patch, Post } from "@nestjs/common"
import {
  type DeleteDetailsRequest,
  type DeleteDetailsResponse,
  type MinimalRecordsResponse,
  type Outcome,
  type OutcomeRequest,
  type OutcomesResponse,
  type RetentionResponse,
  deleteDetailsRequestSchema,
  outcomeRequestSchema,
} from "@eve/contracts"

import { UuidParam } from "../http/uuid-param.js"
import { ZodBody } from "../http/zod-request.js"
import { RecordsService } from "./records.service.js"
import { RetentionService } from "./retention.service.js"

/** Every route is guarded by the global session and CSRF guard: only the signed-in Candidate. */
@Controller("v1")
export class RecordsController {
  constructor(
    private readonly service: RecordsService,
    private readonly retention: RetentionService
  ) {}

  /** E5.6: counts and dates for the Retention section on /privacy. Read-only; nothing here starts or stops the job (D-E8). */
  @Get("retention")
  @Header("cache-control", "no-store")
  retentionFacts(): Promise<RetentionResponse> {
    return this.retention.read()
  }

  @Get("applications/:id/outcomes")
  @Header("cache-control", "no-store")
  outcomes(@UuidParam("id", "not_found") id: string): Promise<OutcomesResponse> {
    return this.service.outcomes(id)
  }

  @Post("applications/:id/outcomes")
  @HttpCode(201)
  @Header("cache-control", "no-store")
  record(@UuidParam("id", "not_found") id: string, @ZodBody(outcomeRequestSchema) body: OutcomeRequest): Promise<Outcome> {
    return this.service.recordOutcome(id, body.type)
  }

  @Patch("outcomes/:id")
  @Header("cache-control", "no-store")
  edit(@UuidParam("id", "not_found") id: string, @ZodBody(outcomeRequestSchema) body: OutcomeRequest): Promise<Outcome> {
    return this.service.editOutcome(id, body.type)
  }

  @Post("applications/delete-details")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  deleteDetails(@ZodBody(deleteDetailsRequestSchema) body: DeleteDetailsRequest): Promise<DeleteDetailsResponse> {
    return this.service.deleteDetails(body.applicationIds)
  }

  @Get("minimal-records")
  @Header("cache-control", "no-store")
  minimalRecords(): Promise<MinimalRecordsResponse> {
    return this.service.minimalRecords()
  }

  @Delete("minimal-records/:id")
  @HttpCode(204)
  async clear(@UuidParam("id", "not_found") id: string): Promise<void> {
    await this.service.clearMinimalRecord(id)
  }
}
