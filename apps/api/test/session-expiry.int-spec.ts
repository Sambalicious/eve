import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { Browser, readSetCookies } from "./support/browser.js"
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

const candidate = { sub: CANDIDATE_SUB, email: CANDIDATE_EMAIL, email_verified: true }
const LAST_ACTIVE = "2026-10-01T09:00:00+01:00"

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
const clock = new TestClock(LAST_ACTIVE)

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
})

beforeEach(async () => {
  await database.truncateAll()
  // truncateAll keeps the identity rows; undo any state a test gave the Candidate.
  await database.db.updateTable("candidate").set({ state: "active", revoked_at: null }).execute()
  google.reset()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

/** Signs in with the clock at the Candidate's last activity. */
async function signInLastActiveAt(time: string): Promise<string> {
  clock.set(time)
  return (await browser.signIn(candidate)).sessionCookie
}

describe("Private dashboard: session idle expiry", () => {
  // dashboard.feature @boundary @ac-9.1 "The session idle expiry is 14 days"
  describe("The session idle expiry is 14 days", () => {
    it.each([
      ["2026-10-15T08:59:59+01:00", "valid", 200],
      ["2026-10-15T09:00:01+01:00", "expired", 401],
    ])("opening Home at %s: session is %s", async (time, _state, status) => {
      const sessionCookie = await signInLastActiveAt(LAST_ACTIVE)
      clock.set(time)
      await browser.getSession(sessionCookie).expect(status)
    })

    it("is expired at exactly 14 days after the last activity", async () => {
      const sessionCookie = await signInLastActiveAt(LAST_ACTIVE)
      clock.set("2026-10-15T09:00:00+01:00")
      await browser.getSession(sessionCookie).expect(401)
    })

    // Idle time counts from the last activity; the 30-day absolute lifetime is the separate rule below.
    it("counts from the last activity, not from sign-in", async () => {
      const sessionCookie = await signInLastActiveAt(LAST_ACTIVE)
      clock.set("2026-10-14T09:00:00+01:00")
      await browser.getSession(sessionCookie).expect(200)
      clock.set("2026-10-28T08:59:59+01:00")
      await browser.getSession(sessionCookie).expect(200)
      clock.set("2026-10-30T08:59:58+01:00")
      await browser.getSession(sessionCookie).expect(200)
    })
  })

  // dashboard.feature @permission @ac-9.1 "An expired session sends the Candidate to sign in again"
  it("An expired session sends the Candidate to sign in again", async () => {
    const sessionCookie = await signInLastActiveAt(LAST_ACTIVE)
    clock.set("2026-10-16T09:00:00+01:00")

    const response = await browser.getSession(sessionCookie).expect(401)
    expect(response.body).toEqual({
      error: {
        code: "session_expired",
        message: "Your session ended. Sign in with Google again to continue where you left off.",
      },
    })
    expect(readSetCookies(response)[SESSION_COOKIE]).toBe("")

    const rows = await database.db.selectFrom("dashboard_session").selectAll().execute()
    expect(rows).toHaveLength(0)

    // The web app sends the Candidate to /sign-in?next=/blocked&reason=expired; sign-in returns there.
    const { location } = await browser.signIn(candidate, "/blocked")
    expect(location).toBe(`${PUBLIC_ORIGIN}/blocked`)
  })

  // Audit finding 2: a session used every few days still ends 30 days after sign-in.
  it("ends 30 days after sign-in even when it is used inside the idle window", async () => {
    const sessionCookie = await signInLastActiveAt(LAST_ACTIVE)
    for (const day of ["2026-10-11", "2026-10-21", "2026-10-30"]) {
      clock.set(`${day}T09:00:00+01:00`)
      await browser.getSession(sessionCookie).expect(200)
    }
    clock.set("2026-10-31T08:59:59+01:00")
    await browser.getSession(sessionCookie).expect(200)
    clock.set("2026-10-31T09:00:01+01:00")
    const response = await browser.getSession(sessionCookie).expect(401)
    expect(response.body.error.code).toBe("session_expired")
    expect(await database.db.selectFrom("dashboard_session").selectAll().execute()).toHaveLength(0)
  })

  // A revoked or deleting Candidate must lose access on the next request, not at idle expiry.
  it.each(["revoked", "deleting"] as const)("a session whose Candidate is %s stops resolving and is deleted", async (state) => {
    const sessionCookie = await signInLastActiveAt(LAST_ACTIVE)
    await browser.getSession(sessionCookie).expect(200)

    const session = await database.db.selectFrom("dashboard_session").select("candidate_id").executeTakeFirstOrThrow()
    await database.db.updateTable("candidate").set({ state }).where("id", "=", session.candidate_id).execute()

    const response = await browser.getSession(sessionCookie).expect(401)
    expect(response.body.error.code).toBe("session_expired")
    expect(await database.db.selectFrom("dashboard_session").selectAll().execute()).toHaveLength(0)
  })

  it("reports session_expired for any session cookie the server no longer holds", async () => {
    const response = await browser.getSession("never-issued").expect(401)
    expect(response.body.error.code).toBe("session_expired")
  })
})
