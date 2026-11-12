import { Body, Controller, Delete, Get, Header, Put } from "@nestjs/common"
import {
  type CandidateSettingsResponse,
  type SalaryResponse,
  setGrossSalaryRequestSchema,
  setPreferredNetPayRequestSchema,
  setWorkAuthorizationRequestSchema,
} from "@eve/contracts"

import { parseRequest } from "../http/parse-body.js"
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
  setPolicy(@Body() body: unknown): Promise<SalaryResponse> {
    return this.service.setGross("gross_salary_policy", parseRequest(setGrossSalaryRequestSchema, body))
  }

  @Delete("gross-salary-policy")
  @Header("cache-control", "no-store")
  clearPolicy(): Promise<SalaryResponse> {
    return this.service.clearGross("gross_salary_policy")
  }

  @Put("current-salary")
  @Header("cache-control", "no-store")
  setCurrent(@Body() body: unknown): Promise<SalaryResponse> {
    return this.service.setGross("current_salary", parseRequest(setGrossSalaryRequestSchema, body))
  }

  @Delete("current-salary")
  @Header("cache-control", "no-store")
  clearCurrent(): Promise<SalaryResponse> {
    return this.service.clearGross("current_salary")
  }

  @Put("preferred-net-pay")
  @Header("cache-control", "no-store")
  setNet(@Body() body: unknown): Promise<SalaryResponse> {
    return this.service.setNet(parseRequest(setPreferredNetPayRequestSchema, body))
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
  async setWorkAuthorization(@Body() body: unknown): Promise<CandidateSettingsResponse> {
    const { workAuthorization } = parseRequest(setWorkAuthorizationRequestSchema, body)
    return { workAuthorization: await this.service.setWorkAuthorization(workAuthorization) }
  }
}
