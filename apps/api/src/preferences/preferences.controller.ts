import { Body, Controller, Get, Header, Put, Query, UseGuards } from "@nestjs/common"
import { type PreferencesResponse, type PreferencesVersionsResponse, preferencesVersionsQuerySchema } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { parseSaveBody } from "./preferences-rules.js"
import { PreferencesSaveLimitGuard } from "./preferences-save-limit.guard.js"
import { PreferencesService } from "./preferences.service.js"

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
  read(@Query() query: Record<string, unknown>): Promise<PreferencesResponse> {
    // F-TM-05: this GET takes no query parameter; any one is refused.
    if (Object.keys(query ?? {}).length > 0) throw new ApiException("bad_request")
    return this.service.read()
  }

  /** Order: session and CSRF (global guard), save limit, body bounds and shape, field validation, then the transaction. */
  @Put()
  @UseGuards(PreferencesSaveLimitGuard)
  @Header("cache-control", "no-store")
  save(@Body() body: unknown): Promise<PreferencesResponse> {
    const parsed = parseSaveBody(body)
    if (parsed.kind === "bad_request") throw new ApiException("bad_request")
    if (parsed.kind === "field_errors") throw ApiException.badRequestWithFieldErrors(parsed.fieldErrors)
    return this.service.save(parsed.baseVersion, parsed.values)
  }

  @Get("versions")
  @Header("cache-control", "no-store")
  versions(@Query() query: Record<string, unknown>): Promise<PreferencesVersionsResponse> {
    const parsed = preferencesVersionsQuerySchema.safeParse(query ?? {})
    if (!parsed.success) throw new ApiException("bad_request")
    return this.service.versions(parsed.data.limit, parsed.data.before)
  }
}
