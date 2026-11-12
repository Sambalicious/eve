import { CSRF_HEADER } from "@eve/contracts"
import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import { sql } from "kysely"
import pg from "pg"
import supertest from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { type AlertFeedGetOptions, type AlertFeedHttp, createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { atomFeed, googleRedirect } from "./support/alert-feed-fixtures.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { untilLockWait } from "./support/lock-wait.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { signInBoth } from "./support/qa-hiring-feeds.js"
import {
  ALERT_FEEDS_PATH,
  ALERT_FEED_VERIFICATION_PATH,
  type ApiError,
  BAD_REQUEST_MESSAGE,
  CSRF_INVALID,
  HFEED_A,
  HIRING_FEEDS_PATH,
  NOT_VERIFIED,
  SFEED_A,
  SFEED_A_DIGITS,
  SFEED_B,
  UNAUTHENTICATED,
  clearEpic8,
  countRows,
  fieldErrors,
  insertHiringFeed,
  insertStackFeed,
  ownStackRow,
  setHiringRecord,
  setLegacy,
  setOwnStack,
  stackFeedUrl,
  stackFeedUrls,
  until,
} from "./support/qa-stack-feed.js"
import type { SignedInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0008, run epic-0008, test authoring).
 * stack-feed-registration-gate.feature r1 (AC 2.1 to 2.3, 6.1) and the 409 part
 * of stack-feed-copy-and-unchanged.feature: `POST /v1/stack-posts/alert-feeds`
 * gated by the caller's own `alert_feed_candidate_verification` row (contract
 * v1.22.0 check order steps 1 to 9a), and the AR-4 locking change: the
 * registration takes only the per-Candidate advisory lock and a plain read of
 * the caller's own row, so it never waits on another Candidate or on a held
 * legacy row. `DELETE …/alert-feeds/{id}` without a record. The production
 * Alert feed client points at a local feed server through its `testOrigin` seam,
 * behind a recorder that notes whether the caller's record existed at fetch time.
 */
let database: TestDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let adaId: string
let bolaId: string
let chidiId: string
const clock = new TestClock("2026-10-24T09:00:00.000Z")
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }

/** Per fetch: the URL and whether `owner(url)` had a Stack posts record when the fetch began. */
class RecordingFeedHttp implements AlertFeedHttp {
  inner!: AlertFeedHttp
  readonly fetched: { url: string; recorded: boolean | null }[] = []
  owner: (url: string) => string | null = () => null
  private readonly gates = new Map<string, { waiting: number; open: Promise<void>; release: () => void }>()

  hold(url: string): void {
    let release!: () => void
    const open = new Promise<void>((r) => (release = r))
    this.gates.set(url, { waiting: 0, open, release })
  }

  waiting(url: string): number {
    return this.gates.get(url)?.waiting ?? 0
  }

  release(url: string): void {
    this.gates.get(url)?.release()
    this.gates.delete(url)
  }

  reset(): void {
    for (const url of [...this.gates.keys()]) this.release(url)
    this.fetched.length = 0
    this.owner = () => null
  }

  async get(url: string, options: AlertFeedGetOptions): Promise<string | null> {
    const id = this.owner(url)
    this.fetched.push({ url, recorded: id === null ? null : (await ownStackRow(database.db, id)) !== undefined })
    const gate = this.gates.get(url)
    if (gate) {
      gate.waiting += 1
      await gate.open
    }
    return this.inner.get(url, options)
  }
}
const http = new RecordingFeedHttp()

const POST_1 = "https://www.linkedin.com/posts/acme_react-activity-7250000000000000001-aaaa"
const onePost = () => atomFeed([{ title: "React in production", link: googleRedirect(POST_1), published: "2026-10-24T08:30:00Z", content: "React and TypeScript" }])

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  feeds = await FakeFeedServer.start()
  http.inner = createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 300 })
  app = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: http })
  Logger.overrideLogger(capture)
  ;({ ada, bola, bolaId } = await signInBoth(app, google, database.db, "bola@example.com"))
  adaId = database.operatorId
  ;({ bolaId: chidiId } = await signInBoth(app, google, database.db, "chidi@example.com"))
})

beforeEach(async () => {
  clock.set("2026-10-24T09:00:00.000Z")
  feeds.reset()
  http.reset()
  outbound.reset()
  logs.length = 0
  await clearEpic8(database.db)
  Logger.overrideLogger(capture)
})

afterEach(() => {
  // AC 8.1: nothing left 127.0.0.1; the full feed URL never reaches a log line.
  expect(outbound.urls).toEqual([])
  expect(logs.join("\n")).not.toContain(SFEED_A_DIGITS)
})

afterAll(async () => {
  http.reset()
  await app?.close()
  await feeds?.close()
  google?.close()
  await database?.stop()
  Logger.overrideLogger(false)
})

const register = (who: SignedInCandidate, url: string, label: string | null = null) => who.post(ALERT_FEEDS_PATH).send({ url, label })
const serve = (...urls: string[]) => urls.forEach((url) => feeds.on(url, { kind: "body", body: onePost() }))
const expect409 = (body: unknown) => expect((body as ApiError).error).toEqual(NOT_VERIFIED)

describe("own record unlocks registration (registration-gate:27, :42, :227; migration:63)", () => {
  it.each([
    ["ada (Operator)", () => ada, () => adaId],
    ["bola (invited)", () => bola, () => bolaId],
  ] as const)("%s with her own record registers SFEED_A: 201, one fetch, stored for her", async (_name, who, id) => {
    await setOwnStack(database.db, id())
    serve(SFEED_A)
    const response = await register(who(), SFEED_A, "React posts").expect(201)
    expect(response.body).toMatchObject({ feed: { url: SFEED_A, label: "React posts", maskedUrl: "…654321" }, storedPosts: 1 })
    expect(feeds.requestsTo(SFEED_A)).toBe(1)
    expect(await stackFeedUrls(database.db, id())).toEqual([SFEED_A])
  })

  it("registration-gate:42 an invitee registers on her own record while the legacy shared row does not exist", async () => {
    await setLegacy(database.db, false)
    await setOwnStack(database.db, bolaId)
    serve(SFEED_A)
    await register(bola, SFEED_A).expect(201)
  })

  it("registration-gate:227 the same URL registered by Ada and then Bola, each on her own record, is stored for each; no message mentions the other", async () => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    serve(SFEED_A)
    await register(ada, SFEED_A).expect(201)
    const response = await register(bola, SFEED_A).expect(201)
    const { feed, storedPosts } = response.body as { feed: { label: string | null }; storedPosts: number }
    expect(JSON.stringify({ label: feed.label, storedPosts })).not.toMatch(/another|other candidate|\bada\b/i)
    expect(JSON.stringify(response.body)).not.toContain(adaId)
    expect(await stackFeedUrls(database.db, adaId)).toEqual([SFEED_A])
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([SFEED_A])
  })
})

describe("no record but her own enables her (registration-gate:60, :86, :103; copy-and-unchanged:46)", () => {
  it.each([
    ["ada has her own record", async () => setOwnStack(database.db, adaId)],
    ["chidi has his own record", async () => setOwnStack(database.db, chidiId)],
    ["bola has her own Hiring record", async () => setHiringRecord(database.db, bolaId)],
    ["the legacy shared record exists", async () => setLegacy(database.db, true)],
    [
      "the legacy record exists and every other Candidate has both records",
      async () => {
        await setLegacy(database.db, true)
        for (const id of [adaId, chidiId]) {
          await setOwnStack(database.db, id)
          await setHiringRecord(database.db, id)
        }
      },
    ],
  ] as const)("bola, no record of her own (%s): 409 alert_feeds_not_verified, no fetch, nothing stored", async (_name, given) => {
    await given()
    serve(SFEED_A)
    expect409((await register(bola, SFEED_A).expect(409)).body)
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
    expect(await countRows(database.db, "alert_feed", bolaId)).toBe(0)
  })

  it("registration-gate:103 the Operator without her own record is refused like anyone else", async () => {
    await setLegacy(database.db, false)
    serve(SFEED_A)
    expect409((await register(ada, SFEED_A).expect(409)).body)
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
  })

  it("copy-and-unchanged:46 the 409 message is the fixed, list-neutral text and names no person or shared record", async () => {
    const body = (await register(bola, SFEED_A).expect(409)).body as ApiError
    expect(body.error.message).toBe(NOT_VERIFIED.message)
    expect(body.error.message).not.toMatch(/operator|admin|owner|the person who runs your eve|team|shared|installation|on behalf of/i)
  })

  it("isolation:123 Ada records; Bola is still refused", async () => {
    await ada.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Ada's basis" }).expect(200)
    expect409((await register(bola, SFEED_A).expect(409)).body)
  })
})

describe("check order (registration-gate:113, :130, :137)", () => {
  it("row 1: no own record, 10 feeds including SFEED_A → 409 first", async () => {
    await insertStackFeed(database.db, bolaId, SFEED_A)
    for (let n = 1; n <= 9; n += 1) await insertStackFeed(database.db, bolaId, stackFeedUrl(n))
    expect409((await register(bola, SFEED_A).expect(409)).body)
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
  })

  it("row 2: no own record, own Hiring record, HFEED_A a Hiring feed → 409, not in_other_list", async () => {
    await setHiringRecord(database.db, bolaId)
    await insertHiringFeed(database.db, bolaId, HFEED_A)
    expect409((await register(bola, HFEED_A).expect(409)).body)
  })

  it("row 3: own record, 10 feeds, HFEED_A a Hiring feed → limit_reached before in_other_list", async () => {
    await setOwnStack(database.db, bolaId)
    for (let n = 1; n <= 10; n += 1) await insertStackFeed(database.db, bolaId, stackFeedUrl(n))
    await insertHiringFeed(database.db, bolaId, HFEED_A)
    expect(fieldErrors((await register(bola, HFEED_A).expect(400)).body)).toEqual(["url/limit_reached"])
    expect(feeds.requestsTo(HFEED_A)).toBe(0)
  })

  it("row 4: own record, SFEED_A one of 3 feeds and also a fixture Hiring feed → duplicate before in_other_list", async () => {
    await setOwnStack(database.db, bolaId)
    await insertStackFeed(database.db, bolaId, SFEED_A)
    await insertStackFeed(database.db, bolaId, stackFeedUrl(1))
    await insertStackFeed(database.db, bolaId, stackFeedUrl(2))
    await insertHiringFeed(database.db, bolaId, SFEED_A)
    expect(fieldErrors((await register(bola, SFEED_A).expect(400)).body)).toEqual(["url/duplicate"])
  })

  it("row 5: own record, HFEED_A a Hiring feed that would time out → in_other_list, no fetch", async () => {
    await setOwnStack(database.db, bolaId)
    for (let n = 1; n <= 3; n += 1) await insertStackFeed(database.db, bolaId, stackFeedUrl(n))
    await insertHiringFeed(database.db, bolaId, HFEED_A)
    feeds.on(HFEED_A, { kind: "hang" })
    expect(fieldErrors((await register(bola, HFEED_A).expect(400)).body)).toEqual(["url/in_other_list"])
    expect(feeds.requestsTo(HFEED_A)).toBe(0)
  })

  it("registration-gate:130 a URL format error and no own record → the field error, not 409; no outbound request", async () => {
    const response = await register(bola, "https://www.google.com/alerts/feeds/0123").expect(400)
    expect((response.body as ApiError).error.message).toBe(BAD_REQUEST_MESSAGE)
    expect(fieldErrors(response.body)).toEqual(["url/invalid_format"])
    expect(http.fetched).toEqual([])
  })

  it("registration-gate:137 no session → 401 unauthenticated; no CSRF → 403 csrf_invalid; neither fetches", async () => {
    serve(SFEED_A)
    expect((await supertest(app.getHttpServer()).post(ALERT_FEEDS_PATH).send({ url: SFEED_A, label: null }).expect(401)).body).toEqual({ error: UNAUTHENTICATED })
    expect((await supertest(app.getHttpServer()).post(ALERT_FEEDS_PATH).set("cookie", bola.cookie).send({ url: SFEED_A, label: null }).expect(403)).body).toEqual({ error: CSRF_INVALID })
    expect((await supertest(app.getHttpServer()).post(ALERT_FEEDS_PATH).set("cookie", bola.cookie).set(CSRF_HEADER, ada.csrfToken).send({ url: SFEED_A, label: null }).expect(403)).body).toEqual({ error: CSRF_INVALID })
    expect(feeds.requestsTo(SFEED_A)).toBe(0)
  })
})

describe("limit counts only her feeds (registration-gate:151, :158; migration:193)", () => {
  it("registration-gate:151 an invitee with her own record and 9 feeds: the 10th is accepted, the 11th refused without a fetch", async () => {
    await setOwnStack(database.db, bolaId)
    for (let n = 1; n <= 9; n += 1) await insertStackFeed(database.db, bolaId, stackFeedUrl(n))
    serve(stackFeedUrl(10), stackFeedUrl(11))
    await register(bola, stackFeedUrl(10)).expect(201)
    expect(fieldErrors((await register(bola, stackFeedUrl(11)).expect(400)).body)).toEqual(["url/limit_reached"])
    expect(feeds.requestsTo(stackFeedUrl(11))).toBe(0)
    expect(await countRows(database.db, "alert_feed", bolaId)).toBe(10)
  })

  it("registration-gate:158 Ada's 10 feeds do not count toward Bola's limit", async () => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    for (let n = 1; n <= 10; n += 1) await insertStackFeed(database.db, adaId, stackFeedUrl(n))
    serve(SFEED_A)
    await register(bola, SFEED_A).expect(201)
  })

  it("migration:193 an invitee's 10 legacy feeds count toward her limit once she records", async () => {
    for (let n = 1; n <= 10; n += 1) await insertStackFeed(database.db, bolaId, stackFeedUrl(n))
    await bola.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }).expect(200)
    expect(fieldErrors((await register(bola, SFEED_A).expect(400)).body)).toEqual(["url/limit_reached"])
  })
})

describe("legacy feeds without a record: the list and DELETE (migration:122, :133, :155; contract DELETE)", () => {
  it("migration:133 GET returns her legacy feeds (masked) with verification null", async () => {
    const b = await insertStackFeed(database.db, bolaId, SFEED_B, { label: "Old feed" })
    const body = (await bola.get(ALERT_FEEDS_PATH).expect(200)).body as { verification: unknown; feeds: { id: string; label: string | null; maskedUrl: string }[] }
    expect(body.verification).toBeNull()
    expect(body.feeds.map((f) => [f.id, f.label, f.maskedUrl])).toEqual([[b, "Old feed", "…222333"]])
  })

  it("migration:155 removing a legacy feed works without a record (204); the record is never touched", async () => {
    const b = await insertStackFeed(database.db, bolaId, SFEED_B)
    await bola.delete(`${ALERT_FEEDS_PATH}/${b}`).expect(204)
    expect(await countRows(database.db, "alert_feed", bolaId)).toBe(0)
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
  })

  it("contract DELETE: another Candidate's feed id is a 204 no-op; a non-UUID id is a plain 400", async () => {
    const adaFeed = await insertStackFeed(database.db, adaId, SFEED_A)
    await bola.delete(`${ALERT_FEEDS_PATH}/${adaFeed}`).expect(204)
    expect(await stackFeedUrls(database.db, adaId)).toEqual([SFEED_A])
    expect((await bola.delete(`${ALERT_FEEDS_PATH}/not-a-uuid`).expect(400)).body).toEqual({ error: { code: "bad_request", message: BAD_REQUEST_MESSAGE } })
  })
})

describe("locked re-check and AR-4 locking (registration-gate:168 to :220)", () => {
  it("registration-gate:168 a registration racing her first save never stores a feed without her record; an accepted fetch came after her record", async () => {
    http.owner = (url) => (url === SFEED_A ? bolaId : null)
    serve(SFEED_A)
    const outcomes = new Set<number>()
    for (let round = 0; round < 10; round += 1) {
      await sql`delete from alert_feed`.execute(database.db)
      await sql`delete from alert_feed_candidate_verification`.execute(database.db)
      http.fetched.length = 0
      const [put, post] = await Promise.all([bola.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }), register(bola, SFEED_A)])
      expect(put.status).toBe(200)
      expect([201, 409]).toContain(post.status)
      outcomes.add(post.status)
      const feedCount = await countRows(database.db, "alert_feed", bolaId)
      if (feedCount > 0) expect(await ownStackRow(database.db, bolaId)).toBeDefined()
      if (post.status === 409) {
        expect409(post.body)
        expect(feedCount).toBe(0)
      } else {
        expect(http.fetched).toEqual([{ url: SFEED_A, recorded: true }])
      }
    }
    expect(outcomes.size).toBeGreaterThan(0)
  })

  it("registration-gate:168 the save still uncommitted when the registration re-checks: 409, nothing stored", async () => {
    serve(SFEED_A)
    const tx = new pg.Client({ connectionString: database.adminUrl })
    await tx.connect()
    try {
      await tx.query("begin")
      await tx.query("insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values ($1, '2026-10-21', 'In flight', now())", [bolaId])
      expect409((await register(bola, SFEED_A).expect(409)).body)
      await tx.query("commit")
    } finally {
      await tx.end()
    }
    expect(await countRows(database.db, "alert_feed", bolaId)).toBe(0)
  })

  it("registration-gate:177 20 fresh invitees each save and register at once: never half-stored, never 500 or deadlock", async () => {
    const pairs: { who: SignedInCandidate; id: string; url: string }[] = []
    for (let n = 0; n < 20; n += 1) {
      const { bola: who, bolaId: id } = await signInBoth(app, google, database.db, `fresh${n}.qa8@example.test`)
      outbound.reset() // the sign-in itself talks to the fake Google OAuth server
      pairs.push({ who, id, url: stackFeedUrl(500 + n) })
    }
    const byUrl = new Map(pairs.map((p) => [p.url, p.id]))
    http.owner = (url) => byUrl.get(url) ?? null
    serve(...pairs.map((p) => p.url))
    const results = await Promise.all(
      pairs.map(async (p) => {
        const [put, post] = await Promise.all([p.who.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." }), register(p.who, p.url)])
        return { p, put, post }
      })
    )
    for (const { p, put, post } of results) {
      expect(put.status, p.url).toBe(200)
      expect([201, 409], `${p.url} ${JSON.stringify(post.body)}`).toContain(post.status)
      const stored = await countRows(database.db, "alert_feed", p.id)
      if (post.status === 409) expect(stored).toBe(0)
      else {
        expect(stored).toBe(1)
        expect(http.fetched.filter((f) => f.url === p.url)).toEqual([{ url: p.url, recorded: true }])
      }
    }
    expect(logs.join("\n")).not.toMatch(/deadlock/i)
  })

  it("registration-gate:184 a held lock on Ada's registration does not delay Bola's (accepted within 2 s, not 503)", async () => {
    await setOwnStack(database.db, adaId)
    await setOwnStack(database.db, bolaId)
    serve(SFEED_B)
    const { FEED_REGISTRATION_LOCK_CLASS } = (await import("../src/stack-posts/stack-posts.repository.js")) as unknown as { FEED_REGISTRATION_LOCK_CLASS: number }
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    try {
      await holder.query("begin")
      await holder.query("select pg_advisory_xact_lock($1, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, adaId])
      const started = Date.now()
      const response = await register(bola, SFEED_B)
      expect(response.status).toBe(201)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await holder.query("rollback").catch(() => undefined)
      await holder.end()
    }
  })

  it("registration-gate:184 control: a held lock on Bola's own registration makes her wait (the lock is per Candidate, not absent)", async () => {
    await setOwnStack(database.db, bolaId)
    serve(SFEED_B)
    const { FEED_REGISTRATION_LOCK_CLASS } = (await import("../src/stack-posts/stack-posts.repository.js")) as unknown as { FEED_REGISTRATION_LOCK_CLASS: number }
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    try {
      await holder.query("begin")
      await holder.query("select pg_advisory_xact_lock($1, hashtext($2::text))", [FEED_REGISTRATION_LOCK_CLASS, bolaId])
      const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid
      const pending = register(bola, SFEED_B).then((r) => r)
      await untilLockWait(database.db, "stack posts registration", "advisory", holderPid)
      await holder.query("rollback")
      expect((await pending).status).toBe(201)
    } finally {
      await holder.query("rollback").catch(() => undefined)
      await holder.end()
    }
  })

  it("registration-gate:193 a row lock held on the legacy shared row does not delay the registration (accepted within 2 s)", async () => {
    await setLegacy(database.db, true)
    await setOwnStack(database.db, bolaId)
    serve(SFEED_A)
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    try {
      await holder.query("begin")
      await holder.query("select * from alert_feed_verification for update")
      const started = Date.now()
      const response = await register(bola, SFEED_A)
      expect(response.status).toBe(201)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await holder.query("rollback").catch(() => undefined)
      await holder.end()
    }
  })

  it("registration-gate:193 no registration statement names the legacy table (runtime grant revoked: still 201)", async () => {
    await setOwnStack(database.db, bolaId)
    serve(SFEED_A)
    await sql`revoke all on alert_feed_verification from ${sql.id(database.roles.runtime.name)}`.execute(database.db)
    try {
      await register(bola, SFEED_A).expect(201)
      await bola.get(ALERT_FEEDS_PATH).expect(200)
    } finally {
      await sql`grant select, insert, update, delete on alert_feed_verification to ${sql.id(database.roles.runtime.name)}`.execute(database.db)
    }
  })

  it("registration-gate:202 the cross-list race (20 rounds): HFEED_A ends in exactly one list; the other is in_other_list; 503 only with Retry-After 5", async () => {
    await setOwnStack(database.db, bolaId)
    await setHiringRecord(database.db, bolaId)
    serve(HFEED_A)
    for (let round = 0; round < 20; round += 1) {
      http.hold(HFEED_A)
      const both = Promise.all([register(bola, HFEED_A), bola.post(HIRING_FEEDS_PATH).send({ url: HFEED_A, label: null })])
      await until(() => http.waiting(HFEED_A) === 2)
      http.release(HFEED_A)
      const results = await both
      for (const r of results) {
        expect(r.status, `round ${round}: ${JSON.stringify(r.body)}`).not.toBe(500)
        if (r.status === 503) expect(r.headers["retry-after"]).toBe("5")
      }
      const stored = results.filter((r) => r.status === 201)
      expect(stored, `round ${round}`).toHaveLength(1)
      const refused = results.filter((r) => r.status === 400)
      if (refused.length === 1) expect(fieldErrors(refused[0]!.body)).toEqual(["url/in_other_list"])
      const lists = (await countRows(database.db, "alert_feed", bolaId)) + (await countRows(database.db, "hiring_alert_feed", bolaId))
      expect(lists, `round ${round}`).toBe(1)
      await sql`delete from hiring_alert_feed`.execute(database.db)
      await sql`delete from alert_feed`.execute(database.db)
    }
    expect(logs.join("\n")).not.toMatch(/deadlock/i)
  })

  it("registration-gate:211 two registrations for her 10th slot: exactly 10 feeds; the other is limit_reached", async () => {
    await setOwnStack(database.db, bolaId)
    for (let n = 1; n <= 9; n += 1) await insertStackFeed(database.db, bolaId, stackFeedUrl(n))
    serve(stackFeedUrl(20), stackFeedUrl(21))
    http.hold(stackFeedUrl(20))
    http.hold(stackFeedUrl(21))
    const both = Promise.all([register(bola, stackFeedUrl(20)), register(bola, stackFeedUrl(21))])
    await until(() => http.waiting(stackFeedUrl(20)) === 1 && http.waiting(stackFeedUrl(21)) === 1)
    http.release(stackFeedUrl(20))
    http.release(stackFeedUrl(21))
    const results = (await both).map((r) => [r.status, fieldErrors(r.body)])
    expect(results).toContainEqual([201, []])
    expect(results).toContainEqual([400, ["url/limit_reached"]])
    expect(await countRows(database.db, "alert_feed", bolaId)).toBe(10)
  })

  it("registration-gate:220 a double submit with her own record stores one feed; the other is duplicate", async () => {
    await setOwnStack(database.db, bolaId)
    serve(SFEED_A)
    http.hold(SFEED_A)
    const both = Promise.all([register(bola, SFEED_A), register(bola, SFEED_A)])
    await until(() => http.waiting(SFEED_A) === 2)
    http.release(SFEED_A)
    const results = (await both).map((r) => [r.status, fieldErrors(r.body)])
    expect(results).toContainEqual([201, []])
    expect(results).toContainEqual([400, ["url/duplicate"]])
    expect(await stackFeedUrls(database.db, bolaId)).toEqual([SFEED_A])
  })
})
