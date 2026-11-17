import { Controller, Get, Header, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common"
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
import { UuidParam } from "../http/uuid-param.js"
import { ZodBody } from "../http/zod-request.js"
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
  async create(@ZodBody(createApplicationRequestSchema) body: z.output<typeof createApplicationRequestSchema>, @Res({ passthrough: true }) reply: FastifyReply): Promise<CreateApplicationResponse> {
    const result = await this.service.createApplication(body)
    reply.status(result.created ? 201 : 200)
    return result
  }

  @Get(":id")
  @Header("cache-control", "no-store")
  read(@UuidParam("id", "not_found") id: string): Promise<ApplicationDetail> {
    return this.service.detail(id)
  }

  /** Generate or regenerate both documents. 202: generation runs in the background. */
  @Post(":id/documents/generate")
  @HttpCode(202)
  @Header("cache-control", "no-store")
  generate(@UuidParam("id", "not_found") id: string): Promise<ApplicationSummary> {
    return this.service.startGeneration(id)
  }

  @Get(":id/documents/:file")
  async download(@UuidParam("id", "not_found") id: string, @Param("file") file: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<Buffer> {
    const match = /^(resume|cover-letter)\.(pdf|docx)$/.exec(file)
    if (!match) throw new ApiException("not_found")
    const kind = match[1] === "resume" ? "resume" : "cover_letter"
    const format = match[2] === "pdf" ? "pdf" : "docx"
    const { bytes, filename } = await this.service.download(id, kind, format)
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
  update(@ZodBody(candidateContactSchema) body: z.output<typeof candidateContactSchema>): Promise<CandidateContact> {
    return this.service.updateContact(body)
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
  update(@ZodBody(atsMinimumSchema) body: z.output<typeof atsMinimumSchema>): Promise<AtsMinimum> {
    return this.service.updateAtsMinimum(body)
  }
}
