/**
 * The only HTTP client the board readers use: GET on a fixed allowlist of
 * public API hosts, with a timeout, a response size cap and bounded backoff on
 * 429 and 5xx (scope: "backoff on 429/5xx"). Job pages are never fetched.
 */
export const BOARD_API_HOSTS: ReadonlySet<string> = new Set([
  "boards-api.greenhouse.io",
  "api.lever.co",
  "api.eu.lever.co",
  "api.ashbyhq.com",
  "himalayas.app",
  "remoteok.com",
  "weworkremotely.com",
  "remotive.com",
])

export const BOARD_TIMEOUT_MS = 15_000
export const BOARD_MAX_BYTES = 10 * 1024 * 1024
export const BOARD_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000]

export class BoardReadError extends Error {
  constructor(
    readonly reason: "host_not_allowed" | "http_status" | "too_large" | "timeout" | "network" | "unexpected_body",
    readonly status?: number
  ) {
    super(`Board read failed: ${reason}${status === undefined ? "" : ` ${status}`}`)
    this.name = "BoardReadError"
  }
}

export type BoardHttp = Readonly<{
  getJson(url: string): Promise<unknown>
  getText(url: string): Promise<string>
}>

export function createBoardHttp(options: { sleep?: (ms: number) => Promise<void> } = {}): BoardHttp {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const get = async (url: string, accept: string): Promise<string> => {
    const host = new URL(url).hostname
    if (!BOARD_API_HOSTS.has(host) || !url.startsWith("https://")) throw new BoardReadError("host_not_allowed")
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchOnce(url, accept)
      if (response.ok) return readCapped(response)
      const retryable = response.status === 429 || response.status >= 500
      const delay = BOARD_RETRY_DELAYS_MS[attempt]
      await response.body?.cancel()
      if (!retryable || delay === undefined) throw new BoardReadError("http_status", response.status)
      await sleep(delay)
    }
  }
  return {
    getJson: async (url) => {
      const text = await get(url, "application/json")
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new BoardReadError("unexpected_body")
      }
    },
    getText: (url) => get(url, "application/rss+xml, application/xml, text/xml"),
  }
}

async function fetchOnce(url: string, accept: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: { accept, "user-agent": "eve/0.1 (personal job search; one read per day)" },
      redirect: "error",
      signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
    })
  } catch (error) {
    throw new BoardReadError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network")
  }
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (declared > BOARD_MAX_BYTES) throw new BoardReadError("too_large")
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > BOARD_MAX_BYTES) throw new BoardReadError("too_large")
  return new TextDecoder().decode(buffer)
}
