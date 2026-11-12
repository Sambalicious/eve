import { Body, Controller, Get, type INestApplication, Patch, Post } from "@nestjs/common"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  CANDIDATE_EMAIL,
  CANDIDATE_SUB,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  createTestApp,
} from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * Test-only stand-ins for /v1 routes later slices add. They record every
 * call that reaches a handler, so a refused request is provably unhandled.
 * The guard is global; nothing here opts in.
 */
const handled: string[] = []

@Controller("v1/probe")
class ProbeController {
  @Get(":area")
  read(): { secret: string } {
    handled.push("read")
    return { secret: "dashboard data" }
  }

  @Post(":area")
  write(@Body() body: unknown): { ok: true } {
    handled.push(`write ${JSON.stringify(body)}`)
    return { ok: true }
  }

  @Patch(":area")
  patch(): { ok: true } {
    handled.push("patch")
    return { ok: true }
  }
}

const UNAUTHENTICATED_BODY = {
  error: { code: "unauthenticated", message: "Sign in to continue." },
}

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({
    databaseUrl: database.url,
    clock: new TestClock(new Date()),
    extraControllers: [ProbeController],
  })
  browser = new Browser(app, google)
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("Private dashboard: unauthenticated requests", () => {
  // dashboard.feature @permission @ac-9.1 "Unauthenticated requests receive no data" (every Examples row)
  describe("Unauthenticated requests receive no data", () => {
    it.each([
      "settings",
      "career-profile",
      "documents",
      "blocked-applications",
      "unmatched-messages",
      "application-history",
      "approved-answers",
    ])("refuses GET /v1/probe/%s with 401 and only the error envelope", async (area) => {
      handled.length = 0
      const response = await browser.http().get(`/v1/probe/${area}`).expect(401)
      expect(response.body).toEqual(UNAUTHENTICATED_BODY)
      expect(handled).toEqual([])
    })

    it("refuses GET /v1/session without a session", async () => {
      const response = await browser.getSession().expect(401)
      expect(response.body).toEqual(UNAUTHENTICATED_BODY)
    })
  })

  // Every "An unauthenticated request cannot ..." scenario across gherkin/*.feature:
  // the global guard refuses the mutation before any handler runs, so no state changes.
  // The domain endpoints and their "unchanged" assertions arrive with their slices.
  it.each([
    ["dashboard.feature", "record an Outcome", "patch"],
    ["activation-gate.feature", "approve a sample", "post"],
    ["blocked-and-manual.feature", "decline a same-company review", "post"],
    ["blocked-and-manual.feature", "mark a Blocked Application completed", "post"],
    ["career-profile.feature", "approve a Career Profile", "post"],
    ["career-profile.feature", "edit an approved Career Profile", "patch"],
    ["cost-ceiling.feature", "raise the ceiling", "post"],
    ["daily-cap-and-duplicates.feature", "record an existing application", "post"],
    ["daily-cap-and-duplicates.feature", "decline a held same-company posting", "post"],
    ["daily-cap-and-duplicates.feature", "return an Uncertain Submission to the queue", "post"],
    ["data-retention-and-privacy.feature", "approve an AI provider", "post"],
    ["data-retention-and-privacy.feature", "delete records", "post"],
    ["discovery.feature", "submit a pasted link", "post"],
    ["global-pause.feature", "change the global pause", "post"],
    ["outcome-tracking.feature", "link an Unmatched Message", "post"],
    ["submission.feature", "resolve an Uncertain Submission", "post"],
    ["submission.feature", "return an Uncertain Submission to the queue", "post"],
  ] as const)("%s: An unauthenticated request cannot %s", async (_feature, action, method) => {
    handled.length = 0
    const agent = browser.http()
    const response = await agent[method](`/v1/probe/${encodeURIComponent(action)}`)
      .send({ value: "x" })
      .expect(401)
    expect(response.body).toEqual(UNAUTHENTICATED_BODY)
    expect(handled).toEqual([])
  })

  // tailored-documents.feature "An unauthenticated request cannot download a Tailored Document"
  it("tailored-documents.feature: An unauthenticated request cannot download a Tailored Document", async () => {
    handled.length = 0
    const response = await browser.http().get("/v1/probe/documents-resume-download").expect(401)
    expect(response.body).toEqual(UNAUTHENTICATED_BODY)
    expect(handled).toEqual([])
  })

  it("answers an unknown /v1 route with the not_found envelope", async () => {
    const response = await browser.http().get("/v1/does-not-exist").expect(404)
    expect(response.body).toEqual({ error: { code: "not_found", message: "Not found." } })
  })

  it("serves health without a session", async () => {
    const response = await browser.http().get("/v1/health").expect(200)
    expect(response.body).toEqual({ status: "ok", database: "ok" })
  })

  describe("CSRF on state-changing routes", () => {
    async function signedIn(): Promise<{ sessionCookie: string; csrfToken: string }> {
      const { sessionCookie } = await browser.signIn({
        sub: CANDIDATE_SUB,
        email: CANDIDATE_EMAIL,
        email_verified: true,
      })
      const session = await browser.getSession(sessionCookie).expect(200)
      return { sessionCookie, csrfToken: session.body.csrfToken as string }
    }

    it("refuses a signed-in mutation without the CSRF header", async () => {
      const { sessionCookie } = await signedIn()
      handled.length = 0
      const response = await browser
        .http()
        .post("/v1/probe/global-pause")
        .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
        .send({ on: false })
        .expect(403)
      expect(response.body).toEqual({
        error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." },
      })
      expect(handled).toEqual([])
    })

    it("refuses a signed-in mutation with a wrong CSRF header", async () => {
      const { sessionCookie, csrfToken } = await signedIn()
      handled.length = 0
      await browser
        .http()
        .patch("/v1/probe/outcome")
        .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
        .set("x-csrf-token", `${csrfToken}x`)
        .expect(403)
      expect(handled).toEqual([])
    })

    it("accepts a signed-in mutation with the session's CSRF header", async () => {
      const { sessionCookie, csrfToken } = await signedIn()
      handled.length = 0
      await browser
        .http()
        .post("/v1/probe/global-pause")
        .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
        .set("x-csrf-token", csrfToken)
        .send({ on: false })
        .expect(201)
      expect(handled).toEqual(['write {"on":false}'])
    })

    it("does not require CSRF on reads", async () => {
      const { sessionCookie } = await signedIn()
      await browser
        .http()
        .get("/v1/probe/settings")
        .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
        .expect(200)
    })
  })

  describe("logout", () => {
    it("ends the session and clears the cookie", async () => {
      const { sessionCookie } = await browser.signIn({
        sub: CANDIDATE_SUB,
        email: CANDIDATE_EMAIL,
        email_verified: true,
      })
      const { csrfToken } = (await browser.getSession(sessionCookie).expect(200)).body as {
        csrfToken: string
      }
      const response = await browser
        .http()
        .post("/v1/auth/logout")
        .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
        .set("x-csrf-token", csrfToken)
        .expect(204)
      expect(response.headers["set-cookie"]?.[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;`))
      await browser.getSession(sessionCookie).expect(401)
    })

    it("refuses logout without the CSRF header", async () => {
      const { sessionCookie } = await browser.signIn({
        sub: CANDIDATE_SUB,
        email: CANDIDATE_EMAIL,
        email_verified: true,
      })
      await browser
        .http()
        .post("/v1/auth/logout")
        .set("cookie", `${SESSION_COOKIE}=${sessionCookie}`)
        .expect(403)
      await browser.getSession(sessionCookie).expect(200)
    })

    it("refuses logout without a session", async () => {
      await browser.http().post("/v1/auth/logout").expect(401)
    })
  })
})
