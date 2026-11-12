/**
 * Preloaded into the api process by the E2E stack (`node --import`):
 *   - records every outbound HTTP(S) request the api makes to E2E_OUTBOUND_LOG,
 *     one JSON line per request ({ method, url, at });
 *   - answers the Greenhouse, Lever and Ashby public API fixtures;
 *   - fails every other non-loopback request, so no test reaches a live host
 *     (outbound-and-separation.feature AC 10.5).
 *
 * Declared test double: proves nothing about the live ATS APIs.
 */
import { appendFileSync } from "node:fs"

import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"

import { ASHBY_BOARD, ATS_API, GREENHOUSE_JOB, HIDDEN_CASES, LEVER_JOB } from "./ats-fixtures.mjs"

const LOG = process.env.E2E_OUTBOUND_LOG
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

const server = setupServer(
  http.get(ATS_API.greenhouse, () => HttpResponse.json(GREENHOUSE_JOB)),
  http.get(ATS_API.lever, () => HttpResponse.json(LEVER_JOB)),
  http.get(ATS_API.ashby, () => HttpResponse.json(ASHBY_BOARD)),
  // Repair wave 1: the hidden-result rows (check-this-job.feature r3 CTJ:92).
  ...HIDDEN_CASES.filter((row) => row.api !== null).map((row) => http.get(row.api, () => HttpResponse.json(row.body))),
  // Any other external call would leave the machine: fail it (it is still recorded).
  http.all(/^https?:\/\//, ({ request }) => {
    if (LOOPBACK.has(new URL(request.url).hostname)) return undefined
    return HttpResponse.error()
  })
)

server.events.on("request:start", ({ request }) => {
  const { hostname } = new URL(request.url)
  if (LOOPBACK.has(hostname) || !LOG) return
  appendFileSync(LOG, `${JSON.stringify({ method: request.method, url: request.url, at: new Date().toISOString() })}\n`)
})

server.listen({ onUnhandledRequest: "bypass" })
