import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post } from "@nestjs/common"
import {
  type DeleteDetailsResponse,
  type MinimalRecordsResponse,
  type Outcome,
  type OutcomesResponse,
  type RetentionResponse,
  deleteDetailsRequestSchema,
  outcomeRequestSchema,
} from "@eve/contracts"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { parseRequest } from "../http/parse-body.js"
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
  outcomes(@Param("id") id: string): Promise<OutcomesResponse> {
    return this.service.outcomes(uuid(id))
  }

  @Post("applications/:id/outcomes")
  @HttpCode(201)
  @Header("cache-control", "no-store")
  record(@Param("id") id: string, @Body() body: unknown): Promise<Outcome> {
    return this.service.recordOutcome(uuid(id), parseRequest(outcomeRequestSchema, body).type)
  }

  @Patch("outcomes/:id")
  @Header("cache-control", "no-store")
  edit(@Param("id") id: string, @Body() body: unknown): Promise<Outcome> {
    return this.service.editOutcome(uuid(id), parseRequest(outcomeRequestSchema, body).type)
  }

  @Post("applications/delete-details")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  deleteDetails(@Body() body: unknown): Promise<DeleteDetailsResponse> {
    return this.service.deleteDetails(parseRequest(deleteDetailsRequestSchema, body).applicationIds)
  }

  @Get("minimal-records")
  @Header("cache-control", "no-store")
  minimalRecords(): Promise<MinimalRecordsResponse> {
    return this.service.minimalRecords()
  }

  @Delete("minimal-records/:id")
  @HttpCode(204)
  async clear(@Param("id") id: string): Promise<void> {
    await this.service.clearMinimalRecord(uuid(id))
  }
}

function uuid(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new ApiException("not_found")
  return value
}
