import { type INestApplication, Logger } from "@nestjs/common"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { SIGN_IN_ATTEMPT_COOKIE } from "../src/auth/cookies.js"
import { hashToken } from "../src/auth/secure-token.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  CANDIDATE_EMAIL,
  CANDIDATE_SUB,
  PUBLIC_ORIGIN,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  createTestApp,
} from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
const clock = new TestClock(new Date())

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
})

afterEach(() => vi.restoreAllMocks())

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

async function signedIn(): Promise<{ cookie: string; csrf: string }> {
  const { sessionCookie } = await browser.signIn({
    sub: CANDIDATE_SUB,
    email: CANDIDATE_EMAIL,
    email_verified: true,
  })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  return { cookie: `__Host-ja_session=${sessionCookie}`, csrf }
}

// CR-05 / SEC-006: client errors are 4xx contract codes and never ERROR log lines.
describe("client errors (CR-05, SEC-006)", () => {
  it.each([
    [
      "malformed JSON",
      { "content-type": "application/json" },
      "{",
      400,
      { code: "bad_request", message: "The request is not valid." },
    ],
    [
      "unsupported content type",
      { "content-type": "application/x-unknown" },
      "x",
      415,
      { code: "unsupported_media_type", message: "The request body type is not supported." },
    ],
    [
      "body over the limit",
      { "content-type": "application/json" },
      JSON.stringify({ pad: "a".repeat(1_100_000) }),
      413,
      { code: "payload_too_large", message: "The request body is too large." },
    ],
  ])("$0 without a session: $3 with the contract envelope, no ERROR log", async (_label, headers, body, status, error) => {
    const errorLog = vi.spyOn(Logger.prototype, "error")
    // In-process inject: Fastify answers 413 from content-length and closes a real socket mid-write.
    const fastify = app.getHttpAdapter().getInstance() as import("fastify").FastifyInstance
    const response = await fastify.inject({ method: "POST", url: "/v1/auth/logout", headers, payload: body })
    expect(response.statusCode).toBe(status)
    expect(response.json()).toEqual({ error })
    expect(errorLog).not.toHaveBeenCalled()
  })

  it("malformed JSON from a signed-in Candidate is also a 400", async () => {
    const { cookie, csrf } = await signedIn()
    const errorLog = vi.spyOn(Logger.prototype, "error")
    const response = await browser
      .http()
      .post("/v1/auth/logout")
      .set({ cookie, "x-csrf-token": csrf, "content-type": "application/json" })
      .send("{nope")
      .expect(400)
    expect(response.body.error.code).toBe("bad_request")
    expect(errorLog).not.toHaveBeenCalled()
  })
})

// CR-02 / SEC-005: the stored return path is re-checked before it goes into /sign-in?next=.
describe("carried next on /sign-in (CR-02, SEC-005)", () => {
  it.each(["//evil.com", "/%76%31/session", "https://evil.com/x"])(
    "a planted return_path %s comes back as next=/dashboard",
    async (planted) => {
      const attemptId = "planted-attempt-id"
      await database.db
        .insertInto("sign_in_attempt")
        .values({
          id_hash: hashToken(attemptId),
          state: "s",
          nonce: "n",
          code_verifier: "v",
          return_path: planted,
          created_at: clock.now(),
        })
        .execute()
      const response = await browser
        .http()
        .get("/v1/auth/google/callback?error=access_denied&state=s")
        .set("cookie", `${SIGN_IN_ATTEMPT_COOKIE}=${attemptId}`)
        .expect(302)
      const location = new URL(response.headers.location as string)
      expect(location.origin).toBe(PUBLIC_ORIGIN)
      expect(location.searchParams.get("error")).toBe("cancelled")
      expect(location.searchParams.get("next")).toBe("/dashboard")
    }
  )
})

// CR-01 end to end: an encoded /v1 return path never lands the browser on the API.
it("start while signed in does not redirect to an encoded /v1 path (CR-01)", async () => {
  const { cookie } = await signedIn()
  const response = await browser
    .http()
    .get(`/v1/auth/google/start?next=${encodeURIComponent("/%76%31/session")}`)
    .set("cookie", cookie)
    .expect(302)
  expect(response.headers.location).toBe(`${PUBLIC_ORIGIN}/dashboard`)
})

// CR-04: health reports 503 with the exact envelope when Postgres does not answer.
it("GET /v1/health returns 503 service_unavailable when the database is unreachable (CR-04)", async () => {
  const unreachable = await createTestApp({
    databaseUrl: "postgres://nobody:nothing@127.0.0.1:1/none",
    clock,
  })
  try {
    const response = await new Browser(unreachable, google).http().get("/v1/health").expect(503)
    expect(response.body).toEqual({
      error: { code: "service_unavailable", message: "The service is unavailable. Try again shortly." },
    })
  } finally {
    await unreachable.close()
  }
})
