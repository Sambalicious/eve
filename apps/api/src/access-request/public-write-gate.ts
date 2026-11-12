import { ACCESS_REQUEST_BODY_MAX_BYTES, ACCESS_REQUEST_PATH, ACCESS_REQUEST_PROOF_PATH, type AccessRequestFieldCode, type ApiErrorCode, type ApiErrorResponse } from "@eve/contracts"
import type { FastifyInstance, FastifyReply } from "fastify"

import { API_ERROR_MESSAGES, ApiException } from "../http/api-exception.js"

declare module "fastify" {
  interface FastifyRequest {
    /** Set only by the public write gate, after the Origin, media type and size checks pass. */
    publicWriteChecked?: boolean
  }
}

const JSON_MEDIA_TYPE = /^application\/json\s*(?:;\s*charset\s*=\s*"?utf-8"?\s*)?$/i
const PUBLIC_PATHS = new Set([ACCESS_REQUEST_PATH, ACCESS_REQUEST_PROOF_PATH])

/**
 * Transport lock for the one public write (architecture.r1 7.2). Runs in
 * `onRequest`, after routing and before any body parser, so it compares the
 * route pattern (never the raw URL) and refuses `text/plain`, multipart and
 * form bodies before Fastify would parse them. A refusal is answered here: the
 * handler never runs, so nothing is stored or counted. Both public routes get
 * `cache-control: no-store`, including refusals.
 */
export function registerPublicWriteGate(fastify: FastifyInstance, publicOrigin: string): void {
  fastify.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url
    if (route === undefined || !PUBLIC_PATHS.has(route)) return
    void reply.header("cache-control", "no-store")
    if (request.method !== "POST" || route !== ACCESS_REQUEST_PATH) return

    if (request.headers.origin !== publicOrigin) return refuse(reply, "origin_forbidden")
    const type = request.headers["content-type"]
    if (typeof type !== "string" || !JSON_MEDIA_TYPE.test(type)) return refuse(reply, "unsupported_media_type")
    const length = Number(request.headers["content-length"])
    if (!Number.isInteger(length) || length > ACCESS_REQUEST_BODY_MAX_BYTES) return refuse(reply, "access_request_invalid", ["body.too_large"])
    request.publicWriteChecked = true
  })
}

function refuse(reply: FastifyReply, code: ApiErrorCode, fields?: AccessRequestFieldCode[]): FastifyReply {
  const body: ApiErrorResponse = { error: { code, message: API_ERROR_MESSAGES[code], ...(fields ? { fields } : {}) } }
  return reply.status(new ApiException(code).getStatus()).send(body)
}
