import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { CSRF_HEADER } from "@eve/contracts"
import type { FastifyRequest } from "fastify"
import { timingSafeEqual } from "node:crypto"

import { ApiException } from "../http/api-exception.js"
import { SESSION_COOKIE } from "./cookies.js"
import { IS_PUBLIC, IS_PUBLIC_WRITE } from "./public.decorator.js"
import { type ActiveSession, SessionService } from "./session.service.js"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

declare module "fastify" {
  interface FastifyRequest {
    dashboardSession?: ActiveSession
  }
}

/**
 * Global guard: every route needs an active session unless it is a safe-method
 * route marked `@Public()`, or the single `@PublicWrite()` route whose transport
 * gate passed. State-changing methods also need the session's CSRF token in
 * `x-csrf-token`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>()
    if (this.flag(context, IS_PUBLIC_WRITE)) {
      // Never reads the cookie. Without the gate's flag (for example after a path
      // rename the gate doesn't know), refuse instead of falling open.
      if (request.publicWriteChecked === true) return true
      throw new ApiException("origin_forbidden")
    }
    if (SAFE_METHODS.has(request.method) && this.flag(context, IS_PUBLIC)) return true

    const lookup = await this.sessions.resume(request.cookies[SESSION_COOKIE])
    if (lookup.kind === "missing") throw new ApiException("unauthenticated")
    if (lookup.kind === "expired") throw new ApiException("session_expired")

    if (!SAFE_METHODS.has(request.method) && !hasMatchingCsrf(request, lookup.session)) {
      throw new ApiException("csrf_invalid")
    }
    request.dashboardSession = lookup.session
    return true
  }

  private flag(context: ExecutionContext, key: string): boolean {
    return this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) === true
  }
}

/** The CSRF rule both the guard and the pre-body outreach gate apply (CR-6). */
export function hasMatchingCsrf(request: FastifyRequest, session: ActiveSession): boolean {
  const header = request.headers[CSRF_HEADER]
  if (typeof header !== "string") return false
  const presented = Buffer.from(header)
  const expected = Buffer.from(session.csrfToken)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}
