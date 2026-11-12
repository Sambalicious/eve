import { Controller, Delete, Get, Header, HttpCode, Param, Put, Body } from "@nestjs/common"
import { type Lead, type LeadStage, leadRequestSchema, type LeadsResponse } from "@eve/contracts"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { LeadsService } from "./leads.service.js"

const uuidSchema = z.uuid()

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
  async upsert(@Param("jobPostingId") jobPostingId: string, @Body() body: unknown): Promise<Lead> {
    const id = uuidSchema.safeParse(jobPostingId)
    if (!id.success) throw new ApiException("bad_request")
    const parsed = leadRequestSchema.safeParse(body)
    if (!parsed.success) throw new ApiException("bad_request")
    const lead = await this.service.setStage(id.data, parsed.data.stage as LeadStage)
    if (!lead) throw new ApiException("not_found")
    return lead
  }

  @Delete(":jobPostingId")
  @HttpCode(204)
  async remove(@Param("jobPostingId") jobPostingId: string): Promise<void> {
    const id = uuidSchema.safeParse(jobPostingId)
    if (!id.success) throw new ApiException("bad_request")
    await this.service.remove(id.data)
  }
}
