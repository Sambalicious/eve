import type { INestApplication } from "@nestjs/common"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0007 Phase 1, run epic-0007-p1, test authoring):
 * `GET /v1/stack-posts/hiring-search-inputs` through the real api, AuthGuard,
 * forced RLS and Postgres (api-contract.md "Phase 1", hiring-view.feature
 * "Reading Hiring view data without a session is refused", hiring-search-links
 * AC 2.5 rows, "Each Candidate's Hiring view is built from their own settings").
 *
 * The path and response shape are written out from the contract rather than
 * imported from @eve/contracts, so this file is an independent oracle: a renamed
 * path, an extra key (the schema is strict) or a reordered term fails here.
 */
const HIRING_SEARCH_INPUTS_PATH = "/v1/stack-posts/hiring-search-inputs"
const responseSchema = z.object({ hintTerms: z.array(z.enum(["remote", "relocation", "visa sponsorship"])).max(3) }).strict()

const BOLA_SUB = "200000000000000000707"
const BOLA_EMAIL = "bola.qa@example.test"

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let bolaId: string
const clock = new TestClock("2026-10-25T09:00:00.000Z")

type Prefs = { remoteAccepted: boolean; relocationAccepted: boolean; sponsorshipNeededForRelocation: boolean }

/** Sets the three booleans on the Candidate's job_preferences row, keeping its other keys (0018 values). */
async function setPrefs(candidateId: string, prefs: Prefs | Record<string, unknown>): Promise<void> {
  await sql`insert into job_preferences (candidate_id, version, values) values (${candidateId}::uuid, 1, ${JSON.stringify(prefs)}::jsonb)
    on conflict (candidate_id) do update set values = job_preferences.values || excluded.values`.execute(database.db)
}

async function replacePrefs(candidateId: string, values: Record<string, unknown>): Promise<void> {
  await sql`insert into job_preferences (candidate_id, version, values) values (${candidateId}::uuid, 1, ${JSON.stringify(values)}::jsonb)
    on conflict (candidate_id) do update set values = excluded.values`.execute(database.db)
}

async function hints(candidate: SignedInCandidate): Promise<string[]> {
  const response = await candidate.get(HIRING_SEARCH_INPUTS_PATH).expect(200)
  expect(response.headers["cache-control"]).toBe("no-store")
  return responseSchema.parse(response.body).hintTerms
}

let operatorPrefs: unknown

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  bolaId = (await database.db.insertInto("candidate").values({ email: BOLA_EMAIL, google_sub: BOLA_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  await database.db.insertInto("job_criteria").values({ candidate_id: bolaId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: BOLA_SUB, email: BOLA_EMAIL, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  bola = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, BOLA_EMAIL)
  operatorPrefs = (await database.db.selectFrom("job_preferences").select("values").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).values
})

beforeEach(async () => {
  await database.db.deleteFrom("job_preferences").where("candidate_id", "=", bolaId).execute()
  await replacePrefs(database.operatorId, operatorPrefs as Record<string, unknown>)
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("session (hiring-view.feature @permission @ac-1.3)", () => {
  it("without a session cookie: 401 unauthenticated, \"Sign in to continue.\", no Candidate data", async () => {
    const anonymous = await new Browser(app, google).http().get(HIRING_SEARCH_INPUTS_PATH).expect(401)
    expect(anonymous.body).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } })
  })

  it("with a cookie the server no longer holds: 401 session_expired", async () => {
    const response = await new Browser(app, google).http().get(HIRING_SEARCH_INPUTS_PATH).set("cookie", `${SESSION_COOKIE}=never-issued`).expect(401)
    expect(response.body.error.code).toBe("session_expired")
  })

  it("a GET needs no CSRF token (safe method) and ignores unknown query parameters", async () => {
    const response = await new Browser(app, google).http().get(`${HIRING_SEARCH_INPUTS_PATH}?family=backend&candidate=${bolaId}`).set("cookie", ada.cookie).expect(200)
    expect(responseSchema.parse(response.body)).toEqual({ hintTerms: ["remote", "relocation", "visa sponsorship"] })
  })
})

describe("hint terms from the caller's own Job Preferences (AC 2.5)", () => {
  it("the Operator's 0018 values (all three true) give remote, relocation, visa sponsorship in that order", async () => {
    expect(await hints(ada)).toEqual(["remote", "relocation", "visa sponsorship"])
  })

  it.each([
    [true, true, true, ["remote", "relocation", "visa sponsorship"]],
    [true, true, false, ["remote", "relocation"]],
    [true, false, true, ["remote"]],
    [true, false, false, ["remote"]],
    [false, true, true, ["relocation", "visa sponsorship"]],
    [false, true, false, ["relocation"]],
    [false, false, true, []],
    [false, false, false, []],
  ])("remote=%s relocation=%s sponsorship=%s → %j", async (remoteAccepted, relocationAccepted, sponsorshipNeededForRelocation, expected) => {
    await setPrefs(database.operatorId, { remoteAccepted, relocationAccepted, sponsorshipNeededForRelocation })
    expect(await hints(ada)).toEqual(expected)
  })

  it("a Candidate with no Job Preferences row gets 200 { hintTerms: [] }", async () => {
    expect(await database.db.selectFrom("job_preferences").select("candidate_id").where("candidate_id", "=", bolaId).execute()).toEqual([])
    expect(await hints(bola)).toEqual([])
  })

  it.each([
    ["missing keys", {}],
    ["a key of the wrong type", { remoteAccepted: "yes", relocationAccepted: true, sponsorshipNeededForRelocation: true }],
    ["null values", { remoteAccepted: null, relocationAccepted: null, sponsorshipNeededForRelocation: null }],
    ["one key missing", { remoteAccepted: true, relocationAccepted: true }],
  ])("a malformed row (%s) is not an error: 200 { hintTerms: [] }", async (_name, values) => {
    await replacePrefs(bolaId, values)
    expect(await hints(bola)).toEqual([])
  })

  it("extra keys in the row are ignored (non-strict parse)", async () => {
    await replacePrefs(bolaId, { remoteAccepted: true, relocationAccepted: false, sponsorshipNeededForRelocation: false, payFloor: { amount: "1" }, somethingNew: 1 })
    expect(await hints(bola)).toEqual(["remote"])
  })

  it("the response never echoes other preference values (pay floor, countries, industries)", async () => {
    const body = JSON.stringify((await ada.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body)
    for (const leaked of ["payFloor", "2000", "gambling", "OM", "NG", "Africa/Lagos"]) expect(body).not.toContain(leaked)
  })
})

describe("tenancy (hiring-view.feature @permission; cross-Candidate registry)", () => {
  it("Ada and Bola each read only their own preferences", async () => {
    await setPrefs(bolaId, { remoteAccepted: false, relocationAccepted: true, sponsorshipNeededForRelocation: false })
    expect(await hints(ada)).toEqual(["remote", "relocation", "visa sponsorship"])
    expect(await hints(bola)).toEqual(["relocation"])
    await setPrefs(database.operatorId, { remoteAccepted: false, relocationAccepted: false, sponsorshipNeededForRelocation: false })
    expect(await hints(ada)).toEqual([])
    expect(await hints(bola)).toEqual(["relocation"])
  })

  it("Bola with no row does not fall back to the Operator's row", async () => {
    expect(await hints(ada)).toHaveLength(3)
    expect(await hints(bola)).toEqual([])
  })
})

describe("read-only, no outbound, no AI, no spend (AC 3.9, 10.2)", () => {
  it("a read writes no row in job_preferences, job_criteria, ai_call or spend_entry", async () => {
    const snapshot = async () => ({
      prefs: await database.db.selectFrom("job_preferences").selectAll().orderBy("candidate_id").execute(),
      criteria: await database.db.selectFrom("job_criteria").selectAll().orderBy("candidate_id").execute(),
      ai: await database.db.selectFrom("ai_call").select("id").execute(),
      spend: await database.db.selectFrom("spend_entry").selectAll().execute(),
    })
    const before = await snapshot()
    await hints(ada)
    await hints(bola)
    expect(await snapshot()).toEqual(before)
  })

  it("is answered during the global pause and the cost-ceiling pause", async () => {
    await database.db.updateTable("control_state").set({ global_paused: true, cost_paused: true }).execute()
    try {
      expect(await hints(ada)).toEqual(["remote", "relocation", "visa sponsorship"])
    } finally {
      await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
    }
  })

  it("is answered without an Alert feed verification", async () => {
    await database.db.deleteFrom("alert_feed_candidate_verification").execute()
    await sql`delete from alert_feed_verification`.execute(database.db)
    expect(await hints(ada)).toHaveLength(3)
  })
})
