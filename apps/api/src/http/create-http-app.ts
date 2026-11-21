import fastifyCookie from "@fastify/cookie"
import fastifyMultipart from "@fastify/multipart"
import { RESUME_MAX_BYTES } from "@eve/contracts"
import type { INestApplication } from "@nestjs/common"
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify"

import { registerPublicWriteGate } from "../access-request/public-write-gate.js"
import type { AppConfig } from "../config/env.js"
import { REQUEST_ID_HEADER, accessLogOptions } from "./access-log.js"
import { registerOutreachPathGate } from "../outreach/outreach-path-gate.js"
import { registerAddedFactsPathGate } from "../added-facts/added-facts-path-gate.js"

/**
 * Shared Fastify setup for the api entry point and HTTP tests. `trustProxy` is a
 * hop count (EPIC-0003): with 1 behind Caddy, `request.ip` is the address Caddy
 * saw, and a client-sent X-Forwarded-For entry can't change it.
 */
export function createFastifyAdapter(config: Pick<AppConfig, "accessRequest" | "accessLog">, logStream?: { write(line: string): void }): FastifyAdapter {
  return new FastifyAdapter({ ...accessLogOptions(config.accessLog, logStream), trustProxy: trustHops(config.accessRequest.trustProxy) })
}

/**
 * Trust the nearest `hops` addresses (the socket peer is hop 0). This Fastify
 * version treats a numeric `trustProxy` as "trust nothing", so a count is passed
 * as a function. 0 disables forwarding headers entirely.
 */
export function trustHops(hops: number): false | ((address: string, hop: number) => boolean) {
  return hops === 0 ? false : (_address, hop) => hop < hops
}

export async function configureHttpApp(
  app: NestFastifyApplication,
  config: Pick<AppConfig, "publicOrigin" | "accessLog" | "addedFactsEnabled">,
): Promise<INestApplication> {
  // The id a request is logged under is also sent back, so a Candidate can quote it. Only with the log on.
  if (config.accessLog) {
    app.getHttpAdapter().getInstance().addHook("onRequest", (request, reply, done) => {
      void reply.header(REQUEST_ID_HEADER, request.id)
      done()
    })
  }
  // Before any body parser: the one public write is checked on Origin, media type and size first.
  registerPublicWriteGate(app.getHttpAdapter().getInstance(), config.publicOrigin)
  await app.register(fastifyCookie)
  // CR-6: after cookies and before any body parser, so a body error cannot pre-empt the Outreach 404.
  registerOutreachPathGate(app)
  // FEAT-0017: after cookies and before any body parser, so the new routes' 404s precede body errors.
  registerAddedFactsPathGate(app, config.addedFactsEnabled)
  // Only the resume upload reads multipart. One file, no other fields, 5 MB.
  await app.register(fastifyMultipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: RESUME_MAX_BYTES, headerPairs: 50 },
    throwFileSizeLimit: true,
  })
  app.enableShutdownHooks()
  return app
}
