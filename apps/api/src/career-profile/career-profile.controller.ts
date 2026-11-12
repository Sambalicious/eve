import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Logger, Param, Post, Put, Req } from "@nestjs/common"
import {
  type CareerProfileResponse,
  type CareerProfileVersion,
  RESUME_FILE_FIELD,
  RESUME_MAX_BYTES,
  approveCareerProfileDraftRequestSchema,
  saveCareerProfileDraftRequestSchema,
} from "@eve/contracts"
import type { FastifyRequest } from "fastify"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { parseRequest } from "../http/parse-body.js"
import { CareerProfileService } from "./career-profile.service.js"
import { sniffResumeType } from "./resume-file-type.js"
import { displayFilename } from "./resume-storage.js"
import { refusalReasonFor } from "./refusal-reason.js"
import { EXTRACTION_CHILD, EXTRACTION_LIMITS, type ExtractionChild, runResumeExtraction } from "./resume-text.js"

const versionSchema = z.coerce.number().int().positive().max(1_000_000)
const discardQuerySchema = z.object({ version: z.coerce.number().int().positive().optional() }).strict()

@Controller("v1/career-profile")
export class CareerProfileController {
  private readonly logger = new Logger(CareerProfileController.name)

  constructor(
    private readonly service: CareerProfileService,
    @Inject(EXTRACTION_CHILD) private readonly extractionChild: ExtractionChild
  ) {}

  @Get()
  @Header("cache-control", "no-store")
  read(): Promise<CareerProfileResponse> {
    return this.service.read()
  }

  @Get("versions/:version")
  @Header("cache-control", "no-store")
  readVersion(@Param("version") raw: string): Promise<CareerProfileVersion> {
    const version = versionSchema.safeParse(raw)
    if (!version.success) throw new ApiException("not_found")
    return this.service.readVersion(version.data)
  }

  /**
   * `multipart/form-data` with one part named `resume`. Approval is checked
   * before the body is read. The type is decided from the bytes; the size limit
   * is enforced while streaming. Answers 202 with the drafting state.
   */
  @Post("resume")
  @HttpCode(202)
  @Header("cache-control", "no-store")
  async uploadResume(@Req() request: FastifyRequest): Promise<CareerProfileResponse> {
    await this.service.assertCanDraftFromResume()
    if (!request.isMultipart()) throw new ApiException("unsupported_media_type")
    const file = await request.file().catch(() => undefined)
    if (!file || file.fieldname !== RESUME_FILE_FIELD) throw new ApiException("resume_file_invalid")
    const bytes = await file.toBuffer().catch((error: { code?: string }) => {
      throw new ApiException(error.code === "FST_REQ_FILE_TOO_LARGE" ? "resume_file_invalid" : "bad_request")
    })
    if (bytes.length === 0 || bytes.length > RESUME_MAX_BYTES) throw new ApiException("resume_file_invalid")
    const mediaType = sniffResumeType(bytes)
    if (!mediaType) throw new ApiException("resume_file_invalid")
    // Bounded child process (SEC-201). The reason names a limit, never file content.
    const extraction = await runResumeExtraction(mediaType, bytes, EXTRACTION_LIMITS, this.extractionChild)
    if (!extraction.ok) {
      this.logger.log(`Resume refused as unreadable: ${extraction.reason}`)
      throw ApiException.resumeUnreadable(refusalReasonFor(extraction.reason))
    }
    return this.service.draftFromResume({ filename: displayFilename(file.filename), mediaType, bytes, text: extraction.text })
  }

  /** Creates the draft from the approved version, or replaces the draft's content. */
  @Put("draft")
  @Header("cache-control", "no-store")
  saveDraft(@Body() body: unknown): Promise<CareerProfileVersion> {
    return this.service.saveDraft(parseRequest(saveCareerProfileDraftRequestSchema, body))
  }

  @Post("draft/approve")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  approve(@Body() body: unknown): Promise<CareerProfileResponse> {
    return this.service.approveDraft(parseRequest(approveCareerProfileDraftRequestSchema, body).version)
  }

  @Delete("draft")
  @HttpCode(204)
  discard(@Req() request: FastifyRequest): Promise<void> {
    return this.service.discardDraft(parseRequest(discardQuerySchema, request.query).version)
  }
}
