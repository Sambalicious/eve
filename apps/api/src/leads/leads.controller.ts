import { Controller, Delete, Get, Header, HttpCode, Put } from "@nestjs/common"
import { type Lead, type LeadRequest, type LeadStage, leadRequestSchema, type LeadsResponse } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { UuidParam } from "../http/uuid-param.js"
import { ZodBody } from "../http/zod-request.js"
import { LeadsService } from "./leads.service.js"

/**
 * v1.29.0 lead pipeline. The global guard requires the Candidate's session on
 * all three routes and the CSRF header on PUT and DELETE. A posting the
 * Candidate does not hold is `404 not_found`, so a lead can never be attached to
 * someone else's posting.
 */
@Controller("v1/leads")
export class LeadsController {
  constructor(private readonly service: LeadsService) {}

  @Get()
  @Header("cache-control", "no-store")
  list(): Promise<LeadsResponse> {
    return this.service.list()
  }

  @Put(":jobPostingId")
  @Header("cache-control", "no-store")
  async upsert(@UuidParam("jobPostingId", "bad_request") id: string, @ZodBody(leadRequestSchema) body: LeadRequest): Promise<Lead> {
    const lead = await this.service.setStage(id, body.stage as LeadStage)
    if (!lead) throw new ApiException("not_found")
    return lead
  }

  @Delete(":jobPostingId")
  @HttpCode(204)
  async remove(@UuidParam("jobPostingId", "bad_request") id: string): Promise<void> {
    await this.service.remove(id)
  }
}
