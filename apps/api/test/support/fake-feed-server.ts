import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A local stand-in for Google Alerts feed URLs (no real Google). Tests point
 * the Alert feed client at it through the `testOrigin` seam, after the
 * allowlist check passed on the real `https://www.google.com/alerts/feeds/…`
 * URL. Each path gets a handler; every request is recorded.
 */
export type FeedReply =
  | Readonly<{ kind: "body"; status?: number; body: string; headers?: Record<string, string> }>
  | Readonly<{ kind: "status"; status: number; headers?: Record<string, string> }>
  | Readonly<{ kind: "redirect"; status: number; location: string }>
  /** Writes `chunkBytes` chunks with no content-length until the client stops reading. */
  | Readonly<{ kind: "stream"; chunkBytes: number }>
  /** Never answers; the client's timeout fires. */
  | Readonly<{ kind: "hang" }>
  /** Destroys the socket: the client sees a network failure. */
  | Readonly<{ kind: "reset" }>

export type FeedHandler = FeedReply | ((attempt: number) => FeedReply)

export class FakeFeedServer {
  readonly requests: { path: string; at: number }[] = []
  private readonly handlers = new Map<string, FeedHandler>()
  private readonly attempts = new Map<string, number>()
  private readonly open = new Set<ServerResponse>()
  streamedBytes = 0

  private constructor(private readonly server: Server) {}

  static async start(): Promise<FakeFeedServer> {
    const holder: { instance?: FakeFeedServer } = {}
    const server = createServer((request, response) => holder.instance!.handle(request, response))
    server.keepAliveTimeout = 1
    const instance = new FakeFeedServer(server)
    holder.instance = instance
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return instance
  }

  get origin(): string {
    const { port } = this.server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  /** `feedUrl` is the real Google URL; only its path is used. */
  on(feedUrl: string, handler: FeedHandler): void {
    this.handlers.set(new URL(feedUrl).pathname, handler)
  }

  requestsTo(feedUrl: string): number {
    const path = new URL(feedUrl).pathname
    return this.requests.filter((request) => request.path === path).length
  }

  reset(): void {
    this.handlers.clear()
    this.attempts.clear()
    this.requests.length = 0
    this.streamedBytes = 0
    for (const response of this.open) response.destroy()
    this.open.clear()
  }

  async close(): Promise<void> {
    this.reset()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://x").pathname
    this.requests.push({ path, at: Date.now() })
    const attempt = (this.attempts.get(path) ?? 0) + 1
    this.attempts.set(path, attempt)
    const handler = this.handlers.get(path)
    if (!handler) {
      response.writeHead(404).end()
      return
    }
    const reply = typeof handler === "function" ? handler(attempt) : handler
    switch (reply.kind) {
      case "body":
        response.writeHead(reply.status ?? 200, { "content-type": "application/atom+xml; charset=utf-8", ...reply.headers }).end(reply.body)
        return
      case "status":
        response.writeHead(reply.status, reply.headers).end()
        return
      case "redirect":
        response.writeHead(reply.status, { location: reply.location }).end()
        return
      case "reset":
        request.socket.destroy()
        return
      case "hang":
        this.open.add(response)
        return
      case "stream": {
        this.open.add(response)
        response.writeHead(200, { "content-type": "application/atom+xml" })
        const chunk = Buffer.alloc(reply.chunkBytes, "x")
        const write = () => {
          if (response.destroyed || this.streamedBytes > 64 * 1024 * 1024) return
          this.streamedBytes += chunk.length
          if (response.write(chunk)) setImmediate(write)
          else response.once("drain", write)
        }
        response.on("close", () => this.open.delete(response))
        write()
        return
      }
    }
  }
}
