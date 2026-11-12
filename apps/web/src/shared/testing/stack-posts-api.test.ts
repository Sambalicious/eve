import { ALERT_FEED_VERIFICATION_PATH, ALERT_FEEDS_PATH, apiErrorResponseSchema, CSRF_HEADER } from "@eve/contracts"
import { afterEach, describe, expect, it } from "vitest"

import { server } from "./server"
import { createStackPostsApi, FEED_A } from "./stack-posts-api"
import { TEST_CSRF_TOKEN } from "./contract-handlers"

/**
 * The web fake answers the v1.15.2 field rules the same way the API does
 * (api-contract v1.15.2, Validation): every bad field in one 400, and per
 * field missing, then invalid_characters, then too_long, in code points.
 */
async function send(method: "PUT" | "POST", path: string, body: unknown) {
  const response = await fetch(new URL(path, window.location.origin), {
    method,
    headers: { "content-type": "application/json", [CSRF_HEADER]: TEST_CSRF_TOKEN },
    body: JSON.stringify(body),
  })
  const json = (await response.json()) as { error?: { fieldErrors?: { field: string; problem: string }[] } }
  return { status: response.status, problems: (json.error?.fieldErrors ?? []).map(({ field, problem }) => `${field}:${problem}`).sort() }
}

function useFake() {
  const api = createStackPostsApi()
  server.use(...api.handlers)
  return api
}

afterEach(() => server.resetHandlers())

describe("Stack posts web fake, verification (v1.15.2)", () => {
  it.each([
    ["2099-01-01", "   ", ["verificationBasis:missing", "verifiedOn:future_date"]],
    ["2099-01-01", "basis\u0000x", ["verificationBasis:invalid_characters", "verifiedOn:future_date"]],
    ["2026-02-30", "a".repeat(501), ["verificationBasis:too_long", "verifiedOn:invalid"]],
    ["2026-10-20", `${"a".repeat(501)}\u0000x`, ["verificationBasis:invalid_characters"]],
    ["2026-10-20", "Reviewed\u007f terms", ["verificationBasis:invalid_characters"]],
    ["2026-10-20", "😀".repeat(501), ["verificationBasis:too_long"]],
    ["2026-10-20", `${"a".repeat(499)}🇳🇬`, ["verificationBasis:too_long"]],
    ["2026-10-20", "Reviewed\u0085 terms", ["verificationBasis:invalid_characters"]],
    ["2026-10-20", "Reviewed\u061c terms", ["verificationBasis:invalid_characters"]],
    ["2026-10-20", "Reviewed\u2066 terms", ["verificationBasis:invalid_characters"]],
    ["2026-10-20", "Reviewed\u200b terms", ["verificationBasis:invalid_characters"]],
    ["2026-10-20", "Reviewed\ufeff terms", ["verificationBasis:invalid_characters"]],
  ])("date %s, basis %j gives %j", async (verifiedOn, verificationBasis, problems) => {
    useFake()
    expect(await send("PUT", ALERT_FEED_VERIFICATION_PATH, { verifiedOn, verificationBasis })).toEqual({ status: 400, problems })
  })

  it.each(["😀".repeat(500), "Reviewed\tGoogle\r\nAlerts terms.\n", "Reviewed\u00a0terms \u200c \u{1f468}\u200d\u{1f469}", "\ufeffReviewed terms"])("basis %j is stored", async (verificationBasis) => {
    const api = useFake()
    expect((await send("PUT", ALERT_FEED_VERIFICATION_PATH, { verifiedOn: "2026-10-20", verificationBasis })).status).toBe(200)
    expect(api.state.verification?.verificationBasis).toBe(verificationBasis.trim())
  })
})

describe("Stack posts web fake, registration (v1.15.2)", () => {
  const verified = { verifiedOn: "2026-10-20", verificationBasis: "Reviewed.", updatedAt: "2026-10-21T12:00:00.000Z" }

  it.each([
    ["https://www.google.com/search?q=react", "lab\u0000el", ["label:invalid_characters", "url:invalid_format"]],
    [FEED_A, "React\tposts", ["label:invalid_characters"]],
    [FEED_A, `${"a".repeat(30)}\n${"a".repeat(31)}`, ["label:invalid_characters"]],
    [FEED_A, "😀".repeat(61), ["label:too_long"]],
    [FEED_A, `${"a".repeat(59)}🇳🇬`, ["label:too_long"]],
    [FEED_A, "React\u0085posts", ["label:invalid_characters"]],
    [FEED_A, "React\u009fposts", ["label:invalid_characters"]],
    [FEED_A, "\u202eReact posts", ["label:invalid_characters"]],
    [FEED_A, "React\u200fposts", ["label:invalid_characters"]],
    [FEED_A, "React\u2060posts", ["label:invalid_characters"]],
    [FEED_A, "React\ufeffposts", ["label:invalid_characters"]],
  ])("url %s, label %j gives %j", async (url, label, problems) => {
    const api = useFake()
    expect(await send("POST", ALERT_FEEDS_PATH, { url, label })).toEqual({ status: 400, problems })
    expect(api.state.feeds).toEqual([])
  })

  it.each(["😀".repeat(60), "React\u00a0posts", "\u0645\u06cc\u200c\u062e posts", "Family \u{1f468}\u200d\u{1f469}\u200d\u{1f467} posts", "Réact 🚀 posts"])(
    "label %j is accepted",
    async (label) => {
      const api = useFake()
      api.state.verification = verified
      expect((await send("POST", ALERT_FEEDS_PATH, { url: FEED_A, label })).status).toBe(201)
      expect(api.state.feeds[0]?.label).toBe(label)
    }
  )

  it("a U+FEFF at either end of the label is trimmed before the character rule", async () => {
    const api = useFake()
    api.state.verification = verified
    expect((await send("POST", ALERT_FEEDS_PATH, { url: FEED_A, label: "\ufeffReact posts\ufeff" })).status).toBe(201)
    expect(api.state.feeds[0]?.label).toBe("React posts")
  })

  it("registrationBusy answers 503 service_unavailable with Retry-After: 5 (header only), stores nothing, then the retry succeeds", async () => {
    const api = useFake()
    api.state.verification = verified
    api.state.registrationBusy = 1
    const busy = await fetch(new URL(ALERT_FEEDS_PATH, window.location.origin), {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: TEST_CSRF_TOKEN },
      body: JSON.stringify({ url: FEED_A, label: "React posts" }),
    })
    expect(busy.status).toBe(503)
    expect(busy.headers.get("retry-after")).toBe("5")
    expect(apiErrorResponseSchema.parse(await busy.json())).toEqual({
      error: { code: "service_unavailable", message: "The service is unavailable. Try again shortly." },
    })
    expect(api.state.feeds).toEqual([])
    expect(api.state.posts).toEqual([])
    expect(api.state.registrationBusy).toBe(0)
    expect((await send("POST", ALERT_FEEDS_PATH, { url: FEED_A, label: "React posts" })).status).toBe(201)
    expect(api.state.feeds).toHaveLength(1)
  })

  it("field errors come before busy: an invalid label is a 400 even while busy", async () => {
    const api = useFake()
    api.state.verification = verified
    api.state.registrationBusy = 1
    expect(await send("POST", ALERT_FEEDS_PATH, { url: FEED_A, label: "React\u200bposts" })).toEqual({ status: 400, problems: ["label:invalid_characters"] })
    expect(api.state.registrationBusy).toBe(1)
  })
})
