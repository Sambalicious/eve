import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common"
import type { FastifyRequest } from "fastify"

import { ApiException } from "./api-exception.js"

/**
 * Threat model P3-12c (EPIC-0007), SEC-E8-02 and SEC-E8-02b (EPIC-0008): a write body is JSON only
 * (both verification PUTs and both feed registration POSTs). Session and CSRF guards run first.
 * The Fastify adapter also parses form encodings, which a cross-site form can send; such a
 * body is refused as a plain 400 before the body pipe validates it, with no write.
 * Apply it with `@UseGuards(JsonBodyGuard)` on the route.
 */
@Injectable()
export class JsonBodyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const contentType = context.switchToHttp().getRequest<FastifyRequest>().headers["content-type"]
    if (!/^application\/json\s*(;|$)/i.test(contentType ?? "")) throw new ApiException("bad_request")
    return true
  }
}
