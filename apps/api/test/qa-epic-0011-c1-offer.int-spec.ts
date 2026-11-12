import type { INestApplication } from "@nestjs/common"
import { apiErrorResponseSchema, applicationOutcomesPath, outcomePath, outcomeTypeSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { MESSAGES, insertApplication, insertOutcome, signInInvitee } from "./support/qa-epic-0011.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA test authoring, EPIC-0011 API-C1 (api-contract.md v1.28.0 "C1. offer Outcome type").
 * Gherkin: applications-board.r1.feature (BRD "The Outcome endpoints accept offer",
 * "An unknown Outcome type is still rejected", Closed-from-Interview/Offer),
 * status-words.r1.feature ST:158 ("only enum change is offer").
 * Expected red until the `offer` value and migration 0033 land.
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
  await database.db.deleteFrom("outcome").execute()
  await database.db.deleteFrom("application").execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("C1: the offer Outcome type", () => {
  it("ST:158 the type enum gains only offer, appended last, and request_for_action stays", () => {
    expect(outcomeTypeSchema.options).toEqual(["confirmation", "rejection", "interview_invitation", "request_for_action", "offer"])
  })

  it("POST …/outcomes with offer answers 201 with type offer and the list reads it back", async () => {
    const id = await insertApplication(database.db, database.operatorId)
    const created = await operator.post(applicationOutcomesPath(id)).send({ type: "offer" })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body).toMatchObject({ applicationId: id, type: "offer", source: "candidate", excerpt: null })
    const listed = await operator.get(applicationOutcomesPath(id))
    expect(listed.status).toBe(200)
    expect(listed.body.outcomes ?? listed.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.id, type: "offer" })]))
  })

  it("a non-Operator records offer on their own Application (any signed-in Candidate)", async () => {
    const id = await insertApplication(database.db, bisiId, {}, "Globex")
    const created = await bisi.post(applicationOutcomesPath(id)).send({ type: "offer" })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.type).toBe("offer")
  })

  it("PATCH …/outcomes/{id} edits any Outcome to offer: 200, only type and updatedAt change, createdAt keeps", async () => {
    const id = await insertApplication(database.db, database.operatorId)
    const outcomeId = await insertOutcome(database.db, database.operatorId, id, "interview_invitation", new Date("2026-11-05T10:00:00.000Z"))
    const edited = await operator.patch(outcomePath(outcomeId)).send({ type: "offer" })
    expect(edited.status, JSON.stringify(edited.body)).toBe(200)
    expect(edited.body).toMatchObject({ id: outcomeId, type: "offer", createdAt: "2026-11-05T10:00:00.000Z" })
    const again = await operator.patch(outcomePath(outcomeId)).send({ type: "offer" })
    expect(again.status).toBe(200)
    expect({ ...again.body, updatedAt: null }).toEqual({ ...edited.body, updatedAt: null })
  })

  it("a backward move is an edit: offer back to interview_invitation keeps one row and the same createdAt (no delete)", async () => {
    const id = await insertApplication(database.db, database.operatorId)
    const outcomeId = await insertOutcome(database.db, database.operatorId, id, "offer", new Date("2026-11-05T10:00:00.000Z"))
    const edited = await operator.patch(outcomePath(outcomeId)).send({ type: "interview_invitation" })
    expect(edited.status).toBe(200)
    const rows = await database.db.selectFrom("outcome").selectAll().where("application_id", "=", id).execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: "interview_invitation" })
  })

  it.each(["promotion", "Offer", "", null, 1])("an unknown type %j is 400 bad_request and nothing is stored", async (type) => {
    const id = await insertApplication(database.db, database.operatorId)
    const response = await operator.post(applicationOutcomesPath(id)).send({ type })
    expect(response.status).toBe(400)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("bad_request")
    expect(await database.db.selectFrom("outcome").select("id").execute()).toEqual([])
  })

  it("a missing type or an extra key is 400, on POST and PATCH", async () => {
    const id = await insertApplication(database.db, database.operatorId)
    const outcomeId = await insertOutcome(database.db, database.operatorId, id, "confirmation", new Date())
    expect((await operator.post(applicationOutcomesPath(id)).send({})).status).toBe(400)
    expect((await operator.post(applicationOutcomesPath(id)).send({ type: "offer", extra: 1 })).status).toBe(400)
    expect((await operator.patch(outcomePath(outcomeId)).send({ type: "offer", candidateId: bisiId })).status).toBe(400)
    expect((await operator.patch(outcomePath(outcomeId)).send({ type: "promotion" })).status).toBe(400)
  })

  it("there is no Outcome delete endpoint and this release adds none", async () => {
    const id = await insertApplication(database.db, database.operatorId)
    const outcomeId = await insertOutcome(database.db, database.operatorId, id, "offer", new Date())
    const response = await operator.delete(outcomePath(outcomeId))
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await database.db.selectFrom("outcome").select("id").where("id", "=", outcomeId).execute()).toHaveLength(1)
  })

  it("another Candidate's Application or Outcome is 404 not_found for POST and PATCH, and nothing is written", async () => {
    const operatorsApp = await insertApplication(database.db, database.operatorId)
    const operatorsOutcome = await insertOutcome(database.db, database.operatorId, operatorsApp, "confirmation", new Date())
    const post = await bisi.post(applicationOutcomesPath(operatorsApp)).send({ type: "offer" })
    expect(post.status).toBe(404)
    expect(apiErrorResponseSchema.parse(post.body).error).toEqual({ code: "not_found", message: MESSAGES.notFound })
    const patch = await bisi.patch(outcomePath(operatorsOutcome)).send({ type: "offer" })
    expect(patch.status).toBe(404)
    expect((await database.db.selectFrom("outcome").select("type").where("id", "=", operatorsOutcome).executeTakeFirstOrThrow()).type).toBe("confirmation")
  })

  it("a minimal record (details deleted) refuses a new Outcome with 409 application_state_conflict", async () => {
    const id = await insertApplication(database.db, database.operatorId, { details_deleted_at: new Date("2026-11-02T00:00:00Z") })
    const response = await operator.post(applicationOutcomesPath(id)).send({ type: "offer" })
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "application_state_conflict", message: MESSAGES.stateConflict })
  })

  it("the outcome.type check accepts offer and still refuses any other value (migration 0033 step 4)", async () => {
    const id = await insertApplication(database.db, database.operatorId)
    await expect(insertOutcome(database.db, database.operatorId, id, "offer", new Date())).resolves.toEqual(expect.any(String))
    await expect(insertOutcome(database.db, database.operatorId, id, "promotion", new Date())).rejects.toThrow(/outcome_type_check|check constraint/)
  })
})
