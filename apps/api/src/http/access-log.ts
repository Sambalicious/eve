import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { FastifyServerOptions } from "fastify"

/** Request ids from a client are kept only when they are short and plain; anything else is replaced. */
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/

export const REQUEST_ID_HEADER = "x-request-id"

/**
 * The id a request is logged and answered under: a plain `x-request-id` the caller (or Caddy) sent, so one
 * request can be followed across hops, else a fresh UUID. The value is validated so a caller cannot put
 * arbitrary text in the log.
 */
export function generateRequestId(request: Pick<IncomingMessage, "headers">): string {
  const sent = request.headers[REQUEST_ID_HEADER]
  return typeof sent === "string" && CLIENT_REQUEST_ID.test(sent) ? sent : randomUUID()
}

/**
 * Credentials never reach a log line. The serializers below already emit no headers at all; these paths are a
 * second layer that still holds if a serializer is ever widened.
 */
export const LOG_REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
] as const

/**
 * Access log for the api (one line when a request arrives, one when it completes). A line carries the method,
 * the path without its query string, the status, the response time and the request id. No header, cookie,
 * query string or body is logged: the query can hold an OAuth code, and bodies hold the Candidate's data.
 */
export function accessLogOptions(enabled: boolean, stream?: { write(line: string): void }): Pick<FastifyServerOptions, "logger" | "genReqId"> {
  if (!enabled) return { logger: false, genReqId: generateRequestId }
  return {
    logger: {
      level: "info",
      redact: { paths: [...LOG_REDACT_PATHS], censor: "[redacted]" },
      serializers: {
        req: (request: { method?: string; url?: string }) => ({ method: request.method, url: (request.url ?? "").split("?")[0] }),
        res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
      },
      ...(stream ? { stream } : {}),
    },
    genReqId: generateRequestId,
  }
}
