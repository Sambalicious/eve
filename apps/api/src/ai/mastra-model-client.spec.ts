import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { INVALID_OUTPUT } from "./model-client.js"
import { MastraModelClient } from "./mastra-model-client.js"

const ANTHROPIC_MESSAGES = "https://api.anthropic.com/v1/messages"
const REDIRECT_HOST = "https://evil.example"
const KEY = "sk-ant-test-BASEURL-SENTINEL"
const RESUME_MARKER = "resume-marker-sec-202"

const anthropicRequests: { apiKey: string | null; body: string }[] = []
const redirectedRequests: string[] = []
const server = setupServer(
  http.post(ANTHROPIC_MESSAGES, async ({ request }) => {
    anthropicRequests.push({ apiKey: request.headers.get("x-api-key"), body: await request.text() })
    return HttpResponse.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify({ a: "ok" }) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 3 },
    })
  }),
  // Counted so the assertion names the leak; onUnhandledFrame: "error" fails any other host.
  http.all(`${REDIRECT_HOST}/*`, ({ request }) => {
    redirectedRequests.push(`${request.method} ${request.url}`)
    return HttpResponse.json({}, { status: 500 })
  })
)

const savedBaseUrl = process.env.ANTHROPIC_BASE_URL

// onUnhandledFrame is MSW 3's name for onUnhandledRequest: any unmatched host fails the test.
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  anthropicRequests.length = 0
  redirectedRequests.length = 0
  if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = savedBaseUrl
})
afterAll(() => server.close())

function callOnce() {
  return new MastraModelClient().generateObject({
    apiKey: KEY,
    model: "claude-haiku-5-5",
    system: "Extract facts.",
    prompt: `<resume>${RESUME_MARKER}</resume>`,
    schema: z.object({ a: z.string() }).strict(),
    maxOutputTokens: 50,
    abortSignal: AbortSignal.timeout(5_000),
  })
}

// SEC-202: the environment must not be able to send the key and resume text elsewhere.
describe("MastraModelClient Anthropic endpoint (SEC-202)", () => {
  it.each([
    ["another host", `${REDIRECT_HOST}/v1`],
    ["a loopback listener", "http://127.0.0.1:9/v1"],
  ])("ignores ANTHROPIC_BASE_URL pointing at %s: zero requests there, one to api.anthropic.com", async (_label, redirect) => {
    process.env.ANTHROPIC_BASE_URL = redirect
    const result = await callOnce()
    expect(redirectedRequests).toEqual([])
    expect(anthropicRequests).toHaveLength(1)
    expect(anthropicRequests[0]?.apiKey).toBe(KEY)
    expect(anthropicRequests[0]?.body).toContain(RESUME_MARKER)
    expect(result.object).not.toBe(INVALID_OUTPUT)
    expect(result.object).toEqual({ a: "ok" })
  })

  it("sends to api.anthropic.com when ANTHROPIC_BASE_URL is unset", async () => {
    delete process.env.ANTHROPIC_BASE_URL
    await callOnce()
    expect(anthropicRequests).toHaveLength(1)
    expect(redirectedRequests).toEqual([])
  })
})
