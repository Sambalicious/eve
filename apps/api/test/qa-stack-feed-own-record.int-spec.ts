import { CSRF_HEADER } from "@eve/contracts"
import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import { sql } from "kysely"
import pg from "pg"
import supertest from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { signInBoth } from "./support/qa-hiring-feeds.js"
import {
  ALERT_FEED_VERIFICATION_PATH,
  ALERT_FEEDS_PATH,
  type AlertFeedsBody,
  type ApiError,
  BAD_REQUEST_MESSAGE,
  CSRF_INVALID,
  HIRING_FEEDS_PATH,
  HIRING_VERIFICATION_PATH,
  NOT_FOUND,
  OWN_TABLE,
  SESSION_EXPIRED,
  SFEED_A,
  SFEED_A_DIGITS,
  STACK_POSTS_PATH,
  UNAUTHENTICATED,
  asRuntime,
  clearEpic8,
  countRows,
  hiringRows,
  insertStackFeed,
  insertStackPosts,
  legacyRows,
  ownStackRow,
  ownStackRows,
  revokeRuntime,
  setHiringRecord,
  setLegacy,
  setOwnStack,
} from "./support/qa-stack-feed.js"
import type { SignedInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0008, run epic-0008, test authoring).
 * stack-feed-own-record.feature r1 and stack-feed-isolation.feature r1, API side:
 * `PUT /v1/stack-posts/alert-feeds/verification` for any role, `GET …/alert-feeds`
 * returning the caller's own record, the absent delete route, session and CSRF,
 * pauses, logs, separation from the Hiring record, concurrency, and forced RLS on
 * `alert_feed_candidate_verification` with and without a Candidate id.
 * Real api, real Postgres (runtime role); nothing leaves 127.0.0.1.
 *
 * Ada is the Operator (TEMPLATE_OPERATOR_SUB, `database.operatorId`), Bola an
 * invited Candidate. "Chidi" is a third invitee signed in for the no-role-check rows.
 */
let database: TestDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let chidi: SignedInCandidate
let adaId: string
let bolaId: string
let chidiId: string
let runtime: pg.Client
const clock = new TestClock("2026-10-24T09:00:00.000Z") // 10:00 WAT, today = 2026-10-24
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }
const undo: (() => Promise<void>)[] = []

const VALID = { verifiedOn: "2026-10-21", verificationBasis: "Read Google's Alerts RSS terms on 21 Oct." } as const

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  Logger.overrideLogger(capture)
  ;({ ada, bola, bolaId } = await signInBoth(app, google, database.db, "bola@example.com"))
  adaId = database.operatorId
  ;({ bola: chidi, bolaId: chidiId } = await signInBoth(app, google, database.db, "chidi@example.com"))
  runtime = new pg.Client({ connectionString: database.url })
  await runtime.connect()
})

beforeEach(async () => {
  clock.set("2026-10-24T09:00:00.000Z")
  outbound.reset()
  logs.length = 0
  await clearEpic8(database.db)
  Logger.overrideLogger(capture)
})

afterEach(async () => {
  while (undo.length > 0) await undo.pop()!()
  // own-record:364, copy-and-unchanged:119: the save and the list make no outbound request.
  expect(outbound.urls).toEqual([])
})

afterAll(async () => {
  await runtime?.end()
  await app?.close()
  google?.close()
  await database?.stop()
  Logger.overrideLogger(false)
})

const save = (who: SignedInCandidate, body: unknown) => who.put(ALERT_FEED_VERIFICATION_PATH).send(body as object)
const list = async (who: SignedInCandidate) => (await who.get(ALERT_FEEDS_PATH).expect(200)).body as AlertFeedsBody
const problems = (body: unknown) => (body as ApiError).error.fieldErrors?.map((e) => `${e.field}/${e.problem}`)

describe("any Candidate records her own record (own-record:35, :65, :123, :146, :162, :169)", () => {
  it.each([
    ["ada (Operator)", () => ada, () => adaId],
    ["bola (invited)", () => bola, () => bolaId],
  ] as const)("%s: 200 with her own record, stored trimmed, updatedAt = server time; GET returns the same", async (_name, who, id) => {
    const response = await save(who(), { verifiedOn: "2026-10-21", verificationBasis: "  Read Google's Alerts RSS terms on 21 Oct.  " }).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.body).toEqual({ verification: { verifiedOn: "2026-10-21", verificationBasis: VALID.verificationBasis, updatedAt: "2026-10-24T09:00:00.000Z" }, feeds: [], limit: 10, globalPaused: false })
    expect(await ownStackRow(database.db, id())).toMatchObject({ verified_on: "2026-10-21", verification_basis: VALID.verificationBasis, updated_at: new Date("2026-10-24T09:00:00.000Z") })
    expect(await list(who())).toEqual(response.body)
    expect(await ownStackRows(database.db)).toHaveLength(1)
  })

  it("own-record:162 Operator and two invitees each save: all 200 with the saver's own record; never 404 or 403", async () => {
    const savers = [
      [ada, adaId, "Ada's basis"],
      [bola, bolaId, "Bola's basis"],
      [chidi, chidiId, "Chidi's basis"],
    ] as const
    for (const [who, id, basis] of savers) {
      const response = await save(who, { verifiedOn: "2026-10-21", verificationBasis: basis })
      expect(response.status, id).toBe(200)
      expect((response.body as AlertFeedsBody).verification?.verificationBasis).toBe(basis)
    }
    expect((await ownStackRows(database.db)).map((r) => [r.candidate_id, r.verification_basis]).sort()).toEqual(savers.map(([, id, basis]) => [id, basis]).sort())
  })

  it("own-record:146 the list holds exactly verification, feeds and limit, and no role field, for every role", async () => {
    for (const who of [ada, bola]) {
      const body = await list(who)
      expect(Object.keys(body).sort()).toEqual(["feeds", "globalPaused", "limit", "verification"]) // r2 OWN-1
      expect(body).toEqual({ verification: null, feeds: [], limit: 10, globalPaused: false })
      for (const key of ["canRecordVerification", "role", "isOperator"]) expect(JSON.stringify(body)).not.toContain(key)
    }
  })

  it.each([
    ["ada has her own record", async () => setOwnStack(database.db, adaId)],
    ["bola has her own Hiring record", async () => setHiringRecord(database.db, bolaId)],
    ["the legacy shared record exists", async () => setLegacy(database.db, true)],
    [
      "all three hold",
      async () => {
        await setOwnStack(database.db, adaId)
        await setHiringRecord(database.db, bolaId)
        await setLegacy(database.db, true)
      },
    ],
  ] as const)("own-record:129 bola has no record of her own (%s): her list returns verification null", async (_name, given) => {
    await given()
    expect((await list(bola)).verification).toBeNull()
  })

  it("own-record:104 updating her record keeps her feeds and posts; the response carries only masked feeds", async () => {
    await setOwnStack(database.db, bolaId, "2026-10-15", "Read terms.")
    const feedId = await insertStackFeed(database.db, bolaId, SFEED_A, { label: "React posts" })
    await insertStackPosts(database.db, bolaId, 4, { sourceFeedId: feedId })
    const response = await save(bola, { verifiedOn: "2026-10-22", verificationBasis: "Read terms again." }).expect(200)
    const body = response.body as AlertFeedsBody
    expect(body.feeds.map((f) => [f.id, f.label, f.maskedUrl])).toEqual([[feedId, "React posts", "…654321"]])
    expect(JSON.stringify(body)).not.toContain(SFEED_A_DIGITS)
    expect(await countRows(database.db, "alert_feed", bolaId)).toBe(1)
    expect(await countRows(database.db, "stack_post", bolaId)).toBe(4)
  })

  it("own-record:90, :446 an update replaces her one row (last save wins); the same body twice leaves one row with a newer updatedAt", async () => {
    await save(bola, { verifiedOn: "2026-10-15", verificationBasis: "Read terms." }).expect(200)
    clock.set("2026-10-24T10:00:00.000Z")
    await save(bola, { verifiedOn: "2026-10-22", verificationBasis: "Read Google's Alerts RSS terms again." }).expect(200)
    expect(await ownStackRows(database.db)).toEqual([{ candidate_id: bolaId, verified_on: "2026-10-22", verification_basis: "Read Google's Alerts RSS terms again.", updated_at: new Date("2026-10-24T10:00:00.000Z") }])
    clock.set("2026-10-24T10:05:00.000Z")
    await save(bola, { verifiedOn: "2026-10-22", verificationBasis: "Read Google's Alerts RSS terms again." }).expect(200)
    expect(await ownStackRows(database.db)).toEqual([{ candidate_id: bolaId, verified_on: "2026-10-22", verification_basis: "Read Google's Alerts RSS terms again.", updated_at: new Date("2026-10-24T10:05:00.000Z") }])
  })

  it("own-record:153 Ada's update leaves Bola's list byte-equal, updatedAt included", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)
    await save(ada, { verifiedOn: "2026-10-01", verificationBasis: "Ada's basis" }).expect(200)
    const before = await list(bola)
    clock.set("2026-10-24T11:00:00.000Z")
    await save(ada, { verifiedOn: "2026-10-24", verificationBasis: "Ada's new basis" }).expect(200)
    expect(await list(bola)).toEqual(before)
    expect(before.verification).toEqual({ verifiedOn: "2026-10-21", verificationBasis: "Bola's basis", updatedAt: "2026-10-24T09:00:00.000Z" })
  })
})

describe("field errors for every role, never 404 (own-record:177, :229, :237, :254, :269)", () => {
  const long = (n: number) => "a".repeat(n)
  it.each([
    ["bola", { verificationBasis: "Read terms." }, ["verifiedOn/missing"]],
    ["bola", { verifiedOn: "2026-02-30", verificationBasis: "Read terms." }, ["verifiedOn/invalid"]],
    ["bola", { verifiedOn: "21/10/2026", verificationBasis: "Read terms." }, ["verifiedOn/invalid"]],
    ["bola", { verifiedOn: "2026-10-25", verificationBasis: "Read terms." }, ["verifiedOn/future_date"]],
    ["bola", { verifiedOn: "2026-10-21", verificationBasis: "  \t " }, ["verificationBasis/missing"]],
    ["bola", { verifiedOn: "2026-10-21", verificationBasis: "Read\u0007terms" }, ["verificationBasis/invalid_characters"]],
    ["bola", { verifiedOn: "2026-10-21", verificationBasis: "Read\u202Eterms" }, ["verificationBasis/invalid_characters"]],
    ["bola", { verifiedOn: "2026-10-21", verificationBasis: long(501) }, ["verificationBasis/too_long"]],
    ["bola", { verifiedOn: "2026-10-25", verificationBasis: "   " }, ["verifiedOn/future_date", "verificationBasis/missing"]],
    ["ada", { verifiedOn: "2026-10-25", verificationBasis: "   " }, ["verifiedOn/future_date", "verificationBasis/missing"]],
    ["ada", {}, ["verifiedOn/missing", "verificationBasis/missing"]],
    ["ada", { verifiedOn: null, verificationBasis: null }, ["verifiedOn/missing", "verificationBasis/missing"]],
  ] as const)("%s %j → 400 with exactly %j; no record stored", async (who, body, expected) => {
    const response = await save(who === "ada" ? ada : bola, body).expect(400)
    expect((response.body as ApiError).error).toMatchObject({ code: "bad_request", message: BAD_REQUEST_MESSAGE })
    expect(problems(response.body)).toEqual(expected)
    expect(await ownStackRows(database.db)).toEqual([])
  })

  it("own-record:229 an invalid update keeps her earlier record unchanged", async () => {
    await save(bola, { verifiedOn: "2026-10-15", verificationBasis: "Read terms." }).expect(200)
    const before = await ownStackRow(database.db, bolaId)
    clock.set("2026-10-24T09:30:00.000Z")
    expect(problems((await save(bola, { verifiedOn: "2026-02-30", verificationBasis: "Read terms." }).expect(400)).body)).toEqual(["verifiedOn/invalid"])
    expect(await ownStackRow(database.db, bolaId)).toEqual(before)
  })

  it.each([
    ["a JSON array", ["2026-10-21", "Read terms."]],
    ["a JSON string", "2026-10-21"],
    ["an unknown key candidateId (ada's id)", "candidateId"],
    ["an unknown key singleton", "singleton"],
  ] as const)("own-record:237, isolation:62 %s → plain 400 with no fieldErrors; nothing written for anyone", async (_name, shape) => {
    await setOwnStack(database.db, adaId, "2026-10-01", "Ada's basis")
    const adaBefore = await ownStackRow(database.db, adaId)
    const body = shape === "candidateId" ? { ...VALID, candidateId: adaId } : shape === "singleton" ? { ...VALID, singleton: true } : shape
    const response = await bola.put(ALERT_FEED_VERIFICATION_PATH).set("content-type", "application/json").send(JSON.stringify(body)).expect(400)
    expect((response.body as ApiError).error).toEqual({ code: "bad_request", message: BAD_REQUEST_MESSAGE })
    expect(await ownStackRow(database.db, bolaId)).toBeUndefined()
    expect(await ownStackRow(database.db, adaId)).toEqual(adaBefore)
  })

  it.each([
    ["2026-10-24T22:59:00.000Z", "2026-10-24", 200],
    ["2026-10-24T22:59:00.000Z", "2026-10-25", 400],
    ["2026-10-24T23:00:00.000Z", "2026-10-25", 200],
    ["2026-10-24T23:01:00.000Z", "2026-10-26", 400],
    ["2026-10-24T23:01:00.000Z", "2024-02-29", 200],
  ] as const)("own-record:254 at %s the date %s answers %i (WAT calendar day)", async (now, date, status) => {
    clock.set(now)
    const response = await save(bola, { verifiedOn: date, verificationBasis: "Read terms." }).expect(status)
    if (status === 400) expect(problems(response.body)).toEqual(["verifiedOn/future_date"])
  })

  it.each([
    ["1 a", "a", "a"],
    ["500 a", "a".repeat(500), "a".repeat(500)],
    ["500 a padded with 3 spaces", `   ${"a".repeat(500)}   `, "a".repeat(500)],
    ["500 emoji (500 code points)", "😀".repeat(500), "😀".repeat(500)],
    ["line break and tab kept", "Line one\nLine two\tend", "Line one\nLine two\tend"],
  ] as const)("own-record:269 %s is accepted and stored as trimmed", async (_name, basis, stored) => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: basis }).expect(200)
    expect((await ownStackRow(database.db, bolaId))?.verification_basis).toBe(stored)
  })

  it.each([
    ["501 a", "a".repeat(501)],
    ["499 a then a flag (2 code points)", `${"a".repeat(499)}🇳🇬`],
  ] as const)("own-record:269 %s is too_long", async (_name, basis) => {
    expect(problems((await save(bola, { verifiedOn: "2026-10-21", verificationBasis: basis }).expect(400)).body)).toEqual(["verificationBasis/too_long"])
  })
})

describe("session, CSRF and revocation (own-record:305, :318, :326, :334)", () => {
  it("no session: 401 unauthenticated; nothing recorded", async () => {
    const response = await supertest(app.getHttpServer()).put(ALERT_FEED_VERIFICATION_PATH).send(VALID).expect(401)
    expect((response.body as ApiError).error).toEqual(UNAUTHENTICATED)
    expect(await ownStackRows(database.db)).toEqual([])
  })

  it("missing CSRF and another session's CSRF: 403 csrf_invalid; nothing recorded", async () => {
    const missing = await supertest(app.getHttpServer()).put(ALERT_FEED_VERIFICATION_PATH).set("cookie", bola.cookie).send(VALID).expect(403)
    expect((missing.body as ApiError).error).toEqual(CSRF_INVALID)
    const foreign = await supertest(app.getHttpServer()).put(ALERT_FEED_VERIFICATION_PATH).set("cookie", bola.cookie).set(CSRF_HEADER, ada.csrfToken).send(VALID).expect(403)
    expect((foreign.body as ApiError).error).toEqual(CSRF_INVALID)
    expect(await ownStackRows(database.db)).toEqual([])
  })

  it("own-record:334 the list without a session is 401 unauthenticated", async () => {
    expect((await supertest(app.getHttpServer()).get(ALERT_FEEDS_PATH).expect(401)).body).toEqual({ error: UNAUTHENTICATED })
  })

  it("own-record:318 an expired session (14 days idle): 401 session_expired; nothing recorded", async () => {
    const { bola: idle } = await signInBoth(app, google, database.db, "idle.qa8@example.test")
    outbound.reset() // the sign-in itself talks to the fake Google OAuth server
    clock.set("2026-11-07T09:00:00.000Z")
    const response = await save(idle, VALID).expect(401)
    expect((response.body as ApiError).error).toEqual(SESSION_EXPIRED)
    expect(await ownStackRows(database.db)).toEqual([])
  })

  it("own-record:326 (contract N-1) a revoked Candidate's sessions are gone: 401; nothing recorded", async () => {
    const { bola: revoked, bolaId: revokedId } = await signInBoth(app, google, database.db, "revoked.qa8@example.test")
    outbound.reset() // the sign-in itself talks to the fake Google OAuth server
    await database.db.updateTable("candidate").set({ state: "revoked" } as never).where("id", "=", revokedId).execute()
    await sql`delete from dashboard_session where candidate_id = ${revokedId}::uuid`.execute(database.db)
    expect((await save(revoked, VALID)).status).toBe(401)
    expect(await ownStackRow(database.db, revokedId)).toBeUndefined()
  })
})

describe("the record cannot be deleted (own-record:342; contract 'Record cannot be deleted')", () => {
  beforeEach(async () => {
    await setOwnStack(database.db, bolaId, "2026-10-21", "Read terms.")
  })

  it("DELETE …/verification matches the feed route and is a plain 400 (id not a UUID); record unchanged", async () => {
    const before = await ownStackRow(database.db, bolaId)
    const response = await bola.delete(ALERT_FEED_VERIFICATION_PATH).expect(400)
    expect((response.body as ApiError).error).toEqual({ code: "bad_request", message: BAD_REQUEST_MESSAGE })
    expect(await ownStackRow(database.db, bolaId)).toEqual(before)
  })

  it.each(["post", "patch"] as const)("%s …/verification is 404 not_found (no such route); record unchanged", async (method) => {
    const before = await ownStackRow(database.db, bolaId)
    const response = await bola[method](ALERT_FEED_VERIFICATION_PATH).send(VALID).expect(404)
    expect((response.body as ApiError).error).toEqual(NOT_FOUND)
    expect(await ownStackRow(database.db, bolaId)).toEqual(before)
  })

  it("PUT with no fields or null values is 400 missing for both; record unchanged", async () => {
    const before = await ownStackRow(database.db, bolaId)
    for (const body of [{}, { verifiedOn: null, verificationBasis: null }]) {
      expect(problems((await save(bola, body).expect(400)).body)).toEqual(["verifiedOn/missing", "verificationBasis/missing"])
    }
    expect(await ownStackRow(database.db, bolaId)).toEqual(before)
  })
})

describe("pauses, no outbound, no AI, logs (own-record:352, :364, :375, :384)", () => {
  it.each([
    ["global pause", { global_paused: true, cost_paused: false }],
    ["cost-ceiling pause", { global_paused: false, cost_paused: true }],
  ] as const)("the save works during the %s", async (_name, pauses) => {
    await database.db.updateTable("control_state").set(pauses).execute()
    await save(bola, VALID).expect(200)
    expect(await ownStackRow(database.db, bolaId)).toMatchObject({ verified_on: "2026-10-21" })
  })

  it("own-record:364 record then update: no outbound request (afterEach), no ai_call, no spend_entry", async () => {
    await save(bola, VALID).expect(200)
    await save(bola, { verifiedOn: "2026-10-22", verificationBasis: "Again." }).expect(200)
    expect(await countRows(database.db, "ai_call")).toBe(0)
    expect(await countRows(database.db, "spend_entry")).toBe(0)
  })

  it("own-record:375 the basis is never logged; the save logs one line naming her Candidate id (BE-1)", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Basis-marker-7c1f" }).expect(200)
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Basis-marker-9e2a" }).expect(200)
    await bola.get(ALERT_FEEDS_PATH).expect(200)
    const all = logs.join("\n")
    expect(all).not.toContain("Basis-marker-7c1f")
    expect(all).not.toContain("Basis-marker-9e2a")
    expect(logs.filter((entry) => entry.includes(`Stack posts feed verification saved for Candidate ${bolaId}`))).toHaveLength(2)
  })

  it("own-record:384 the basis is returned only to its author: never in the other's list, nor either posts list", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)
    await save(ada, { verifiedOn: "2026-10-01", verificationBasis: "Ada's basis" }).expect(200)
    await insertStackPosts(database.db, bolaId, 1)
    await insertStackPosts(database.db, adaId, 1)
    const bolaFeeds = JSON.stringify(await list(bola))
    const adaFeeds = JSON.stringify(await list(ada))
    expect(bolaFeeds).toContain("Bola's basis")
    expect(bolaFeeds).not.toContain("Ada's basis")
    expect(adaFeeds).toContain("Ada's basis")
    expect(adaFeeds).not.toContain("Bola's basis")
    for (const who of [ada, bola]) {
      const posts = JSON.stringify((await who.get(STACK_POSTS_PATH).expect(200)).body)
      expect(posts).not.toContain("Bola's basis")
      expect(posts).not.toContain("Ada's basis")
    }
  })
})

describe("separate from the Hiring record and the legacy row (own-record:401 to :424; isolation:85, :92; migration:226)", () => {
  it("own-record:401 saving her Stack posts record creates no Hiring record; her Hiring list stays null", async () => {
    await save(bola, VALID).expect(200)
    expect(await hiringRows(database.db)).toEqual([])
    expect(((await bola.get(HIRING_FEEDS_PATH).expect(200)).body as { verification: unknown }).verification).toBeNull()
  })

  it("own-record:409 updating her Stack posts record leaves her Hiring record byte-equal", async () => {
    await setHiringRecord(database.db, bolaId, "2026-10-01", "Hiring basis")
    const before = await hiringRows(database.db)
    await save(bola, VALID).expect(200)
    await save(bola, { verifiedOn: "2026-10-23", verificationBasis: "Updated." }).expect(200)
    expect(await hiringRows(database.db)).toEqual(before)
  })

  it("own-record:416, :424 saving or updating her Hiring record never creates or changes her Stack posts record", async () => {
    await bola.put(HIRING_VERIFICATION_PATH).send(VALID).expect(200)
    expect(await ownStackRows(database.db)).toEqual([])
    expect((await list(bola)).verification).toBeNull()
    await setOwnStack(database.db, bolaId, "2026-10-15", "Stack basis")
    const before = await ownStackRow(database.db, bolaId)
    await bola.put(HIRING_VERIFICATION_PATH).send({ verifiedOn: "2026-10-23", verificationBasis: "Hiring again." }).expect(200)
    expect(await ownStackRow(database.db, bolaId)).toEqual(before)
  })

  it("isolation:92 the Stack posts save names neither the Hiring table nor the legacy table (runtime grants revoked)", async () => {
    undo.push(await revokeRuntime(database.db, database.roles.runtime.name, "hiring_feed_verification"))
    undo.push(await revokeRuntime(database.db, database.roles.runtime.name, "alert_feed_verification"))
    await save(bola, VALID).expect(200)
    expect((await list(bola)).verification).toMatchObject({ verifiedOn: "2026-10-21" })
  })

  it("isolation:92 the Hiring save names no Stack posts verification table (runtime grant on the new table revoked)", async () => {
    undo.push(await revokeRuntime(database.db, database.roles.runtime.name, OWN_TABLE))
    await bola.put(HIRING_VERIFICATION_PATH).send(VALID).expect(200)
  })

  it("migration:226 a save never changes the legacy shared row", async () => {
    await setLegacy(database.db, true)
    const before = await legacyRows(database.db)
    await save(ada, VALID).expect(200)
    await save(bola, VALID).expect(200)
    expect(await legacyRows(database.db)).toEqual(before)
  })

  it("migration:233 deleting the legacy row changes no Candidate's list", async () => {
    await setLegacy(database.db, true)
    await setOwnStack(database.db, adaId, "2026-09-30", "Copied")
    const adaBefore = await list(ada)
    const bolaBefore = await list(bola)
    await setLegacy(database.db, false)
    expect(await list(ada)).toEqual(adaBefore)
    expect(await list(bola)).toEqual(bolaBefore)
  })
})

describe("concurrency (own-record:463, :471)", () => {
  it("own-record:463 two saves of her own record race: one row, the last committed wins, both 200, no conflict code", async () => {
    const [a, b] = await Promise.all([save(bola, { verifiedOn: "2026-10-20", verificationBasis: "First." }), save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Second." })])
    expect([a.status, b.status]).toEqual([200, 200])
    const rows = await ownStackRows(database.db)
    expect(rows).toHaveLength(1)
    expect(["First.", "Second."]).toContain(rows[0]!.verification_basis)
    expect((await list(bola)).verification?.verificationBasis).toBe(rows[0]!.verification_basis)
  })

  it("own-record:471 Ada and Bola save at the same moment: each gets only her own record; neither waits on a held legacy row", async () => {
    await setLegacy(database.db, true)
    const holder = new pg.Client({ connectionString: database.adminUrl })
    await holder.connect()
    try {
      await holder.query("begin")
      await holder.query("select * from alert_feed_verification for update")
      const started = Date.now()
      const [a, b] = await Promise.all([save(ada, { verifiedOn: "2026-10-01", verificationBasis: "Ada's basis" }), save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" })])
      expect(Date.now() - started).toBeLessThan(2_500)
      expect((a.body as AlertFeedsBody).verification?.verificationBasis).toBe("Ada's basis")
      expect((b.body as AlertFeedsBody).verification?.verificationBasis).toBe("Bola's basis")
    } finally {
      await holder.query("rollback")
      await holder.end()
    }
  })
})

describe("forced row-level security on the per-Candidate table (isolation:18 to :53, :101; migration:291)", () => {
  it("migration:291 RLS enabled and forced with exactly one policy, byte-equal to hiring_feed_verification's; runtime has DML", async () => {
    const { rows } = await sql<{ enabled: boolean; forced: boolean; policies: number }>`
      select c.relrowsecurity as enabled, c.relforcerowsecurity as forced, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = ${OWN_TABLE}`.execute(database.db)
    expect(rows).toEqual([{ enabled: true, forced: true, policies: 1 }])
    const policy = async (table: string) =>
      (await sql<{ qual: string; check: string; cmd: string }>`select pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as check, p.polcmd as cmd
        from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = ${table}`.execute(database.db)).rows[0]
    expect(await policy(OWN_TABLE)).toEqual(await policy("hiring_feed_verification"))
    const grants = await sql<{ privilege_type: string }>`select privilege_type from information_schema.role_table_grants where table_name = ${OWN_TABLE} and grantee = ${database.roles.runtime.name} order by 1`.execute(database.db)
    expect(grants.rows.map((r) => r.privilege_type)).toEqual(expect.arrayContaining(["DELETE", "INSERT", "SELECT", "UPDATE"]))
  })

  it("isolation:18, :25 scoped to Bola she reads only her row; with no Candidate id, or an empty one, the table reads empty", async () => {
    await setOwnStack(database.db, adaId, "2026-10-01", "Ada's basis")
    await setOwnStack(database.db, bolaId, "2026-10-21", "Bola's basis")
    await asRuntime(runtime, bolaId, async (client) => {
      expect((await client.query(`select verification_basis from ${OWN_TABLE}`)).rows).toEqual([{ verification_basis: "Bola's basis" }])
    })
    for (const scope of [null, ""]) {
      await asRuntime(runtime, scope, async (client) => {
        expect((await client.query(`select count(*)::int as n from ${OWN_TABLE}`)).rows[0]).toEqual({ n: 0 })
      })
    }
  })

  it.each(["insert", "update", "delete"] as const)("isolation:31 a %s in Bola's scope naming Ada's id is refused or touches nothing", async (op) => {
    await setOwnStack(database.db, adaId, "2026-10-01", "Ada's basis")
    const adaBefore = await ownStackRow(database.db, adaId)
    await asRuntime(runtime, bolaId, async (client) => {
      if (op === "insert") {
        await expect(client.query(`insert into ${OWN_TABLE} (candidate_id, verified_on, verification_basis, updated_at) values ($1, '2026-10-21', 'x', now())`, [adaId])).rejects.toThrow(/row-level security|violates|duplicate/)
      } else if (op === "update") {
        expect((await client.query(`update ${OWN_TABLE} set verification_basis = 'hijack' where candidate_id = $1`, [adaId])).rowCount).toBe(0)
      } else {
        expect((await client.query(`delete from ${OWN_TABLE} where candidate_id = $1`, [adaId])).rowCount).toBe(0)
      }
    })
    expect(await ownStackRow(database.db, adaId)).toEqual(adaBefore)
  })

  it("isolation:31 Bola cannot move her own row to Ada's id (with check)", async () => {
    await setOwnStack(database.db, bolaId)
    await asRuntime(runtime, bolaId, async (client) => {
      await expect(client.query(`update ${OWN_TABLE} set candidate_id = $1 where candidate_id = $2`, [adaId, bolaId])).rejects.toThrow(/row-level security|violates/)
    })
  })

  it("isolation:45 the runtime role is not the table owner and has no BYPASSRLS", async () => {
    const owner = await sql<{ owner: string }>`select tableowner as owner from pg_tables where schemaname = 'public' and tablename = ${OWN_TABLE}`.execute(database.db)
    expect(owner.rows[0]?.owner).not.toBe(database.roles.runtime.name)
    const role = await sql<{ bypass: boolean; superuser: boolean }>`select rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = ${database.roles.runtime.name}`.execute(database.db)
    expect(role.rows[0]).toEqual({ bypass: false, superuser: false })
  })

  it("isolation:53, :62 query parameters and headers naming Ada are ignored: Bola's save writes Bola's row only", async () => {
    await setOwnStack(database.db, adaId, "2026-10-01", "Ada's basis")
    const adaBefore = await ownStackRow(database.db, adaId)
    const response = await bola.put(`${ALERT_FEED_VERIFICATION_PATH}?candidateId=${adaId}`).set("X-Candidate-Id", adaId).send(VALID).expect(200)
    expect((response.body as AlertFeedsBody).verification?.verificationBasis).toBe(VALID.verificationBasis)
    expect(await ownStackRow(database.db, adaId)).toEqual(adaBefore)
    expect(await ownStackRow(database.db, bolaId)).toMatchObject({ verification_basis: VALID.verificationBasis })
  })

  it("isolation:76 the list never shows or counts another Candidate's record", async () => {
    await setOwnStack(database.db, adaId, "2026-10-01", "Ada's basis")
    const body = await list(bola)
    expect(body).toEqual({ verification: null, feeds: [], limit: 10, globalPaused: false })
    expect(JSON.stringify(body)).not.toContain(adaId)
  })

  it("migration:284, isolation:114 deleting a Candidate deletes her Stack posts record (cascade); others stay", async () => {
    const { bolaId: goneId } = await signInBoth(app, google, database.db, "gone.qa8@example.test")
    outbound.reset() // the sign-in itself talks to the fake Google OAuth server
    await setOwnStack(database.db, goneId)
    await setOwnStack(database.db, adaId)
    await sql`delete from candidate where id = ${goneId}::uuid`.execute(database.db)
    expect(await ownStackRow(database.db, goneId)).toBeUndefined()
    expect(await ownStackRow(database.db, adaId)).toBeDefined()
  })
})
