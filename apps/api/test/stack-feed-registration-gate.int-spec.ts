import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import { ALERT_FEEDS_PATH, ALERT_FEED_VERIFICATION_PATH, CSRF_HEADER, apiErrorResponseSchema } from "@eve/contracts"
import pg from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { FEED_REGISTRATION_LOCK_CLASS } from "../src/stack-posts/stack-posts.repository.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { Browser } from "./support/browser.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { GatedFeedHttp, until } from "./support/qa-hiring-feeds.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import {
  BANNED_WORDING,
  HFEED_A,
  NOT_VERIFIED,
  SFEED_A,
  SFEED_B,
  clearFeeds,
  insertStackFeed,
  ownStackRow,
  recordHiring,
  recordStack,
  setLegacy,
  signInInvitee,
  stackFeed,
  stackFeedUrls,
  stackPostCount,
} from "./support/stack-feed-fixtures.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0008 `POST /v1/stack-posts/alert-feeds` gated by the caller's own record
 * (api-contract.md v1.22.0 check order 1 to 9a; stack-feed-registration-gate.feature,
 * backend and both scenarios; stack-feed-isolation.feature:123; stack-feed-migration.feature:193;
 * stack-feed-copy-and-unchanged.feature:46). Real api and Postgres (runtime role); the
 * production feed client behind a gate and a local feed server. Lock waits are observed
 * in pg_locks, never slept on.
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
let chidiId: string
const clock = new TestClock("2026-10-28T09:00:00.000Z")
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }

const twoPosts = () =>
  atomFeed([
    { title: "React in production", link: googleRedirect("https://www.linkedin.com/posts/e8-reg-1"), content: "React and TypeScript" },
    { title: "Hooks", link: googleRedirect("https://www.linkedin.com/posts/e8-reg-2"), content: "React" },
  ])

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  feeds = await FakeFeedServer.start()
  gate = new GatedFeedHttp(createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 300, sleep: async () => undefined }))
  app = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: gate })
  Logger.overrideLogger(capture)
  ada = await signInCandidate(new Browser(app, google))
  ;({ id: bolaId, session: bola } = await signInInvitee(app, google, database.db, "bola@example.com", "200000000000000000091"))
  chidiId = (await signInInvitee(app, google, database.db, "chidi@example.com", "200000000000000000092")).id
})

beforeEach(async () => {
  clock.set("2026-10-28T09:00:00.000Z")
  feeds.reset()
  gate.reset()
  outbound.reset()
  logs.length = 0
  Logger.overrideLogger(capture)
  await clearFeeds(database.db)
  await database.db.updateTable("job_criteria").set({ frameworks: ["React"], technologies: ["TypeScript"] }).execute()
})

afterEach(() => {
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

const ADA = () => database.operatorId
const register = (who: SignedInCandidate, url: string, label: string | null = null) => who.post(ALERT_FEEDS_PATH).send({ url, label })
const problems = (body: unknown) => (apiErrorResponseSchema.parse(body).error.fieldErrors ?? []).map((error) => `${error.field}/${error.problem}`)
const serve = (...urls: string[]) => urls.forEach((url) => feeds.on(url, { kind: "body", body: twoPosts() }))

describe("own record lets her register (SRG:27, :42; ISO:123 half; SRG:227)", () => {
  it.each([
    ["ada", () => ada, () => ADA()],
    ["bola", () => bola, () => bolaId],
  ])("SRG:27 %s with her own record registers SFEED_A: 201, one request, stored for her", async (_who, who, id) => {
    await recordStack(database.db, id())
    serve(SFEED_A)
    const response = await register(who(), SFEED_A, "React posts").expect(201)
    expect(response.body.feed).toMatchObject({ label: "React posts", maskedUrl: "…654321", url: SFEED_A })
    expect(feeds.requestsTo(SFEED_A)).toBe(1)
    expect(await stackFeedUrls(database.db, id())).toEqual([SFEED_A])
    expect(await stackPostCount(database.db, id())).toBe(2)
  })

  it("SRG:42 an invitee registers on her own record while the legacy shared record does not exist", async () => {
    await setLegacy(database.db as never, false)
    await recordStack(database.db, bolaId)
    serve(SFEED_A)
    await register(bola, SFEED_A).expect(201)
  })

  it("SRG:227 the same URL registered by two Candidates on their own records is stored for each; no message mentions the other", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    serve(SFEED_A)
    await register(ada, SFEED_A).expect(201)
    const response = await register(bola, SFEED_A).expect(201)
    expect(JSON.stringify(response.body)).not.toMatch(/another|other Candidate|ada\.okafor|Operator/i)
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([SFEED_A])
  })
})

describe("SEC-E8-02b the registration body is JSON only; session and CSRF come first", () => {
  const FORM = `url=${encodeURIComponent(SFEED_A)}&label=FormMarker`
  it.each([
    ["application/x-www-form-urlencoded", FORM],
    ["text/plain", JSON.stringify({ url: SFEED_A, label: "FormMarker" })],
    ["multipart/form-data; boundary=x", `--x\r\nContent-Disposition: form-data; name="url"\r\n\r\n${SFEED_A}\r\n--x--\r\n`],
  ])("content-type %s with her own record, session and CSRF token: plain 400, no request, nothing stored", async (contentType, body) => {
    await recordStack(database.db, bolaId)
    serve(SFEED_A)
    const response = await bola.post(ALERT_FEEDS_PATH).set("content-type", contentType).send(body).expect(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([])
    expect(await stackPostCount(database.db, bolaId)).toBe(0)
  })

  it("a form body without a session is 401 and without a CSRF token is 403, before the media type check", async () => {
    await recordStack(database.db, bolaId)
    const anon = () => new Browser(app, google).http().post(ALERT_FEEDS_PATH).set("content-type", "application/x-www-form-urlencoded")
    expect((await anon().set(CSRF_HEADER, bola.csrfToken).send(FORM).expect(401)).body.error.code).toBe("unauthenticated")
    expect((await anon().set("cookie", bola.cookie).send(FORM).expect(403)).body.error.code).toBe("csrf_invalid")
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([])
  })

  it.each(["application/json; charset=utf-8", "Application/JSON"])("content-type %s is accepted", async (contentType) => {
    await recordStack(database.db, bolaId)
    serve(SFEED_A)
    await bola.post(ALERT_FEEDS_PATH).set("content-type", contentType).send(JSON.stringify({ url: SFEED_A, label: null })).expect(201)
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([SFEED_A])
  })
})

describe("no own record is 409 before any fetch (SRG:60, :76, :86, :103; COPY:46)", () => {
  it("SRG:60, SRG:76 without her own record: 409 with the exact message, no request, nothing stored", async () => {
    serve(SFEED_A)
    const response = await register(bola, SFEED_A).expect(409)
    expect(response.body).toEqual(NOT_VERIFIED)
    expect(feeds.requests).toEqual([])
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([])
    expect(await stackPostCount(database.db, bolaId)).toBe(0)
  })

  it("COPY:46 the 409 message names no other person or shared record and tells her to record her own check", async () => {
    const { message } = (await register(bola, SFEED_A).expect(409)).body.error as { message: string }
    expect(message).not.toMatch(BANNED_WORDING)
    expect(message).toMatch(/^Record the permitted-use verification/)
  })

  it.each([
    ["ada (the Operator) has her own record", async () => recordStack(database.db, ADA())],
    ["chidi has his own record", async () => recordStack(database.db, chidiId)],
    ["bola has her own Hiring record", async () => recordHiring(database.db, bolaId)],
    ["the legacy shared record exists", async () => setLegacy(database.db as never, true)],
    [
      "the legacy shared record exists and every other Candidate has both records",
      async () => {
        await setLegacy(database.db as never, true)
        for (const id of [ADA(), chidiId]) {
          await recordStack(database.db, id)
          await recordHiring(database.db, id)
        }
      },
    ],
  ])("SRG:86 %s: bola is still refused 409 with no request", async (_name, arrange) => {
    await arrange()
    serve(SFEED_A)
    expect((await register(bola, SFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
    expect(feeds.requests).toEqual([])
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([])
  })

  it("SRG:103 the Operator with no record of her own is refused like anyone else", async () => {
    serve(SFEED_A)
    expect((await register(ada, SFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
    expect(feeds.requests).toEqual([])
  })
})

describe("check order (SRG:113, :130, :137)", () => {
  afterEach(() => {
    expect(feeds.requests).toEqual([])
  })

  it("SRG:113 row 1: no own record and 10 feeds including SFEED_A → 409", async () => {
    for (let n = 0; n < 9; n++) await insertStackFeed(database.db, bolaId, stackFeed(n))
    await insertStackFeed(database.db, bolaId, SFEED_A)
    expect((await register(bola, SFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
  })

  it("SRG:113 row 2: no own record, her Hiring record and HFEED_A a Hiring feed → 409, not in_other_list", async () => {
    await recordHiring(database.db, bolaId)
    await database.db.insertInto("hiring_alert_feed").values({ candidate_id: bolaId, id: crypto.randomUUID(), url: HFEED_A, label: null, created_at: clock.now(), last_read_at: null, last_failure_reason: null, last_failed_at: null }).execute()
    expect((await register(bola, HFEED_A).expect(409)).body).toEqual(NOT_VERIFIED)
  })

  it("SRG:113 row 3: own record, 10 feeds, HFEED_A a Hiring feed → limit_reached", async () => {
    await recordStack(database.db, bolaId)
    for (let n = 0; n < 10; n++) await insertStackFeed(database.db, bolaId, stackFeed(n))
    await database.db.insertInto("hiring_alert_feed").values({ candidate_id: bolaId, id: crypto.randomUUID(), url: HFEED_A, label: null, created_at: clock.now(), last_read_at: null, last_failure_reason: null, last_failed_at: null }).execute()
    expect(problems((await register(bola, HFEED_A).expect(400)).body)).toEqual(["url/limit_reached"])
  })

  it("SRG:113 row 4: own record, SFEED_A in both lists → duplicate", async () => {
    await recordStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_A)
    await database.db.insertInto("hiring_alert_feed").values({ candidate_id: bolaId, id: crypto.randomUUID(), url: SFEED_A, label: null, created_at: clock.now(), last_read_at: null, last_failure_reason: null, last_failed_at: null }).execute()
    expect(problems((await register(bola, SFEED_A).expect(400)).body)).toEqual(["url/duplicate"])
  })

  it("SRG:113 row 5: own record, HFEED_A a Hiring feed that would time out → in_other_list", async () => {
    await recordStack(database.db, bolaId)
    await database.db.insertInto("hiring_alert_feed").values({ candidate_id: bolaId, id: crypto.randomUUID(), url: HFEED_A, label: null, created_at: clock.now(), last_read_at: null, last_failure_reason: null, last_failed_at: null }).execute()
    feeds.on(HFEED_A, { kind: "hang" })
    expect(problems((await register(bola, HFEED_A).expect(400)).body)).toEqual(["url/in_other_list"])
  })

  it("SRG:130 a field error comes before the own-record 409", async () => {
    expect(problems((await register(bola, "https://www.google.com/alerts/feeds/0123").expect(400)).body)).toEqual(["url/invalid_format"])
  })

  it.each([
    ["no session", () => new Browser(app, google).http().post(ALERT_FEEDS_PATH).send({ url: SFEED_A, label: null }), "unauthenticated"],
    ["no valid CSRF token", () => new Browser(app, google).http().post(ALERT_FEEDS_PATH).set("cookie", bola.cookie).send({ url: SFEED_A, label: null }), "csrf_invalid"],
  ])("SRG:137 %s comes before the own-record refusal", async (_name, send, code) => {
    expect((await send()).body.error.code).toBe(code)
  })
})

describe("limits (SRG:151, :158; MIG:193)", () => {
  it("SRG:151 an invitee with her own record reaches the 10th feed and is refused the 11th with no request", async () => {
    await recordStack(database.db, bolaId)
    for (let n = 0; n < 9; n++) await insertStackFeed(database.db, bolaId, stackFeed(n))
    serve(stackFeed(9))
    await register(bola, stackFeed(9)).expect(201)
    expect(problems((await register(bola, stackFeed(10)).expect(400)).body)).toEqual(["url/limit_reached"])
    expect(feeds.requestsTo(stackFeed(10))).toBe(0)
    expect(await stackFeedUrls(database.db, bolaId)).toHaveLength(10)
  })

  it("SRG:158 another Candidate's 10 feeds do not count toward her limit", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    for (let n = 0; n < 10; n++) await insertStackFeed(database.db, ADA(), stackFeed(n))
    serve(SFEED_B)
    await register(bola, SFEED_B).expect(201)
  })

  it("MIG:193 10 legacy feeds stored before EPIC-0008 count toward her limit once she records", async () => {
    for (let n = 0; n < 10; n++) await insertStackFeed(database.db, bolaId, stackFeed(n))
    await bola.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    expect(problems((await register(bola, stackFeed(20)).expect(400)).body)).toEqual(["url/limit_reached"])
    expect(feeds.requests).toEqual([])
  })
})

describe("races (SRG:168, :177, :184, :193, :202, :211, :220)", () => {
  it("SRG:168 a registration racing her first save never stores a feed without her record; an accepted fetch came after the record", async () => {
    const recordAtFetch: boolean[] = []
    serve(SFEED_A)
    gate.hold(SFEED_A)
    const save = Promise.resolve(bola.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }))
    const registration = Promise.resolve(register(bola, SFEED_A))
    // Observe whether her record existed when the fetch started (if it started at all), then let it go.
    const observed = until(async () => gate.waiting(SFEED_A) > 0, 3_000).then(
      async () => {
        recordAtFetch.push((await ownStackRow(database.db, bolaId)) !== undefined)
        gate.release(SFEED_A)
      },
      () => gate.release(SFEED_A)
    )
    const [saved, registered] = await Promise.all([save, registration])
    await observed
    expect(saved.status).toBe(200)
    if (registered.status === 409) {
      expect(registered.body).toEqual(NOT_VERIFIED)
      expect(await stackFeedUrls(database.db, bolaId)).toEqual([])
    } else {
      expect(registered.status).toBe(201)
      expect(recordAtFetch).toEqual([true])
      expect(await stackFeedUrls(database.db, bolaId)).toEqual([SFEED_A])
    }
  })

  it("SRG:177 20 fresh invitees each save and register at once: refused with nothing stored, or accepted with the record stored; never 500", async () => {
    serve(SFEED_A)
    const outcomes = new Set<number>()
    for (let round = 0; round < 20; round++) {
      const { id, session } = await signInInvitee(app, google, database.db, `race-${round}@example.com`, `2100000000000000000${String(round).padStart(2, "0")}`)
      outbound.reset() // the fake Google sign-in exchange
      const [saved, registered] = await Promise.all([
        session.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }),
        register(session, SFEED_A),
      ])
      expect(saved.status, `round ${round}`).toBe(200)
      expect([201, 409], `round ${round}`).toContain(registered.status)
      outcomes.add(registered.status)
      const stored = await stackFeedUrls(database.db, id)
      if (registered.status === 409) expect(stored).toEqual([])
      else {
        expect(stored).toEqual([SFEED_A])
        expect(await ownStackRow(database.db, id)).toBeDefined()
      }
    }
    expect(outcomes.size).toBeGreaterThan(0)
  }, 120_000)

  async function holdOnAdminConnection(statement: string, params: unknown[] = []): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: database.adminUrl })
    await client.connect()
    await client.query("begin")
    await client.query(statement, params)
    return client
  }

  it("SRG:184 a session holding ada's per-Candidate registration lock does not delay bola's registration", async () => {
    await recordStack(database.db, ADA())
    await recordStack(database.db, bolaId)
    serve(SFEED_B)
    const holder = await holdOnAdminConnection("select pg_advisory_xact_lock($1::int, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, ADA()])
    try {
      const started = Date.now()
      const response = await register(bola, SFEED_B)
      expect(response.status).toBe(201)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await holder.end()
    }
  })

  it("SRG:193 a row lock held on the legacy shared record does not delay registration", async () => {
    await setLegacy(database.db as never, true)
    await recordStack(database.db, bolaId)
    serve(SFEED_A)
    const holder = await holdOnAdminConnection("select singleton from alert_feed_verification for update")
    try {
      const started = Date.now()
      expect((await register(bola, SFEED_A)).status).toBe(201)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await holder.end()
    }
  })

  it("SRG:202 the cross-list race over 50 rounds: one list each time, the other in_other_list; never 500", async () => {
    await recordStack(database.db, bolaId)
    await recordHiring(database.db, bolaId)
    feeds.on(HFEED_A, { kind: "body", body: atomFeed([]) })
    for (let round = 0; round < 50; round++) {
      const [stack, hiring] = await Promise.all([register(bola, HFEED_A), bola.post("/v1/stack-posts/hiring-feeds").send({ url: HFEED_A, label: null })])
      const statuses = [stack.status, hiring.status].sort()
      const inStack = await database.db.selectFrom("alert_feed").select("id").where("url", "=", HFEED_A).execute()
      const inHiring = await database.db.selectFrom("hiring_alert_feed").select("id").where("url", "=", HFEED_A).execute()
      if (statuses.includes(503)) {
        for (const response of [stack, hiring].filter((item) => item.status === 503)) expect(response.headers["retry-after"]).toBe("5")
        expect(inStack.length + inHiring.length).toBeLessThanOrEqual(1)
      } else {
        expect(statuses, `round ${round}`).toEqual([201, 400])
        expect(problems((stack.status === 400 ? stack : hiring).body)).toEqual(["url/in_other_list"])
        expect(inStack.length + inHiring.length).toBe(1)
      }
      await database.db.deleteFrom("alert_feed").execute()
      await database.db.deleteFrom("hiring_alert_feed").execute()
    }
  }, 120_000)

  it("SRG:211 two registrations for her 10th slot leave exactly 10; the other is limit_reached", async () => {
    await recordStack(database.db, bolaId)
    for (let n = 0; n < 9; n++) await insertStackFeed(database.db, bolaId, stackFeed(n))
    serve(stackFeed(50), stackFeed(51))
    gate.hold(stackFeed(50))
    gate.hold(stackFeed(51))
    const pending = Promise.all([register(bola, stackFeed(50)), register(bola, stackFeed(51))])
    await until(() => gate.waiting(stackFeed(50)) === 1 && gate.waiting(stackFeed(51)) === 1)
    gate.release(stackFeed(50))
    gate.release(stackFeed(51))
    const responses = await pending
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400])
    expect(problems(responses.find((response) => response.status === 400)!.body)).toEqual(["url/limit_reached"])
    expect(await stackFeedUrls(database.db, bolaId)).toHaveLength(10)
  })

  it("SRG:220 two submits of the same URL store one feed; the other is duplicate", async () => {
    await recordStack(database.db, bolaId)
    serve(SFEED_A)
    gate.hold(SFEED_A)
    const pending = Promise.all([register(bola, SFEED_A), register(bola, SFEED_A)])
    await until(() => gate.waiting(SFEED_A) === 2)
    gate.release(SFEED_A)
    const responses = await pending
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400])
    expect(problems(responses.find((response) => response.status === 400)!.body)).toEqual(["url/duplicate"])
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([SFEED_A])
  })
})
