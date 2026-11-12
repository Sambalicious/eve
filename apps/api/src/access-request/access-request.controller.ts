import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post, Req } from "@nestjs/common"
import { ACCESS_REQUEST_PATH, ACCESS_REQUEST_PROOF_PATH, type AccessRequestAccepted, type AccessRequestProof } from "@eve/contracts"
import type { FastifyRequest } from "fastify"

import { Public, PublicWrite } from "../auth/public.decorator.js"
import { AccessRequestService } from "./access-request.service.js"

const RECEIVED: AccessRequestAccepted = Object.freeze({ status: "received" })

/**
 * EPIC-0003 public request access. Neither route reads a cookie. Both send
 * `cache-control: no-store` (also set by the transport gate for refusals).
 */
@Controller()
export class AccessRequestController {
  constructor(private readonly service: AccessRequestService) {}

  @Get(ACCESS_REQUEST_PROOF_PATH.slice(1))
  @Public()
  @Header("cache-control", "no-store")
  proof(): AccessRequestProof {
    return this.service.proof()
  }

  /** Every accepted, coalesced or silently dropped request gets this same 202. */
  @Post(ACCESS_REQUEST_PATH.slice(1))
  @PublicWrite()
  @HttpCode(HttpStatus.ACCEPTED)
  @Header("cache-control", "no-store")
  async create(@Body() body: unknown, @Req() request: FastifyRequest): Promise<AccessRequestAccepted> {
    await this.service.submit(body, request.ip)
    return RECEIVED
  }
}
