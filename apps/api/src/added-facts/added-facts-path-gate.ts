import type { NestFastifyApplication } from "@nestjs/platform-fastify"
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { hasMatchingCsrf } from "../auth/auth.guard.js"
import { SESSION_COOKIE } from "../auth/cookies.js"
import { SessionService } from "../auth/session.service.js"
import { CandidateScope } from "../db/candidate-scope.js"
import { ApiException } from "../http/api-exception.js"
import { AddedFactsRepository } from "./added-facts.repository.js"

/**
 * FEAT-0017 (api-contract A-1, "Order of checks"): Fastify parses the body before
 * Nest runs the guard and the handler, so a malformed body would answer 400, 413
 * or 415 before the 404 rules. This `onRequest` hook runs after routing and before
 * every body parser, the pattern `outreach-path-gate.ts` uses, and answers steps 1
 * to 5 itself:
 *
 * 1. the session; 2. CSRF on every non-GET; 3. `ADDED_FACTS_ENABLED` (404 when off,
 * so a malformed body cannot reveal the route); 4. the path ids are UUIDs; 5. the
 * Application is the session Candidate's own (404, no existence oracle).
 *
 * The hook is a transport check: the handler locks and re-checks the Application,
 * so a deletion that commits after this hook still wins.
 */
const ROUTES = new Set(["/v1/applications/:id/added-facts", "/v1/applications/:id/added-facts/:factId", "/v1/applications/:id/added-facts/confirm"])
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const uuid = z.uuid()

export function registerAddedFactsPathGate(app: NestFastifyApplication, enabled: boolean): void {
  const fastify: FastifyInstance = app.getHttpAdapter().getInstance()
  const sessions = lazy(() => app.get(SessionService))
  const applications = lazy(() => app.get(AddedFactsRepository))

  fastify.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url
    if (route === undefined || !ROUTES.has(route)) return
    void reply.header("cache-control", "no-store")

    const lookup = await sessions().resume(request.cookies?.[SESSION_COOKIE])
    if (lookup.kind === "missing") throw new ApiException("unauthenticated")
    if (lookup.kind === "expired") throw new ApiException("session_expired")
    if (!SAFE_METHODS.has(request.method) && !hasMatchingCsrf(request, lookup.session)) throw new ApiException("csrf_invalid")

    if (!enabled) throw new ApiException("not_found")

    const params = request.params as { id?: string; factId?: string }
    if (!uuid.safeParse(params.id ?? "").success) throw new ApiException("not_found")
    if (params.factId !== undefined && !uuid.safeParse(params.factId).success) throw new ApiException("not_found")
    const exists = await CandidateScope.run(lookup.session.candidateId, () => applications().transaction((trx, candidateId) => applications().findApplication(trx, candidateId, params.id!)))
    if (exists === undefined) throw new ApiException("not_found")
  })
}

/** One container lookup per token, on first use. */
function lazy<T>(resolve: () => T): () => T {
  let value: T | undefined
  return () => (value ??= resolve())
}
