import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { FEED_A, atomFeed } from "../../test/support/alert-feed-fixtures.js"
import { createAlertFeedHttp } from "./alert-feed-http.js"

/**
 * Without the test seam the client requests exactly the constant origin plus
 * the parsed path, and nothing else (AC 6.4, 6.7). Unhandled requests fail.
 */
const server = setupServer()
const requests: string[] = []

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" })
  server.events.on("request:start", ({ request }) => void requests.push(`${request.method} ${request.url}`))
})
afterAll(() => server.close())

describe("alert feed client origin", () => {
  it("requests https://www.google.com plus the feed path, once, with redirect manual", async () => {
    server.use(http.get(FEED_A, () => HttpResponse.text(atomFeed([]))))
    await expect(createAlertFeedHttp().get(FEED_A, { retries: false })).resolves.toContain("<feed")
    expect(requests).toEqual([`GET ${FEED_A}`])
  })
})
