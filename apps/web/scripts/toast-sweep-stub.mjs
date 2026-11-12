#!/usr/bin/env node
/**
 * Test double for toast-geometry-sweep.mjs. Not part of the product.
 *
 * Serves only the API routes the Settings page needs for the sweep, with
 * synthetic data and no secrets. Listens on 127.0.0.1:$STUB_PORT and prints
 * "stub on <port>" when ready.
 *
 *   PUT  /v1/candidate-settings/job-criteria   ok, or 500, after ?putDelay ms
 *   PUT  other settings sections               404, so the error toast shows
 *   GET  /__stub?put=ok|500&putDelay=<ms>      configure the PUT above
 *
 * Any other route gets a 404.
 */
import http from "node:http"

const PORT = Number(process.env.STUB_PORT)
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error("STUB_PORT must be a port number")
  process.exit(2)
}

const NOW = "2026-10-21T09:00:00.000Z"
const cfg = { put: "ok", putDelay: 0 }
let criteria = { minCoreMatchPercent: 75, frameworks: ["React", "Next.js"], technologies: ["TypeScript"], version: 3 }

const routes = {
  // Synthetic token: base64url of "toast-sweep-stub-csrf-not-secret".
  "GET /v1/session": () => ({ csrfToken: "dG9hc3Qtc3dlZXAtc3R1Yi1jc3JmLW5vdC1zZWNyZXQ" }),
  "GET /v1/career-profile": () => ({ inUse: null, draft: null, drafting: null, history: [] }),
  "GET /v1/candidate-settings": () => ({ workAuthorization: "none outside Nigeria" }),
  "GET /v1/candidate-settings/contact": () => ({ fullName: "Test Candidate", lines: ["Lagos, Nigeria", "candidate@example.com"] }),
  "GET /v1/candidate-settings/job-criteria": () => criteria,
  "GET /v1/controls": () => ({
    globalPaused: false,
    globalPausedAt: null,
    costPause: null,
    spend: {
      month: "2026-10-01",
      spent: "0.00",
      ceiling: "50.00",
      defaultCeiling: "50.00",
      raised: false,
      maxCeiling: "100.00",
      canRaise: true,
      percentUsed: 0,
      byCategory: { hosting: "0.00", ai: "0.00", browser: "0.00", discovery: "0.00", email: "0.00" },
    },
  }),
  "GET /v1/submission/status": () => ({
    automaticEnabled: false,
    gatePassedAt: null,
    careerProfileApproved: true,
    existingApplicationsCompletedAt: NOW,
    countingSamples: 0,
    requiredSamples: 5,
    todayWatDay: "2026-10-21",
    todayCount: 0,
    cap: 5,
    queuedForTomorrow: 0,
    globalPaused: false,
  }),
  "GET /v1/submissions/summary": () => ({ samples: { awaitingReview: 0, approved: 0, rejected: 0 }, blocked: 0, held: 0, uncertain: 0 }),
}

const notFound = { error: { code: "not_found", message: "Not found." } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(JSON.stringify(body))
  }
  let raw = ""
  for await (const chunk of req) raw += chunk

  if (req.method === "GET" && url.pathname === "/__stub") {
    const put = url.searchParams.get("put")
    if (put === "ok" || put === "500") cfg.put = put
    const delay = url.searchParams.get("putDelay")
    if (delay !== null) cfg.putDelay = Math.max(0, Math.min(30_000, Number(delay) || 0))
    return send(200, cfg)
  }

  const key = `${req.method} ${url.pathname}`
  if (key === "PUT /v1/candidate-settings/job-criteria") {
    await new Promise((resolve) => setTimeout(resolve, cfg.putDelay))
    if (cfg.put === "500") return send(500, { error: { code: "internal_error", message: "Something went wrong." } })
    let body = {}
    try {
      body = JSON.parse(raw || "{}")
    } catch {
      return send(400, { error: { code: "bad_request", message: "The request is not valid." } })
    }
    criteria = {
      minCoreMatchPercent: body.minCoreMatchPercent ?? criteria.minCoreMatchPercent,
      frameworks: body.frameworks ?? criteria.frameworks,
      technologies: body.technologies ?? criteria.technologies,
      version: criteria.version + 1,
    }
    return send(200, criteria)
  }

  const route = routes[key]
  if (route) return send(200, route())
  send(404, notFound)
})

server.listen(PORT, "127.0.0.1", () => console.log(`stub on ${PORT}`))
