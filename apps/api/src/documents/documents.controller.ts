import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common"
import {
  type ApplicationDetail,
  type ApplicationSummary,
  type ApplicationsResponse,
  type CandidateContact,
  type CreateApplicationResponse,
  type DocumentsListResponse,
  applicationsRetentionFilterSchema,
  candidateContactSchema,
  createApplicationRequestSchema,
  type AtsMinimum,
  atsMinimumSchema,
} from "@eve/contracts"
import type { FastifyReply } from "fastify"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { parseRequest } from "../http/parse-body.js"
import { DocumentsService } from "./documents.service.js"

const MEDIA_TYPE = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const

/** Every route is guarded by the global session and CSRF guard (single Candidate: being signed in is ownership). */
@Controller("v1/applications")
export class ApplicationsController {
  constructor(private readonly service: DocumentsService) {}

  /** E5.7 (D-E11): `?retention=due|waiting` filters; any other value, a repeated or an empty one is ignored (full list, no error). */
  @Get()
  @Header("cache-control", "no-store")
  list(@Query("retention") retention: unknown): Promise<ApplicationsResponse> {
    const filter = applicationsRetentionFilterSchema.safeParse(retention)
    return this.service.list(filter.success ? filter.data : null)
  }

  /** 201 with `created: true`; 200 with `created: false` when the requisition already has an Application. */
  @Post()
  @Header("cache-control", "no-store")
  async create(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply): Promise<CreateApplicationResponse> {
    const result = await this.service.createApplication(parseRequest(createApplicationRequestSchema, body))
    reply.status(result.created ? 201 : 200)
    return result
  }

  @Get(":id")
  @Header("cache-control", "no-store")
  read(@Param("id") id: string): Promise<ApplicationDetail> {
    return this.service.detail(uuid(id))
  }

  /** Generate or regenerate both documents. 202: generation runs in the background. */
  @Post(":id/documents/generate")
  @HttpCode(202)
  @Header("cache-control", "no-store")
  generate(@Param("id") id: string): Promise<ApplicationSummary> {
    return this.service.startGeneration(uuid(id))
  }

  @Get(":id/documents/:file")
  async download(@Param("id") id: string, @Param("file") file: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<Buffer> {
    const match = /^(resume|cover-letter)\.(pdf|docx)$/.exec(file)
    if (!match) throw new ApiException("not_found")
    const kind = match[1] === "resume" ? "resume" : "cover_letter"
    const format = match[2] === "pdf" ? "pdf" : "docx"
    const { bytes, filename } = await this.service.download(uuid(id), kind, format)
    reply
      .header("content-type", MEDIA_TYPE[format])
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .header("content-security-policy", "sandbox; default-src 'none'")
    return bytes
  }
}

@Controller("v1/documents")
export class DocumentsListController {
  constructor(private readonly service: DocumentsService) {}

  @Get()
  @Header("cache-control", "no-store")
  list(): Promise<DocumentsListResponse> {
    return this.service.documentsList()
  }
}

@Controller("v1/candidate-settings/contact")
export class CandidateContactController {
  constructor(private readonly service: DocumentsService) {}

  @Get()
  @Header("cache-control", "no-store")
  read(): Promise<CandidateContact> {
    return this.service.contact()
  }

  @Put()
  @Header("cache-control", "no-store")
  update(@Body() body: unknown): Promise<CandidateContact> {
    return this.service.updateContact(parseRequest(candidateContactSchema, body))
  }
}

/** v1.26.0 (ATS): the minimum ATS match for automatic submission. */
@Controller("v1/candidate-settings/ats")
export class AtsMinimumController {
  constructor(private readonly service: DocumentsService) {}

  @Get()
  @Header("cache-control", "no-store")
  read(): Promise<AtsMinimum> {
    return this.service.atsMinimum()
  }

  @Put()
  @Header("cache-control", "no-store")
  update(@Body() body: unknown): Promise<AtsMinimum> {
    return this.service.updateAtsMinimum(parseRequest(atsMinimumSchema, body))
  }
}

function uuid(id: string): string {
  if (!z.uuid().safeParse(id).success) throw new ApiException("not_found")
  return id
}
