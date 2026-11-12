/**
 * EPIC-0007 Phase 3: a local stand-in for Google Alerts feed URLs, spawned by
 * global setup as its own process on 127.0.0.1:$FEED_STAND_IN_PORT.
 *
 * Declared test double. The api's Alert feed client keeps its allowlist check
 * on the real `https://www.google.com/alerts/feeds/{digits}/{digits}` URL and
 * then requests this origin plus the parsed path, through the EPIC-0005 seam
 * `ALERT_FEED_TEST_ORIGIN` (SEC-E5-04: loopback only, needs
 * `ALERT_FEED_TEST_ORIGIN_ENABLED=1`, refused in production). It proves nothing
 * about live Google Alerts.
 *
 * Feed paths: `/alerts/feeds/...` answer with the reply set for that path
 * (404 when none) and every request is recorded.
 * Control paths (tests only, never requested by the api because the allowlist
 * admits only the feed path pattern):
 *   POST /__control/reset                       clear replies and recorded requests
 *   POST /__control/feeds  { path, reply }      set the reply for one feed path
 *   GET  /__control/requests                    [{ path, at }]
 * Replies: { kind: "body", status?, body } | { kind: "status", status } |
 *          { kind: "redirect", status, location } | { kind: "hang" }
 */
import { createServer } from "node:http"

const port = Number(process.env.FEED_STAND_IN_PORT)
if (!Number.isInteger(port) || port <= 0) throw new Error("FEED_STAND_IN_PORT is required")

const replies = new Map()
const requests = []
const hanging = new Set()

function readJson(request) {
  return new Promise((resolve, reject) => {
    let text = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => (text += chunk))
    request.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
  })
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://stand-in").pathname
  if (path.startsWith("/__control/")) {
    if (path === "/__control/reset" && request.method === "POST") {
      replies.clear()
      requests.length = 0
      for (const open of hanging) open.destroy()
      hanging.clear()
      response.writeHead(204).end()
      return
    }
    if (path === "/__control/feeds" && request.method === "POST") {
      const { path: feedPath, reply } = await readJson(request)
      replies.set(feedPath, reply)
      response.writeHead(204).end()
      return
    }
    if (path === "/__control/requests" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(requests))
      return
    }
    response.writeHead(404).end()
    return
  }
  requests.push({ path, at: new Date().toISOString() })
  const reply = replies.get(path)
  if (!reply) {
    response.writeHead(404).end()
    return
  }
  switch (reply.kind) {
    case "body":
      response.writeHead(reply.status ?? 200, { "content-type": "application/atom+xml; charset=utf-8" }).end(reply.body)
      return
    case "status":
      response.writeHead(reply.status).end()
      return
    case "redirect":
      response.writeHead(reply.status, { location: reply.location }).end()
      return
    case "hang":
      hanging.add(response)
      return
    default:
      response.writeHead(500).end()
  }
})
server.keepAliveTimeout = 1
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`feed stand-in listening on 127.0.0.1:${port}\n`)
})
