import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { FEED_A, atomFeed, atomFeedOfBytes } from "../../test/support/alert-feed-fixtures.js"
import { FakeFeedServer } from "../../test/support/fake-feed-server.js"
import { ALERT_FEED_MAX_BYTES, AlertFeedError, alertFeedTestOriginFromEnv, createAlertFeedHttp } from "./alert-feed-http.js"

/**
 * The real client against a local feed server reached through the test
 * origin seam, after the allowlist check passed on the Google URL (AC 4.4,
 * 4.7, 6.2, 6.3). No request leaves the machine.
 */
let feeds: FakeFeedServer
const sleeps: number[] = []
const client = (options: Parameters<typeof createAlertFeedHttp>[0] = {}) =>
  createAlertFeedHttp({ sleep: async (ms) => void sleeps.push(ms), testOrigin: feeds.origin, ...options })

beforeAll(async () => {
  feeds = await FakeFeedServer.start()
})
beforeEach(() => {
  feeds.reset()
  sleeps.length = 0
})
afterAll(async () => feeds.close())

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return "resolved"
  } catch (error) {
    if (error instanceof AlertFeedError) return error.reason
    throw error
  }
}

describe("createAlertFeedHttp", () => {
  it("returns the body of a 200 after exactly one request", async () => {
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    await expect(client().get(FEED_A, { retries: false })).resolves.toContain("<feed")
    expect(feeds.requestsTo(FEED_A)).toBe(1)
  })

  it("refuses a URL outside the allowlist with no request, even with a test origin", async () => {
    expect(await reason(client().get("https://www.google.com/search?q=react", { retries: true }))).toBe("url_not_allowed")
    expect(feeds.requests).toEqual([])
  })

  it.each([
    [404, "unexpected_response"],
    [403, "unexpected_response"],
    [500, "unexpected_response"],
    [204, "unexpected_response"],
  ])("classifies HTTP %d as %s with one attempt at registration", async (status, code) => {
    feeds.on(FEED_A, { kind: "status", status })
    expect(await reason(client().get(FEED_A, { retries: false }))).toBe(code)
    expect(feeds.requestsTo(FEED_A)).toBe(1)
  })

  it.each([301, 302, 307, 308])("does not follow a %d redirect", async (status) => {
    const elsewhere = "https://www.google.com/alerts/feeds/5/5"
    feeds.on(FEED_A, { kind: "redirect", status, location: `${feeds.origin}/alerts/feeds/5/5` })
    feeds.on(elsewhere, { kind: "body", body: atomFeed([]) })
    expect(await reason(client().get(FEED_A, { retries: true }))).toBe("redirected")
    expect(feeds.requests.map((request) => request.path)).toEqual(["/alerts/feeds/01234567890123456789/9876543210987654321"])
  })

  it("classifies a reset connection as not_reachable without leaking the URL", async () => {
    feeds.on(FEED_A, { kind: "reset" })
    const error = await client().get(FEED_A, { retries: false }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AlertFeedError)
    expect((error as AlertFeedError).reason).toBe("not_reachable")
    expect((error as Error).message).not.toContain("01234567890123456789")
  })

  it("classifies a refused connection as not_reachable", async () => {
    expect(await reason(createAlertFeedHttp({ testOrigin: "http://127.0.0.1:1" }).get(FEED_A, { retries: false }))).toBe("not_reachable")
  })

  it("classifies a slow answer as timed_out", async () => {
    feeds.on(FEED_A, { kind: "hang" })
    expect(await reason(client({ timeoutMs: 100 }).get(FEED_A, { retries: false }))).toBe("timed_out")
  })

  it("accepts a body of exactly the cap and refuses one byte over", async () => {
    const exact = atomFeedOfBytes(ALERT_FEED_MAX_BYTES)
    feeds.on(FEED_A, { kind: "body", body: exact })
    expect(await client().get(FEED_A, { retries: false })).toHaveLength(exact.length)
    feeds.on(FEED_A, { kind: "body", body: `${exact} ` })
    expect(await reason(client().get(FEED_A, { retries: false }))).toBe("too_large")
  })

  it("stops a stream without a length header at the cap", async () => {
    feeds.on(FEED_A, { kind: "stream", chunkBytes: 64 * 1024 })
    expect(await reason(client().get(FEED_A, { retries: true }))).toBe("too_large")
    expect(feeds.streamedBytes).toBeLessThan(8 * ALERT_FEED_MAX_BYTES)
  })

  it("retries 429 and 5xx with the board delays on scheduled reads, then records the failure", async () => {
    feeds.on(FEED_A, { kind: "status", status: 503 })
    expect(await reason(client().get(FEED_A, { retries: true }))).toBe("unexpected_response")
    expect(feeds.requestsTo(FEED_A)).toBe(3)
    expect(sleeps).toEqual([1_000, 4_000])
  })

  it("succeeds on a retry", async () => {
    feeds.on(FEED_A, (attempt) => (attempt === 1 ? { kind: "status", status: 429 } : { kind: "body", body: atomFeed([]) }))
    await expect(client().get(FEED_A, { retries: true })).resolves.toContain("<feed")
    expect(feeds.requestsTo(FEED_A)).toBe(2)
  })

  it("does not retry a 404", async () => {
    feeds.on(FEED_A, { kind: "status", status: 404 })
    expect(await reason(client().get(FEED_A, { retries: true }))).toBe("unexpected_response")
    expect(feeds.requestsTo(FEED_A)).toBe(1)
  })

  it("stops between retries when the feed is no longer wanted (AC 4.8)", async () => {
    feeds.on(FEED_A, { kind: "status", status: 503 })
    await expect(client().get(FEED_A, { retries: true, stillWanted: async () => false })).resolves.toBeNull()
    expect(feeds.requestsTo(FEED_A)).toBe(1)
  })

  it("refuses a test origin in production", () => {
    expect(() => createAlertFeedHttp({ testOrigin: "http://fake-feeds:8080", production: true })).toThrow()
  })
})

describe("ALERT_FEED_TEST_ORIGIN (SEC-E5-04)", () => {
  const ORIGIN = "http://127.0.0.1:8099"

  it("is unused when unset or blank, whatever the other variables say", () => {
    expect(alertFeedTestOriginFromEnv({})).toBeUndefined()
    expect(alertFeedTestOriginFromEnv({ ALERT_FEED_TEST_ORIGIN: "  ", ALERT_FEED_TEST_ORIGIN_ENABLED: "1", NODE_ENV: "production" })).toBeUndefined()
  })

  it.each(["http://127.0.0.1:8099", "http://localhost:8080", "http://127.0.0.1:1", "http://localhost:65535/"])("accepts loopback %s with ALERT_FEED_TEST_ORIGIN_ENABLED=1", (origin) => {
    expect(alertFeedTestOriginFromEnv({ ALERT_FEED_TEST_ORIGIN: origin, ALERT_FEED_TEST_ORIGIN_ENABLED: "1", NODE_ENV: "test" })).toBe(new URL(origin).origin)
  })

  it.each([undefined, "", "0", "true", "yes", " 1"])("refuses to start without the exact opt-in (ALERT_FEED_TEST_ORIGIN_ENABLED=%j)", (enabled) => {
    const env = { ALERT_FEED_TEST_ORIGIN: ORIGIN, NODE_ENV: "development", ...(enabled === undefined ? {} : { ALERT_FEED_TEST_ORIGIN_ENABLED: enabled }) }
    expect(() => alertFeedTestOriginFromEnv(env)).toThrow(/ALERT_FEED_TEST_ORIGIN_ENABLED/)
  })

  it("refuses to start in production even with the opt-in", () => {
    expect(() => alertFeedTestOriginFromEnv({ ALERT_FEED_TEST_ORIGIN: ORIGIN, ALERT_FEED_TEST_ORIGIN_ENABLED: "1", NODE_ENV: "production" })).toThrow(/production/)
  })

  it.each([
    "http://fake-feeds:8080",
    "https://127.0.0.1:8099",
    "http://127.0.0.2:8099",
    "http://[::1]:8099",
    "http://10.0.0.5:8080",
    "http://169.254.169.254",
    "http://localhost.evil.example:80",
    "http://user:pw@127.0.0.1:8099",
    "http://127.0.0.1:8099/alerts",
    "http://127.0.0.1:8099?x=1",
    "http://127.0.0.1",
    "not a url",
  ])("refuses the non-loopback or non-plain origin %s", (origin) => {
    expect(() => alertFeedTestOriginFromEnv({ ALERT_FEED_TEST_ORIGIN: origin, ALERT_FEED_TEST_ORIGIN_ENABLED: "1", NODE_ENV: "test" })).toThrow(/loopback/)
  })

  it("createAlertFeedHttp itself refuses a non-loopback test origin", () => {
    expect(() => createAlertFeedHttp({ testOrigin: "http://fake-feeds:8080" })).toThrow(/loopback/)
    expect(() => createAlertFeedHttp({ testOrigin: ORIGIN })).not.toThrow()
  })

  it("the error never contains the configured value", () => {
    const secretish = "http://10.1.2.3:4567"
    expect(() => alertFeedTestOriginFromEnv({ ALERT_FEED_TEST_ORIGIN: secretish, ALERT_FEED_TEST_ORIGIN_ENABLED: "1" })).toThrow(expect.objectContaining({ message: expect.not.stringContaining("10.1.2.3") }))
  })
})
