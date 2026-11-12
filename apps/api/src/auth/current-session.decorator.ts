import { type ExecutionContext, createParamDecorator } from "@nestjs/common"
import type { FastifyRequest } from "fastify"

import { ApiException } from "../http/api-exception.js"
import type { ActiveSession } from "./session.service.js"

/** The session the AuthGuard resolved for this request. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ActiveSession => {
    const session = context.switchToHttp().getRequest<FastifyRequest>().dashboardSession
    if (!session) throw new ApiException("unauthenticated")
    return session
  }
)
