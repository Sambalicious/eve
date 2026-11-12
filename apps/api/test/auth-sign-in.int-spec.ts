import type { INestApplication } from "@nestjs/common"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SESSION_COOKIE, SIGN_IN_ATTEMPT_COOKIE } from "../src/auth/cookies.js"
import { Browser, readSetCookies, setCookieLine } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  CANDIDATE_EMAIL,
  CANDIDATE_SUB,
  OTHER_EMAIL,
  OTHER_SUB,
  PUBLIC_ORIGIN,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  createTestApp,
} from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

const candidate = { sub: CANDIDATE_SUB, email: CANDIDATE_EMAIL, email_verified: true }

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

beforeEach(async () => {
  clock.set(new Date())
  await database.truncateAll()
})

afterEach(() => {
  expect(google.unexpectedRequests).toEqual([])
  google.reset()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

async function countSessions(): Promise<number> {
  const row = await database.db
    .selectFrom("dashboard_session")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

describe("Private dashboard: Google sign-in", () => {
  it("redirects to Google with code flow, PKCE S256, openid email scope, state and nonce", async () => {
    const { authorizationUrl } = await browser.startSignIn("/dashboard")
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    )
    const params = authorizationUrl.searchParams
    expect(params.get("response_type")).toBe("code")
    expect(params.get("client_id")).toBe(TEST_CLIENT_ID)
    expect(params.get("scope")).toBe("openid email")
    expect(params.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/v1/auth/google/callback`)
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(params.get("code_challenge")).toMatch(/^[\w-]{43}$/)
    expect(params.get("state")).toBeTruthy()
    expect(params.get("nonce")).toBeTruthy()
  })

  it("sets the attempt cookie HttpOnly, Secure, SameSite=Lax with a 10 minute lifetime", async () => {
    const response = await browser.http().get("/v1/auth/google/start").expect(302)
    const line = setCookieLine(response, SIGN_IN_ATTEMPT_COOKIE) ?? ""
    expect(line).toMatch(/HttpOnly/)
    expect(line).toMatch(/Secure/)
    expect(line).toMatch(/SameSite=Lax/)
    expect(line).toMatch(/Path=\//)
    expect(line).toMatch(/Max-Age=600/)
  })

  // dashboard.feature @happy @ac-9.1 "The Candidate signs in with the Google account bound at installation"
  it("The Candidate signs in with the Google account bound at installation", async () => {
    expect(await countSessions()).toBe(0)

    const started = await browser.startSignIn()
    const response = await browser
      .callback(google.approve(started.authorizationUrl, candidate), started.attemptCookie)
      .expect(302)

    expect(response.headers.location).toBe(`${PUBLIC_ORIGIN}/dashboard`)
    const sessionLine = setCookieLine(response, SESSION_COOKIE) ?? ""
    expect(sessionLine).toMatch(/HttpOnly/)
    expect(sessionLine).toMatch(/Secure/)
    expect(sessionLine).toMatch(/SameSite=Lax/)
    expect(sessionLine).not.toMatch(/Domain=/)
    expect(await countSessions()).toBe(1)

    const sessionCookie = readSetCookies(response)[SESSION_COOKIE] ?? ""
    const session = await browser.getSession(sessionCookie).expect(200)
    expect(Object.keys(session.body)).toEqual(["csrfToken"])
  })

  it("stores only a hash of the session ID", async () => {
    const { sessionCookie } = await browser.signIn(candidate)
    const rows = await database.db.selectFrom("dashboard_session").selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id_hash).not.toBe(sessionCookie)
    expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("sends the client secret and PKCE verifier to Google's token endpoint", async () => {
    await browser.signIn(candidate)
    expect(google.tokenRequests).toHaveLength(1)
    expect(google.tokenRequests[0]?.get("code_verifier")).toMatch(/^[\w-]{43,128}$/)
    expect(google.tokenRequests[0]?.get("redirect_uri")).toBe(
      `${PUBLIC_ORIGIN}/v1/auth/google/callback`
    )
  })

  // dashboard.feature @happy @ac-9.1 @ac-7.4 "After sign-in the Candidate returns to the page they asked for"
  it("After sign-in the Candidate returns to the page they asked for", async () => {
    const { location } = await browser.signIn(candidate, "/applications/R-1042#resume")
    expect(location).toBe(`${PUBLIC_ORIGIN}/applications/R-1042#resume`)
  })

  it.each([
    ["absolute URL", "https://evil.example/x"],
    ["protocol-relative", "//evil.example/x"],
    ["backslash", "/\\evil.example"],
    ["API path", "/v1/session"],
  ])("does not redirect off the dashboard for a %s next", async (_label, next) => {
    const { location } = await browser.signIn(candidate, next)
    expect(location).toBe(`${PUBLIC_ORIGIN}/dashboard`)
  })

  // dashboard.feature @permission @ac-9.1 "A Google account other than the Candidate's is refused"
  it("A Google account other than the Candidate's is refused", async () => {
    const started = await browser.startSignIn("/applications/R-1042")
    const response = await browser
      .callback(
        google.approve(started.authorizationUrl, {
          sub: OTHER_SUB,
          email: OTHER_EMAIL,
          email_verified: true,
        }),
        started.attemptCookie
      )
      .expect(302)

    const location = new URL(response.headers.location as string)
    expect(location.origin + location.pathname).toBe(`${PUBLIC_ORIGIN}/sign-in`)
    expect(location.searchParams.get("error")).toBe("account_refused")
    expect(location.searchParams.get("email")).toBe(OTHER_EMAIL)
    expect(location.searchParams.get("next")).toBe("/applications/R-1042")
    expect(readSetCookies(response)[SESSION_COOKIE]).toBeUndefined()
    expect(await countSessions()).toBe(0)
  })

  it("refuses the bound sub when Google says the email is not verified", async () => {
    const started = await browser.startSignIn()
    const response = await browser
      .callback(
        google.approve(started.authorizationUrl, { ...candidate, email_verified: false }),
        started.attemptCookie
      )
      .expect(302)
    const location = new URL(response.headers.location as string)
    expect(location.searchParams.get("error")).toBe("account_refused")
    expect(location.searchParams.has("email")).toBe(false)
    expect(await countSessions()).toBe(0)
  })

  // dashboard.feature @permission @ac-9.1 "A cancelled Google sign-in creates no session"
  it("A cancelled Google sign-in creates no session", async () => {
    const started = await browser.startSignIn("/blocked")
    const response = await browser
      .callback(google.cancel(started.authorizationUrl), started.attemptCookie)
      .expect(302)

    const location = new URL(response.headers.location as string)
    expect(location.pathname).toBe("/sign-in")
    expect(location.searchParams.get("error")).toBe("cancelled")
    expect(location.searchParams.get("next")).toBe("/blocked")
    expect(readSetCookies(response)[SESSION_COOKIE]).toBeUndefined()
    expect(await countSessions()).toBe(0)
    expect(google.tokenRequests).toHaveLength(0)
  })

  it("maps any other Google error to failed", async () => {
    const started = await browser.startSignIn()
    const response = await browser
      .callback(new URLSearchParams({ error: "server_error" }), started.attemptCookie)
      .expect(302)
    expect(new URL(response.headers.location as string).searchParams.get("error")).toBe("failed")
  })

  describe("ID token verification (iss, aud, exp, nonce)", () => {
    const nowSeconds = () => Math.floor(Date.now() / 1000)

    it.each([
      ["wrong issuer", { iss: "https://evil.example" }],
      ["wrong audience", { aud: "someone-elses-client" }],
      ["expired token", { exp: nowSeconds() - 3600, iat: nowSeconds() - 7200 }],
      ["wrong nonce", { nonce: "replayed-nonce" }],
    ])("creates no session for a token with a %s", async (_label, override) => {
      const started = await browser.startSignIn()
      const response = await browser
        .callback(
          google.approve(started.authorizationUrl, { ...candidate, ...override }),
          started.attemptCookie
        )
        .expect(302)
      const location = new URL(response.headers.location as string)
      expect(location.searchParams.get("error")).toBe("failed")
      expect(readSetCookies(response)[SESSION_COOKIE]).toBeUndefined()
      expect(await countSessions()).toBe(0)
    })
  })

  describe("callback integrity", () => {
    it("rejects a callback whose state does not match the attempt", async () => {
      const started = await browser.startSignIn()
      const query = google.approve(started.authorizationUrl, candidate)
      query.set("state", "forged-state")
      const response = await browser.callback(query, started.attemptCookie).expect(302)
      expect(new URL(response.headers.location as string).searchParams.get("error")).toBe("failed")
      expect(await countSessions()).toBe(0)
    })

    it("rejects a callback without the attempt cookie (login CSRF)", async () => {
      const started = await browser.startSignIn()
      const response = await browser
        .callback(google.approve(started.authorizationUrl, candidate), undefined)
        .expect(302)
      expect(new URL(response.headers.location as string).searchParams.get("error")).toBe("failed")
      expect(await countSessions()).toBe(0)
      expect(google.tokenRequests).toHaveLength(0)
    })

    it("lets an attempt complete only once", async () => {
      const started = await browser.startSignIn()
      const query = google.approve(started.authorizationUrl, candidate)
      await browser.callback(query, started.attemptCookie).expect(302)
      const replay = await browser.callback(query, started.attemptCookie).expect(302)
      expect(new URL(replay.headers.location as string).searchParams.get("error")).toBe("failed")
      expect(await countSessions()).toBe(1)
    })

    it("rejects an attempt older than 10 minutes", async () => {
      const started = await browser.startSignIn()
      clock.set(new Date(clock.now().getTime() + 10 * 60 * 1000 + 1000))
      const response = await browser
        .callback(google.approve(started.authorizationUrl, candidate), started.attemptCookie)
        .expect(302)
      expect(new URL(response.headers.location as string).searchParams.get("error")).toBe("failed")
      expect(await countSessions()).toBe(0)
    })

    it("clears the attempt cookie on every callback outcome", async () => {
      const started = await browser.startSignIn()
      const response = await browser
        .callback(google.cancel(started.authorizationUrl), started.attemptCookie)
        .expect(302)
      expect(readSetCookies(response)[SIGN_IN_ATTEMPT_COOKIE]).toBe("")
    })
  })

  // QA-F1: every redirect site keeps Location on PUBLIC_ORIGIN for dot-segment escapes.
  describe("return path cannot leave PUBLIC_ORIGIN (QA-F1)", () => {
    const DOT_SEGMENT_ESCAPES = [
      "/.//evil.com",
      "/..//evil.com",
      "/a/..//evil.com",
      "/%2e//evil.com",
      "/%2e%2e//evil.com",
      "/v1/../..//evil.com",
      "/dashboard/../..//evil.com",
    ]

    function expectOnPublicOrigin(location: string): URL {
      const url = new URL(location)
      expect(url.origin).toBe(PUBLIC_ORIGIN)
      return url
    }

    function expectCarriedNextOnPublicOrigin(location: string): void {
      const next = expectOnPublicOrigin(location).searchParams.get("next") ?? ""
      expect(new URL(next, PUBLIC_ORIGIN).origin).toBe(PUBLIC_ORIGIN)
      expect(next).toBe("/dashboard")
    }

    it.each(DOT_SEGMENT_ESCAPES)("start while signed in redirects on-origin for %s", async (next) => {
      const { sessionCookie } = await browser.signIn(candidate)
      const response = await browser
        .http()
        .get(`/v1/auth/google/start?next=${encodeURIComponent(next)}`)
        .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
        .expect(302)
      expect(expectOnPublicOrigin(response.headers.location as string).pathname).toBe("/dashboard")
    })

    it.each(DOT_SEGMENT_ESCAPES)("callback success redirects on-origin for %s", async (next) => {
      const { location } = await browser.signIn(candidate, next)
      expect(location).toBe(`${PUBLIC_ORIGIN}/dashboard`)
    })

    it.each(DOT_SEGMENT_ESCAPES)("cancelled callback carries an on-origin next for %s", async (next) => {
      const started = await browser.startSignIn(next)
      const response = await browser
        .callback(google.cancel(started.authorizationUrl), started.attemptCookie)
        .expect(302)
      expectCarriedNextOnPublicOrigin(response.headers.location as string)
    })

    it.each(DOT_SEGMENT_ESCAPES)("refused callback carries an on-origin next for %s", async (next) => {
      const started = await browser.startSignIn(next)
      const response = await browser
        .callback(
          google.approve(started.authorizationUrl, {
            sub: OTHER_SUB,
            email: OTHER_EMAIL,
            email_verified: true,
          }),
          started.attemptCookie
        )
        .expect(302)
      expectCarriedNextOnPublicOrigin(response.headers.location as string)
    })

    it.each(DOT_SEGMENT_ESCAPES)("failed start carries an on-origin next for %s", async (next) => {
      const isolatedApp = await createTestApp({ databaseUrl: database.url, clock })
      const { http, HttpResponse } = await import("msw")
      google.server.use(
        http.get("https://accounts.google.com/.well-known/openid-configuration", () =>
          HttpResponse.error()
        )
      )
      try {
        const response = await new Browser(isolatedApp, google)
          .http()
          .get(`/v1/auth/google/start?next=${encodeURIComponent(next)}`)
          .expect(302)
        expectCarriedNextOnPublicOrigin(response.headers.location as string)
      } finally {
        google.server.resetHandlers()
        await isolatedApp.close()
      }
    })
  })

  // dashboard.feature @duplicate @ac-9.1 "A signed-in Candidate opening the sign-in page goes to Home"
  it("A signed-in Candidate opening the sign-in page goes to Home", async () => {
    const { sessionCookie } = await browser.signIn(candidate)
    const response = await browser
      .http()
      .get("/v1/auth/google/start")
      .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
      .expect(302)

    expect(response.headers.location).toBe(`${PUBLIC_ORIGIN}/dashboard`)
    expect(readSetCookies(response)[SIGN_IN_ATTEMPT_COOKIE]).toBeUndefined()
    expect(await countSessions()).toBe(1)
  })

  it("ends the session the browser presented when it signs in again", async () => {
    const first = await browser.signIn(candidate)
    const started = await browser.startSignIn()
    await browser
      .callback(google.approve(started.authorizationUrl, candidate), started.attemptCookie, {
        [SESSION_COOKIE]: first.sessionCookie,
      })
      .expect(302)
    expect(await countSessions()).toBe(1)
    await browser.getSession(first.sessionCookie).expect(401)
  })

  it("returns to the sign-in page with failed when Google discovery is unreachable", async () => {
    // A fresh app has no cached discovery document.
    const isolatedApp = await createTestApp({ databaseUrl: database.url, clock })
    const { http, HttpResponse } = await import("msw")
    google.server.use(
      http.get("https://accounts.google.com/.well-known/openid-configuration", () =>
        HttpResponse.error()
      )
    )
    try {
      const response = await new Browser(isolatedApp, google)
        .http()
        .get("/v1/auth/google/start?next=/blocked")
        .expect(302)
      const location = new URL(response.headers.location as string)
      expect(location.pathname).toBe("/sign-in")
      expect(location.searchParams.get("error")).toBe("failed")
      expect(location.searchParams.get("next")).toBe("/blocked")
    } finally {
      google.server.resetHandlers()
      await isolatedApp.close()
    }
  })

  describe("EPIC-0002 A1 unit 4: the session binds to the candidate row; owner email capture", () => {
    afterEach(async () => {
      await database.db.updateTable("candidate").set({ google_sub: CANDIDATE_SUB, email: null, state: "active" }).where("id", "=", database.operatorId).execute()
      await database.db.deleteFrom("candidate").where("role", "=", "candidate").execute()
    })

    it("binds the session to the Operator's candidate row", async () => {
      await browser.signIn(candidate)
      const rows = await database.db.selectFrom("dashboard_session").select(["candidate_id", "google_sub"]).execute()
      expect(rows).toEqual([{ candidate_id: database.operatorId, google_sub: CANDIDATE_SUB }])
    })

    it("reads the bound sub from the candidate table, not from the environment", async () => {
      await database.db.updateTable("candidate").set({ google_sub: OTHER_SUB }).where("id", "=", database.operatorId).execute()
      await browser.signIn({ sub: OTHER_SUB, email: OTHER_EMAIL, email_verified: true })
      const refused = await browser.startSignIn()
      const response = await browser.callback(google.approve(refused.authorizationUrl, candidate), refused.attemptCookie).expect(302)
      expect(new URL(response.headers.location as string).searchParams.get("error")).toBe("account_refused")
      const rows = await database.db.selectFrom("dashboard_session").select("candidate_id").execute()
      expect(rows).toEqual([{ candidate_id: database.operatorId }])
    })

    it("binds a second active Candidate's session to that Candidate, never to the Operator", async () => {
      const other = await database.db.insertInto("candidate").values({ email: null, google_sub: OTHER_SUB, role: "candidate", onboarded_at: null, revoked_at: null }).returning("id").executeTakeFirstOrThrow()
      await browser.signIn({ sub: OTHER_SUB, email: OTHER_EMAIL, email_verified: true })
      const rows = await database.db.selectFrom("dashboard_session").select("candidate_id").execute()
      expect(rows).toEqual([{ candidate_id: other.id }])
    })

    it("refuses a revoked Candidate and creates no session", async () => {
      await database.db.updateTable("candidate").set({ state: "revoked", revoked_at: new Date() }).where("id", "=", database.operatorId).execute()
      const started = await browser.startSignIn()
      const response = await browser.callback(google.approve(started.authorizationUrl, candidate), started.attemptCookie).expect(302)
      expect(new URL(response.headers.location as string).searchParams.get("error")).toBe("account_refused")
      expect(await countSessions()).toBe(0)
    })

    it("captures the Operator's email from the verified ID token at first sign-in, and never overwrites it", async () => {
      await browser.signIn(candidate)
      const first = await database.db.selectFrom("candidate").select("email").where("id", "=", database.operatorId).executeTakeFirstOrThrow()
      expect(first.email).toBe(CANDIDATE_EMAIL)
      await browser.signIn({ ...candidate, email: "renamed.ada@gmail.com" })
      const second = await database.db.selectFrom("candidate").select("email").where("id", "=", database.operatorId).executeTakeFirstOrThrow()
      expect(second.email).toBe(CANDIDATE_EMAIL)
    })

    it("captures no email when Google does not mark it verified", async () => {
      const started = await browser.startSignIn()
      await browser.callback(google.approve(started.authorizationUrl, { ...candidate, email_verified: false }), started.attemptCookie).expect(302)
      const row = await database.db.selectFrom("candidate").select("email").where("id", "=", database.operatorId).executeTakeFirstOrThrow()
      expect(row.email).toBeNull()
    })
  })
})
