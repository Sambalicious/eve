import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { ConvertedFeature as Feature } from "@eve/contracts"
import type { FastifyRequest } from "fastify"

import { ApiException } from "../http/api-exception.js"
import { capabilityFor } from "../shared/converted-features.js"
import { CandidateIdentityRepository } from "./candidate-identity.repository.js"

export const CONVERTED_FEATURE = "eve:convertedFeature"

/**
 * Marks a route of an EPIC-0001 feature EPIC-0002 has not converted yet
 * (architecture r3/r4 "Fail closed before conversion"). ConvertedFeatureGuard,
 * a global guard that runs after AuthGuard, refuses anyone but the Operator.
 */
export const ConvertedFeature = (feature: Feature) => SetMetadata(CONVERTED_FEATURE, feature)

/**
 * 409 `feature_not_yet_available` with `{ feature }` for a non-Operator while
 * `CONVERTED[feature]` is false. 409, not 404: the resource, if any, is the
 * caller's own, so nothing leaks. Runs before the handler, so nothing is read
 * or written.
 */
@Injectable()
export class ConvertedFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identities: CandidateIdentityRepository
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<Feature | undefined>(CONVERTED_FEATURE, [context.getHandler(), context.getClass()])
    if (feature === undefined) return true
    const session = context.switchToHttp().getRequest<FastifyRequest>().dashboardSession
    if (!session) throw new ApiException("unauthenticated")
    const isOperator = await this.identities.isOperator(session.candidateId)
    if (capabilityFor(feature, isOperator) === "available") return true
    throw ApiException.featureNotYetAvailable(feature)
  }
}
