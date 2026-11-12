import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post } from "@nestjs/common"
import {
  type ApprovedAnswer,
  type ApprovedAnswersResponse,
  createApprovedAnswerRequestSchema,
  updateApprovedAnswerRequestSchema,
} from "@eve/contracts"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { parseRequest } from "../http/parse-body.js"
import { ApprovedAnswersService } from "./approved-answers.service.js"

const answerIdSchema = z.uuid()

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
  create(@Body() body: unknown): Promise<ApprovedAnswer> {
    return this.service.create(parseRequest(createApprovedAnswerRequestSchema, body))
  }

  @Patch(":id")
  @Header("cache-control", "no-store")
  update(@Param("id") id: string, @Body() body: unknown): Promise<ApprovedAnswer> {
    return this.service.update(answerId(id), parseRequest(updateApprovedAnswerRequestSchema, body).value)
  }

  @Delete(":id")
  @HttpCode(204)
  delete(@Param("id") id: string): Promise<void> {
    return this.service.delete(answerId(id))
  }
}

/** A malformed id names no answer: 404, the same as an unknown one. */
function answerId(raw: string): string {
  const result = answerIdSchema.safeParse(raw)
  if (!result.success) throw new ApiException("not_found")
  return result.data
}
