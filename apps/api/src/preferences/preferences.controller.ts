import { Controller, Get, Header, Put, UseGuards } from "@nestjs/common"
import { type PreferencesResponse, type PreferencesVersionsResponse, preferencesVersionsQuerySchema } from "@eve/contracts"
import { z } from "zod"

import { ParsedBody, ZodQuery } from "../http/zod-request.js"
import { type PreferencesSave, preferencesSaveOrRefuse } from "./preferences-request.js"
import { PreferencesSaveLimitGuard } from "./preferences-save-limit.guard.js"
import { PreferencesService } from "./preferences.service.js"

/** F-TM-05: the read takes no query parameter; any one is refused. */
const noQuery = z.object({}).strict()

/**
 * `GET`/`PUT /v1/me/preferences` and `GET /v1/me/preferences/versions`
 * (contract v1.25.0, D40). Session Candidate only: no route takes a Candidate
 * ID. The global guard requires the session on all three and the CSRF header
 * on PUT. Not behind ConvertedFeatureGuard.
 */
@Controller("v1/me/preferences")
export class PreferencesController {
  constructor(private readonly service: PreferencesService) {}

  @Get()
  @Header("cache-control", "no-store")
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the pipe refuses any parameter, so the value is always {}
  read(@ZodQuery(noQuery) _query: z.output<typeof noQuery>): Promise<PreferencesResponse> {
    return this.service.read()
  }

  /** Order: session and CSRF (global guard), save limit, body bounds and shape, field validation, then the transaction. */
  @Put()
  @UseGuards(PreferencesSaveLimitGuard)
  @Header("cache-control", "no-store")
  save(@ParsedBody(preferencesSaveOrRefuse) request: PreferencesSave): Promise<PreferencesResponse> {
    return this.service.save(request.baseVersion, request.values)
  }

  @Get("versions")
  @Header("cache-control", "no-store")
  versions(@ZodQuery(preferencesVersionsQuerySchema) query: z.output<typeof preferencesVersionsQuerySchema>): Promise<PreferencesVersionsResponse> {
    return this.service.versions(query.limit, query.before)
  }
}
