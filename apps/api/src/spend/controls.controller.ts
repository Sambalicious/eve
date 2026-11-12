import { Body, Controller, Get, Header, Put } from "@nestjs/common"
import { type Controls, type RaiseCeilingResponse, raiseCeilingRequestSchema, setGlobalPauseRequestSchema } from "@eve/contracts"

import { parseRequest } from "../http/parse-body.js"
import { ControlsService } from "./controls.service.js"
import { ConvertedFeature } from "../auth/converted-feature.guard.js"

/** Guarded by the global session and CSRF guard: only the signed-in Candidate. */
@ConvertedFeature("spend")
@Controller("v1/controls")
export class ControlsController {
  constructor(private readonly service: ControlsService) {}

  @Get()
  @Header("cache-control", "no-store")
  controls(): Promise<Controls> {
    return this.service.controls()
  }

  @Put("global-pause")
  @Header("cache-control", "no-store")
  setGlobalPause(@Body() body: unknown): Promise<Controls> {
    return this.service.setGlobalPause(parseRequest(setGlobalPauseRequestSchema, body).paused)
  }

  @Put("ceiling")
  @Header("cache-control", "no-store")
  raiseCeiling(@Body() body: unknown): Promise<RaiseCeilingResponse> {
    const request = parseRequest(raiseCeilingRequestSchema, body)
    return this.service.raiseCeiling(request.month, request.ceiling)
  }
}
