import { Controller, Delete, Get, Header, Put } from "@nestjs/common"
import {
  type CandidateSettingsResponse,
  type SalaryResponse,
  setGrossSalaryRequestSchema,
  setPreferredNetPayRequestSchema,
  setWorkAuthorizationRequestSchema,
} from "@eve/contracts"

import type { z } from "zod"

import { ZodBody } from "../http/zod-request.js"
import { SalaryService } from "./salary.service.js"

@Controller("v1/salary")
export class SalaryController {
  constructor(private readonly service: SalaryService) {}

  @Get()
  @Header("cache-control", "no-store")
  read(): Promise<SalaryResponse> {
    return this.service.read()
  }

  @Put("gross-salary-policy")
  @Header("cache-control", "no-store")
  setPolicy(@ZodBody(setGrossSalaryRequestSchema) body: z.output<typeof setGrossSalaryRequestSchema>): Promise<SalaryResponse> {
    return this.service.setGross("gross_salary_policy", body)
  }

  @Delete("gross-salary-policy")
  @Header("cache-control", "no-store")
  clearPolicy(): Promise<SalaryResponse> {
    return this.service.clearGross("gross_salary_policy")
  }

  @Put("current-salary")
  @Header("cache-control", "no-store")
  setCurrent(@ZodBody(setGrossSalaryRequestSchema) body: z.output<typeof setGrossSalaryRequestSchema>): Promise<SalaryResponse> {
    return this.service.setGross("current_salary", body)
  }

  @Delete("current-salary")
  @Header("cache-control", "no-store")
  clearCurrent(): Promise<SalaryResponse> {
    return this.service.clearGross("current_salary")
  }

  @Put("preferred-net-pay")
  @Header("cache-control", "no-store")
  setNet(@ZodBody(setPreferredNetPayRequestSchema) body: z.output<typeof setPreferredNetPayRequestSchema>): Promise<SalaryResponse> {
    return this.service.setNet(body)
  }

  @Delete("preferred-net-pay")
  @Header("cache-control", "no-store")
  clearNet(): Promise<SalaryResponse> {
    return this.service.clearNet()
  }
}

@Controller("v1/candidate-settings")
export class CandidateSettingsController {
  constructor(private readonly service: SalaryService) {}

  @Get()
  @Header("cache-control", "no-store")
  async read(): Promise<CandidateSettingsResponse> {
    return { workAuthorization: await this.service.workAuthorization() }
  }

  @Put("work-authorization")
  @Header("cache-control", "no-store")
  async setWorkAuthorization(@ZodBody(setWorkAuthorizationRequestSchema) { workAuthorization }: z.output<typeof setWorkAuthorizationRequestSchema>): Promise<CandidateSettingsResponse> {
    return { workAuthorization: await this.service.setWorkAuthorization(workAuthorization) }
  }
}
