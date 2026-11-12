import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { SUBMISSION_STATUS_PATH, apiErrorResponseSchema, manualCompletePath, submissionSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { MESSAGES, applicationRow, insertApplication, signInInvitee } from "./support/qa-epic-0011.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA test authoring, EPIC-0011 API-C3 (api-contract.md v1.28.0 "C3. manual-complete (changed)").
 * Gherkin: applications-board.r1.feature BRD:76 to BRD:148 (AC-6.3). The safety-critical
 * guard split: the Draft path is open to every Candidate, the blocked path stays
 * Operator-only (risk 1 in the contract; Security reviews the split). Real api,
 * real runtime role under RLS. Expected red until C3 lands.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let operator: SignedInCandidate
let bisi: SignedInCandidate
let bisiId: string
const clock = new TestClock("2026-11-07T09:00:00.000Z")

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
  for (const table of ["submission_event", "notification_outbox", "outcome", "submission_day", "application"] as const) await database.db.deleteFrom(table).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const manualComplete = (who: SignedInCandidate, id: string) => who.post(manualCompletePath(id))
const conflict = (body: unknown) => apiErrorResponseSchema.parse(body).error

describe("C3 Draft path: any signed-in Candidate", () => {
  it("BRD:92 a non-Operator's prepared Draft becomes Manual: 200 state manual, kind null, manual_completed_at set, no cap day", async () => {
    const id = await insertApplication(database.db, bisiId, { state: "documents_ready" })
    const response = await manualComplete(bisi, id)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const submission = submissionSchema.parse(response.body)
    expect(submission).toMatchObject({ state: "manual", kind: null, submittedWatDay: null, sample: null })
    expect(submission.manualCompletedAt).not.toBeNull()
    expect(await applicationRow(database.db, id)).toMatchObject({ submission_state: "manual", submission_kind: null, submitted_local_day: null, manual_completed_at: expect.any(Date) })
  })

  it.each(["prepared", "generating", "documents_ready", "documents_blocked", "documents_failed"] as const)("BRD:92 an Application in state %s with no submission state is accepted (the user may have applied with their own documents)", async (state) => {
    const id = await insertApplication(database.db, bisiId, { state })
    expect((await manualComplete(bisi, id)).status).toBe(200)
    expect(await applicationRow(database.db, id)).toMatchObject({ submission_state: "manual" })
  })

  it("BRD:91 it never counts toward the daily cap: todayCount and submission_day are unchanged for the Operator too", async () => {
    const id = await insertApplication(database.db, database.operatorId)
    const before = (await operator.get(SUBMISSION_STATUS_PATH).expect(200)).body.todayCount
    await manualComplete(operator, id).expect(200)
    expect((await operator.get(SUBMISSION_STATUS_PATH).expect(200)).body.todayCount).toBe(before)
    expect(await database.db.selectFrom("submission_day").selectAll().execute()).toEqual([])
  })

  it.each([
    ["a minimal record (details deleted)", { details_deleted_at: new Date("2026-11-02T00:00:00Z") }],
    ["a sample awaiting review", { sample_state: "awaiting_review" }],
    ["a sample approved and waiting to be sent", { sample_state: "approved" }],
    ["a sample that was rejected", { sample_state: "rejected" }],
  ] as const)("BRD:100 a Draft that is %s is 409 application_state_conflict and nothing changes", async (_label, values) => {
    const id = await insertApplication(database.db, bisiId, values)
    const before = await applicationRow(database.db, id)
    const response = await manualComplete(bisi, id)
    expect(response.status).toBe(409)
    expect(conflict(response.body)).toEqual({ code: "application_state_conflict", message: MESSAGES.stateConflict })
    expect(await applicationRow(database.db, id)).toEqual(before)
  })

  it.each([
    ["queued", { submission_state: "queued", submission_kind: "automatic" }],
    ["submit_claimed", { submission_state: "submit_claimed", submission_kind: "automatic" }],
    ["submitting", { submission_state: "submitting", submission_kind: "automatic" }],
    ["confirmed", { submission_state: "confirmed", submission_kind: "automatic" }],
    ["uncertain", { submission_state: "uncertain", submission_kind: "automatic" }],
    ["declined", { submission_state: "declined", submission_kind: "automatic" }],
    ["not_submitted", { submission_state: "not_submitted", submission_kind: "automatic" }],
  ] as const)("BRD:114 an Application in submission state %s is 409 application_state_conflict (step 7), for the Operator and a non-Operator alike, and nothing changes", async (_label, values) => {
    for (const [who, id] of [
      [operator, await insertApplication(database.db, database.operatorId, values, "Op Co")],
      [bisi, await insertApplication(database.db, bisiId, values, "Bisi Co")],
    ] as const) {
      const before = await applicationRow(database.db, id)
      const response = await manualComplete(who, id)
      // A non-Operator in a submission state that is not draft/blocked/manual is a conflict, not a feature gate.
      expect(response.status, JSON.stringify(response.body)).toBe(409)
      expect(conflict(response.body).code).toBe("application_state_conflict")
      expect(await applicationRow(database.db, id)).toEqual(before)
    }
  })

  it("BRD:121 twice is idempotent: 200 with the same manualCompletedAt and no second record or event", async () => {
    const id = await insertApplication(database.db, bisiId)
    const first = submissionSchema.parse((await manualComplete(bisi, id).expect(200)).body)
    const events = (await database.db.selectFrom("submission_event").select("id").execute()).length
    clock.set("2026-11-07T10:00:00.000Z")
    const second = submissionSchema.parse((await manualComplete(bisi, id).expect(200)).body)
    clock.set("2026-11-07T09:00:00.000Z")
    expect(second.manualCompletedAt).toBe(first.manualCompletedAt)
    expect((await database.db.selectFrom("submission_event").select("id").execute()).length).toBe(events)
  })

  it("after a Draft completion the queue route refuses the Application on its existing state check", async () => {
    const id = await insertApplication(database.db, database.operatorId)
    await manualComplete(operator, id).expect(200)
    const queued = await operator.post(`/v1/applications/${id}/queue`)
    expect(queued.status).toBeGreaterThanOrEqual(400)
    expect(queued.status).toBeLessThan(500)
    expect(await applicationRow(database.db, id)).toMatchObject({ submission_state: "manual" })
  })
})

describe("C3 blocked path: the submission capability (the guard split)", () => {
  const blocked = { submission_state: "blocked", submission_kind: "automatic", blocked_reason: "captcha", blocked_at: new Date("2026-11-06T09:00:00Z") }

  it("BRD:128 the Operator completes his own blocked Application as before: 200, manual, submitted_local_day null", async () => {
    const id = await insertApplication(database.db, database.operatorId, blocked)
    const response = await manualComplete(operator, id)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(submissionSchema.parse(response.body)).toMatchObject({ state: "manual" })
    expect(await applicationRow(database.db, id)).toMatchObject({ submission_state: "manual", submitted_local_day: null })
  })

  it("BRD:128 a non-Operator's own blocked Application (backend-seeded) is 409 feature_not_yet_available with feature submission, and nothing changes", async () => {
    const id = await insertApplication(database.db, bisiId, blocked)
    const before = await applicationRow(database.db, id)
    const response = await manualComplete(bisi, id)
    expect(response.status).toBe(409)
    expect(response.body.error).toEqual({ code: "feature_not_yet_available", message: MESSAGES.notAvailable, feature: "submission" })
    expect(await applicationRow(database.db, id)).toEqual(before)
  })

  it("the same non-Operator can still complete a Draft right after (the two paths do not leak into each other)", async () => {
    const draft = await insertApplication(database.db, bisiId, {}, "Draft Co")
    const blockedId = await insertApplication(database.db, bisiId, blocked, "Blocked Co")
    await manualComplete(bisi, blockedId).expect(409)
    await manualComplete(bisi, draft).expect(200)
    expect(await applicationRow(database.db, blockedId)).toMatchObject({ submission_state: "blocked" })
  })
})

describe("C3 isolation and auth", () => {
  it("BRD:141 another Candidate's Application is 404 not_found for a non-Operator and for the Operator, and is not written", async () => {
    const operatorsDraft = await insertApplication(database.db, database.operatorId, {}, "Op Draft")
    const bisisDraft = await insertApplication(database.db, bisiId, {}, "Bisi Draft")
    const asBisi = await manualComplete(bisi, operatorsDraft)
    expect(asBisi.status).toBe(404)
    expect(conflict(asBisi.body)).toEqual({ code: "not_found", message: MESSAGES.notFound })
    const asOperator = await manualComplete(operator, bisisDraft)
    expect(asOperator.status).toBe(404)
    expect(await applicationRow(database.db, operatorsDraft)).toMatchObject({ submission_state: null })
    expect(await applicationRow(database.db, bisisDraft)).toMatchObject({ submission_state: null })
  })

  it("an id that is not a UUID, or a UUID that exists nowhere, is 404 before anything else", async () => {
    expect((await manualComplete(bisi, "not-a-uuid")).status).toBe(404)
    expect((await manualComplete(bisi, randomUUID())).status).toBe(404)
  })

  it("401 signed out and 403 csrf_invalid without the header, both before the Application is looked up", async () => {
    const id = await insertApplication(database.db, bisiId)
    const request = (await import("supertest")).default
    expect((await request(app.getHttpServer()).post(manualCompletePath(id))).status).toBe(401)
    const noCsrf = await request(app.getHttpServer()).post(manualCompletePath(id)).set("cookie", bisi.cookie)
    expect(noCsrf.status).toBe(403)
    expect(noCsrf.body.error.code).toBe("csrf_invalid")
    expect(await applicationRow(database.db, id)).toMatchObject({ submission_state: null })
  })

  it("two simultaneous requests for one Draft produce one Manual record (the row lock serialises them)", async () => {
    const id = await insertApplication(database.db, bisiId)
    const results = await Promise.all([manualComplete(bisi, id), manualComplete(bisi, id), manualComplete(bisi, id)])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(new Set(results.map((r) => r.body.manualCompletedAt)).size).toBe(1)
  })
})
