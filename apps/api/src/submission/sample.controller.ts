import { Controller, Get, Header, HttpCode, Param, Post } from "@nestjs/common"
import { type FormAnswersResponse, type PrepareSamplesResult, type SamplesResponse, type SubmissionSummary, sampleStateSchema } from "@eve/contracts"
import { z } from "zod"

import { ApiException } from "../http/api-exception.js"
import { ZodQuery } from "../http/zod-request.js"
import { SampleService } from "./sample.service.js"
import { ConvertedFeature } from "../auth/converted-feature.guard.js"

/** Activation Gate samples, the dashboard counts and sample form answers (v1.7.0). Session- and CSRF-guarded globally. */
@Controller("v1")
export class SampleController {
  constructor(private readonly service: SampleService) {}

  @ConvertedFeature("submission")
  @Get("samples")
  @Header("cache-control", "no-store")
  list(@ZodQuery("state", sampleStateSchema) state: z.output<typeof sampleStateSchema>): Promise<SamplesResponse> {
    return this.service.list(state)
  }

  @ConvertedFeature("submission")
  @Post("samples/prepare")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  prepare(): Promise<PrepareSamplesResult> {
    return this.service.prepare()
  }

  @ConvertedFeature("submission")
  @Get("submissions/summary")
  @Header("cache-control", "no-store")
  summary(): Promise<SubmissionSummary> {
    return this.service.summary()
  }

  @ConvertedFeature("submission")
  @Get("applications/:id/form-answers")
  @Header("cache-control", "no-store")
  formAnswers(@Param("id") id: string): Promise<FormAnswersResponse> {
    if (!z.uuid().safeParse(id).success) throw new ApiException("not_found")
    return this.service.formAnswers(id)
  }
}
