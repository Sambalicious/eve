import { Body, Controller, Get, Header, HttpCode, Param, Post, Put } from "@nestjs/common"
import { type MeResponse, meNoteSchema, setAdvancedRequestSchema } from "@eve/contracts"

import { CurrentSession } from "../auth/current-session.decorator.js"
import type { ActiveSession } from "../auth/session.service.js"
import { ApiException } from "../http/api-exception.js"
import { MeService } from "./me.service.js"

/**
 * `GET /v1/me` (EPIC-0002 A2) plus the EPIC-0011 C2 writes (contract v1.28.0):
 * `PUT /v1/me/advanced` and `POST /v1/me/notes/:note/dismiss`. Session Candidate
 * only: no route takes a Candidate ID. Not behind ConvertedFeatureGuard.
 */
@Controller("v1/me")
export class MeController {
  constructor(private readonly service: MeService) {}

  @Get()
  @Header("cache-control", "no-store")
  me(@CurrentSession() session: ActiveSession): Promise<MeResponse> {
    return this.service.read(session.candidateId)
  }

  @Put("advanced")
  @Header("cache-control", "no-store")
  setAdvanced(@CurrentSession() session: ActiveSession, @Body() body: unknown): Promise<MeResponse> {
    const parsed = setAdvancedRequestSchema.safeParse(body)
    if (!parsed.success) throw new ApiException("bad_request")
    return this.service.setAdvanced(session.candidateId, parsed.data.enabled)
  }

  /** Any body is ignored. An unknown note is 404 before anything is written. */
  @Post("notes/:note/dismiss")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  dismiss(@CurrentSession() session: ActiveSession, @Param("note") note: string): Promise<MeResponse> {
    const parsed = meNoteSchema.safeParse(note)
    if (!parsed.success) throw new ApiException("not_found")
    return this.service.dismiss(session.candidateId, parsed.data)
  }
}
