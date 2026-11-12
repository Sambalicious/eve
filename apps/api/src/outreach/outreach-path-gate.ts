import type { NestFastifyApplication } from "@nestjs/platform-fastify"
import type { FastifyInstance } from "fastify"

import { hasMatchingCsrf } from "../auth/auth.guard.js"
import { SESSION_COOKIE } from "../auth/cookies.js"
import { SessionService } from "../auth/session.service.js"
import { CandidateScope } from "../db/candidate-scope.js"
import { ApiException } from "../http/api-exception.js"
import { OUTREACH_READER_NAME_ROUTE, OUTREACH_WRITE_ROUTE, outreachKind, outreachUuid } from "./outreach-path.js"
import { OutreachRepository } from "./outreach.repository.js"

/**
 * CR-6 (contract section 2, "Order of checks"). Fastify parses the body before
 * Nest runs the guard and the handler, so a malformed JSON body, a wrong content
 * type or an oversized body used to answer 400, 415 or 413 before the path and
 * the 404 rule. That is step 4 ahead of step 3. This `onRequest` hook runs after
 * routing and before every body parser, the pattern `public-write-gate.ts` uses,
 * and answers steps 1 to 3 and the 404 rule itself. Only a live, owned
 * Application reaches the body checks and the handler, so no body error can
 * pre-empt a `404 not_found`. The Application check is step 6 in the contract and
 * is hoisted above step 4 on purpose, for that guarantee only.
 *
 * The only duplicated work is the session lookup: the guard resolves the same
 * session again and `claimRun`, `writeReaderName` and `read` re-check the
 * Application under their own row locks, so a deletion that commits after this
 * hook still wins. The hook is a transport check, not the authority.
 */
export function registerOutreachPathGate(app: NestFastifyApplication): void {
  const fastify: FastifyInstance = app.getHttpAdapter().getInstance()
  // Resolved on the first request, after the application has initialised its providers.
  const sessions = lazy(() => app.get(SessionService))
  const outreach = lazy(() => app.get(OutreachRepository))

  fastify.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url
    if (route !== OUTREACH_WRITE_ROUTE && route !== OUTREACH_READER_NAME_ROUTE) return
    void reply.header("cache-control", "no-store")

    // Step 1: the session, from the cookie the fastify-cookie plugin has already parsed.
    const lookup = await sessions().resume(request.cookies?.[SESSION_COOKIE])
    if (lookup.kind === "missing") throw new ApiException("unauthenticated")
    if (lookup.kind === "expired") throw new ApiException("session_expired")
    // Step 2: CSRF on both state-changing routes, before the Application is touched and before the body.
    if (!hasMatchingCsrf(request, lookup.session)) throw new ApiException("csrf_invalid")

    // Step 3 and the 404 rule: the path, then the Application as this Candidate may see it.
    const params = request.params as { id?: string; kind?: string }
    const applicationId = outreachUuid(params.id ?? "")
    outreachKind(params.kind ?? "")
    const live = await CandidateScope.run(lookup.session.candidateId, () => outreach().liveApplication(applicationId))
    if (!live) throw new ApiException("not_found")
  })
}

/** One container lookup per token, on first use. */
function lazy<T>(resolve: () => T): () => T {
  let value: T | undefined
  return () => (value ??= resolve())
}
