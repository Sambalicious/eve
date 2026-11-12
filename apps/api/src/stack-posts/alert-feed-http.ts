import { ALERT_FEED_URL_PATTERN, type AlertFeedFailureReason } from "@eve/contracts"

import { BOARD_MAX_BYTES, BOARD_RETRY_DELAYS_MS, BOARD_TIMEOUT_MS } from "../discovery/sources/board-http.js"

/**
 * ADR 0012: the only code in the Stack posts module that calls `fetch`. It
 * accepts exactly `https://www.google.com/alerts/feeds/{digits}/{digits}`,
 * requests the constant origin plus the parsed path (never the raw input),
 * follows no redirect, stops at 10 s and 1 MiB, and classifies every failure
 * into one of six codes. Errors carry only the code: never the URL, the
 * response, or the underlying error message.
 */
export const ALERT_FEED_ORIGIN = "https://www.google.com"
export const ALERT_FEED_TIMEOUT_MS = 10_000
export const ALERT_FEED_MAX_BYTES = 1024 * 1024
export const ALERT_FEED_RETRY_DELAYS_MS: readonly number[] = BOARD_RETRY_DELAYS_MS

/** Compared by a unit test: the Alert feed client is no looser than the board readers (AC 6.3). */
export const BOARD_LIMITS = { timeoutMs: BOARD_TIMEOUT_MS, maxBytes: BOARD_MAX_BYTES } as const

export class AlertFeedError extends Error {
  constructor(readonly reason: AlertFeedFailureReason | "url_not_allowed") {
    super(`Alert feed read failed: ${reason}`)
    this.name = "AlertFeedError"
  }
}

export type AlertFeedGetOptions = Readonly<{
  /** Scheduled reads retry 429 and 5xx with the board delays; registration makes one attempt (AC 4.4, 4.7). */
  retries: boolean
  /** Checked before each retry; false stops reading at once (AC 4.8). */
  stillWanted?: () => Promise<boolean>
}>

export type AlertFeedHttp = Readonly<{
  /** Resolves with the body text of a 200 within the cap; `null` when `stillWanted` said stop. */
  get(url: string, options: AlertFeedGetOptions): Promise<string | null>
}>

export type AlertFeedHttpOptions = Readonly<{
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  maxBytes?: number
  /**
   * Tests and browser QA only: replaces the origin after the allowlist check
   * passed on the real URL. Must be a loopback origin; refused in production
   * by `createAlertFeedHttp` (SEC-E5-04).
   */
  testOrigin?: string
  production?: boolean
}>

/** AC 6.1: exact pattern, then a `URL` re-check. Throws before any I/O. Returns the path to request. */
export function assertAlertFeedUrl(url: string): string {
  if (!ALERT_FEED_URL_PATTERN.test(url)) throw new AlertFeedError("url_not_allowed")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AlertFeedError("url_not_allowed")
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.google.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^\/alerts\/feeds\/[0-9]+\/[0-9]+$/.test(parsed.pathname)
  ) {
    throw new AlertFeedError("url_not_allowed")
  }
  return parsed.pathname
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"])

/**
 * SEC-E5-04: a test origin is only `http://127.0.0.1:<port>` or
 * `http://localhost:<port>` with nothing else (no path, query, credentials).
 * Returns the normalised origin; the error never repeats the value.
 */
function loopbackOrigin(value: string): string {
  const parsed = URL.canParse(value) ? new URL(value) : null
  const plain = parsed !== null && parsed.username === "" && parsed.password === "" && (parsed.pathname === "/" || parsed.pathname === "") && parsed.search === "" && parsed.hash === ""
  if (parsed === null || !plain || parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.port === "") {
    throw new Error("ALERT_FEED_TEST_ORIGIN must be a loopback origin: http://127.0.0.1:<port> or http://localhost:<port>")
  }
  return parsed.origin
}

/**
 * SEC-E5-04: reads the browser-QA test origin from the environment. Unset or
 * blank: undefined (production behaviour). Set: the process refuses to start
 * unless `ALERT_FEED_TEST_ORIGIN_ENABLED` is exactly "1", `NODE_ENV` is not
 * production, and the value is a loopback origin.
 */
export function alertFeedTestOriginFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env["ALERT_FEED_TEST_ORIGIN"]?.trim()
  if (!value) return undefined
  if (env["NODE_ENV"] === "production") throw new Error("ALERT_FEED_TEST_ORIGIN must not be set in production")
  if (env["ALERT_FEED_TEST_ORIGIN_ENABLED"] !== "1") throw new Error("ALERT_FEED_TEST_ORIGIN is set but ALERT_FEED_TEST_ORIGIN_ENABLED is not \"1\"")
  return loopbackOrigin(value)
}

export function createAlertFeedHttp(options: AlertFeedHttpOptions = {}): AlertFeedHttp {
  if (options.testOrigin !== undefined && options.production === true) {
    throw new Error("ALERT_FEED_TEST_ORIGIN must not be set in production")
  }
  if (options.testOrigin !== undefined) loopbackOrigin(options.testOrigin)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = options.timeoutMs ?? ALERT_FEED_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? ALERT_FEED_MAX_BYTES
  const origin = options.testOrigin ?? ALERT_FEED_ORIGIN

  return {
    async get(url, { retries, stillWanted }) {
      const requestUrl = origin + assertAlertFeedUrl(url)
      for (let attempt = 0; ; attempt += 1) {
        const signal = AbortSignal.timeout(timeoutMs)
        const response = await fetchOnce(requestUrl, signal)
        if (response.status === 200) return readCapped(response, maxBytes, signal)
        await response.body?.cancel().catch(() => undefined)
        if (response.status >= 300 && response.status < 400) throw new AlertFeedError("redirected")
        const retryable = response.status === 429 || response.status >= 500
        const delay = retries ? ALERT_FEED_RETRY_DELAYS_MS[attempt] : undefined
        if (!retryable || delay === undefined) throw new AlertFeedError("unexpected_response")
        await sleep(delay)
        if (stillWanted && !(await stillWanted())) return null
      }
    },
  }
}

async function fetchOnce(url: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      redirect: "manual",
      signal,
      headers: {
        accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
        "user-agent": "eve/0.1 (personal alert reader; 4 reads per day)",
      },
    })
  } catch (error) {
    // Never forward the message or cause: undici puts the host and path in them.
    throw new AlertFeedError(isTimeout(error) ? "timed_out" : "not_reachable")
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || (error.name === "AbortError" && error.cause instanceof Error && error.cause.name === "TimeoutError"))
}

/** Reads the body chunk by chunk and cancels at cap + 1 byte, so a stream without a length stops at the cap. */
async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new AlertFeedError("too_large")
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new AlertFeedError("too_large")
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof AlertFeedError) throw error
    throw new AlertFeedError(signal.aborted || isTimeout(error) ? "timed_out" : "not_reachable")
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}
