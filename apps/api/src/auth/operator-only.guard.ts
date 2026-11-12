import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { FastifyRequest } from "fastify"

import { ApiException } from "../http/api-exception.js"
import { CandidateIdentityRepository } from "./candidate-identity.repository.js"

export const OPERATOR_ONLY = "eve:operatorOnly"

/**
 * A route that writes installation-wide shared state (the employer list
 * approval, the remote board catalog, the evaluation settings singleton).
 * Anyone but the Operator gets 404, as the Operator console and the Alert feed
 * verification (r5 K6) do, so the route does not exist for them.
 */
export const OperatorOnly = () => SetMetadata(OPERATOR_ONLY, true)

@Injectable()
export class OperatorOnlyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identities: CandidateIdentityRepository
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(OPERATOR_ONLY, [context.getHandler(), context.getClass()]) !== true) return true
    const session = context.switchToHttp().getRequest<FastifyRequest>().dashboardSession
    if (!session || !(await this.identities.isOperator(session.candidateId))) throw new ApiException("not_found")
    return true
  }
}
