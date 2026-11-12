import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import {
  ALERT_FEEDS_PATH,
  ALERT_FEED_VERIFICATION_PATH,
  CSRF_HEADER,
  HIRING_ALERT_FEEDS_PATH,
  HIRING_FEED_VERIFICATION_PATH,
  HIRING_POSTS_PATH,
  STACK_POSTS_PATH,
  alertFeedsResponseSchema,
  apiErrorResponseSchema,
  hiringAlertFeedsResponseSchema,
  hiringPostsResponseSchema,
  registerAlertFeedResponseSchema,
  stackPostsResponseSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { Browser } from "./support/browser.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import {
  HFEED_A,
  HFEED_A_DIGITS,
  HFEED_B,
  HIRING_AND_STACK_TABLES,
  POST_1,
  POST_2,
  SFEED_A,
  hiringFeedUrl,
  insertHiringFeed,
  insertHiringPosts,
  insertStackFeed,
  recordOwn,
  recordLegacyShared,
  recordOwnStack,
  legacySharedRows,
  clearLegacyShared,
  signInBola,
} from "./support/hiring-fixtures.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0007 Phase 3 routes against the real api, real Postgres (runtime role,
 * forced RLS) and a local feed server standing in for Google Alerts
 * (api-contract.r1.md; hiring-alert-feeds.feature, hiring-posts.feature r4).
 * Two signed-in Candidates: "ada" (the Operator) and "bola" (invited). No
 * request leaves 127.0.0.1 (OutboundRecorder); no AI, no email.
 */
let database: TestDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let bolaId: string
const clock = new TestClock("2026-10-24T09:00:00.000Z")
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
  const browser = new Browser(app, google)
  ada = await signInCandidate(browser)
  ;({ id: bolaId, session: bola } = await signInBola(database.db, browser))
})

beforeEach(async () => {
  clock.set("2026-10-24T09:00:00.000Z")
  feeds.reset()
  outbound.reset()
  logs.length = 0
  Logger.overrideLogger(capture)
  for (const table of [...HIRING_AND_STACK_TABLES, "ai_call", "spend_entry"] as const) await database.db.deleteFrom(table).execute()
  await clearLegacyShared(database.db)
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"] }).execute()
})

afterEach(() => {
  // HAF:979, P3-7: no full feed URL in any log line; nothing left 127.0.0.1 (AC 10.3, 10.5).
  expect(logs.join("\n")).not.toContain(HFEED_A_DIGITS)
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
const hiringFeeds = (who: SignedInCandidate) => who.get(HIRING_ALERT_FEEDS_PATH)
const save = (who: SignedInCandidate, body: unknown) => who.put(HIRING_FEED_VERIFICATION_PATH).send(body as object)
const registerHiring = (who: SignedInCandidate, url: string, label: string | null = null) => who.post(HIRING_ALERT_FEEDS_PATH).send({ url, label })
const registerStack = (who: SignedInCandidate, url: string, label: string | null = null) => who.post(ALERT_FEEDS_PATH).send({ url, label })
const fieldErrors = (body: unknown) => apiErrorResponseSchema.parse(body).error.fieldErrors
const ownRows = async () =>
  (await database.db.selectFrom("hiring_feed_verification").select(["candidate_id", sql<string>`verified_on::text`.as("verified_on"), "verification_basis", "updated_at"]).orderBy("candidate_id").execute())
const hiringFeedRows = (candidateId: string) => database.db.selectFrom("hiring_alert_feed").select(["url", "label"]).where("candidate_id", "=", candidateId).orderBy("created_at").execute()
const stackFeedRows = (candidateId: string) => database.db.selectFrom("alert_feed").select("url").where("candidate_id", "=", candidateId).execute()
const twoEntries = () =>
  atomFeed([
    { title: "We're hiring a frontend engineer", link: googleRedirect(POST_1), content: "React and TypeScript, remote", published: "2026-10-23T09:00:00Z" },
    { title: "Join our team", link: googleRedirect(POST_2), content: "Vue" },
  ])
const NOT_VERIFIED = { error: { code: "alert_feeds_not_verified", message: "Record the permitted-use verification for Google Alerts feeds before registering a feed." } }

describe("GET hiring-feeds (HAF:319, HAF:346, HAF:357)", () => {
  it.each([
    ["ada (Operator)", true],
    ["ada (Operator)", false],
    ["bola (invited)", true],
    ["bola (invited)", false],
  ])("HAF:319 %s with no own record and the shared record %s gets verification null and no feeds", async (who, shared) => {
    if (shared) await recordLegacyShared(database.db)
    const response = await hiringFeeds(who.startsWith("ada") ? ada : bola).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(hiringAlertFeedsResponseSchema.parse(response.body)).toEqual({ verification: null, feeds: [], limit: 10, globalPaused: false })
  })

  it("HAF:357 the response holds exactly verification, feeds and limit for the Operator and the invitee (no role field)", async () => {
    for (const who of [ada, bola]) {
      const body = (await hiringFeeds(who).expect(200)).body as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(["feeds", "globalPaused", "limit", "verification"]) // r2 OWN-1
      expect(JSON.stringify(body)).not.toMatch(/canRecordVerification|role|operator/i)
    }
  })

  it("HAF:346 with her own record: verifiedOn, verificationBasis and updatedAt, field by field (P3-6a)", async () => {
    await recordOwn(database.db, bolaId)
    const body = hiringAlertFeedsResponseSchema.parse((await hiringFeeds(bola).expect(200)).body)
    expect(body.verification).toEqual({ verifiedOn: "2026-10-21", verificationBasis: "Read Google's terms for Alerts RSS on 21 Oct.", updatedAt: "2026-10-21T10:00:00.000Z" })
    expect(Object.keys(body.verification!).sort()).toEqual(["updatedAt", "verificationBasis", "verifiedOn"])
  })

  it("HAF:1038 without a session is refused as unauthenticated", async () => {
    const response = await new Browser(app, google).http().get(HIRING_ALERT_FEEDS_PATH).expect(401)
    expect(response.body.error.code).toBe("unauthenticated")
  })
})

describe("PUT hiring-feeds/verification (AC 6.6; HAF:379 to :619)", () => {
  it("HAF:379, HAF:563 any Candidate records her own: 200 with the saved record; the Operator and the invitee alike (no role check)", async () => {
    for (const [who, basis] of [[ada, "Ada's basis"], [bola, "Bola's basis"]] as const) {
      const response = await save(who, { verifiedOn: "2026-10-21", verificationBasis: basis }).expect(200)
      expect(response.headers["cache-control"]).toBe("no-store")
      const body = hiringAlertFeedsResponseSchema.parse(response.body)
      expect(body).toEqual({ verification: { verifiedOn: "2026-10-21", verificationBasis: basis, updatedAt: "2026-10-24T09:00:00.000Z" }, feeds: [], limit: 10, globalPaused: false })
    }
    expect((await ownRows()).map((row) => row.verification_basis).sort()).toEqual(["Ada's basis", "Bola's basis"])
  })

  it("HAF:400, HAF:570 a second save replaces the first, one row, newer updated_at; HAF:577 the last save wins", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    clock.set("2026-10-24T09:05:00.000Z")
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    clock.set("2026-10-24T09:06:00.000Z")
    await save(bola, { verifiedOn: "2026-10-24", verificationBasis: "From tab B" }).expect(200)
    expect(await ownRows()).toEqual([{ candidate_id: bolaId, verified_on: "2026-10-24", verification_basis: "From tab B", updated_at: new Date("2026-10-24T09:06:00.000Z") }])
  })

  it("HAF:577 two saves racing: exactly one row, one of the two bodies, no error", async () => {
    const [a, b] = await Promise.all([save(bola, { verifiedOn: "2026-10-21", verificationBasis: "From tab A" }), save(bola, { verifiedOn: "2026-10-21", verificationBasis: "From tab B" })])
    expect([a.status, b.status]).toEqual([200, 200])
    const rows = await ownRows()
    expect(rows).toHaveLength(1)
    expect(["From tab A", "From tab B"]).toContain(rows[0]!.verification_basis)
  })

  it("HAF:411 updating keeps her Hiring Alert feeds and answers with them masked", async () => {
    await recordOwn(database.db, ADA())
    await insertHiringFeed(database.db, ADA(), HFEED_A, { label: "A" })
    await insertHiringFeed(database.db, ADA(), HFEED_B, { createdAt: new Date("2026-10-21T09:00:00Z") })
    const response = await save(ada, { verifiedOn: "2026-10-24", verificationBasis: "New basis." }).expect(200)
    const body = hiringAlertFeedsResponseSchema.parse(response.body)
    expect(body.feeds.map((feed) => feed.maskedUrl)).toEqual(["…123456", "…777888"])
    expect(JSON.stringify(response.body)).not.toContain(HFEED_A_DIGITS)
    expect(await hiringFeedRows(ADA())).toHaveLength(2)
  })

  it.each([
    [{ verificationBasis: "Read terms." }, [["verifiedOn", "missing"]]],
    [{ verifiedOn: null, verificationBasis: "Read terms." }, [["verifiedOn", "missing"]]],
    [{ verifiedOn: "2026-02-30", verificationBasis: "Read terms." }, [["verifiedOn", "invalid"]]],
    [{ verifiedOn: "21/10/2026", verificationBasis: "Read terms." }, [["verifiedOn", "invalid"]]],
    [{ verifiedOn: 20261021, verificationBasis: "Read terms." }, [["verifiedOn", "invalid"]]],
    [{ verifiedOn: "2026-10-25", verificationBasis: "Read terms." }, [["verifiedOn", "future_date"]]],
    [{ verifiedOn: "2026-10-21" }, [["verificationBasis", "missing"]]],
    [{ verifiedOn: "2026-10-21", verificationBasis: "  \t " }, [["verificationBasis", "missing"]]],
    [{ verifiedOn: "2026-10-21", verificationBasis: 42 }, [["verificationBasis", "invalid"]]],
    [{ verifiedOn: "2026-10-21", verificationBasis: "Read\u0007terms" }, [["verificationBasis", "invalid_characters"]]],
    [{ verifiedOn: "2026-10-21", verificationBasis: "Read\u200Bterms" }, [["verificationBasis", "invalid_characters"]]],
    [{ verifiedOn: "2026-10-21", verificationBasis: "a".repeat(501) }, [["verificationBasis", "too_long"]]],
    [{ verifiedOn: "2026-10-21", verificationBasis: "\u0007".repeat(501) }, [["verificationBasis", "invalid_characters"]]],
    [{ verifiedOn: "2026-10-25", verificationBasis: "" }, [["verifiedOn", "future_date"], ["verificationBasis", "missing"]]],
  ])("HAF:447, HAF:472 refuses %j with exactly those field errors and saves nothing", async (body, expected) => {
    const response = await save(bola, body).expect(400)
    expect(apiErrorResponseSchema.parse(response.body).error.message).toBe("The request is not valid.")
    expect(fieldErrors(response.body)).toEqual(expected.map(([field, problem]) => ({ field, position: null, problem })))
    expect(await ownRows()).toEqual([])
  })

  it.each([
    ["a JSON array", ["2026-10-21", "Read terms."]],
    ["a JSON string", "2026-10-21"],
  ])("HAF:482 %s is a plain 400 with no field errors", async (_name, body) => {
    const response = await bola.put(HIRING_FEED_VERIFICATION_PATH).set("content-type", "application/json").send(JSON.stringify(body)).expect(400)
    expect(apiErrorResponseSchema.parse(response.body).error.fieldErrors).toBeUndefined()
    expect(await ownRows()).toEqual([])
  })

  it("HAF:482, P3-13a an unknown candidateId key aimed at another Candidate is a plain 400; both rows unchanged", async () => {
    await recordOwn(database.db, ADA(), "Ada's basis")
    await recordOwn(database.db, bolaId, "Bola's basis")
    const before = await ownRows()
    const response = await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Forged.", candidateId: ADA() }).expect(400)
    expect(apiErrorResponseSchema.parse(response.body).error.fieldErrors).toBeUndefined()
    expect(await ownRows()).toEqual(before)
  })

  it.each([
    ["2026-10-24T22:59:00Z", "2026-10-24", 200],
    ["2026-10-24T22:59:00Z", "2026-10-25", 400],
    ["2026-10-24T23:01:00Z", "2026-10-25", 200],
    ["2026-10-24T23:01:00Z", "2026-10-26", 400],
    ["2026-10-24T23:01:00Z", "1999-01-01", 200],
  ])("HAF:495 at %s the date %s answers %i (WAT day boundary)", async (now, date, status) => {
    clock.set(now)
    const response = await save(bola, { verifiedOn: date, verificationBasis: "Read terms." }).expect(status)
    if (status === 400) expect(fieldErrors(response.body)).toEqual([{ field: "verifiedOn", position: null, problem: "future_date" }])
  })

  it.each([
    ["a", "a", 200],
    ["a".repeat(500), "a".repeat(500), 200],
    [`   ${"a".repeat(500)}   `, "a".repeat(500), 200],
    ["é".repeat(500), "é".repeat(500), 200],
    ["a".repeat(501), null, 400],
    ["Line one\nLine two\tend", "Line one\nLine two\tend", 200],
  ])("HAF:510 basis length in code points after trimming (%#)", async (basis, stored, status) => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: basis }).expect(status)
    expect((await ownRows()).map((row) => row.verification_basis)).toEqual(stored === null ? [] : [stored])
  })

  describe("HAF:550, HV:135, HV:150, P3-12a/c session, CSRF and media type refusals write nothing", () => {
    const body = { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }
    it("no session, a valid-looking CSRF token: 401 unauthenticated", async () => {
      const response = await new Browser(app, google).http().put(HIRING_FEED_VERIFICATION_PATH).set(CSRF_HEADER, bola.csrfToken).send(body).expect(401)
      expect(response.body).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } })
      expect(await ownRows()).toEqual([])
    })
    it("her session, no CSRF token: 403 csrf_invalid", async () => {
      const response = await new Browser(app, google).http().put(HIRING_FEED_VERIFICATION_PATH).set("cookie", bola.cookie).send(body).expect(403)
      expect(response.body).toEqual({ error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } })
      expect(await ownRows()).toEqual([])
    })
    it("her session, another session's CSRF token: 403 csrf_invalid", async () => {
      const response = await new Browser(app, google).http().put(HIRING_FEED_VERIFICATION_PATH).set("cookie", bola.cookie).set(CSRF_HEADER, ada.csrfToken).send(body).expect(403)
      expect(response.body.error.code).toBe("csrf_invalid")
      expect(await ownRows()).toEqual([])
    })
    it.each(["text/plain", "application/x-www-form-urlencoded"])("content-type %s is refused and writes nothing", async (contentType) => {
      const response = await bola.put(HIRING_FEED_VERIFICATION_PATH).set("content-type", contentType).send("verifiedOn=2026-10-21&verificationBasis=x")
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
      expect(await ownRows()).toEqual([])
    })
    it("SEC-E8H-02 no content-type header: a body is 415 unsupported_media_type, an empty body is a plain 400; nothing recorded", async () => {
      const fastify = app.getHttpAdapter().getInstance() as import("fastify").FastifyInstance
      const auth = { cookie: bola.cookie, [CSRF_HEADER]: bola.csrfToken }
      const withBody = await fastify.inject({ method: "PUT", url: HIRING_FEED_VERIFICATION_PATH, headers: auth, payload: JSON.stringify({ verifiedOn: "2026-10-21", verificationBasis: "NoTypeMarker" }) })
      expect(withBody.headers["content-type"]).toMatch(/^application\/json/)
      expect([withBody.statusCode, withBody.json()]).toEqual([415, { error: { code: "unsupported_media_type", message: "The request body type is not supported." } }])
      const empty = await fastify.inject({ method: "PUT", url: HIRING_FEED_VERIFICATION_PATH, headers: auth })
      expect([empty.statusCode, empty.json()]).toEqual([400, { error: { code: "bad_request", message: "The request is not valid." } }])
      expect(await ownRows()).toEqual([])
    })

    it.each(["application/vnd.api+json", "application/merge-patch+json"])("SEC-E8H-02 content-type %s is 415 unsupported_media_type; nothing recorded", async (contentType) => {
      const response = await bola.put(HIRING_FEED_VERIFICATION_PATH).set("content-type", contentType).send(JSON.stringify({ verifiedOn: "2026-10-21", verificationBasis: "PlusJsonMarker" })).expect(415)
      expect(response.body).toEqual({ error: { code: "unsupported_media_type", message: "The request body type is not supported." } })
      expect(await ownRows()).toEqual([])
    })

    it("HV:135, HV:150 POST and DELETE: no session is 401 before CSRF, no CSRF is 403; nothing changes and no request", async () => {
      await recordOwn(database.db, bolaId)
      const id = await insertHiringFeed(database.db, bolaId, HFEED_B)
      const anon = () => new Browser(app, google).http()
      expect((await anon().post(HIRING_ALERT_FEEDS_PATH).send({ url: HFEED_A, label: null })).body.error.code).toBe("unauthenticated")
      expect((await anon().post(HIRING_ALERT_FEEDS_PATH).set("cookie", bola.cookie).send({ url: HFEED_A, label: null })).body.error.code).toBe("csrf_invalid")
      expect((await anon().delete(`${HIRING_ALERT_FEEDS_PATH}/${id}`)).body.error.code).toBe("unauthenticated")
      expect((await anon().delete(`${HIRING_ALERT_FEEDS_PATH}/${id}`).set("cookie", bola.cookie)).body.error.code).toBe("csrf_invalid")
      expect(await hiringFeedRows(bolaId)).toEqual([{ url: HFEED_B, label: null }])
      expect(feeds.requests).toEqual([])
    })
    it.each([
      ["text/plain", JSON.stringify({ url: HFEED_A, label: null })],
      ["multipart/form-data; boundary=x", `--x\r\nContent-Disposition: form-data; name="url"\r\n\r\n${HFEED_A}\r\n--x--\r\n`],
    ])("SEC-E8-02b a %s registration is a plain 400 before any request; nothing stored", async (contentType, payload) => {
      await recordOwn(database.db, bolaId)
      const response = await bola.post(HIRING_ALERT_FEEDS_PATH).set("content-type", contentType).send(payload).expect(400)
      expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
      expect(feeds.requests).toEqual([])
      expect(await hiringFeedRows(bolaId)).toEqual([])
    })
    it("SEC-E8-02b a form registration without a session is 401 and without a CSRF token is 403, before the media type check", async () => {
      await recordOwn(database.db, bolaId)
      const anon = () => new Browser(app, google).http().post(HIRING_ALERT_FEEDS_PATH).set("content-type", "application/x-www-form-urlencoded")
      expect((await anon().set(CSRF_HEADER, bola.csrfToken).send(`url=${encodeURIComponent(HFEED_A)}`).expect(401)).body.error.code).toBe("unauthenticated")
      expect((await anon().set("cookie", bola.cookie).send(`url=${encodeURIComponent(HFEED_A)}`).expect(403)).body.error.code).toBe("csrf_invalid")
      expect(await hiringFeedRows(bolaId)).toEqual([])
    })
    it("a form-encoded registration is refused before any request", async () => {
      await recordOwn(database.db, bolaId)
      const response = await bola.post(HIRING_ALERT_FEEDS_PATH).set("content-type", "application/x-www-form-urlencoded").send(`url=${encodeURIComponent(HFEED_A)}`)
      expect(response.status).toBe(400)
      expect(feeds.requests).toEqual([])
      expect(await hiringFeedRows(bolaId)).toEqual([])
    })
  })

  it("HAF:585 no route deletes the record: DELETE, POST and PATCH on the path are not served (DELETE meets the :id route's non-UUID 400) and leave it unchanged", async () => {
    await recordOwn(database.db, bolaId)
    const before = await ownRows()
    for (const method of ["delete", "post", "patch"] as const) {
      const response = await bola[method](HIRING_FEED_VERIFICATION_PATH).send({})
      expect([400, 404, 405]).toContain(response.status)
    }
    await save(bola, { verifiedOn: "", verificationBasis: "" }).expect(400)
    expect(await ownRows()).toEqual(before)
  })

  it.each([
    ["the global pause", { global_paused: true }],
    ["the cost pause", { cost_paused: true }],
  ])("HAF:593 works during %s", async (_name, pause) => {
    await database.db.updateTable("control_state").set(pause).execute()
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
  })

  it("HAF:606 recording and updating make no outbound request, no AI call, no spend", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    await save(bola, { verifiedOn: "2026-10-22", verificationBasis: "Read again." }).expect(200)
    expect(feeds.requests).toEqual([])
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })

  it("HAF:615, P3-6c/d the basis is never logged or echoed; the log records the save with her Candidate id", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Basis-marker-7c1f" }).expect(200)
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Basis-marker-9e2a" }).expect(200)
    const refused = await save(bola, { verifiedOn: "2026-10-21", verificationBasis: `Basis-marker-7c1f${"a".repeat(600)}` }).expect(400)
    await hiringFeeds(bola).expect(200)
    const all = logs.join("\n")
    expect(all).not.toContain("Basis-marker-7c1f")
    expect(all).not.toContain("Basis-marker-9e2a")
    expect(JSON.stringify(refused.body)).not.toContain("Basis-marker")
    expect(all).toContain(`Hiring feed verification saved for Candidate ${bolaId}`)
  })

  it("HAF:624, P3-6f the basis is returned only to its author", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)
    await save(ada, { verifiedOn: "2026-10-21", verificationBasis: "Ada's basis" }).expect(200)
    const bolaBody = JSON.stringify((await hiringFeeds(bola).expect(200)).body)
    const adaBody = JSON.stringify((await hiringFeeds(ada).expect(200)).body)
    expect(bolaBody).toContain("Bola's basis")
    expect(bolaBody).not.toContain("Ada's basis")
    expect(adaBody).toContain("Ada's basis")
    expect(adaBody).not.toContain("Bola's basis")
    for (const who of [ada, bola]) expect(JSON.stringify((await who.get(HIRING_POSTS_PATH).expect(200)).body)).not.toMatch(/basis/i)
  })

  it("HAF:661 saving one Candidate's record never changes another's (row and update time byte-equal)", async () => {
    await recordOwn(database.db, ADA(), "Ada's basis", "2026-10-01")
    const adaBefore = await database.db.selectFrom("hiring_feed_verification").selectAll().where("candidate_id", "=", ADA()).executeTakeFirstOrThrow()
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)
    expect(await database.db.selectFrom("hiring_feed_verification").selectAll().where("candidate_id", "=", ADA()).executeTakeFirstOrThrow()).toEqual(adaBefore)
    expect(hiringAlertFeedsResponseSchema.parse((await hiringFeeds(ada).expect(200)).body).verification?.verifiedOn).toBe("2026-10-01")
  })
})

describe("POST hiring-feeds: registration (AC 6.1 to 6.4)", () => {
  it("HAF:52, HAF:87, HAF:987 registers with a label: 201 with the full URL once, posts stored from the one fetch, no Stack post", async () => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: twoEntries() })
    const response = await registerHiring(ada, HFEED_A, "Frontend hiring").expect(201)
    expect(response.headers["cache-control"]).toBe("no-store")
    const body = registerAlertFeedResponseSchema.parse(response.body)
    expect(body).toMatchObject({ feed: { label: "Frontend hiring", maskedUrl: "…123456", url: HFEED_A, failure: null, lastReadAt: "2026-10-24T09:00:00.000Z" }, storedPosts: 2 })
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
    expect(await database.db.selectFrom("hiring_post").select("canonical_url").orderBy("canonical_url").execute()).toEqual([{ canonical_url: POST_1 }, { canonical_url: POST_2 }])
    expect(await database.db.selectFrom("stack_post").select("id").execute()).toEqual([])
    // Every later response shows only the mask.
    const later = JSON.stringify([(await hiringFeeds(ada).expect(200)).body, (await ada.get(HIRING_POSTS_PATH).expect(200)).body])
    expect(later).not.toContain(HFEED_A_DIGITS)
    expect(later).toContain("…123456")
  })

  it("HAF:79 no label is stored as null", async () => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    await registerHiring(ada, HFEED_A, "   ").expect(201)
    expect(await hiringFeedRows(ADA())).toEqual([{ url: HFEED_A, label: null }])
  })

  it("HAF:62, HAF:71 the lists are separate: a Hiring feed is not in alert-feeds, a Stack feed is not in hiring-feeds", async () => {
    await recordOwn(database.db, ADA())
    await recordOwnStack(database.db, ADA())
    await insertHiringFeed(database.db, ADA(), HFEED_A, { label: "Frontend hiring" })
    await insertStackFeed(database.db, ADA(), SFEED_A, { label: "React posts" })
    const stack = alertFeedsResponseSchema.parse((await ada.get(ALERT_FEEDS_PATH).expect(200)).body)
    const hiring = hiringAlertFeedsResponseSchema.parse((await hiringFeeds(ada).expect(200)).body)
    expect(stack.feeds.map((feed) => feed.label)).toEqual(["React posts"])
    expect(hiring.feeds.map((feed) => feed.label)).toEqual(["Frontend hiring"])
  })

  it("HAF:635, HAF:653 without her own record: 409 with the exact message, no request; another Candidate's record does not count", async () => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    const response = await registerHiring(bola, HFEED_A).expect(409)
    expect(response.body).toEqual(NOT_VERIFIED)
    expect(feeds.requests).toEqual([])
    expect(await hiringFeedRows(bolaId)).toEqual([])
  })

  it("HAF:678 the shared EPIC-0005 record enables Hiring feeds for neither the Operator nor the invitee", async () => {
    await recordLegacyShared(database.db)
    for (const who of [ada, bola]) expect((await registerHiring(who, HFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
    expect(feeds.requests).toEqual([])
  })

  it("HAF:686 a missing shared record does not block her own Hiring feeds; Stack posts still 409 (no Stack posts record of her own)", async () => {
    await recordOwn(database.db, bolaId)
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    await registerHiring(bola, HFEED_A).expect(201)
    expect((await registerStack(bola, SFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
  })

  it("HAF:697, P3-17c recording her own Hiring record creates no Stack posts record and her Stack posts registration is still 409", async () => {
    // EPIC-0008: the Stack posts gate is her own Stack posts record; the legacy shared row stays absent too.
    await save(ada, { verifiedOn: "2026-10-21", verificationBasis: "Ada's own." }).expect(200)
    expect(await database.db.selectFrom("alert_feed_candidate_verification").selectAll().execute()).toEqual([])
    expect(await legacySharedRows(database.db)).toEqual([])
    expect(alertFeedsResponseSchema.parse((await ada.get(ALERT_FEEDS_PATH).expect(200)).body).verification).toBeNull()
    expect((await registerStack(ada, SFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
  })

  // EPIC-0008 supersedes HAF:706 and HAF:715 (gherkin/README.md): the Stack posts save is per Candidate, with no role check.
  it("HAF:706 (superseded by EPIC-0008 SOR:162) an invitee's Stack posts save is 200, writes only her own Stack posts row and leaves her Hiring record", async () => {
    await recordOwn(database.db, bolaId, "Bola's own", "2026-10-21")
    const response = await bola.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Invitee." }).expect(200)
    expect(alertFeedsResponseSchema.parse(response.body).verification).toMatchObject({ verifiedOn: "2026-10-21", verificationBasis: "Invitee." })
    expect(await database.db.selectFrom("alert_feed_candidate_verification").select(["candidate_id", "verification_basis"]).execute()).toEqual([{ candidate_id: bolaId, verification_basis: "Invitee." }])
    expect(await legacySharedRows(database.db)).toEqual([])
    expect((await ownRows()).map((row) => [row.candidate_id, row.verified_on, row.verification_basis])).toEqual([[bolaId, "2026-10-21", "Bola's own"]])
  })

  it("HAF:715 (superseded by EPIC-0008 SOR:401) the Operator's Stack posts save writes her own Stack posts row and creates no Hiring record", async () => {
    await ada.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Ada Stack." }).expect(200)
    expect(await database.db.selectFrom("alert_feed_candidate_verification").select(["candidate_id", "verification_basis"]).execute()).toEqual([{ candidate_id: ADA(), verification_basis: "Ada Stack." }])
    expect(await legacySharedRows(database.db)).toEqual([])
    expect(await ownRows()).toEqual([])
  })

  it("HAF:221 a field error comes before the own-record 409, with no request", async () => {
    const response = await bola.post(HIRING_ALERT_FEEDS_PATH).send({ url: "https://www.google.com/alerts/feeds/0123", label: null }).expect(400)
    expect(fieldErrors(response.body)).toEqual([{ field: "url", position: null, problem: "invalid_format" }])
    expect(feeds.requests).toEqual([])
  })

  it.each([
    ["no session", (body: object) => new Browser(app, google).http().post(HIRING_ALERT_FEEDS_PATH).send(body), "unauthenticated"],
    ["no CSRF token", (body: object) => new Browser(app, google).http().post(HIRING_ALERT_FEEDS_PATH).set("cookie", bola.cookie).send(body), "csrf_invalid"],
  ] as const)("HAF:229 %s comes before the own-record refusal", async (_name, send, code) => {
    const response = await send({ url: HFEED_A, label: null })
    expect(response.body.error.code).toBe(code)
    expect(feeds.requests).toEqual([])
  })

  describe("HAF:203 the first refusal in check order wins, with no request", () => {
    it("no own record, her own Stack posts record, 10 feeds including HFEED_A: 409", async () => {
      await recordOwnStack(database.db, ADA())
      for (let n = 0; n < 9; n++) await insertHiringFeed(database.db, ADA(), hiringFeedUrl(n))
      await insertHiringFeed(database.db, ADA(), HFEED_A)
      expect((await registerHiring(ada, HFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
    })
    it("no own record and SFEED_A in her Stack list: 409", async () => {
      await insertStackFeed(database.db, ADA(), SFEED_A)
      expect((await registerHiring(ada, SFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
    })
    it("own record and 10 feeds including HFEED_A: limit_reached", async () => {
      await recordOwn(database.db, ADA())
      for (let n = 0; n < 9; n++) await insertHiringFeed(database.db, ADA(), hiringFeedUrl(n))
      await insertHiringFeed(database.db, ADA(), HFEED_A)
      expect(fieldErrors((await registerHiring(ada, HFEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    })
    it("own record, 10 feeds and SFEED_A in her Stack list: limit_reached", async () => {
      await recordOwn(database.db, ADA())
      for (let n = 0; n < 10; n++) await insertHiringFeed(database.db, ADA(), hiringFeedUrl(n))
      await insertStackFeed(database.db, ADA(), SFEED_A)
      expect(fieldErrors((await registerHiring(ada, SFEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    })
    it("own record, HFEED_A in both of her lists (fixture): duplicate", async () => {
      await recordOwn(database.db, ADA())
      await insertHiringFeed(database.db, ADA(), HFEED_A)
      await insertStackFeed(database.db, ADA(), HFEED_A)
      expect(fieldErrors((await registerHiring(ada, HFEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "duplicate" }])
    })
    it("own record, SFEED_A in her Stack list and it would time out: in_other_list", async () => {
      await recordOwn(database.db, ADA())
      feeds.on(SFEED_A, { kind: "hang" })
      expect(await insertStackFeed(database.db, ADA(), SFEED_A)).toBeTruthy()
      expect(fieldErrors((await registerHiring(ada, SFEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "in_other_list" }])
    })
    afterEach(async () => {
      expect(feeds.requests).toEqual([])
    })
  })

  describe("HAF:241 the Stack posts route keeps its order with in_other_list after duplicate", () => {
    it("no Stack posts record of her own, her own Hiring record, HFEED_A in her Hiring list: 409 (her Hiring record does not lift it)", async () => {
      await recordOwn(database.db, ADA())
      await insertHiringFeed(database.db, ADA(), HFEED_A)
      expect((await registerStack(ada, HFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
    })
    it("own Stack posts record, 10 Stack feeds, HFEED_A a Hiring feed: limit_reached", async () => {
      await recordOwnStack(database.db, ADA())
      for (let n = 0; n < 10; n++) await insertStackFeed(database.db, ADA(), hiringFeedUrl(n))
      await insertHiringFeed(database.db, ADA(), HFEED_A)
      expect(fieldErrors((await registerStack(ada, HFEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    })
    it("own Stack posts record, SFEED_A in both lists (fixture): duplicate", async () => {
      await recordOwnStack(database.db, ADA())
      await insertStackFeed(database.db, ADA(), SFEED_A)
      await insertHiringFeed(database.db, ADA(), SFEED_A)
      expect(fieldErrors((await registerStack(ada, SFEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "duplicate" }])
    })
    it("HAF:110, HAF:133 own Stack posts record, HFEED_A a Hiring feed (sent with spaces), would time out: in_other_list", async () => {
      await recordOwnStack(database.db, ADA())
      await insertHiringFeed(database.db, ADA(), HFEED_A)
      feeds.on(HFEED_A, { kind: "hang" })
      expect(fieldErrors((await registerStack(ada, `  ${HFEED_A}  `).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "in_other_list" }])
      expect(await stackFeedRows(ADA())).toEqual([])
    })
    afterEach(async () => {
      expect(feeds.requests).toEqual([])
    })
  })

  it("HAF:99, HAF:152 a Stack posts feed URL (sent with spaces) is refused as in_other_list with no request and nothing stored", async () => {
    await recordOwn(database.db, ADA())
    await insertStackFeed(database.db, ADA(), SFEED_A)
    expect(fieldErrors((await registerHiring(ada, `  ${SFEED_A}  `).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "in_other_list" }])
    expect(feeds.requests).toEqual([])
    expect(await hiringFeedRows(ADA())).toEqual([])
  })

  it("HAF:142 a Stack posts registration in no other list behaves as in EPIC-0005", async () => {
    await recordOwnStack(database.db, ADA())
    feeds.on(SFEED_A, { kind: "body", body: atomFeed([]) })
    await registerStack(ada, SFEED_A, "React posts").expect(201)
    expect(await stackFeedRows(ADA())).toEqual([{ url: SFEED_A }])
  })

  it("HAF:160 after removing a Stack posts feed its URL can be registered as a Hiring feed", async () => {
    await recordOwn(database.db, ADA())
    const stackId = await insertStackFeed(database.db, ADA(), SFEED_A)
    await ada.delete(`${ALERT_FEEDS_PATH}/${stackId}`).expect(204)
    feeds.on(SFEED_A, { kind: "body", body: atomFeed([]) })
    await registerHiring(ada, SFEED_A).expect(201)
  })

  it("HAF:169 another Candidate's Stack posts feed URL does not block registration and is not revealed", async () => {
    await recordOwn(database.db, bolaId)
    await insertStackFeed(database.db, ADA(), SFEED_A)
    await insertHiringFeed(database.db, ADA(), HFEED_A)
    feeds.on(SFEED_A, { kind: "body", body: atomFeed([]) })
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    const a = await registerHiring(bola, SFEED_A).expect(201)
    const b = await registerHiring(bola, HFEED_A).expect(201)
    expect(JSON.stringify([a.body, b.body])).not.toMatch(/another|other Candidate|ada\.okafor|Operator/i)
  })

  it("HAF:259, HAF:266, HAF:275, HAF:292 the cap is 10 Hiring feeds, separate from 10 Stack feeds; removing one frees a slot", async () => {
    await recordOwn(database.db, ADA())
    for (let n = 0; n < 10; n++) await insertStackFeed(database.db, ADA(), hiringFeedUrl(100 + n))
    for (let n = 0; n < 9; n++) await insertHiringFeed(database.db, ADA(), hiringFeedUrl(n), { createdAt: new Date(Date.UTC(2026, 9, 20, 0, n)) })
    feeds.on(hiringFeedUrl(9), { kind: "body", body: atomFeed([]) })
    await registerHiring(ada, hiringFeedUrl(9)).expect(201)
    expect(fieldErrors((await registerHiring(ada, hiringFeedUrl(10)).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    expect(feeds.requestsTo(hiringFeedUrl(10))).toBe(0)
    expect(await hiringFeedRows(ADA())).toHaveLength(10)
    expect(await stackFeedRows(ADA())).toHaveLength(10)
    const [first] = hiringAlertFeedsResponseSchema.parse((await hiringFeeds(ada).expect(200)).body).feeds
    await ada.delete(`${HIRING_ALERT_FEEDS_PATH}/${first!.id}`).expect(204)
    feeds.on(hiringFeedUrl(10), { kind: "body", body: atomFeed([]) })
    await registerHiring(ada, hiringFeedUrl(10)).expect(201)
  })

  it("HAF:284 10 Hiring feeds do not block a 10th Stack feed", async () => {
    await recordOwnStack(database.db, ADA())
    for (let n = 0; n < 10; n++) await insertHiringFeed(database.db, ADA(), hiringFeedUrl(n))
    for (let n = 0; n < 9; n++) await insertStackFeed(database.db, ADA(), hiringFeedUrl(100 + n))
    feeds.on(SFEED_A, { kind: "body", body: atomFeed([]) })
    await registerStack(ada, SFEED_A).expect(201)
  })

  it("HAF:299 the cap counts only the session Candidate's feeds", async () => {
    await recordOwn(database.db, bolaId)
    for (let n = 0; n < 10; n++) await insertHiringFeed(database.db, ADA(), hiringFeedUrl(n))
    feeds.on(HFEED_B, { kind: "body", body: atomFeed([]) })
    await registerHiring(bola, HFEED_B).expect(201)
  })

  it("HAF:847 a duplicate is refused before any request", async () => {
    await recordOwn(database.db, ADA())
    await insertHiringFeed(database.db, ADA(), HFEED_A)
    expect(fieldErrors((await registerHiring(ada, HFEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "duplicate" }])
    expect(feeds.requests).toEqual([])
  })

  it.each([
    "http://www.google.com/alerts/feeds/0123/4567",
    "https://google.com/alerts/feeds/0123/4567",
    "https://www.google.com/alerts/feeds/0123",
    "https://www.google.com/alerts/feeds/0123/4567/extra",
    "https://www.google.com/alerts/feeds/0123/45a7",
    "https://www.google.com/search?q=site:linkedin.com/posts",
    "https://www.linkedin.com/search/results/content/?keywords=hiring",
    "https://www.google.com/alerts/feeds/0123/4567?x=1",
    "https://www.google.com/search?q=hiring",
  ])("HAF:811, OUT:75 %s is refused as invalid_format before any request", async (url) => {
    await recordOwn(database.db, ADA())
    expect(fieldErrors((await registerHiring(ada, url).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "invalid_format" }])
    expect(feeds.requests).toEqual([])
  })

  it.each([
    ["a".repeat(60), 201, "a".repeat(60)],
    ["a".repeat(61), 400, "too_long"],
    ["   ", 201, null],
    ["  Frontend hiring  ", 201, "Frontend hiring"],
    ["Hiring\tposts", 400, "invalid_characters"],
  ] as const)("HAF:831 label %j", async (label, status, expected) => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    const response = await registerHiring(ada, HFEED_A, label).expect(status)
    if (status === 201) expect((await hiringFeedRows(ADA()))[0]?.label).toBe(expected)
    else expect(fieldErrors(response.body)).toEqual([{ field: "label", position: null, problem: expected }])
  })

  it.each([
    ["not reachable", { kind: "reset" } as const, "not_reachable"],
    ["HTTP 500", { kind: "status", status: 500 } as const, "unexpected_response"],
    ["HTTP 302", { kind: "redirect", status: 302, location: "https://www.google.com/url?q=x" } as const, "redirected"],
    ["an HTML page", { kind: "body", body: "<!doctype html><html><body>hi</body></html>" } as const, "not_a_feed"],
    ["a stream past the cap", { kind: "stream", chunkBytes: 64 * 1024 } as const, "too_large"],
    ["no answer", { kind: "hang" } as const, "timed_out"],
  ])("HAF:863 %s: refused with %s, nothing stored, one attempt", async (_name, reply, reason) => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, reply)
    expect(fieldErrors((await registerHiring(ada, HFEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: reason }])
    expect(await hiringFeedRows(ADA())).toEqual([])
    expect(await database.db.selectFrom("hiring_post").select("id").execute()).toEqual([])
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
  })

  it.each([
    ["the global pause", { global_paused: true }],
    ["the cost pause", { cost_paused: true }],
  ])("HAF:961, OUT:95 registration is allowed during %s (EPIC-0005 rule)", async (_name, pause) => {
    await recordOwn(database.db, ADA())
    await database.db.updateTable("control_state").set(pause).execute()
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    await registerHiring(ada, HFEED_A).expect(201)
  })

  it("HAF:1046 registration makes no AI call and records no spend", async () => {
    await recordOwn(database.db, ADA())
    feeds.on(HFEED_A, { kind: "body", body: twoEntries() })
    await registerHiring(ada, HFEED_A).expect(201)
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })
})

describe("DELETE hiring-feeds/:id (HAF:916, HAF:925, HAF:1006)", () => {
  it("HAF:916 removes the feed, keeps its posts with source null; the URL can then go in either list", async () => {
    await recordOwn(database.db, ADA())
    await recordOwnStack(database.db, ADA())
    const id = await insertHiringFeed(database.db, ADA(), HFEED_A, { label: "Frontend hiring" })
    await insertHiringPosts(database.db, ADA(), [{ feedId: id }, { feedId: id }, { feedId: id }])
    const response = await ada.delete(`${HIRING_ALERT_FEEDS_PATH}/${id}`).expect(204)
    expect(response.headers["cache-control"]).toBe("no-store")
    const posts = hiringPostsResponseSchema.parse((await ada.get(HIRING_POSTS_PATH).expect(200)).body)
    expect(posts.items.map((item) => item.source)).toEqual([null, null, null])
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    await registerStack(ada, HFEED_A).expect(201)
  })

  it("HAF:925 removing an already removed feed changes nothing; a non-UUID is a plain 400", async () => {
    const keep = await insertHiringFeed(database.db, ADA(), HFEED_B)
    await ada.delete(`${HIRING_ALERT_FEEDS_PATH}/00000000-0000-4000-8000-000000000999`).expect(204)
    const bad = await ada.delete(`${HIRING_ALERT_FEEDS_PATH}/not-a-uuid`).expect(400)
    expect(apiErrorResponseSchema.parse(bad.body).error.fieldErrors).toBeUndefined()
    expect((await database.db.selectFrom("hiring_alert_feed").select("id").execute()).map((row) => row.id)).toEqual([keep])
  })

  it("HAF:1006, P3-8 another Candidate's feed id gets 204 and the row stays", async () => {
    const id = await insertHiringFeed(database.db, ADA(), HFEED_A)
    await bola.delete(`${HIRING_ALERT_FEEDS_PATH}/${id}`).expect(204)
    expect(await hiringFeedRows(ADA())).toEqual([{ url: HFEED_A, label: null }])
  })
})

describe("GET hiring-posts (AC 7.4)", () => {
  it("HP:221, HP:227, HP:154 newest first by published date, ties by first seen; matched technologies never order", async () => {
    await insertHiringPosts(database.db, ADA(), [
      { title: "22", publishedAt: new Date("2026-10-22T09:00:00Z"), matched: ["React", "TypeScript"] },
      { title: "24-first", publishedAt: new Date("2026-10-24T08:00:00Z"), firstSeenAt: new Date("2026-10-24T08:10:00Z") },
      { title: "23", publishedAt: new Date("2026-10-23T09:00:00Z"), matched: ["React"] },
      { title: "24-second", publishedAt: new Date("2026-10-24T08:00:00Z"), firstSeenAt: new Date("2026-10-24T08:20:00Z") },
    ])
    const response = await ada.get(HIRING_POSTS_PATH).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    const body = hiringPostsResponseSchema.parse(response.body)
    expect(body.items.map((item) => item.title)).toEqual(["24-second", "24-first", "23", "22"])
    expect(JSON.stringify(body)).not.toMatch(/score|rank/)
  })

  it("item shape: date and dateKind fall back to first seen; source carries label and mask only", async () => {
    const feedId = await insertHiringFeed(database.db, ADA(), HFEED_A, { label: "Frontend hiring" })
    await insertHiringPosts(database.db, ADA(), [{ canonicalUrl: POST_1, title: "T", snippet: "S", firstSeenAt: new Date("2026-10-24T08:00:00Z"), matched: [], feedId }])
    const [item] = hiringPostsResponseSchema.parse((await ada.get(HIRING_POSTS_PATH).expect(200)).body).items
    expect(item).toMatchObject({ canonicalUrl: POST_1, kind: "post", title: "T", snippet: "S", date: "2026-10-24T08:00:00.000Z", dateKind: "found", matchedTechnologies: [], source: { label: "Frontend hiring", maskedUrl: "…123456" } })
  })

  it.each([
    [0, 0],
    [1, 1],
    [50, 1],
    [51, 2],
  ])("HP:296, HP:289 %i posts give totalPages %i", async (count, pages) => {
    await insertHiringPosts(database.db, ADA(), Array.from({ length: count }, (_, i) => ({ firstSeenAt: new Date(Date.UTC(2026, 9, 1, 0, i)) })))
    const body = hiringPostsResponseSchema.parse((await ada.get(HIRING_POSTS_PATH).expect(200)).body)
    expect(body).toMatchObject({ page: 1, pageSize: 50, totalCount: count, totalPages: pages })
    expect(body.items).toHaveLength(Math.min(count, 50))
  })

  it("HP:296 2,000 posts give totalPages 40", async () => {
    await insertHiringPosts(database.db, ADA(), Array.from({ length: 2000 }, (_, i) => ({ firstSeenAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) })))
    expect(hiringPostsResponseSchema.parse((await ada.get(HIRING_POSTS_PATH).expect(200)).body)).toMatchObject({ totalCount: 2000, totalPages: 40 })
  })

  it.each(["0", "-1", "abc", "1.5", "01", "1e3", "1234567890"])("HP:315 page=%s is 400 page/invalid", async (page) => {
    const response = await ada.get(`${HIRING_POSTS_PATH}?page=${page}`).expect(400)
    expect(fieldErrors(response.body)).toEqual([{ field: "page", position: null, problem: "invalid" }])
  })

  it("HP:315 a page past the last returns no items with the true totals", async () => {
    await insertHiringPosts(database.db, ADA(), Array.from({ length: 60 }, (_, i) => ({ firstSeenAt: new Date(Date.UTC(2026, 9, 1, 0, i)) })))
    expect(hiringPostsResponseSchema.parse((await ada.get(`${HIRING_POSTS_PATH}?page=3`).expect(200)).body)).toEqual({ items: [], page: 3, pageSize: 50, totalCount: 60, totalPages: 2 })
  })

  it("HP:309, HP:334 totalCount and items are the caller's only", async () => {
    await insertHiringPosts(database.db, ADA(), Array.from({ length: 70 }, () => ({ title: "ADA-POST" })))
    await insertHiringPosts(database.db, bolaId, Array.from({ length: 3 }, () => ({ title: "BOLA-POST" })))
    const body = hiringPostsResponseSchema.parse((await bola.get(HIRING_POSTS_PATH).expect(200)).body)
    expect(body).toMatchObject({ totalCount: 3, totalPages: 1 })
    expect(body.items.every((item) => item.title === "BOLA-POST")).toBe(true)
  })

  it("HP:348 Hiring posts never in the Stack posts list and the reverse", async () => {
    await database.db
      .insertInto("stack_post")
      .values({ candidate_id: ADA(), id: crypto.randomUUID(), canonical_url: POST_2, kind: "post", title: "STACK", snippet: "", published_at: null, matched_technologies: [], source_feed_id: null, first_seen_at: new Date("2026-10-24T08:00:00Z") })
      .execute()
    await insertHiringPosts(database.db, ADA(), [{ canonicalUrl: POST_1, title: "HIRING" }])
    expect(stackPostsResponseSchema.parse((await ada.get(STACK_POSTS_PATH).expect(200)).body).items.map((item) => item.canonicalUrl)).toEqual([POST_2])
    expect(hiringPostsResponseSchema.parse((await ada.get(HIRING_POSTS_PATH).expect(200)).body).items.map((item) => item.canonicalUrl)).toEqual([POST_1])
  })

  it("is available without the caller's record and during both pauses", async () => {
    await database.db.updateTable("control_state").set({ global_paused: true, cost_paused: true }).execute()
    await insertHiringPosts(database.db, bolaId, [{ title: "kept" }])
    expect(hiringPostsResponseSchema.parse((await bola.get(HIRING_POSTS_PATH).expect(200)).body).totalCount).toBe(1)
  })

  it("HAF:998, HAF:1023 a Candidate never sees another's Hiring feeds or failing state", async () => {
    await recordOwn(database.db, ADA())
    await recordOwn(database.db, bolaId)
    await insertHiringFeed(database.db, ADA(), HFEED_A, { label: "Ada frontend hiring", failure: "timed_out" })
    await insertHiringFeed(database.db, bolaId, HFEED_B, { label: "Bola backend hiring" })
    const body = hiringAlertFeedsResponseSchema.parse((await hiringFeeds(bola).expect(200)).body)
    expect(body.feeds.map((feed) => [feed.label, feed.failure])).toEqual([["Bola backend hiring", null]])
  })
})
