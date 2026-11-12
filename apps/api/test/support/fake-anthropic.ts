import { http, HttpResponse } from "msw"
import type { SetupServer } from "msw/node"

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"

export type AnthropicRequest = Readonly<{ apiKey: string | null; body: Record<string, unknown> }>

type Reply =
  | { kind: "object"; value: unknown; usage?: { input: number; output: number } }
  | { kind: "text"; text: string }
  | { kind: "status"; status: number }
  | { kind: "hang" }
  | { kind: "held"; value: unknown }

/**
 * Stands in for Anthropic's Messages endpoint only, on the shared MSW server.
 * Records every request so tests can count them, and replies with what the
 * test queued. Every other outbound request is counted by OutboundRecorder.
 */
export class FakeAnthropic {
  readonly requests: AnthropicRequest[] = []
  private replies: Reply[] = []
  private hanging: (() => void)[] = []
  private held: (() => void)[] = []
  /** Runs before each reply, after the request is recorded (lets a test change state mid-call). */
  onRequest: (() => Promise<void>) | null = null

  constructor(private readonly server: SetupServer) {}

  install(): void {
    this.server.use(
      http.post(ANTHROPIC_MESSAGES_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        this.requests.push({ apiKey: request.headers.get("x-api-key"), body })
        if (this.onRequest) await this.onRequest()
        return this.respond(body)
      })
    )
  }

  replyWithObject(value: unknown, usage = { input: 1200, output: 300 }): void {
    this.replies.push({ kind: "object", value, usage })
  }

  replyWithText(text: string): void {
    this.replies.push({ kind: "text", text })
  }

  replyWithStatus(status: number): void {
    this.replies.push({ kind: "status", status })
  }

  replyByHanging(): void {
    this.replies.push({ kind: "hang" })
  }

  /** Holds the next request until `releaseHeld()`, then answers with `value`. */
  replyWithObjectWhenReleased(value: unknown): void {
    this.replies.push({ kind: "held", value })
  }

  /** Answers every request held by `replyWithObjectWhenReleased`. */
  releaseHeld(): void {
    for (const answer of this.held.splice(0)) answer()
  }

  /**
   * Resolves once `count` requests are being held. Drafting sends its request in the
   * background after the upload returns 202, so under load it can arrive after the
   * test moves on; releasing before it arrives would leave it held until the
   * extraction timeout.
   */
  async waitForHeld(count = 1, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.held.length < count) {
      if (Date.now() > deadline) throw new Error(`expected ${count} held Anthropic request(s), have ${this.held.length}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /**
   * Resolves once `count` requests arrived. Background work (drafting) sends its
   * request after the 202, and since slice 7 after a ledger reservation, so a
   * test that counts requests right after the upload must wait for them.
   */
  async waitForRequests(count = 1, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.requests.length < count) {
      if (Date.now() > deadline) throw new Error(`expected ${count} Anthropic request(s), have ${this.requests.length}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /** Ends every held request with an error. */
  release(): void {
    for (const end of this.hanging.splice(0)) end()
  }

  reset(): void {
    this.release()
    this.releaseHeld()
    this.requests.length = 0
    this.replies = []
  }

  /** Text of the user message in a recorded request (the resume text sent). */
  static promptOf(request: AnthropicRequest): string {
    const messages = request.body.messages as { content: unknown }[] | undefined
    return JSON.stringify(messages ?? [])
  }

  private async respond(body: Record<string, unknown>): Promise<Response> {
    const reply = this.replies.shift()
    if (!reply) return HttpResponse.json({ type: "error", error: { type: "api_error", message: "no reply queued" } }, { status: 500 })
    if (reply.kind === "status") {
      return HttpResponse.json({ type: "error", error: { type: "overloaded_error", message: "x" } }, { status: reply.status })
    }
    if (reply.kind === "held") {
      return new Promise<Response>((resolve) => {
        this.held.push(() => resolve(this.objectResponse(body, reply.value)))
      })
    }
    if (reply.kind === "hang") {
      // Held until release() or reset(), so a test can end the wait instead of the timeout.
      return new Promise<Response>((resolve) => {
        this.hanging.push(() => resolve(HttpResponse.json({ type: "error", error: { type: "api_error", message: "released" } }, { status: 500 })))
      })
    }
    if (reply.kind === "object") return this.objectResponse(body, reply.value, reply.usage)
    return this.textResponse(body, reply.text)
  }

  private objectResponse(body: Record<string, unknown>, value: unknown, usage?: { input: number; output: number }): Response {
    return this.textResponse(body, JSON.stringify(value), usage)
  }

  private textResponse(body: Record<string, unknown>, text: string, usage?: { input: number; output: number }): Response {
    return HttpResponse.json({
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: usage?.input ?? 50, output_tokens: usage?.output ?? 10 },
    })
  }
}

/** Counts every request that leaves the process (anything not to loopback). */
export class OutboundRecorder {
  readonly urls: string[] = []

  constructor(server: SetupServer) {
    server.events.on("request:start", ({ request }) => {
      const { hostname } = new URL(request.url)
      if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1" && hostname !== "[::1]") {
        this.urls.push(`${request.method} ${request.url}`)
      }
    })
  }

  reset(): void {
    this.urls.length = 0
  }
}
