import type { INestApplication } from "@nestjs/common"
import { APPLICATIONS_PATH, applicationListItemSchema, applicationsResponseSchema, applicationOutcomesPath, outcomePath } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertApplication, insertOutcome, signInInvitee } from "./support/qa-epic-0011.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA test authoring, EPIC-0011 API-C4 (api-contract.md v1.28.0 "C4. Board fields on GET /v1/applications").
 * Gherkin: applications-board.r1.feature BRD:202 ("Only the Application list carries the board fields"),
 * BRD:53 placement table inputs (AC-6.2), BRD:273 list-row-only. The placement itself is derived
 * on the web (covered in the unit tests and the e2e board journeys); here the API supplies
 * the five fields correctly. Expected red until C4 lands.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let operator: SignedInCandidate
let bisi: SignedInCandidate
let bisiId: string
const clock = new TestClock("2026-11-07T09:00:00.000Z")
const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 10, day, hour))

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  operator = await signInCandidate(new Browser(app, google))
  const invitee = await signInInvitee(app, google, database.db)
  bisi = invitee.session
  bisiId = invitee.id
})

beforeEach(async () => {
  for (const table of ["outcome", "submission_event", "notification_outbox", "application"] as const) await database.db.deleteFrom(table).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const list = async (who: SignedInCandidate) => {
  const response = await who.get(APPLICATIONS_PATH)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  const parsed = applicationsResponseSchema.parse(response.body)
  return Object.fromEntries(parsed.applications.map((row) => [row.id, row]))
}

describe("C4: the five board keys on the list row", () => {
  it("BRD:202 every row carries submissionState, submissionKind, sampleState, latestOutcome and requestForAction, and the body is strict", async () => {
    const id = await insertApplication(database.db, bisiId)
    const response = await bisi.get(APPLICATIONS_PATH)
    expect(Object.keys(response.body)).toEqual(["applications"])
    expect(response.body.applications).toHaveLength(1)
    const row = response.body.applications[0]
    expect(row.id).toBe(id)
    for (const key of ["submissionState", "submissionKind", "sampleState", "latestOutcome", "requestForAction"]) expect(row).toHaveProperty(key)
    expect(row).toMatchObject({ submissionState: null, submissionKind: null, sampleState: null, latestOutcome: null, requestForAction: false })
    expect(() => applicationListItemSchema.parse(row)).not.toThrow()
  })

  it("AC-6.2 the stored submission fields pass through as stored; a manual Application is submissionState manual with kind null", async () => {
    const queued = await insertApplication(database.db, bisiId, { submission_state: "queued", submission_kind: "automatic" }, "Q Co")
    const manual = await insertApplication(database.db, bisiId, { submission_state: "manual", manual_completed_at: at(5) }, "M Co")
    const sample = await insertApplication(database.db, bisiId, { sample_state: "awaiting_review" }, "S Co")
    const rejectedSample = await insertApplication(database.db, bisiId, { sample_state: "rejected" }, "R Co")
    const blocked = await insertApplication(database.db, bisiId, { submission_state: "blocked", submission_kind: "automatic", blocked_reason: "captcha" }, "B Co")
    const rows = await list(bisi)
    expect(rows[queued]).toMatchObject({ submissionState: "queued", submissionKind: "automatic", sampleState: null })
    expect(rows[manual]).toMatchObject({ submissionState: "manual", submissionKind: null })
    expect(rows[sample]).toMatchObject({ submissionState: null, sampleState: "awaiting_review" })
    expect(rows[rejectedSample]).toMatchObject({ submissionState: null, sampleState: "rejected" })
    expect(rows[blocked]).toMatchObject({ submissionState: "blocked" })
  })

  it("latestOutcome is the newest non-request_for_action Outcome by (created_at desc, id desc), with its id, type and createdAt", async () => {
    const id = await insertApplication(database.db, bisiId)
    await insertOutcome(database.db, bisiId, id, "confirmation", at(1))
    const interview = await insertOutcome(database.db, bisiId, id, "interview_invitation", at(2))
    const rows = await list(bisi)
    expect(rows[id]!.latestOutcome).toEqual({ id: interview, type: "interview_invitation", createdAt: at(2).toISOString() })
    expect(rows[id]!.requestForAction).toBe(false)
  })

  it.each([
    [["confirmation", "interview_invitation", "offer"], "offer"],
    [["offer", "rejection"], "rejection"],
    [["interview_invitation", "offer", "interview_invitation"], "interview_invitation"],
  ] as const)("BRD:53 Outcome history %j gives latestOutcome %s", async (history, expected) => {
    const id = await insertApplication(database.db, bisiId)
    for (const [index, type] of history.entries()) await insertOutcome(database.db, bisiId, id, type, at(1 + index))
    expect((await list(bisi))[id]!.latestOutcome?.type).toBe(expected)
  })

  it("an edited Outcome keeps its createdAt, so it stays the newest (a backward move edits the placing Outcome)", async () => {
    const id = await insertApplication(database.db, bisiId)
    await insertOutcome(database.db, bisiId, id, "confirmation", at(1))
    const placing = await insertOutcome(database.db, bisiId, id, "offer", at(3))
    await bisi.patch(outcomePath(placing)).send({ type: "interview_invitation" }).expect(200)
    expect((await list(bisi))[id]!.latestOutcome).toEqual({ id: placing, type: "interview_invitation", createdAt: at(3).toISOString() })
  })

  it("ties on created_at are broken by id descending", async () => {
    const id = await insertApplication(database.db, bisiId)
    const a = await insertOutcome(database.db, bisiId, id, "confirmation", at(2))
    const b = await insertOutcome(database.db, bisiId, id, "interview_invitation", at(2))
    const winner = a > b ? a : b
    expect((await list(bisi))[id]!.latestOutcome?.id).toBe(winner)
  })

  it("requestForAction is true exactly when the newest Outcome overall is request_for_action; latestOutcome skips it", async () => {
    const id = await insertApplication(database.db, bisiId)
    const interview = await insertOutcome(database.db, bisiId, id, "interview_invitation", at(1))
    await insertOutcome(database.db, bisiId, id, "request_for_action", at(2))
    let row = (await list(bisi))[id]!
    expect(row.requestForAction).toBe(true)
    expect(row.latestOutcome).toMatchObject({ id: interview, type: "interview_invitation" })
    await insertOutcome(database.db, bisiId, id, "confirmation", at(3))
    row = (await list(bisi))[id]!
    expect(row.requestForAction).toBe(false)
  })

  it("only a request_for_action Outcome: latestOutcome null, requestForAction true", async () => {
    const id = await insertApplication(database.db, bisiId)
    await insertOutcome(database.db, bisiId, id, "request_for_action", at(1))
    expect((await list(bisi))[id]).toMatchObject({ latestOutcome: null, requestForAction: true })
  })

  it("a minimal record (details deleted) has latestOutcome null and requestForAction false; submission fields keep their stored values", async () => {
    const id = await insertApplication(database.db, bisiId, { details_deleted_at: at(4), submission_state: "manual", manual_completed_at: at(3), final_status: "offer" })
    await insertOutcome(database.db, bisiId, id, "offer", at(2))
    expect((await list(bisi))[id]).toMatchObject({ latestOutcome: null, requestForAction: false, submissionState: "manual", detailsDeletedAt: expect.any(String) })
  })

  it("the list shows only the caller's own Applications and Outcomes", async () => {
    const mine = await insertApplication(database.db, bisiId, {}, "Mine")
    const theirs = await insertApplication(database.db, database.operatorId, {}, "Theirs")
    await insertOutcome(database.db, database.operatorId, theirs, "offer", at(1))
    const rows = await list(bisi)
    expect(Object.keys(rows)).toEqual([mine])
    expect(rows[mine]!.latestOutcome).toBeNull()
    expect(Object.keys(await list(operator))).toEqual([theirs])
  })

  it("an Outcome recorded through the route shows on the next list read as the board's placing Outcome (offer included)", async () => {
    const id = await insertApplication(database.db, bisiId, { submission_state: "manual", manual_completed_at: at(1) })
    const created = await bisi.post(applicationOutcomesPath(id)).send({ type: "offer" })
    expect(created.status).toBe(201)
    expect((await list(bisi))[id]!.latestOutcome).toMatchObject({ id: created.body.id, type: "offer" })
  })

  it("500-row cap and newest-first order are unchanged", async () => {
    const first = await insertApplication(database.db, bisiId, { created_at: at(1) }, "Old")
    const second = await insertApplication(database.db, bisiId, { created_at: at(2) }, "New")
    const response = await bisi.get(APPLICATIONS_PATH)
    expect(response.body.applications.map((row: { id: string }) => row.id)).toEqual([second, first])
  })
})

describe("C4 scope: only GET /v1/applications gains the keys (BRD:202, BRD:273)", () => {
  it("GET /v1/applications/{id} keeps the v1.27.0 shape without the board keys", async () => {
    const id = await insertApplication(database.db, bisiId)
    const response = await bisi.get(`${APPLICATIONS_PATH}/${id}`)
    expect(response.status).toBe(200)
    const application = response.body.application ?? response.body
    for (const key of ["submissionState", "submissionKind", "sampleState", "latestOutcome", "requestForAction"]) expect(application).not.toHaveProperty(key)
  })
})
