import { Controller, Delete, Get, Header, HttpCode, Patch, Post } from "@nestjs/common"
import {
  type ApprovedAnswer,
  type ApprovedAnswersResponse,
  type CreateApprovedAnswerRequest,
  type UpdateApprovedAnswerRequest,
  createApprovedAnswerRequestSchema,
  updateApprovedAnswerRequestSchema,
} from "@eve/contracts"

import { UuidParam } from "../http/uuid-param.js"
import { ZodBody } from "../http/zod-request.js"
import { ApprovedAnswersService } from "./approved-answers.service.js"

@Controller("v1/approved-answers")
export class ApprovedAnswersController {
  constructor(private readonly service: ApprovedAnswersService) {}

  @Get()
  @Header("cache-control", "no-store")
  async list(): Promise<ApprovedAnswersResponse> {
    return { answers: await this.service.list() }
  }

  @Post()
  @Header("cache-control", "no-store")
  create(@ZodBody(createApprovedAnswerRequestSchema) body: CreateApprovedAnswerRequest): Promise<ApprovedAnswer> {
    return this.service.create(body)
  }

  @Patch(":id")
  @Header("cache-control", "no-store")
  update(@UuidParam("id", "not_found") id: string, @ZodBody(updateApprovedAnswerRequestSchema) body: UpdateApprovedAnswerRequest): Promise<ApprovedAnswer> {
    return this.service.update(id, body.value)
  }

  @Delete(":id")
  @HttpCode(204)
  delete(@UuidParam("id", "not_found") id: string): Promise<void> {
    return this.service.delete(id)
  }
}
