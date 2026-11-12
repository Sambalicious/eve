import { type INestApplication, Logger, type LoggerService } from "@nestjs/common"
import { CSRF_HEADER } from "@eve/contracts"
import supertest from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  ALERT_FEED_VERIFICATION_PATH,
  type ApiError,
  BAD_REQUEST_MESSAGE,
  HFEED_A,
  HFEED_B,
  HIRING_FEEDS_PATH,
  HIRING_POSTS_PATH,
  HIRING_VERIFICATION_PATH,
  type HiringFeedsBody,
  clearPhase3,
  countRows,
  hiringVerifications,
  insertHiringFeed,
  sharedVerificationRows,
  ownStackVerificationRows,
  signInBoth,
} from "./support/qa-hiring-feeds.js"
import type { SignedInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-authored (EPIC-0007 Phase 3, run epic-0007-p3, test authoring).
 * `PUT /v1/stack-posts/hiring-feeds/verification` and the verification part of
 * `GET /v1/stack-posts/hiring-feeds` (api-contract.r1; hiring-alert-feeds.feature
 * r4 HAF:352, :442 to :619; D14, D16). Real api, real Postgres (runtime role),
 * two Candidates signed in over HTTP: Ada (the Operator) and Bola (invited).
 * Nothing leaves 127.0.0.1 (OutboundRecorder); no AI, no email.
 */
let database: TestDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let bolaId: string
const clock = new TestClock("2026-10-24T09:00:00.000Z") // 10:00 WAT
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
  app = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: createAlertFeedHttp({ testOrigin: feeds.origin, timeoutMs: 300 }) })
  Logger.overrideLogger(capture)
  ;({ ada, bola, bolaId } = await signInBoth(app, google, database.db))
})

beforeEach(async () => {
  clock.set("2026-10-24T09:00:00.000Z")
  feeds.reset()
  outbound.reset()
  logs.length = 0
  await clearPhase3(database.db)
  Logger.overrideLogger(capture)
})

afterEach(() => {
  expect(outbound.urls).toEqual([])
  expect(feeds.requests).toEqual([])
})

afterAll(async () => {
  await app?.close()
  await feeds?.close()
  google?.close()
  await database?.stop()
  Logger.overrideLogger(false)
})

const save = (who: SignedInCandidate, body: unknown) => who.put(HIRING_VERIFICATION_PATH).send(body as object)
const valid = { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }
const fieldErrors = (body: unknown) => (body as ApiError).error.fieldErrors
const bolaRecord = async () => (await hiringVerifications(database.db)).find((row) => row.candidate_id === bolaId)

describe("GET hiring-feeds: verification shape (HAF:314, :341, :352)", () => {
  it("without her own record: exactly { verification: null, feeds: [], limit: 10, globalPaused: false }, no-store, for both Candidates", async () => {
    for (const who of [ada, bola]) {
      const response = await who.get(HIRING_FEEDS_PATH).expect(200)
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(response.body).toEqual({ verification: null, feeds: [], limit: 10, globalPaused: false })
    }
  })

  it("HAF:352 the response holds exactly verification, feeds and limit: no canRecordVerification or other role field", async () => {
    await save(ada, valid).expect(200)
    const body = (await ada.get(HIRING_FEEDS_PATH).expect(200)).body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(["feeds", "globalPaused", "limit", "verification"]) // r2 OWN-1
    expect(Object.keys(body["verification"] as object).sort()).toEqual(["updatedAt", "verificationBasis", "verifiedOn"])
  })

  it("HAF:341 with her own record: verifiedOn and verificationBasis are her own", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read Google's terms for Alerts RSS on 21 Oct." }).expect(200)
    const body = (await bola.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody
    expect(body.verification).toMatchObject({ verifiedOn: "2026-10-21", verificationBasis: "Read Google's terms for Alerts RSS on 21 Oct." })
    expect(new Date(body.verification!.updatedAt).toISOString()).toBe(body.verification!.updatedAt)
  })
})

describe("PUT hiring-feeds/verification: record and update (HAF:374 to :406)", () => {
  it("first save answers 200 with the Hiring feeds response; one row, trimmed basis", async () => {
    const response = await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "  Read terms.  " }).expect(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.body).toMatchObject({ verification: { verifiedOn: "2026-10-21", verificationBasis: "Read terms." }, feeds: [], limit: 10, globalPaused: false })
    expect((await hiringVerifications(database.db)).map((r) => [r.candidate_id, r.verified_on, r.verification_basis])).toEqual([[bolaId, "2026-10-21", "Read terms."]])
  })

  it("HAF:395 an update replaces her record (exactly one row)", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Read Google's terms for Alerts RSS on 21 Oct." }).expect(200)
    await save(bola, { verifiedOn: "2026-10-24", verificationBasis: "Re-read the Alerts terms on 24 Oct." }).expect(200)
    const rows = (await hiringVerifications(database.db)).filter((r) => r.candidate_id === bolaId)
    expect(rows.map((r) => [r.verified_on, r.verification_basis])).toEqual([["2026-10-24", "Re-read the Alerts terms on 24 Oct."]])
  })

  it("HAF:406 updating keeps her Hiring Alert feeds and answers them masked", async () => {
    await save(ada, valid).expect(200)
    await insertHiringFeed(database.db, database.operatorId, HFEED_A, { label: "A" })
    await insertHiringFeed(database.db, database.operatorId, HFEED_B, { label: "B" })
    const response = await save(ada, { verifiedOn: "2026-10-23", verificationBasis: "Updated." }).expect(200)
    const body = response.body as HiringFeedsBody
    expect(body.verification).toMatchObject({ verifiedOn: "2026-10-23", verificationBasis: "Updated." })
    expect(body.feeds.map((f) => [f.label, f.maskedUrl])).toEqual([["A", "…123456"], ["B", "…777888"]])
    expect(JSON.stringify(body)).not.toContain("alerts/feeds")
    expect(await countRows(database.db, "hiring_alert_feed", database.operatorId)).toBe(2)
  })

  it("HAF:565 saving the same body twice leaves one record with a newer update time", async () => {
    const first = (await save(bola, valid).expect(200)).body as HiringFeedsBody
    clock.set("2026-10-24T09:05:00.000Z")
    await new Promise((r) => setTimeout(r, 5))
    const second = (await save(bola, valid).expect(200)).body as HiringFeedsBody
    expect((await hiringVerifications(database.db)).filter((r) => r.candidate_id === bolaId)).toHaveLength(1)
    expect(second.verification).toMatchObject({ verifiedOn: "2026-10-21", verificationBasis: "Read terms." })
    expect(Date.parse(second.verification!.updatedAt)).toBeGreaterThan(Date.parse(first.verification!.updatedAt))
  })

  it("HAF:572 two concurrent saves: both 200, one row holding one of the two bodies, never a mix, no conflict code", async () => {
    for (let round = 0; round < 10; round += 1) {
      const [a, b] = await Promise.all([save(bola, { verifiedOn: "2026-10-20", verificationBasis: "From tab A" }), save(bola, { verifiedOn: "2026-10-21", verificationBasis: "From tab B" })])
      expect([a.status, b.status]).toEqual([200, 200])
      const rows = (await hiringVerifications(database.db)).filter((r) => r.candidate_id === bolaId)
      expect(rows).toHaveLength(1)
      expect([["2026-10-20", "From tab A"], ["2026-10-21", "From tab B"]]).toContainEqual([rows[0]!.verified_on, rows[0]!.verification_basis])
    }
    // Sequential: the last successful save wins.
    await save(bola, { verifiedOn: "2026-10-20", verificationBasis: "From tab A" }).expect(200)
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "From tab B" }).expect(200)
    expect((await bolaRecord())?.verification_basis).toBe("From tab B")
  })

  it("HAF:558 no role check: the Operator and an invited Candidate each get 200 with their own record", async () => {
    const a = (await save(ada, { verifiedOn: "2026-10-01", verificationBasis: "Ada's basis" }).expect(200)).body as HiringFeedsBody
    const b = (await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)).body as HiringFeedsBody
    expect(a.verification?.verificationBasis).toBe("Ada's basis")
    expect(b.verification?.verificationBasis).toBe("Bola's basis")
  })
})

describe("PUT hiring-feeds/verification: refusals (HAF:442 to :545)", () => {
  const BEL = "\u0007"
  it.each<[string, Record<string, unknown>, { field: string; problem: string }[]]>([
    ["verifiedOn missing", { verificationBasis: "Read terms." }, [{ field: "verifiedOn", problem: "missing" }]],
    ["verifiedOn null", { verifiedOn: null, verificationBasis: "Read terms." }, [{ field: "verifiedOn", problem: "missing" }]],
    ["verifiedOn empty", { verifiedOn: "", verificationBasis: "Read terms." }, [{ field: "verifiedOn", problem: "missing" }]],
    ["verifiedOn 2026-02-30", { verifiedOn: "2026-02-30", verificationBasis: "Read terms." }, [{ field: "verifiedOn", problem: "invalid" }]],
    ["verifiedOn 21/10/2026", { verifiedOn: "21/10/2026", verificationBasis: "Read terms." }, [{ field: "verifiedOn", problem: "invalid" }]],
    ["verifiedOn a number", { verifiedOn: 20261021, verificationBasis: "Read terms." }, [{ field: "verifiedOn", problem: "invalid" }]],
    ["verifiedOn tomorrow in WAT", { verifiedOn: "2026-10-25", verificationBasis: "Read terms." }, [{ field: "verifiedOn", problem: "future_date" }]],
    ["basis missing", { verifiedOn: "2026-10-21" }, [{ field: "verificationBasis", problem: "missing" }]],
    ["basis null", { verifiedOn: "2026-10-21", verificationBasis: null }, [{ field: "verificationBasis", problem: "missing" }]],
    ["basis blank after trim", { verifiedOn: "2026-10-21", verificationBasis: "  \t " }, [{ field: "verificationBasis", problem: "missing" }]],
    ["basis a number", { verifiedOn: "2026-10-21", verificationBasis: 42 }, [{ field: "verificationBasis", problem: "invalid" }]],
    ["basis BEL", { verifiedOn: "2026-10-21", verificationBasis: `Read${BEL}terms` }, [{ field: "verificationBasis", problem: "invalid_characters" }]],
    ["basis ZWSP", { verifiedOn: "2026-10-21", verificationBasis: "Read\u200Bterms" }, [{ field: "verificationBasis", problem: "invalid_characters" }]],
    ["basis bidi", { verifiedOn: "2026-10-21", verificationBasis: "Read\u202Eterms" }, [{ field: "verificationBasis", problem: "invalid_characters" }]],
    ["basis 501 a", { verifiedOn: "2026-10-21", verificationBasis: "a".repeat(501) }, [{ field: "verificationBasis", problem: "too_long" }]],
    ["basis 501 BEL: characters before length", { verifiedOn: "2026-10-21", verificationBasis: BEL.repeat(501) }, [{ field: "verificationBasis", problem: "invalid_characters" }]],
    [
      "HAF:467 every field error at once",
      { verifiedOn: "2026-10-25", verificationBasis: "" },
      [{ field: "verifiedOn", problem: "future_date" }, { field: "verificationBasis", problem: "missing" }],
    ],
  ])("%s: 400 bad_request with exactly those field errors, nothing saved", async (_name, body, expected) => {
    const response = await save(bola, body).expect(400)
    const error = (response.body as ApiError).error
    expect(error.code).toBe("bad_request")
    expect(error.message).toBe(BAD_REQUEST_MESSAGE)
    expect(fieldErrors(response.body)).toEqual(expected.map((e) => ({ ...e, position: null })))
    expect(await bolaRecord()).toBeUndefined()
  })

  it("a refusal leaves an earlier record unchanged (and HAF:580 an empty date and basis cannot clear it)", async () => {
    await save(bola, valid).expect(200)
    const before = await bolaRecord()
    await save(bola, { verifiedOn: "", verificationBasis: "" }).expect(400)
    expect(await bolaRecord()).toEqual(before)
  })

  it.each<[string, unknown]>([
    ["a JSON array", ["2026-10-21", "Read terms."]],
    ["a JSON string", "2026-10-21"],
    ["an unknown key candidateId", { ...valid, candidateId: "00000000-0000-4000-8000-000000000001" }],
  ])("HAF:477 %s is a plain 400 bad_request with no field errors", async (_name, body) => {
    const response = await bola.put(HIRING_VERIFICATION_PATH).set("content-type", "application/json").send(JSON.stringify(body)).expect(400)
    expect((response.body as ApiError).error).toEqual({ code: "bad_request", message: BAD_REQUEST_MESSAGE })
    expect(await bolaRecord()).toBeUndefined()
  })

  it("the unknown key naming Ada's id writes no row for Ada either", async () => {
    await save(bola, { ...valid, candidateId: database.operatorId }).expect(400)
    expect(await hiringVerifications(database.db)).toEqual([])
  })

  it.each<[string, string, string]>([
    ["2026-10-24T22:59:00.000Z", "2026-10-24", "accepted"],
    ["2026-10-24T22:59:00.000Z", "2026-10-25", "future_date"],
    ["2026-10-24T23:01:00.000Z", "2026-10-25", "accepted"],
    ["2026-10-24T23:01:00.000Z", "2026-10-26", "future_date"],
    ["2026-10-24T23:01:00.000Z", "1999-01-01", "accepted"],
  ])("HAF:490 at %s the date %s is %s (WAT day boundary)", async (now, verifiedOn, result) => {
    clock.set(now)
    const response = await save(bola, { verifiedOn, verificationBasis: "Read terms." })
    if (result === "accepted") expect(response.status).toBe(200)
    else expect(fieldErrors(response.body)).toEqual([{ field: "verifiedOn", position: null, problem: "future_date" }])
  })

  it.each<[string, string, string | null]>([
    ["1 a", "a", "a"],
    ["500 a", "a".repeat(500), "a".repeat(500)],
    ["500 a with 3 spaces either side", `   ${"a".repeat(500)}   `, "a".repeat(500)],
    ["500 é (500 code points)", "é".repeat(500), "é".repeat(500)],
    ["499 a + one astral code point", `${"a".repeat(499)}😀`, `${"a".repeat(499)}😀`],
    ["501 a", "a".repeat(501), null],
    ["line break and tab kept", "Line one\nLine two\tend", "Line one\nLine two\tend"],
  ])("HAF:505 basis %s", async (_name, verificationBasis, stored) => {
    const response = await save(bola, { verifiedOn: "2026-10-21", verificationBasis })
    if (stored === null) {
      expect(fieldErrors(response.body)).toEqual([{ field: "verificationBasis", position: null, problem: "too_long" }])
      expect(await bolaRecord()).toBeUndefined()
    } else {
      expect(response.status).toBe(200)
      expect((await bolaRecord())?.verification_basis).toBe(stored)
    }
  })
})

describe("PUT hiring-feeds/verification: session and CSRF (HAF:545; HV:141)", () => {
  it("no session and a valid-looking CSRF token: 401 unauthenticated, nothing saved", async () => {
    const refused = await supertest(app.getHttpServer()).put(HIRING_VERIFICATION_PATH).set(CSRF_HEADER, "a".repeat(43)).send(valid).expect(401)
    expect((refused.body as ApiError).error).toEqual({ code: "unauthenticated", message: "Sign in to continue." })
    expect(await hiringVerifications(database.db)).toEqual([])
  })

  it("her session with no CSRF token: 403 csrf_invalid, nothing saved", async () => {
    const refused = await supertest(app.getHttpServer()).put(HIRING_VERIFICATION_PATH).set("cookie", bola.cookie).send(valid).expect(403)
    expect((refused.body as ApiError).error).toEqual({ code: "csrf_invalid", message: "The request is missing a valid CSRF token." })
    expect(await hiringVerifications(database.db)).toEqual([])
  })

  it("her session with another session's CSRF token: 403 csrf_invalid, nothing saved", async () => {
    const refused = await supertest(app.getHttpServer()).put(HIRING_VERIFICATION_PATH).set("cookie", bola.cookie).set(CSRF_HEADER, ada.csrfToken).send(valid).expect(403)
    expect((refused.body as ApiError).error.code).toBe("csrf_invalid")
    expect(await hiringVerifications(database.db)).toEqual([])
  })

  it("an invalid body without a session is still 401 (session before validation)", async () => {
    await supertest(app.getHttpServer()).put(HIRING_VERIFICATION_PATH).set(CSRF_HEADER, "a".repeat(43)).send({}).expect(401)
  })
})

describe("no delete, pauses, no outbound, no AI, no spend (HAF:580, :588, :601)", () => {
  it.each(["delete", "post", "patch"] as const)("HAF:580 %s on the verification path is not served and leaves the record", async (method) => {
    await save(bola, valid).expect(200)
    const before = await bolaRecord()
    const response = await bola[method](HIRING_VERIFICATION_PATH).send({})
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(await bolaRecord()).toEqual(before)
  })

  it.each([
    ["global pause", { global_paused: true, cost_paused: false }],
    ["cost-ceiling pause", { global_paused: false, cost_paused: true }],
  ] as const)("HAF:588 the save works during the %s", async (_name, pauses) => {
    await database.db.updateTable("control_state").set(pauses).execute()
    await save(bola, valid).expect(200)
    expect(await bolaRecord()).toMatchObject({ verified_on: "2026-10-21" })
  })

  it("HAF:601 record then update: no outbound request (afterEach), no ai_call, no spend_entry", async () => {
    await save(bola, valid).expect(200)
    await save(bola, { verifiedOn: "2026-10-22", verificationBasis: "Again." }).expect(200)
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })
})

describe("the basis stays private (HAF:610, :619)", () => {
  it("HAF:610 no log line contains either basis; a save is logged with her Candidate id", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Basis-marker-7c1f" }).expect(200)
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Basis-marker-9e2a" }).expect(200)
    await bola.get(HIRING_FEEDS_PATH).expect(200)
    const all = logs.join("\n")
    expect(all).not.toContain("Basis-marker-7c1f")
    expect(all).not.toContain("Basis-marker-9e2a")
    expect(logs.some((entry) => entry.includes(bolaId) && /hiring feed verification saved/i.test(entry))).toBe(true)
  })

  it("HAF:619 each Candidate's feeds response holds only her own basis; neither posts response holds either", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)
    await save(ada, { verifiedOn: "2026-10-01", verificationBasis: "Ada's basis" }).expect(200)
    const bolaFeeds = JSON.stringify((await bola.get(HIRING_FEEDS_PATH).expect(200)).body)
    const adaFeeds = JSON.stringify((await ada.get(HIRING_FEEDS_PATH).expect(200)).body)
    expect(bolaFeeds).toContain("Bola's basis")
    expect(bolaFeeds).not.toContain("Ada's basis")
    expect(adaFeeds).toContain("Ada's basis")
    expect(adaFeeds).not.toContain("Bola's basis")
    for (const who of [ada, bola]) {
      const posts = JSON.stringify((await who.get(HIRING_POSTS_PATH).expect(200)).body)
      expect(posts).not.toContain("Bola's basis")
      expect(posts).not.toContain("Ada's basis")
    }
  })
})

describe("one record per Candidate, independent of the shared EPIC-0005 record (HAF:656, :692, :701, :710; D15)", () => {
  it("HAF:656 Bola's save leaves Ada's record exactly as it was, update time included", async () => {
    await save(ada, { verifiedOn: "2026-10-01", verificationBasis: "Ada's basis" }).expect(200)
    const adaBefore = (await hiringVerifications(database.db)).find((r) => r.candidate_id === database.operatorId)
    clock.set("2026-10-24T10:00:00.000Z")
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)
    expect((await hiringVerifications(database.db)).find((r) => r.candidate_id === database.operatorId)).toEqual(adaBefore)
    expect(((await ada.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody).verification?.verifiedOn).toBe("2026-10-01")
    expect(((await bola.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody).verification?.verifiedOn).toBe("2026-10-21")
  })

  it("HAF:692 the Operator recording her own Hiring check never writes the shared EPIC-0005 record or her own Stack posts record", async () => {
    await save(ada, valid).expect(200)
    expect(await sharedVerificationRows(database.db)).toEqual([])
    expect(await ownStackVerificationRows(database.db)).toEqual([])
    expect(((await ada.get("/v1/stack-posts/alert-feeds").expect(200)).body as { verification: unknown }).verification).toBeNull()
  })

  // EPIC-0008 supersedes HAF:701 and HAF:710 (gherkin/README.md): the Stack posts save is per Candidate, with no role check.
  it("HAF:701 (superseded by EPIC-0008 SOR:162) Bola's Stack posts save is 200, writes only her own Stack posts row, her Hiring record kept", async () => {
    await save(bola, { verifiedOn: "2026-10-21", verificationBasis: "Bola's basis" }).expect(200)
    const response = await bola.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-20", verificationBasis: "Bola's Stack posts basis" }).expect(200)
    expect((response.body as { verification: { verifiedOn: string } | null }).verification?.verifiedOn).toBe("2026-10-20")
    expect(await sharedVerificationRows(database.db)).toEqual([])
    expect((await ownStackVerificationRows(database.db)).map((row) => [row.candidate_id, row.verified_on, row.verification_basis])).toEqual([[bolaId, "2026-10-20", "Bola's Stack posts basis"]])
    expect(await bolaRecord()).toMatchObject({ verified_on: "2026-10-21", verification_basis: "Bola's basis" })
  })

  it("HAF:710 (superseded by EPIC-0008 SOR:401) the Operator's Stack posts save writes her own Stack posts row and creates no Hiring record for anyone", async () => {
    await ada.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-20", verificationBasis: "Ada Stack." }).expect(200)
    expect(await sharedVerificationRows(database.db)).toEqual([])
    expect((await ownStackVerificationRows(database.db)).map((row) => [row.candidate_id, row.verification_basis])).toEqual([[database.operatorId, "Ada Stack."]])
    expect(await hiringVerifications(database.db)).toEqual([])
    for (const who of [ada, bola]) expect(((await who.get(HIRING_FEEDS_PATH).expect(200)).body as HiringFeedsBody).verification).toBeNull()
  })
})
