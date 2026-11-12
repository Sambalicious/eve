import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import {
  ALERT_FEEDS_PATH,
  ALERT_FEED_VERIFICATION_PATH,
  CSRF_HEADER,
  HIRING_ALERT_FEEDS_PATH,
  HIRING_FEED_VERIFICATION_PATH,
  STACK_POSTS_PATH,
  alertFeedsResponseSchema,
  apiErrorResponseSchema,
  hiringAlertFeedsResponseSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { atomFeed } from "./support/alert-feed-fixtures.js"
import { Browser } from "./support/browser.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import {
  HFEED_A,
  NOT_VERIFIED,
  SFEED_A,
  clearFeeds,
  hiringRow,
  insertStackFeed,
  insertStackPosts,
  legacyRows,
  ownStackRow,
  ownStackRows,
  recordHiring,
  recordStack,
  revokeRuntime,
  setLegacy,
  signInInvitee,
  stackPostCount,
} from "./support/stack-feed-fixtures.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0008 `PUT /v1/stack-posts/alert-feeds/verification` and `GET /v1/stack-posts/alert-feeds`
 * (api-contract.md v1.22.0; stack-feed-own-record.feature r1, backend and both scenarios;
 * stack-feed-isolation.feature save and list scenarios). Real api, real Postgres through
 * the runtime role (forced RLS), a local feed server for the one registration fetch.
 * Three signed-in Candidates: ada (the Operator), bola and chidi (invited). No request
 * leaves 127.0.0.1; no AI, no spend.
 */
let database: TestDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let chidi: SignedInCandidate
let bolaId: string
let chidiId: string
const clock = new TestClock("2026-10-28T09:00:00.000Z")
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  feeds = await FakeFeedServer.start()
  app = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 300, sleep: async () => undefined }) })
  Logger.overrideLogger(capture)
  ada = await signInCandidate(new Browser(app, google))
  ;({ id: bolaId, session: bola } = await signInInvitee(app, google, database.db, "bola@example.com", "200000000000000000081"))
  ;({ id: chidiId, session: chidi } = await signInInvitee(app, google, database.db, "chidi@example.com", "200000000000000000082"))
})

beforeEach(async () => {
  clock.set("2026-10-28T09:00:00.000Z")
  feeds.reset()
  outbound.reset()
  logs.length = 0
  Logger.overrideLogger(capture)
  await clearFeeds(database.db)
})

afterEach(() => {
  expect(outbound.urls).toEqual([])
})

afterAll(async () => {
  await app?.close()
  await feeds?.close()
  google?.close()
  await database?.stop()
  Logger.overrideLogger(false)
})

const ADA = () => database.operatorId
const save = (who: SignedInCandidate, body: unknown) => who.put(ALERT_FEED_VERIFICATION_PATH).send(body as object)
const list = (who: SignedInCandidate) => who.get(ALERT_FEEDS_PATH)
const verificationOf = async (who: SignedInCandidate) => alertFeedsResponseSchema.parse((await list(who).expect(200)).body).verification
const fieldErrors = (body: unknown) => apiErrorResponseSchema.parse(body).error.fieldErrors
const register = (who: SignedInCandidate, url: string) => who.post(ALERT_FEEDS_PATH).send({ url, label: null })

describe("record and update (SOR:35, :65, :90, :104, :123, :146)", () => {
  it.each([
    ["ada (Operator)", () => ada, () => ADA()],
    ["bola (invited)", () => bola, () => bolaId],
  ])("SOR:35 %s records her own check: 200 with her record; registration then passes the record gate", async (_who, who, id) => {
    const response = await save(who(), { verifiedOn: "2026-10-27", verificationBasis: "Read Google's Alerts RSS terms on 27 Oct." }).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(alertFeedsResponseSchema.parse(response.body)).toEqual({
      verification: { verifiedOn: "2026-10-27", verificationBasis: "Read Google's Alerts RSS terms on 27 Oct.", updatedAt: "2026-10-28T09:00:00.000Z" },
      feeds: [],
      limit: 10,
      globalPaused: false, // r2 OWN-1
    })
    expect((await ownStackRows(database.db)).map((row) => row.candidate_id)).toEqual([id()])
    feeds.on(SFEED_A, { kind: "body", body: atomFeed([]) })
    await register(who(), SFEED_A).expect(201)
  })

  it("SOR:65 the basis is stored trimmed", async () => {
    await save(bola, { verifiedOn: "2026-10-20", verificationBasis: "   Reviewed Google Alerts terms.   " }).expect(200)
    expect((await ownStackRow(database.db, bolaId))?.verification_basis).toBe("Reviewed Google Alerts terms.")
  })

  it.each([
    ["ada", () => ada, () => ADA()],
    ["bola", () => bola, () => bolaId],
  ])("SOR:90 %s: a save from Update replaces her earlier record; she has exactly one", async (_who, who, id) => {
    await recordStack(database.db, id(), { verifiedOn: "2026-10-15", basis: "Basis one." })
    await save(who(), { verifiedOn: "2026-10-28", verificationBasis: "Re-read the Alerts terms on 28 Oct." }).expect(200)
    const mine = (await ownStackRows(database.db)).filter((row) => row.candidate_id === id())
    expect(mine.map((row) => [row.verified_on, row.verification_basis])).toEqual([["2026-10-28", "Re-read the Alerts terms on 28 Oct."]])
  })

  it("SOR:104 updating her record answers with her masked feed and keeps her feed and 3 Stack posts", async () => {
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-15" })
    await insertStackFeed(database.db, bolaId, SFEED_A, { label: "React posts" })
    await insertStackPosts(database.db, bolaId, 3)
    const body = alertFeedsResponseSchema.parse((await save(bola, { verifiedOn: "2026-10-20", verificationBasis: "Updated." }).expect(200)).body)
    expect(body.verification?.verifiedOn).toBe("2026-10-20")
    expect(body.feeds.map((feed) => [feed.label, feed.maskedUrl])).toEqual([["React posts", "…654321"]])
    expect(JSON.stringify(body)).not.toContain("9876543210987654321")
    expect(await stackPostCount(database.db, bolaId)).toBe(3)
    expect((await list(bola).expect(200)).body.feeds).toHaveLength(1)
  })

  it("SOR:123 the list returns her own record with the ISO update time", async () => {
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-21", basis: "Bola's basis", at: new Date("2026-10-21T09:00:00Z") })
    expect(await verificationOf(bola)).toEqual({ verifiedOn: "2026-10-21", verificationBasis: "Bola's basis", updatedAt: "2026-10-21T09:00:00.000Z" })
  })

  it("SOR:146 the list holds exactly verification, feeds and limit, for the Operator and an invitee", async () => {
    for (const who of [ada, bola]) {
      const body = (await list(who).expect(200)).body as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(["feeds", "globalPaused", "limit", "verification"]) // r2 OWN-1
      expect(JSON.stringify(body)).not.toMatch(/canRecordVerification|"role"|isOperator/)
    }
  })
})

describe("the list returns her own record only (SOR:129, :153; ISO:76)", () => {
  it.each([
    ["no other record exists", async () => undefined],
    ["ada has her own Stack posts record", async () => recordStack(database.db, ADA())],
    ["bola has her own Hiring record", async () => recordHiring(database.db, bolaId)],
    ["the legacy shared record exists", async () => setLegacy(database.db as never, true)],
    [
      "all three of the above hold",
      async () => {
        await recordStack(database.db, ADA())
        await recordHiring(database.db, bolaId)
        await setLegacy(database.db as never, true)
      },
    ],
  ])("SOR:129 %s: bola's verification is null", async (_name, arrange) => {
    await arrange()
    expect(await verificationOf(bola)).toBeNull()
  })

  it("ISO:76 bola's list reveals nothing about ada's record", async () => {
    await recordStack(database.db, ADA(), { basis: "ADA-BASIS-MARKER" })
    const body = (await list(bola).expect(200)).body
    expect(body).toEqual({ verification: null, feeds: [], limit: 10, globalPaused: false })
    expect(JSON.stringify(body)).not.toContain("ADA-BASIS-MARKER")
  })

  it("SOR:153 ada's update never changes bola's list", async () => {
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-21", basis: "Bola's basis", at: new Date("2026-10-21T09:00:00Z") })
    await recordStack(database.db, ADA(), { verifiedOn: "2026-10-01", basis: "Ada's basis" })
    const before = await verificationOf(bola)
    await save(ada, { verifiedOn: "2026-10-28", verificationBasis: "Ada's new basis" }).expect(200)
    expect(await verificationOf(bola)).toEqual(before)
  })
})

describe("no role check (SOR:162, :169, :177)", () => {
  it("SOR:162, SOR:169 the Operator and two invitees each save their own record: 200 with the saver's own record, never 404 or 403", async () => {
    for (const [who, basis] of [
      [ada, "Ada's"],
      [bola, "Bola's"],
      [chidi, "Chidi's"],
    ] as const) {
      const response = await save(who, { verifiedOn: "2026-10-21", verificationBasis: basis })
      expect(response.status).toBe(200)
      expect(alertFeedsResponseSchema.parse(response.body).verification?.verificationBasis).toBe(basis)
      expect(JSON.stringify(response.body)).not.toMatch(/not.found/i)
    }
    expect((await ownStackRows(database.db)).map((row) => [row.candidate_id, row.verification_basis]).sort()).toEqual(
      [
        [ADA(), "Ada's"],
        [bolaId, "Bola's"],
        [chidiId, "Chidi's"],
      ].sort()
    )
  })

  it.each([
    ["bola", { verificationBasis: "Read terms." }, [["verifiedOn", "missing"]]],
    ["bola", { verifiedOn: "2026-02-30", verificationBasis: "Read terms." }, [["verifiedOn", "invalid"]]],
    ["bola", { verifiedOn: "2026-10-25", verificationBasis: "Read terms." }, [["verifiedOn", "future_date"]]],
    ["bola", { verifiedOn: "2026-10-21", verificationBasis: "  \t " }, [["verificationBasis", "missing"]]],
    ["bola", { verifiedOn: "2026-10-21", verificationBasis: "Read\u0007terms" }, [["verificationBasis", "invalid_characters"]]],
    ["bola", { verifiedOn: "2026-10-21", verificationBasis: "Read\u202Eterms" }, [["verificationBasis", "invalid_characters"]]],
    ["bola", { verifiedOn: "2026-10-21", verificationBasis: "a".repeat(501) }, [["verificationBasis", "too_long"]]],
    ["bola", { verifiedOn: "2026-10-25", verificationBasis: "   " }, [["verifiedOn", "future_date"], ["verificationBasis", "missing"]]],
    ["ada", { verifiedOn: "2026-10-25", verificationBasis: "   " }, [["verifiedOn", "future_date"], ["verificationBasis", "missing"]]],
    ["ada", {}, [["verifiedOn", "missing"], ["verificationBasis", "missing"]]],
  ])("SOR:177 %s %j: 400 with exactly these field errors, never 404, nothing saved", async (who, body, expected) => {
    clock.set("2026-10-24T09:00:00.000Z")
    const response = await save(who === "ada" ? ada : bola, body).expect(400)
    expect(response.body.error.code).toBe("bad_request")
    expect(fieldErrors(response.body)).toEqual(expected.map(([field, problem]) => ({ field, position: null, problem })))
    expect(await ownStackRows(database.db)).toEqual([])
  })
})

describe("validation (SOR:201, :220, :229, :237, :254, :269)", () => {
  it.each([
    [{ verificationBasis: "Read Google's terms." }, "verifiedOn", "missing"],
    [{ verifiedOn: "2026-10-25", verificationBasis: "Read Google's terms." }, "verifiedOn", "future_date"],
    [{ verifiedOn: "2026-10-21", verificationBasis: "" }, "verificationBasis", "missing"],
    [{ verifiedOn: "2026-10-21", verificationBasis: "   " }, "verificationBasis", "missing"],
    [{ verifiedOn: "2026-10-21", verificationBasis: "a".repeat(501) }, "verificationBasis", "too_long"],
    [{ verifiedOn: "2026-10-21", verificationBasis: "Read\u202Eterms" }, "verificationBasis", "invalid_characters"],
  ])("SOR:201 %j is refused with %s/%s and saves nothing", async (body, field, problem) => {
    clock.set("2026-10-24T09:00:00.000Z")
    expect(fieldErrors((await save(bola, body).expect(400)).body)).toEqual([{ field, position: null, problem }])
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
  })

  it("SOR:220 both field errors come in one response, verifiedOn first", async () => {
    clock.set("2026-10-24T09:00:00.000Z")
    expect(fieldErrors((await save(bola, { verifiedOn: "2026-10-25", verificationBasis: "   " }).expect(400)).body)).toEqual([
      { field: "verifiedOn", position: null, problem: "future_date" },
      { field: "verificationBasis", position: null, problem: "missing" },
    ])
  })

  it("SOR:229 an invalid update keeps her earlier record", async () => {
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-15", basis: "Read terms." })
    const before = await ownStackRow(database.db, bolaId)
    expect(fieldErrors((await save(bola, { verifiedOn: "2026-02-30", verificationBasis: "Read terms." }).expect(400)).body)).toEqual([{ field: "verifiedOn", position: null, problem: "invalid" }])
    expect(await ownStackRow(database.db, bolaId)).toEqual(before)
  })

  it.each([
    ["the JSON array", () => JSON.stringify(["2026-10-21", "Read terms."])],
    ["the JSON string", () => JSON.stringify("2026-10-21")],
    ["an unknown candidateId key", () => JSON.stringify({ verifiedOn: "2026-10-21", verificationBasis: "Read terms.", candidateId: ADA() })],
    ["an unknown singleton key", () => JSON.stringify({ verifiedOn: "2026-10-21", verificationBasis: "Read terms.", singleton: true })],
  ])("SOR:237 %s is a plain 400; nothing saved for her and ada's record unchanged", async (_name, body) => {
    await recordStack(database.db, ADA(), { basis: "Ada's basis" })
    const adaBefore = await ownStackRow(database.db, ADA())
    const response = await bola.put(ALERT_FEED_VERIFICATION_PATH).set("content-type", "application/json").send(body()).expect(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
    expect(await ownStackRow(database.db, ADA())).toEqual(adaBefore)
  })

  it.each([
    ["application/x-www-form-urlencoded", "verifiedOn=2026-10-21&verificationBasis=FormBodyMarker"],
    ["text/plain", JSON.stringify({ verifiedOn: "2026-10-21", verificationBasis: "FormBodyMarker" })],
    ["multipart/form-data; boundary=x", '--x\r\nContent-Disposition: form-data; name="verifiedOn"\r\n\r\n2026-10-21\r\n--x--\r\n'],
  ])("SEC-E8-02 content-type %s with her session and CSRF token is a plain 400 and records nothing", async (contentType, body) => {
    await recordStack(database.db, ADA(), { basis: "Ada's basis" })
    const adaBefore = await ownStackRow(database.db, ADA())
    const response = await bola.put(ALERT_FEED_VERIFICATION_PATH).set("content-type", contentType).send(body).expect(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
    expect(await ownStackRow(database.db, ADA())).toEqual(adaBefore)
  })

  it("SEC-E8H-02 no content-type header: a body is 415 unsupported_media_type, an empty body is a plain 400; nothing recorded", async () => {
    const fastify = app.getHttpAdapter().getInstance() as import("fastify").FastifyInstance
    const auth = { cookie: bola.cookie, [CSRF_HEADER]: bola.csrfToken }
    const withBody = await fastify.inject({ method: "PUT", url: ALERT_FEED_VERIFICATION_PATH, headers: auth, payload: JSON.stringify({ verifiedOn: "2026-10-21", verificationBasis: "NoTypeMarker" }) })
    expect(withBody.headers["content-type"]).toMatch(/^application\/json/)
    expect([withBody.statusCode, withBody.json()]).toEqual([415, { error: { code: "unsupported_media_type", message: "The request body type is not supported." } }])
    const empty = await fastify.inject({ method: "PUT", url: ALERT_FEED_VERIFICATION_PATH, headers: auth })
    expect([empty.statusCode, empty.json()]).toEqual([400, { error: { code: "bad_request", message: "The request is not valid." } }])
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
  })

  it.each(["application/vnd.api+json", "application/merge-patch+json"])("SEC-E8H-02 content-type %s is 415 unsupported_media_type; nothing recorded", async (contentType) => {
    const response = await bola.put(ALERT_FEED_VERIFICATION_PATH).set("content-type", contentType).send(JSON.stringify({ verifiedOn: "2026-10-21", verificationBasis: "PlusJsonMarker" })).expect(415)
    expect(response.body).toEqual({ error: { code: "unsupported_media_type", message: "The request body type is not supported." } })
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
  })

  it.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])("SEC-E8-02 content-type %s is accepted", async (contentType) => {
    await bola.put(ALERT_FEED_VERIFICATION_PATH).set("content-type", contentType).send(JSON.stringify({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." })).expect(200)
    expect((await ownStackRow(database.db, bolaId))?.verification_basis).toBe("Read terms.")
  })

  it.each([
    ["2026-10-24T22:59:00.000Z", "2026-10-24", 200],
    ["2026-10-24T22:59:00.000Z", "2026-10-25", 400],
    ["2026-10-24T23:00:00.000Z", "2026-10-25", 200],
    ["2026-10-24T23:01:00.000Z", "2026-10-26", 400],
    ["2026-10-24T23:01:00.000Z", "2024-02-29", 200],
  ])("SOR:254 at %s the date %s answers %d (WAT calendar day)", async (now, date, status) => {
    clock.set(now)
    const response = await save(bola, { verifiedOn: date, verificationBasis: "Read terms." }).expect(status)
    if (status === 400) expect(fieldErrors(response.body)).toEqual([{ field: "verifiedOn", position: null, problem: "future_date" }])
    else expect((await ownStackRow(database.db, bolaId))?.verified_on).toBe(date)
  })

  it.each([
    ["1 a", "a", 200, "a"],
    ["500 a", "a".repeat(500), 200, "a".repeat(500)],
    ["500 a padded with 3 spaces", `   ${"a".repeat(500)}   `, 200, "a".repeat(500)],
    ["500 emoji", "😀".repeat(500), 200, "😀".repeat(500)],
    ["501 a", "a".repeat(501), 400, null],
    ["499 a and a flag", `${"a".repeat(499)}🇳🇬`, 400, null],
    ["a line break and a tab", "Line one\nLine two\tend", 200, "Line one\nLine two\tend"],
  ])("SOR:269 basis %s answers %d", async (_name, basis, status, stored) => {
    const response = await save(bola, { verifiedOn: "2026-10-21", verificationBasis: basis }).expect(status)
    if (status === 400) expect(fieldErrors(response.body)).toEqual([{ field: "verificationBasis", position: null, problem: "too_long" }])
    else expect((await ownStackRow(database.db, bolaId))?.verification_basis).toBe(stored)
  })
})

describe("session and CSRF (SOR:305, :318, :326, :334)", () => {
  const valid = { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }

  it.each([
    ["no session and a valid-looking CSRF token", () => new Browser(app, google).http().put(ALERT_FEED_VERIFICATION_PATH).set("x-csrf-token", bola.csrfToken).send(valid), "unauthenticated", "Sign in to continue."],
    ["her session with no CSRF token", () => new Browser(app, google).http().put(ALERT_FEED_VERIFICATION_PATH).set("cookie", bola.cookie).send(valid), "csrf_invalid", "The request is missing a valid CSRF token."],
    ["her session with another session's CSRF token", () => new Browser(app, google).http().put(ALERT_FEED_VERIFICATION_PATH).set("cookie", bola.cookie).set("x-csrf-token", ada.csrfToken).send(valid), "csrf_invalid", "The request is missing a valid CSRF token."],
  ])("SOR:305 %s is refused with %s and records nothing", async (_name, send, code, message) => {
    const response = await send()
    expect(response.body).toEqual({ error: { code, message } })
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
  })

  it("SOR:318 an expired session (idle 14 days) is 401 session_expired and records nothing", async () => {
    const { id, session } = await signInInvitee(app, google, database.db, "dele@example.com", "200000000000000000083")
    outbound.reset() // the fake Google sign-in exchange, not a Stack posts request
    await database.db.updateTable("dashboard_session").set({ last_active_at: new Date("2026-10-01T00:00:00Z") }).where("candidate_id", "=", id).execute()
    const response = await save(session, valid).expect(401)
    expect(response.body).toEqual({ error: { code: "session_expired", message: "Your session ended. Sign in with Google again to continue where you left off." } })
    expect(await ownStackRow(database.db, id)).toBeUndefined()
  })

  it("SOR:326 (contract N-1) a revoked Candidate whose sessions were ended gets 401 session_expired and records nothing", async () => {
    const { id, session } = await signInInvitee(app, google, database.db, "efe@example.com", "200000000000000000084")
    outbound.reset() // the fake Google sign-in exchange, not a Stack posts request
    await database.db.updateTable("candidate").set({ state: "revoked" }).where("id", "=", id).execute()
    await database.db.deleteFrom("dashboard_session").where("candidate_id", "=", id).execute()
    const response = await save(session, valid).expect(401)
    expect(response.body.error.code).toBe("session_expired")
    expect(await ownStackRow(database.db, id)).toBeUndefined()
  })

  it("SOR:334 the list without a session is 401 unauthenticated", async () => {
    expect((await new Browser(app, google).http().get(ALERT_FEEDS_PATH).expect(401)).body.error.code).toBe("unauthenticated")
  })
})

describe("no delete (SOR:342; contract 'Record cannot be deleted')", () => {
  it("DELETE is a plain 400, POST and PATCH are 404, empty and null saves are 400 missing; the record and update time are unchanged", async () => {
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-21", basis: "Read terms." })
    const before = await ownStackRow(database.db, bolaId)
    expect((await bola.delete(ALERT_FEED_VERIFICATION_PATH).expect(400)).body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    expect((await bola.post(ALERT_FEED_VERIFICATION_PATH).send({}).expect(404)).body.error.code).toBe("not_found")
    expect((await bola.patch(ALERT_FEED_VERIFICATION_PATH).send({}).expect(404)).body.error.code).toBe("not_found")
    const missing = [
      { field: "verifiedOn", position: null, problem: "missing" },
      { field: "verificationBasis", position: null, problem: "missing" },
    ]
    expect(fieldErrors((await save(bola, {}).expect(400)).body)).toEqual(missing)
    expect(fieldErrors((await save(bola, { verifiedOn: null, verificationBasis: null }).expect(400)).body)).toEqual(missing)
    expect(await ownStackRow(database.db, bolaId)).toEqual(before)
  })
})

describe("pauses, outbound, AI, spend and logs (SOR:352, :364, :375, :384)", () => {
  it.each([
    ["the global pause", { global_paused: true }],
    ["the cost-ceiling pause", { cost_paused: true }],
  ])("SOR:352 the save works during %s", async (_name, pause) => {
    await database.db.updateTable("control_state").set(pause).execute()
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    expect(await ownStackRow(database.db, bolaId)).toBeDefined()
  })

  describe("OWN-1: globalPaused on both feeds responses", () => {
    afterEach(async () => {
      await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
    })

    const stackOf = async (who: SignedInCandidate) => alertFeedsResponseSchema.parse((await list(who).expect(200)).body)
    const hiringOf = async (who: SignedInCandidate) => hiringAlertFeedsResponseSchema.parse((await who.get(HIRING_ALERT_FEEDS_PATH).expect(200)).body)

    it("an invitee, refused GET /v1/controls (409), sees globalPaused true on both feeds responses during the global pause", async () => {
      await bola.get("/v1/controls").expect(409)
      await database.db.updateTable("control_state").set({ global_paused: true }).execute()
      for (const who of [bola, ada]) {
        expect((await stackOf(who)).globalPaused).toBe(true)
        expect((await hiringOf(who)).globalPaused).toBe(true)
      }
      expect((await ada.get("/v1/controls").expect(200)).body.globalPaused).toBe(true)
    })

    it("the verification PUT responses carry it too, and the cost-ceiling pause never sets it (both responses served)", async () => {
      await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
      expect((await stackOf(bola)).globalPaused).toBe(false)
      expect((await hiringOf(bola)).globalPaused).toBe(false)
      await database.db.updateTable("control_state").set({ global_paused: true }).execute()
      const stackSaved = alertFeedsResponseSchema.parse((await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)).body)
      const hiringSaved = hiringAlertFeedsResponseSchema.parse((await bola.put(HIRING_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)).body)
      expect(stackSaved.globalPaused).toBe(true)
      expect(hiringSaved.globalPaused).toBe(true)
    })

    it("is false when not paused, and the body has no pause time or spend data", async () => {
      const stack = (await list(bola).expect(200)).body as Record<string, unknown>
      const hiring = (await bola.get(HIRING_ALERT_FEEDS_PATH).expect(200)).body as Record<string, unknown>
      for (const body of [stack, hiring]) {
        expect(body.globalPaused).toBe(false)
        expect(Object.keys(body).sort()).toEqual(["feeds", "globalPaused", "limit", "verification"])
      }
    })
  })

  it("SOR:364 recording and updating make no outbound request, call no AI and record no spend", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    await save(bola, { verifiedOn: "2026-10-22", verificationBasis: "Read again." }).expect(200)
    expect(feeds.requests).toEqual([])
    expect(outbound.urls).toEqual([])
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })

  it("SOR:375 the basis is never logged; the save is logged with her Candidate id", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Basis-marker-3d7a" }).expect(200)
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Basis-marker-8b1c" }).expect(200)
    await list(bola).expect(200)
    const all = logs.join("\n")
    expect(all).not.toMatch(/Basis-marker-3d7a|Basis-marker-8b1c/)
    expect(all).toContain(`Stack posts feed verification saved for Candidate ${bolaId}`)
  })

  it("SOR:384 each basis is returned only to its author and never in the Stack posts list", async () => {
    await recordStack(database.db, bolaId, { basis: "Bola's Stack basis" })
    await recordStack(database.db, ADA(), { basis: "Ada's Stack basis" })
    await insertStackPosts(database.db, bolaId, 1)
    await insertStackPosts(database.db, ADA(), 1)
    const bolaFeeds = JSON.stringify((await list(bola).expect(200)).body)
    const adaFeeds = JSON.stringify((await list(ada).expect(200)).body)
    expect(bolaFeeds).toContain("Bola's Stack basis")
    expect(bolaFeeds).not.toContain("Ada's Stack basis")
    expect(adaFeeds).toContain("Ada's Stack basis")
    expect(adaFeeds).not.toContain("Bola's Stack basis")
    for (const who of [ada, bola]) expect(JSON.stringify((await who.get(STACK_POSTS_PATH).expect(200)).body)).not.toMatch(/Stack basis/)
  })
})

describe("separate from the Hiring record (SOR:401, :409, :416, :424; ISO:85, :92)", () => {
  it("SOR:401 saving her Stack posts record creates no Hiring record; Hiring registration is still 409", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Stack." }).expect(200)
    expect(await hiringRow(database.db, bolaId)).toBeUndefined()
    expect((await bola.get(HIRING_ALERT_FEEDS_PATH).expect(200)).body.verification).toBeNull()
    expect((await bola.post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null }).expect(409)).body).toEqual(NOT_VERIFIED)
    expect(feeds.requests).toEqual([])
  })

  it("SOR:409 updating her Stack posts record leaves her Hiring record byte-equal", async () => {
    await recordHiring(database.db, bolaId, { verifiedOn: "2026-10-01", basis: "Hiring basis" })
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-02" })
    const before = await hiringRow(database.db, bolaId)
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Stack basis" }).expect(200)
    expect(await hiringRow(database.db, bolaId)).toEqual(before)
    expect((await bola.get(HIRING_ALERT_FEEDS_PATH).expect(200)).body.verification.verifiedOn).toBe("2026-10-01")
  })

  it("SOR:416 saving her Hiring record creates no Stack posts record; Stack posts registration is still 409", async () => {
    await bola.put(HIRING_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Hiring." }).expect(200)
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
    expect(await verificationOf(bola)).toBeNull()
    expect((await register(bola, SFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
  })

  it("SOR:424 updating her Hiring record leaves her Stack posts record byte-equal", async () => {
    await recordStack(database.db, bolaId, { verifiedOn: "2026-10-02", basis: "Stack basis" })
    await recordHiring(database.db, bolaId, { verifiedOn: "2026-10-01" })
    const before = await ownStackRow(database.db, bolaId)
    await bola.put(HIRING_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Hiring again." }).expect(200)
    expect(await ownStackRow(database.db, bolaId)).toEqual(before)
  })

  it("ISO:85 the two lists return their own bases", async () => {
    await recordStack(database.db, bolaId, { basis: "Stack basis" })
    await recordHiring(database.db, bolaId, { basis: "Hiring basis" })
    expect((await verificationOf(bola))?.verificationBasis).toBe("Stack basis")
    expect((await bola.get(HIRING_ALERT_FEEDS_PATH).expect(200)).body.verification.verificationBasis).toBe("Hiring basis")
  })

  it("ISO:92 the Stack posts save touches nothing in the Hiring table: it succeeds with the runtime role locked out of it", async () => {
    await recordHiring(database.db, bolaId)
    const restore = await revokeRuntime(database, "hiring_feed_verification")
    try {
      await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Stack." }).expect(200)
    } finally {
      await restore()
    }
  })
})

describe("idempotency and races (SOR:446, :453, :463, :471)", () => {
  it("SOR:446 saving the same record twice leaves one row with the newer update time", async () => {
    clock.set("2026-10-21T09:00:00.000Z")
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    clock.set("2026-10-21T09:05:00.000Z")
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    const mine = (await ownStackRows(database.db)).filter((row) => row.candidate_id === bolaId)
    expect(mine.map((row) => [row.verified_on, row.verification_basis, row.updated_at.toISOString()])).toEqual([["2026-10-21", "Read terms.", "2026-10-21T09:05:00.000Z"]])
  })

  it("SOR:453 two saves sent at once leave exactly one record", async () => {
    const responses = await Promise.all([save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }), save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." })])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect((await ownStackRows(database.db)).filter((row) => row.candidate_id === bolaId)).toHaveLength(1)
  })

  it("SOR:463 tab A then tab B: both 200, the last save is stored, no conflict code", async () => {
    const a = await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "From tab A" })
    const b = await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "From tab B" })
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await ownStackRow(database.db, bolaId))?.verification_basis).toBe("From tab B")
  })

  it("SOR:471 two Candidates saving at once each get only their own record and neither waits on the other", async () => {
    const started = Date.now()
    await Promise.all([save(ada, { verifiedOn: "2026-10-21", verificationBasis: "Ada at once" }).expect(200), save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola at once" }).expect(200)])
    expect(Date.now() - started).toBeLessThan(1_000)
    expect((await ownStackRows(database.db)).map((row) => [row.candidate_id, row.verification_basis]).sort()).toEqual(
      [
        [ADA(), "Ada at once"],
        [bolaId, "Bola at once"],
      ].sort()
    )
  })
})

describe("the save takes no id (ISO:53, :62)", () => {
  it("ISO:53 bola's save writes only her row; ada's record, gate and list are unchanged", async () => {
    await recordStack(database.db, ADA(), { verifiedOn: "2026-10-01", basis: "Ada's basis" })
    const before = await ownStackRow(database.db, ADA())
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)
    expect((await ownStackRow(database.db, bolaId))?.verified_on).toBe("2026-10-21")
    expect(await ownStackRow(database.db, ADA())).toEqual(before)
    feeds.on(SFEED_A, { kind: "body", body: atomFeed([]) })
    await register(ada, SFEED_A).expect(201)
  })

  it.each([
    ["the body key candidateId", (body: object) => bola.put(ALERT_FEED_VERIFICATION_PATH).send({ ...body, candidateId: ADA() }), 400],
    ["the query parameter candidateId", (body: object) => bola.put(`${ALERT_FEED_VERIFICATION_PATH}?candidateId=${ADA()}`).send(body), 200],
    ["the header X-Candidate-Id", (body: object) => bola.put(ALERT_FEED_VERIFICATION_PATH).set("x-candidate-id", ADA()).send(body), 200],
  ])("ISO:62 aiming the save at ada with %s answers %d and never changes ada's record", async (_name, send, status) => {
    await recordStack(database.db, ADA(), { basis: "Ada's basis" })
    const response = await send({ verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" })
    expect(response.status).toBe(status)
    expect((await ownStackRow(database.db, ADA()))?.verification_basis).toBe("Ada's basis")
    if (status === 400) expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
    else expect(alertFeedsResponseSchema.parse(response.body).verification?.verificationBasis).toBe("Bola's basis")
  })
})

describe("the legacy shared record is never read or written (MIG:217, :226, :233)", () => {
  it("MIG:217 list, save, register and remove all succeed with the runtime role locked out of the legacy table", async () => {
    await setLegacy(database.db as never, true)
    const restore = await revokeRuntime(database, "alert_feed_verification")
    try {
      await list(bola).expect(200)
      await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
      feeds.on(SFEED_A, { kind: "body", body: atomFeed([]) })
      const id = (await register(bola, SFEED_A).expect(201)).body.feed.id as string
      await bola.delete(`${ALERT_FEEDS_PATH}/${id}`).expect(204)
    } finally {
      await restore()
    }
  })

  it("MIG:226 a save of her own record never changes the legacy row", async () => {
    await setLegacy(database.db as never, true)
    await recordStack(database.db, ADA(), { basis: "Reviewed Google Alerts terms on 30 Sep." })
    const before = await legacyRows(database.db as never)
    await save(ada, { verifiedOn: "2026-10-28", verificationBasis: "Re-read the terms on 28 Oct." }).expect(200)
    expect(await legacyRows(database.db as never)).toEqual(before)
  })

  it("MIG:233 (API half) deleting the legacy row changes neither ada's list nor her registration gate", async () => {
    await setLegacy(database.db as never, true)
    await recordStack(database.db, ADA(), { verifiedOn: "2026-09-30" })
    await sql`delete from alert_feed_verification`.execute(database.db)
    expect((await verificationOf(ada))?.verifiedOn).toBe("2026-09-30")
    feeds.on(SFEED_A, { kind: "body", body: atomFeed([]) })
    await register(ada, SFEED_A).expect(201)
  })
})
