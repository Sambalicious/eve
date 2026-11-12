import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import { CSRF_HEADER } from "@eve/contracts"
import { sql } from "kysely"
import pg from "pg"
import supertest from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { untilLockWait } from "./support/lock-wait.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  ALERT_FEEDS_PATH,
  type ApiError,
  GatedFeedHttp,
  HFEED_A,
  HFEED_A_DIGITS,
  HFEED_B,
  HIRING_FEEDS_PATH,
  HIRING_VERIFICATION_PATH,
  type HiringFeedsBody,
  NOT_VERIFIED_MESSAGE,
  SFEED_A,
  clearPhase3,
  countRows,
  hiringFeedUrl,
  hiringFeedUrls,
  hiringVerifications,
  insertHiringFeed,
  insertStackFeed,
  setHiringVerification,
  setLegacySharedVerification,
  setOwnStackVerification,
  signInBoth,
  stackFeedUrl,
  stackFeedUrls,
  until,
} from "./support/qa-hiring-feeds.js"
import type { SignedInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0007 Phase 3, run epic-0007-p3, test authoring).
 * `POST /v1/stack-posts/hiring-feeds`, `DELETE …/hiring-feeds/{id}` and the
 * `in_other_list` change to `POST /v1/stack-posts/alert-feeds`
 * (api-contract.r1 check order steps 1 to 9a; hiring-alert-feeds.feature r4).
 * The production Alert feed client points at a local feed server through its
 * `testOrigin` seam, wrapped in a gate that parks fetches so two requests reach
 * the locked insert together. Lock waits are observed in `pg_locks`, never
 * slept on. Real api, real Postgres (runtime role); nothing leaves 127.0.0.1.
 */
let database: TestDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let gate: GatedFeedHttp
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let bolaId: string
const clock = new TestClock("2026-10-24T09:00:00.000Z")
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }

const POST_1 = "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000001-aaaa"
const POST_2 = "https://www.linkedin.com/posts/beta_frontend-activity-7250000000000000002-bbbb"
const twoPosts = () =>
  atomFeed([
    { title: "We're hiring", link: googleRedirect(POST_1), published: "2026-10-24T08:30:00Z" },
    { title: "Join us", link: googleRedirect(POST_2), published: "2026-10-23T08:30:00Z" },
  ])

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  feeds = await FakeFeedServer.start()
  gate = new GatedFeedHttp(createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 300 }))
  app = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: gate })
  Logger.overrideLogger(capture)
  ;({ ada, bola, bolaId } = await signInBoth(app, google, database.db))
})

beforeEach(async () => {
  clock.set("2026-10-24T09:00:00.000Z")
  feeds.reset()
  gate.reset()
  outbound.reset()
  logs.length = 0
  await clearPhase3(database.db)
  Logger.overrideLogger(capture)
})

afterEach(() => {
  // AC 6.4: no full feed URL in any log line; AC 10.3: nothing left 127.0.0.1.
  expect(logs.join("\n")).not.toContain(HFEED_A_DIGITS)
  expect(outbound.urls).toEqual([])
})

afterAll(async () => {
  gate?.reset()
  await app?.close()
  await feeds?.close()
  google?.close()
  await database?.stop()
  Logger.overrideLogger(false)
})

const register = (who: SignedInCandidate, url: string, label: string | null = null) => who.post(HIRING_FEEDS_PATH).send({ url, label })
const registerStack = (who: SignedInCandidate, url: string, label: string | null = null) => who.post(ALERT_FEEDS_PATH).send({ url, label })
/** Field problems of a refusal; [] for a success body (`{ feed, storedPosts }` has no `error`). Repair wave 1 (G-02). */
const problems = (body: unknown) => ((body as Partial<ApiError>).error?.fieldErrors ?? []).map((e) => `${e.field}/${e.problem}`)
const serveAll = (...urls: string[]) => urls.forEach((url) => feeds.on(url, { kind: "body", body: atomFeed([]) }))
const verifyAda = () => setHiringVerification(database.db, database.operatorId)
const verifyBola = () => setHiringVerification(database.db, bolaId)

describe("registration happy path (HAF:47, :74, :82, :979)", () => {
  it("201 with the full trimmed URL once; one fetch; posts from that fetch stored as Hiring posts only", async () => {
    await verifyAda()
    feeds.on(HFEED_A, { kind: "body", body: twoPosts() })
    const response = await register(ada, `  ${HFEED_A} `, "  Frontend hiring  ").expect(201)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.body).toMatchObject({ feed: { url: HFEED_A, label: "Frontend hiring", maskedUrl: "…123456", failure: null }, storedPosts: 2 })
    expect(feeds.requestsTo(HFEED_A)).toBe(1)
    expect(await countRows(database.db, "hiring_post", database.operatorId)).toBe(2)
    expect(await countRows(database.db, "stack_post")).toBe(0)
    const list = (await ada.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody
    expect(JSON.stringify(list)).not.toContain(HFEED_A_DIGITS)
    expect(list.feeds.map((f) => [f.label, f.maskedUrl])).toEqual([["Frontend hiring", "…123456"]])
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })

  it("HAF:57/:66 the lists stay apart: a Hiring feed is not in alert-feeds and a Stack posts feed is not in hiring-feeds", async () => {
    await verifyAda()
    await setOwnStackVerification(database.db, database.operatorId, true)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A, { label: "Frontend hiring" })
    await insertStackFeed(database.db, database.operatorId, SFEED_A, "React posts")
    const hiring = (await ada.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody
    const stack = (await ada.get(ALERT_FEEDS_PATH).expect(200)).body as HiringFeedsBody
    expect(hiring.feeds.map((f) => f.label)).toEqual(["Frontend hiring"])
    expect(stack.feeds.map((f) => f.label)).toEqual(["React posts"])
  })
})

describe("check order (HAF:198, :216, :224, :630; api-contract.r1 steps 1 to 7)", () => {
  it("HAF:630 no own record: 409 alert_feeds_not_verified with the exact contract message, no fetch, nothing stored", async () => {
    serveAll(HFEED_A)
    const response = await register(bola, HFEED_A).expect(409)
    expect((response.body as ApiError).error).toEqual({ code: "alert_feeds_not_verified", message: NOT_VERIFIED_MESSAGE })
    expect(feeds.requestsTo(HFEED_A)).toBe(0)
    expect(await countRows(database.db, "hiring_alert_feed")).toBe(0)
  })

  it("row 1: no own record + her own Stack posts record + 10 feeds including HFEED_A → 409 first", async () => {
    await setOwnStackVerification(database.db, database.operatorId, true)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    for (let n = 1; n <= 9; n += 1) await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
    serveAll(HFEED_A)
    expect((await register(ada, HFEED_A).expect(409)).body).toMatchObject({ error: { code: "alert_feeds_not_verified" } })
    expect(feeds.requests).toEqual([])
  })

  it("row 2: no own record + SFEED_A is her Stack posts feed → 409, not in_other_list", async () => {
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    expect((await register(ada, SFEED_A).expect(409)).body).toMatchObject({ error: { code: "alert_feeds_not_verified" } })
  })

  it("row 3: own record + 10 feeds including HFEED_A → limit_reached before duplicate", async () => {
    await verifyAda()
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    for (let n = 1; n <= 9; n += 1) await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
    expect(problems((await register(ada, HFEED_A).expect(400)).body)).toEqual(["url/limit_reached"])
    expect(feeds.requests).toEqual([])
  })

  it("row 4: own record + 10 feeds + SFEED_A a Stack posts feed → limit_reached before in_other_list", async () => {
    await verifyAda()
    for (let n = 1; n <= 10; n += 1) await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    expect(problems((await register(ada, SFEED_A).expect(400)).body)).toEqual(["url/limit_reached"])
  })

  it("row 5: own record, HFEED_A in both lists (fixture) → duplicate before in_other_list", async () => {
    await verifyAda()
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(1))
    await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(2))
    await insertStackFeed(database.db, database.operatorId, HFEED_A)
    expect(problems((await register(ada, HFEED_A).expect(400)).body)).toEqual(["url/duplicate"])
  })

  it("row 6: own record, SFEED_A a Stack posts feed that would time out → in_other_list before any fetch", async () => {
    await verifyAda()
    for (let n = 1; n <= 3; n += 1) await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    feeds.on(SFEED_A, { kind: "hang" })
    const response = await register(ada, SFEED_A).expect(400)
    expect((response.body as ApiError).error.fieldErrors).toEqual([{ field: "url", position: null, problem: "in_other_list" }])
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
    expect(await hiringFeedUrls(database.db, database.operatorId)).toHaveLength(3)
  })

  it("HAF:216 a field error comes before 409 (no own record)", async () => {
    const response = await register(bola, "https://www.google.com/alerts/feeds/0123").expect(400)
    expect(problems(response.body)).toEqual(["url/invalid_format"])
    expect(feeds.requests).toEqual([])
  })

  it("HAF:224 no session → 401 unauthenticated before 409", async () => {
    const response = await supertest(app.getHttpServer()).post(HIRING_FEEDS_PATH).set(CSRF_HEADER, "a".repeat(43)).send({ url: HFEED_A }).expect(401)
    expect((response.body as ApiError).error.code).toBe("unauthenticated")
    expect(feeds.requests).toEqual([])
  })

  it("HAF:224 her session without a valid CSRF token → 403 csrf_invalid before 409, nothing stored", async () => {
    await verifyBola()
    serveAll(HFEED_A)
    const response = await supertest(app.getHttpServer()).post(HIRING_FEEDS_PATH).set("cookie", bola.cookie).send({ url: HFEED_A }).expect(403)
    expect((response.body as ApiError).error.code).toBe("csrf_invalid")
    expect(feeds.requests).toEqual([])
    expect(await countRows(database.db, "hiring_alert_feed")).toBe(0)
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
  ])("HAF:806 %s is url/invalid_format before any request", async (url) => {
    await verifyAda()
    expect(problems((await register(ada, url).expect(400)).body)).toEqual(["url/invalid_format"])
    expect(feeds.requests).toEqual([])
  })
})

describe("cross-list refusal both directions (HAF:94, :105, :128, :147, :155, :164; D15)", () => {
  it("HAF:94 SFEED_A already a Stack posts feed → hiring registration url/in_other_list, no request, nothing stored", async () => {
    await verifyAda()
    await setOwnStackVerification(database.db, database.operatorId, true)
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    serveAll(SFEED_A)
    expect((await register(ada, SFEED_A).expect(400)).body).toEqual({ error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "url", position: null, problem: "in_other_list" }] } })
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
    expect(await countRows(database.db, "hiring_alert_feed")).toBe(0)
  })

  it("HAF:105 HFEED_A already a Hiring feed → Stack posts registration url/in_other_list, no request, no Alert feed", async () => {
    await verifyAda()
    await setOwnStackVerification(database.db, database.operatorId, true)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    serveAll(HFEED_A)
    expect(problems((await registerStack(ada, HFEED_A).expect(400)).body)).toEqual(["url/in_other_list"])
    expect(feeds.requestsTo(HFEED_A)).toBe(0)
    expect(await countRows(database.db, "alert_feed")).toBe(0)
  })

  it("HAF:128/:147 both cross-list checks compare the trimmed URL", async () => {
    await verifyAda()
    await setOwnStackVerification(database.db, database.operatorId, true)
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    expect(problems((await register(ada, `  ${SFEED_A}  `).expect(400)).body)).toEqual(["url/in_other_list"])
    expect(problems((await registerStack(ada, `\t${HFEED_A} `).expect(400)).body)).toEqual(["url/in_other_list"])
  })

  it("HAF:236 Stack posts order: no Stack posts record of her own 409 → limit → duplicate → in_other_list (own Hiring record never lifts the 409)", async () => {
    await verifyAda()
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    expect((await registerStack(ada, HFEED_A).expect(409)).body).toMatchObject({ error: { code: "alert_feeds_not_verified" } })
    await setOwnStackVerification(database.db, database.operatorId, true)
    for (let n = 1; n <= 10; n += 1) await insertStackFeed(database.db, database.operatorId, stackFeedUrl(n))
    expect(problems((await registerStack(ada, HFEED_A).expect(400)).body)).toEqual(["url/limit_reached"])
    await database.db.deleteFrom("alert_feed").execute()
    await insertStackFeed(database.db, database.operatorId, SFEED_A)
    await insertHiringFeed(database.db, database.operatorId, SFEED_A)
    expect(problems((await registerStack(ada, SFEED_A).expect(400)).body)).toEqual(["url/duplicate"])
    feeds.on(HFEED_A, { kind: "hang" })
    expect(problems((await registerStack(ada, HFEED_A).expect(400)).body)).toEqual(["url/in_other_list"])
    expect(feeds.requests).toEqual([])
  })

  it("HAF:137 a Stack posts registration in no other list still answers 201 as in EPIC-0005", async () => {
    await setOwnStackVerification(database.db, database.operatorId, true)
    serveAll(SFEED_A)
    expect((await registerStack(ada, SFEED_A, "React posts").expect(201)).body).toMatchObject({ feed: { url: SFEED_A, label: "React posts" } })
  })

  it("HAF:155 after removing the Stack posts feed, its URL registers as a Hiring feed", async () => {
    await verifyAda()
    await setOwnStackVerification(database.db, database.operatorId, true)
    const id = await insertStackFeed(database.db, database.operatorId, SFEED_A)
    await ada.delete(`${ALERT_FEEDS_PATH}/${id}`).expect(204)
    serveAll(SFEED_A)
    await register(ada, SFEED_A).expect(201)
  })

  it("HAF:164 another Candidate's Stack posts or Hiring feed with that URL never blocks and is never revealed", async () => {
    await verifyBola()
    await insertStackFeed(database.db, database.operatorId, SFEED_A, "ADA-SECRET")
    await insertHiringFeed(database.db, database.operatorId, HFEED_A, { label: "ADA-SECRET" })
    serveAll(SFEED_A, HFEED_A)
    const a = await register(bola, SFEED_A).expect(201)
    const b = await register(bola, HFEED_A).expect(201)
    expect(JSON.stringify([a.body, b.body])).not.toContain("ADA-SECRET")
  })
})

describe("cap of 10 per Candidate (HAF:254 to :294; D5)", () => {
  it("HAF:254/:261 the 10th is accepted; the 11th is url/limit_reached with no request", async () => {
    await verifyAda()
    for (let n = 1; n <= 9; n += 1) await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
    serveAll(HFEED_A, HFEED_B)
    await register(ada, HFEED_A).expect(201)
    expect(problems((await register(ada, HFEED_B).expect(400)).body)).toEqual(["url/limit_reached"])
    expect(feeds.requestsTo(HFEED_B)).toBe(0)
    expect(await countRows(database.db, "hiring_alert_feed", database.operatorId)).toBe(10)
  })

  it("HAF:270/:279 10 in one list never blocks the other", async () => {
    await verifyAda()
    await setOwnStackVerification(database.db, database.operatorId, true)
    for (let n = 1; n <= 10; n += 1) await insertStackFeed(database.db, database.operatorId, stackFeedUrl(n))
    serveAll(HFEED_A)
    await register(ada, HFEED_A).expect(201)
    await database.db.deleteFrom("alert_feed").where("url", "=", stackFeedUrl(10)).execute()
    for (let n = 2; n <= 10; n += 1) await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
    serveAll(SFEED_A)
    await registerStack(ada, SFEED_A).expect(201)
    expect(await countRows(database.db, "alert_feed", database.operatorId)).toBe(10)
    expect(await countRows(database.db, "hiring_alert_feed", database.operatorId)).toBe(10)
  })

  it("HAF:287 removing one of 10 frees a slot", async () => {
    await verifyAda()
    const ids: string[] = []
    for (let n = 1; n <= 10; n += 1) ids.push(await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n)))
    await ada.delete(`${HIRING_FEEDS_PATH}/${ids[0]}`).expect(204)
    serveAll(HFEED_A)
    await register(ada, HFEED_A).expect(201)
  })

  it("HAF:294 the cap counts only the session Candidate's feeds", async () => {
    await verifyAda()
    await verifyBola()
    for (let n = 1; n <= 10; n += 1) await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
    serveAll(HFEED_A)
    await register(bola, HFEED_A).expect(201)
  })
})

describe("label, duplicate, fetch failures, pauses (HAF:825 to :962)", () => {
  it.each<[string, string, string | null, string | null]>([
    ["60 a", "a".repeat(60), "a".repeat(60), null],
    ["61 a", "a".repeat(61), null, "label/too_long"],
    ["spaces only", "   ", null, null],
    ["trimmed", "  Frontend hiring  ", "Frontend hiring", null],
    ["a tab", "Hiring\tposts", null, "label/invalid_characters"],
  ])("HAF:825 label %s", async (_name, label, stored, problem) => {
    await verifyAda()
    serveAll(HFEED_A)
    const response = await register(ada, HFEED_A, label)
    if (problem) {
      expect(response.status).toBe(400)
      expect(problems(response.body)).toEqual([problem])
      expect(feeds.requests).toEqual([])
    } else {
      expect(response.status).toBe(201)
      expect((await sql<{ label: string | null }>`select label from hiring_alert_feed`.execute(database.db)).rows).toEqual([{ label: stored }])
    }
  })

  it("HAF:841 a URL already a Hiring feed is url/duplicate with no request", async () => {
    await verifyAda()
    await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    serveAll(HFEED_A)
    expect(problems((await register(ada, HFEED_A).expect(400)).body)).toEqual(["url/duplicate"])
    expect(feeds.requests).toEqual([])
  })

  it.each([
    ["not_reachable", { kind: "reset" }],
    ["unexpected_response", { kind: "status", status: 500 }],
    ["redirected", { kind: "redirect", status: 302, location: "https://example.org/elsewhere" }],
    ["not_a_feed", { kind: "body", body: "<html><body>Sign in</body></html>" }],
    ["timed_out", { kind: "hang" }],
  ] as const)("HAF:857 a fetch answering %s stores nothing and returns url/%s", async (reason, reply) => {
    await verifyAda()
    feeds.on(HFEED_A, reply)
    expect(problems((await register(ada, HFEED_A).expect(400)).body)).toEqual([`url/${reason}`])
    expect(await countRows(database.db, "hiring_alert_feed")).toBe(0)
    expect(await countRows(database.db, "hiring_post")).toBe(0)
  })

  it("HAF:953 registration during the global pause follows EPIC-0005 (allowed) and HAF:962 the cost pause too", async () => {
    await verifyAda()
    serveAll(HFEED_A, HFEED_B)
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    await register(ada, HFEED_A).expect(201)
    await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: true }).execute()
    await register(ada, HFEED_B).expect(201)
  })
})

describe("removal (HAF:910, :919, :998)", () => {
  it("removing her feed is 204, keeps its Hiring posts with source null; repeating is 204 and changes nothing", async () => {
    await verifyAda()
    feeds.on(HFEED_A, { kind: "body", body: twoPosts() })
    const id = ((await register(ada, HFEED_A, "Frontend hiring").expect(201)).body as { feed: { id: string } }).feed.id
    await ada.delete(`${HIRING_FEEDS_PATH}/${id}`).expect(204)
    await ada.delete(`${HIRING_FEEDS_PATH}/${id}`).expect(204)
    expect(await countRows(database.db, "hiring_alert_feed")).toBe(0)
    expect((await sql<{ source_feed_id: string | null }>`select source_feed_id from hiring_post`.execute(database.db)).rows).toEqual([{ source_feed_id: null }, { source_feed_id: null }])
  })

  it("HAF:998 removing another Candidate's feed by id answers 204 like an unknown id and keeps it", async () => {
    await verifyAda()
    await verifyBola()
    const f1 = await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await bola.delete(`${HIRING_FEEDS_PATH}/${f1}`).expect(204)
    await bola.delete(`${HIRING_FEEDS_PATH}/00000000-0000-4000-8000-0000000000ff`).expect(204)
    expect(await hiringFeedUrls(database.db, database.operatorId)).toEqual([HFEED_A])
  })

  it("a non-UUID id is a plain 400 bad_request", async () => {
    const response = await ada.delete(`${HIRING_FEEDS_PATH}/not-a-uuid`).expect(400)
    expect((response.body as ApiError).error.code).toBe("bad_request")
    expect((response.body as ApiError).error.fieldErrors).toBeUndefined()
  })

  it("removal without CSRF is 403 and keeps the feed (HV:141)", async () => {
    const id = await insertHiringFeed(database.db, database.operatorId, HFEED_A)
    await supertest(app.getHttpServer()).delete(`${HIRING_FEEDS_PATH}/${id}`).set("cookie", ada.cookie).expect(403)
    expect(await countRows(database.db, "hiring_alert_feed")).toBe(1)
  })
})

describe("own record gates only its owner (HAF:648, :673, :681, :717; D14, D15, D16)", () => {
  it("HAF:648 Ada's record never enables Bola's registration", async () => {
    await verifyAda()
    serveAll(HFEED_A)
    expect((await register(bola, HFEED_A).expect(409)).body).toMatchObject({ error: { code: "alert_feeds_not_verified" } })
    expect(((await bola.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody).verification).toBeNull()
  })

  it("HAF:673 the shared EPIC-0005 record enables Hiring feeds for neither the Operator nor Bola", async () => {
    await setLegacySharedVerification(database.db, true)
    serveAll(HFEED_A)
    await register(ada, HFEED_A).expect(409)
    await register(bola, HFEED_A).expect(409)
    expect(feeds.requests).toEqual([])
  })

  it("HAF:681 a missing shared record does not block Bola's own Hiring feed; her Stack posts registration still 409s", async () => {
    await verifyBola()
    serveAll(HFEED_A, SFEED_A)
    await register(bola, HFEED_A).expect(201)
    await registerStack(bola, SFEED_A).expect(409)
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
  })

  it("HAF:717 / D16 no Hiring record exists in a freshly migrated database, the Operator included", async () => {
    expect(await countRows(database.db, "hiring_feed_verification")).toBe(0)
    const fresh = await startMigratedDatabase()
    try {
      expect((await sql<{ n: number }>`select count(*)::int as n from hiring_feed_verification`.execute(fresh.db)).rows[0]?.n).toBe(0)
    } finally {
      await fresh.stop()
    }
  })

  it("HAF:717 / D16 a shared EPIC-0005 record does not become anyone's Hiring record when read through the routes", async () => {
    await setLegacySharedVerification(database.db, true)
    for (const who of [ada, bola]) expect(((await who.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody).verification).toBeNull()
    expect(await hiringVerifications(database.db)).toEqual([])
  })
})

describe("concurrency under the per-Candidate advisory lock (HAF:175, :186, :302, :725, :733, :849)", () => {
  it("HAF:849 a double submit of the same URL stores one feed (the other is url/duplicate)", async () => {
    await verifyAda()
    serveAll(HFEED_A)
    gate.hold(HFEED_A)
    const both = Promise.all([register(ada, HFEED_A), register(ada, HFEED_A)])
    await until(() => gate.waiting(HFEED_A) === 2)
    gate.release(HFEED_A)
    const statuses = (await both).map((r) => [r.status, problems(r.body)])
    expect(statuses).toContainEqual([201, []])
    expect(statuses).toContainEqual([400, ["url/duplicate"]])
    expect(await hiringFeedUrls(database.db, database.operatorId)).toEqual([HFEED_A])
  })

  it("HAF:302 two registrations for the 10th slot leave exactly 10; the other is url/limit_reached", async () => {
    await verifyAda()
    for (let n = 1; n <= 9; n += 1) await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
    serveAll(HFEED_A, HFEED_B)
    gate.hold(HFEED_A)
    gate.hold(HFEED_B)
    const both = Promise.all([register(ada, HFEED_A), register(ada, HFEED_B)])
    await until(() => gate.waiting(HFEED_A) === 1 && gate.waiting(HFEED_B) === 1)
    gate.release(HFEED_A)
    gate.release(HFEED_B)
    const results = (await both).map((r) => [r.status, problems(r.body)])
    expect(results).toContainEqual([201, []])
    expect(results).toContainEqual([400, ["url/limit_reached"]])
    expect(await countRows(database.db, "hiring_alert_feed", database.operatorId)).toBe(10)
  })

  it("HAF:175 one URL sent to both lists at once ends in exactly one list; the other is url/in_other_list", async () => {
    await verifyAda()
    await setOwnStackVerification(database.db, database.operatorId, true)
    serveAll(HFEED_A)
    gate.hold(HFEED_A)
    const both = Promise.all([register(ada, HFEED_A), registerStack(ada, HFEED_A)])
    await until(() => gate.waiting(HFEED_A) === 2)
    gate.release(HFEED_A)
    const results = (await both).map((r) => [r.status, problems(r.body)])
    expect(results).toContainEqual([201, []])
    expect(results).toContainEqual([400, ["url/in_other_list"]])
    const hiring = await hiringFeedUrls(database.db, database.operatorId)
    const stack = await stackFeedUrls(database.db, database.operatorId)
    expect(hiring.length + stack.length).toBe(1)
  })

  it("HAF:186 the cross-list race over 50 rounds: always exactly one list, the other in_other_list, never 500 or deadlock", async () => {
    await verifyAda()
    await setOwnStackVerification(database.db, database.operatorId, true)
    serveAll(HFEED_A)
    for (let round = 0; round < 50; round += 1) {
      gate.hold(HFEED_A)
      const both = Promise.all([register(ada, HFEED_A), registerStack(ada, HFEED_A)])
      await until(() => gate.waiting(HFEED_A) === 2)
      gate.release(HFEED_A)
      const results = await both
      for (const r of results) {
        expect(r.status, `round ${round}: ${JSON.stringify(r.body)}`).not.toBe(500)
        if (r.status === 503) {
          expect(r.headers["retry-after"]).toBe("5")
          expect((r.body as ApiError).error.code).toBe("service_unavailable")
        }
      }
      const stored = results.filter((r) => r.status === 201)
      const refused = results.filter((r) => r.status === 400)
      expect(stored.length, `round ${round}`).toBe(1)
      if (refused.length === 1) expect(problems(refused[0]!.body)).toEqual(["url/in_other_list"])
      const hiring = await hiringFeedUrls(database.db, database.operatorId)
      const stack = await stackFeedUrls(database.db, database.operatorId)
      expect(hiring.length + stack.length, `round ${round}`).toBe(1)
      await sql`delete from hiring_alert_feed`.execute(database.db)
      await database.db.deleteFrom("alert_feed").execute()
    }
    expect(logs.join("\n")).not.toMatch(/deadlock/i)
  })

  it("HAF:186 a registration that waits more than 3 s for the per-Candidate lock answers 503 Retry-After 5 and stores nothing", async () => {
    await verifyAda()
    serveAll(HFEED_A)
    // Hold Ada's registration lock on a separate connection, exactly as a concurrent registration would.
    const { FEED_REGISTRATION_LOCK_CLASS } = (await import("../src/stack-posts/stack-posts.repository.js")) as unknown as { FEED_REGISTRATION_LOCK_CLASS: number }
    expect(Number.isInteger(FEED_REGISTRATION_LOCK_CLASS)).toBe(true)
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    try {
      await holder.query("begin")
      await holder.query("select pg_advisory_xact_lock($1, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, database.operatorId])
      const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid
      const pending = register(ada, HFEED_A)
      const settled = pending.then((r) => r)
      await untilLockWait(database.db, "hiring registration", "advisory", holderPid)
      const response = await settled
      expect(response.status).toBe(503)
      expect(response.headers["retry-after"]).toBe("5")
      expect((response.body as ApiError).error).toEqual({ code: "service_unavailable", message: "The service is unavailable. Try again shortly." })
    } finally {
      await holder.query("rollback").catch(() => undefined)
      await holder.end()
    }
    expect(await countRows(database.db, "hiring_alert_feed")).toBe(0)
  })

  it("the Stack posts registration takes the same per-Candidate lock first (api-contract.r1 change 6)", async () => {
    await setOwnStackVerification(database.db, database.operatorId, true)
    serveAll(SFEED_A)
    const { FEED_REGISTRATION_LOCK_CLASS } = (await import("../src/stack-posts/stack-posts.repository.js")) as unknown as { FEED_REGISTRATION_LOCK_CLASS: number }
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    try {
      await holder.query("begin")
      await holder.query("select pg_advisory_xact_lock($1, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, database.operatorId])
      const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid
      const pending = registerStack(ada, SFEED_A).then((r) => r)
      await untilLockWait(database.db, "stack posts registration", "advisory", holderPid)
      await holder.query("rollback")
      expect((await pending).status).toBe(201)
    } finally {
      await holder.query("rollback").catch(() => undefined)
      await holder.end()
    }
  })

  it("HAF:725 a registration racing her first save never stores a feed without her record", async () => {
    serveAll(HFEED_A)
    for (let round = 0; round < 10; round += 1) {
      await sql`delete from hiring_alert_feed`.execute(database.db)
      await sql`delete from hiring_feed_verification`.execute(database.db)
      const [put, post] = await Promise.all([bola.put(HIRING_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }), register(bola, HFEED_A)])
      expect(put.status).toBe(200)
      expect([201, 409]).toContain(post.status)
      const record = (await hiringVerifications(database.db)).find((r) => r.candidate_id === bolaId)
      const feedCount = await countRows(database.db, "hiring_alert_feed", bolaId)
      if (feedCount > 0) expect(record).toBeDefined()
      if (post.status === 409) expect(feedCount).toBe(0)
    }
  })

  it("HAF:733 registrations of different Candidates at the same moment never change each other's result", async () => {
    await verifyAda()
    await verifyBola()
    await setOwnStackVerification(database.db, database.operatorId, true)
    await setOwnStackVerification(database.db, bolaId, true)
    for (let n = 1; n <= 9; n += 1) {
      await insertHiringFeed(database.db, database.operatorId, hiringFeedUrl(n))
      await insertHiringFeed(database.db, bolaId, hiringFeedUrl(n))
    }
    serveAll(HFEED_A, HFEED_B)
    gate.hold(HFEED_A)
    gate.hold(HFEED_B)
    const all = Promise.all([register(ada, HFEED_A), registerStack(bola, HFEED_A), register(bola, HFEED_B)])
    await until(() => gate.waiting(HFEED_A) === 2 && gate.waiting(HFEED_B) === 1)
    gate.release(HFEED_A)
    gate.release(HFEED_B)
    expect((await all).map((r) => r.status)).toEqual([201, 201, 201])
    expect(await hiringFeedUrls(database.db, database.operatorId)).toContain(HFEED_A)
    expect(await countRows(database.db, "hiring_alert_feed", bolaId)).toBe(10)
    expect(await hiringFeedUrls(database.db, bolaId)).toContain(HFEED_B)
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([HFEED_A])
  })
})
