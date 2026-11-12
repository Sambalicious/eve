import { Controller, Get, Header } from "@nestjs/common"
import type { SessionResponse } from "@eve/contracts"

import { CurrentSession } from "./current-session.decorator.js"
import type { ActiveSession } from "./session.service.js"

@Controller("v1/session")
export class SessionController {
  /** Confirms the session is active, records activity, and returns the CSRF token. */
  @Get()
  @Header("cache-control", "no-store")
  current(@CurrentSession() session: ActiveSession): SessionResponse {
    return { csrfToken: session.csrfToken }
  }
}
