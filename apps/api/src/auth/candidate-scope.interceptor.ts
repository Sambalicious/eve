import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common"
import type { FastifyRequest } from "fastify"
import { Observable } from "rxjs"

import { CandidateScope } from "../db/candidate-scope.js"

/**
 * Runs each authenticated handler in the session's Candidate scope (architecture
 * r2, Tenancy mechanism 4: `AuthGuard` resolves the session, this carries its
 * `candidate_id`). Public routes run with no scope, so any Candidate query
 * there throws instead of reading.
 */
@Injectable()
export class CandidateScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const session = context.switchToHttp().getRequest<FastifyRequest>().dashboardSession
    if (!session) return next.handle()
    // The handler runs on subscription, so subscribe inside the scope.
    return new Observable((subscriber) => CandidateScope.run(session.candidateId, () => next.handle().subscribe(subscriber)))
  }
}
