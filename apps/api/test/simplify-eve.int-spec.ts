import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import {
  ADVANCED_ERROR_MESSAGES,
  APPLICATIONS_PATH,
  ME_ADVANCED_PATH,
  ME_PATH,
  apiErrorResponseSchema,
  applicationOutcomesPath,
  applicationsResponseSchema,
  manualCompletePath,
  meNoteDismissPath,
  meResponseSchema,
  outcomePath,
  outcomeSchema,
  submissionSchema,
} from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0011 backend contract v1.28.0 (C1 to C4), through the real api and Postgres.
 * Gherkin: ADV:23, :60 to :110, :145, :151, :157; FD:85, :125; ONB:133; UPG:65 to :81, :116;
 * BRD:52, :91, :99, :105, :118, :124, :143, :149, :154; ST:128, :133, :158, :188.
 * Ada is the Operator (migration 0033 seeds her Advanced on); Kofi is an invitee.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let kofi: SignedInCandidate
let kofiId: string
let anonymous: Browser
const clock = new TestClock("2026-11-07T09:00:00.000Z")
const KOFI_SUB = "200000000000000000b11"
const KOFI_EMAIL = "kofi.e11@example.test"

const ADV_LOCKED = { error: { code: "advanced_locked", message: ADVANCED_ERROR_MESSAGES.advanced_locked } }

async function viewRow(candidateId: string) {
  return (await database.db.selectFrom("candidate_view_setting").selectAll().where("candidate_id", "=", candidateId).executeTakeFirst()) ?? null
}
async function setActivation(candidateId: string, automatic: boolean, gatePassed = true): Promise<void> {
  await database.db.deleteFrom("activation_state").where("candidate_id", "=", candidateId).execute()
  await database.db.insertInto("activation_state").values({ candidate_id: candidateId, existing_applications_completed_at: null, gate_passed_at: gatePassed ? new Date("2026-11-01T00:00:00Z") : null, automatic_enabled: automatic }).execute()
}
async function setView(candidateId: string, values: { advanced?: boolean; note?: boolean; dismissedAt?: Date | null } | null): Promise<void> {
  await database.db.deleteFrom("candidate_view_setting").where("candidate_id", "=", candidateId).execute()
  if (values === null) return
  await database.db.insertInto("candidate_view_setting").values({ candidate_id: candidateId, advanced_enabled: values.advanced ?? false, simpler_note_due: values.note ?? false, improve_list_dismissed_at: values.dismissedAt ?? null, updated_at: new Date("2026-11-01T00:00:00Z") }).execute()
}

type Seed = { submissionState?: string | null; sampleState?: string | null; kind?: string | null; deleted?: boolean; state?: string; createdAt?: Date; blockedReason?: string | null }
async function seedApplication(candidateId: string, seed: Seed = {}): Promise<string> {
  const postingId = randomUUID()
  const requisition = `R-${postingId.slice(0, 8)}`
  const url = `https://boards.greenhouse.io/acme/jobs/${requisition}`
  await insertPostingFor(database.db, candidateId, { id: postingId, application_url: url, requisition_id: requisition, apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company: "Acme", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date("2026-10-01"), evaluated_at: new Date("2026-10-01") })
  const id = randomUUID()
  const created = seed.createdAt ?? new Date("2026-11-01T10:00:00Z")
  await database.db
    .insertInto("application")
    .values({ candidate_id: candidateId, id, job_posting_id: postingId, application_url: url, requisition_id: requisition, company: "Acme", role_title: "Senior Frontend Engineer", state: (seed.state ?? "documents_ready") as never, career_profile_version: 1, blocked_document: seed.state === "documents_blocked" ? "resume" : null, blocked_claim: null, failure: null, created_at: created, updated_at: created })
    .execute()
  const patch: Record<string, unknown> = {}
  if (seed.submissionState) patch.submission_state = seed.submissionState
  if (seed.kind) patch.submission_kind = seed.kind
  if (seed.sampleState) patch.sample_state = seed.sampleState
  if (seed.blockedReason) Object.assign(patch, { blocked_reason: seed.blockedReason, blocked_at: created })
  if (seed.submissionState === "submitting") patch.submit_clicked_at = created
  if (seed.submissionState === "queued") patch.queued_for_local_day = "2026-11-09"
  if (seed.deleted) Object.assign(patch, { details_deleted_at: created, final_status: "confirmed" })
  if (Object.keys(patch).length > 0) await database.db.updateTable("application").set(patch as never).where("id", "=", id).execute()
  return id
}
async function addOutcome(candidateId: string, applicationId: string, type: string, at: Date, id: string = randomUUID()): Promise<string> {
  await database.db.insertInto("outcome").values({ id, candidate_id: candidateId, application_id: applicationId, type: type as never, excerpt: null, created_at: at, updated_at: at }).execute()
  return id
}
const rowOf = async (id: string) => database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  anonymous = new Browser(app, google)
  ada = await signInCandidate(new Browser(app, google))
  kofiId = (await database.db.insertInto("candidate").values({ email: KOFI_EMAIL, google_sub: KOFI_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: KOFI_SUB, email: KOFI_EMAIL, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  kofi = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, KOFI_EMAIL)
})

beforeEach(async () => {
  clock.set("2026-11-07T09:00:00.000Z")
  await database.db.deleteFrom("outcome").execute()
  await database.db.deleteFrom("submission_event").execute()
  await database.db.deleteFrom("application").execute()
  await setView(kofiId, null)
  await setActivation(kofiId, false)
  await setActivation(database.operatorId, false)
  await setView(database.operatorId, { advanced: true })
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("C2 GET /v1/me (ADV:23, :145; UPG:65, :81; FD:85)", () => {
  it("a Candidate with no row reads as the defaults, no row is created by the read", async () => {
    const body = meResponseSchema.parse((await kofi.get(ME_PATH).expect(200)).body)
    expect(body).toMatchObject({ advancedEnabled: false, advancedLocked: false, simplerNoteDue: false, improveListDismissed: false })
    expect(await viewRow(kofiId)).toBeNull()
  })

  it("reports the stored flags, and advancedLocked from activation_state.automatic_enabled for a non-Operator (UPG:65)", async () => {
    await setView(kofiId, { advanced: false, note: true, dismissedAt: new Date("2026-11-02T00:00:00Z") })
    await setActivation(kofiId, true)
    const body = meResponseSchema.parse((await kofi.get(ME_PATH).expect(200)).body)
    expect(body).toMatchObject({ isOperator: false, advancedEnabled: false, advancedLocked: true, simplerNoteDue: true, improveListDismissed: true })
  })

  it("is per user: the other Candidate's flags never show (ADV:145, :151)", async () => {
    await setView(database.operatorId, { advanced: true })
    expect(meResponseSchema.parse((await ada.get(ME_PATH).expect(200)).body).advancedEnabled).toBe(true)
    expect(meResponseSchema.parse((await kofi.get(ME_PATH).expect(200)).body).advancedEnabled).toBe(false)
  })

  it("ADV:157 signed out is 401", async () => {
    await anonymous.http().get(ME_PATH).expect(401)
  })
})

describe("C2 PUT /v1/me/advanced (ADV:60 to :110, :151, :157)", () => {
  it("ADV:60 turns it on, creates the row with the other columns at their defaults, returns the MeResponse; ADV:66 turns it off", async () => {
    const on = meResponseSchema.parse((await kofi.put(ME_ADVANCED_PATH).send({ enabled: true }).expect(200)).body)
    expect(on).toMatchObject({ candidateId: kofiId, advancedEnabled: true, advancedLocked: false, simplerNoteDue: false, improveListDismissed: false })
    expect(await viewRow(kofiId)).toMatchObject({ advanced_enabled: true, simpler_note_due: false, improve_list_dismissed_at: null })
    const off = meResponseSchema.parse((await kofi.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(200)).body)
    expect(off.advancedEnabled).toBe(false)
  })

  it("never changes the other columns of an existing row", async () => {
    const at = new Date("2026-11-02T00:00:00Z")
    await setView(kofiId, { advanced: false, note: true, dismissedAt: at })
    await kofi.put(ME_ADVANCED_PATH).send({ enabled: true }).expect(200)
    expect(await viewRow(kofiId)).toMatchObject({ advanced_enabled: true, simpler_note_due: true, improve_list_dismissed_at: at })
  })

  it("ADV:72 is visibility only: activation_state, controls, Applications and the queue are byte-equal before and after", async () => {
    await setActivation(kofiId, false)
    await seedApplication(kofiId, { submissionState: "queued", kind: "automatic" })
    const snapshot = async () => JSON.stringify([await database.db.selectFrom("activation_state").selectAll().orderBy("candidate_id").execute(), await database.db.selectFrom("application").selectAll().orderBy("id").execute(), await database.db.selectFrom("control_state").selectAll().execute(), await database.db.selectFrom("submission_day").selectAll().execute(), await database.db.selectFrom("submission_event").selectAll().execute()])
    const before = await snapshot()
    await kofi.put(ME_ADVANCED_PATH).send({ enabled: true }).expect(200)
    await kofi.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(200)
    expect(await snapshot()).toBe(before)
  })

  it("ADV:97 refuses off while automatic is on: 409 advanced_locked with the exact message, flag unchanged", async () => {
    await setView(kofiId, { advanced: true })
    await setActivation(kofiId, true)
    const response = await kofi.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(409)
    expect(apiErrorResponseSchema.parse(response.body)).toEqual(ADV_LOCKED)
    expect((await viewRow(kofiId))?.advanced_enabled).toBe(true)
    expect(meResponseSchema.parse((await kofi.get(ME_PATH).expect(200)).body)).toMatchObject({ advancedEnabled: true, advancedLocked: true })
  })

  it("ADV:97 the lock also refuses off when the Candidate has no view row yet (legacy data)", async () => {
    await setView(kofiId, null)
    await setActivation(kofiId, true)
    await kofi.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(409)
    expect(await viewRow(kofiId)).toBeNull()
  })

  it("ADV:104 accepts off once automatic is off; ADV:110 true while automatic is on is 200 and idempotent", async () => {
    await setView(kofiId, { advanced: true })
    await setActivation(kofiId, true)
    const again = meResponseSchema.parse((await kofi.put(ME_ADVANCED_PATH).send({ enabled: true }).expect(200)).body)
    expect(again).toMatchObject({ advancedEnabled: true, advancedLocked: true })
    await setActivation(kofiId, false)
    expect(meResponseSchema.parse((await kofi.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(200)).body)).toMatchObject({ advancedEnabled: false, advancedLocked: false })
  })

  it("ADV:151 a missing, non-boolean or null enabled and any extra key (candidateId) is 400 and writes nothing", async () => {
    for (const body of [{}, { enabled: "true" }, { enabled: null }, { enabled: 1 }, { enabled: true, candidateId: database.operatorId }, { enabled: false, extra: 1 }]) {
      await kofi.put(ME_ADVANCED_PATH).send(body).expect(400)
    }
    await kofi.put(ME_ADVANCED_PATH).expect(400)
    expect(await viewRow(kofiId)).toBeNull()
    expect((await viewRow(database.operatorId))?.advanced_enabled).toBe(true)
  })

  it("ADV:151 acts on the session Candidate only: Kofi's write leaves Ada's row alone and vice versa", async () => {
    await setView(database.operatorId, { advanced: true, note: false })
    await kofi.put(ME_ADVANCED_PATH).send({ enabled: true }).expect(200)
    expect(await viewRow(database.operatorId)).toMatchObject({ advanced_enabled: true, simpler_note_due: false })
    await ada.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(200)
    expect((await viewRow(kofiId))?.advanced_enabled).toBe(true)
  })

  it("ADV:157 signed out is 401; no CSRF header is 403 and nothing is written", async () => {
    await anonymous.http().put(ME_ADVANCED_PATH).send({ enabled: true }).expect(401)
    await kofi.put(ME_ADVANCED_PATH).set("x-csrf-token", "wrong").send({ enabled: true }).expect(403)
    expect(await viewRow(kofiId)).toBeNull()
  })
})

describe("C2 POST /v1/me/notes/:note/dismiss (ONB:133, UPG:76)", () => {
  it("simpler_now clears the note and nothing else; repeating is 200 with the same body", async () => {
    await setView(kofiId, { advanced: false, note: true })
    const first = meResponseSchema.parse((await kofi.post(meNoteDismissPath("simpler_now")).expect(200)).body)
    expect(first).toMatchObject({ simplerNoteDue: false, advancedEnabled: false, improveListDismissed: false })
    expect(meResponseSchema.parse((await kofi.post(meNoteDismissPath("simpler_now")).send({ ignored: true }).expect(200)).body)).toEqual(first)
  })

  it("improve_results sets the time once and keeps the first dismissal time", async () => {
    const first = meResponseSchema.parse((await kofi.post(meNoteDismissPath("improve_results")).expect(200)).body)
    expect(first.improveListDismissed).toBe(true)
    const stored = (await viewRow(kofiId))!.improve_list_dismissed_at!
    clock.set("2026-11-08T09:00:00.000Z")
    await kofi.post(meNoteDismissPath("improve_results")).expect(200)
    expect((await viewRow(kofiId))!.improve_list_dismissed_at).toEqual(stored)
  })

  it("a new row from a dismissal keeps Advanced off", async () => {
    await kofi.post(meNoteDismissPath("simpler_now")).expect(200)
    expect(await viewRow(kofiId)).toMatchObject({ advanced_enabled: false })
  })

  it("an unknown note is 404 and writes nothing; signed out is 401", async () => {
    const response = await kofi.post("/v1/me/notes/everything/dismiss").expect(404)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("not_found")
    expect(await viewRow(kofiId)).toBeNull()
    await anonymous.http().post(meNoteDismissPath("simpler_now")).expect(401)
  })

  it("never touches the other Candidate's row", async () => {
    await setView(database.operatorId, { advanced: true, note: true })
    await kofi.post(meNoteDismissPath("simpler_now")).expect(200)
    expect(await viewRow(database.operatorId)).toMatchObject({ simpler_note_due: true })
  })
})

describe("C2 PUT /v1/submission/automatic turns Advanced on (ADV:92, D4)", () => {
  it("enabling sets Advanced on in the same transaction and locks it; disabling leaves Advanced on and unlocks", async () => {
    await setView(database.operatorId, { advanced: false, note: true })
    await setActivation(database.operatorId, false)
    await ada.put("/v1/submission/automatic").send({ enabled: true }).expect(200)
    expect(await viewRow(database.operatorId)).toMatchObject({ advanced_enabled: true, simpler_note_due: true })
    expect(meResponseSchema.parse((await ada.get(ME_PATH).expect(200)).body)).toMatchObject({ advancedEnabled: true, advancedLocked: true })
    await ada.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(409)
    await ada.put("/v1/submission/automatic").send({ enabled: false }).expect(200)
    expect(meResponseSchema.parse((await ada.get(ME_PATH).expect(200)).body)).toMatchObject({ advancedEnabled: true, advancedLocked: false })
  })

  it("enabling before the gate passed stays 409 gate_requirements_unmet and writes neither flag", async () => {
    await setView(database.operatorId, { advanced: false })
    await setActivation(database.operatorId, false, false)
    const response = await ada.put("/v1/submission/automatic").send({ enabled: true }).expect(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("gate_requirements_unmet")
    expect((await database.db.selectFrom("activation_state").select("automatic_enabled").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).automatic_enabled).toBe(false)
    expect((await viewRow(database.operatorId))?.advanced_enabled).toBe(false)
  })

  it("a non-Operator still gets 409 feature_not_yet_available and nothing is written", async () => {
    const response = await kofi.put("/v1/submission/automatic").send({ enabled: true }).expect(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("feature_not_yet_available")
    expect(await viewRow(kofiId)).toBeNull()
  })

  it("the lock race: concurrent off and automatic-on never leave automatic on with Advanced off, and nothing deadlocks", async () => {
    for (let round = 0; round < 12; round++) {
      await setView(database.operatorId, { advanced: true })
      await setActivation(database.operatorId, false)
      const [off, on] = await Promise.all([ada.put(ME_ADVANCED_PATH).send({ enabled: false }), ada.put("/v1/submission/automatic").send({ enabled: true })])
      expect([200, 409]).toContain(off.status)
      expect(on.status).toBe(200)
      if (off.status === 409) expect(apiErrorResponseSchema.parse(off.body)).toEqual(ADV_LOCKED)
      const activation = await database.db.selectFrom("activation_state").select("automatic_enabled").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
      const view = await viewRow(database.operatorId)
      expect(activation.automatic_enabled).toBe(true)
      expect(view?.advanced_enabled, `round ${round}: off=${off.status}`).toBe(true)
    }
  })
})

describe("C3 POST /v1/applications/:id/manual-complete (BRD:91, :99, :105, :118, :124)", () => {
  const complete = (who: SignedInCandidate, id: string) => who.post(manualCompletePath(id))

  it("BRD:91 a non-Operator's Draft becomes manual: 200 Submission, kind null, no day, never counted", async () => {
    const id = await seedApplication(kofiId)
    const body = submissionSchema.parse((await complete(kofi, id).expect(200)).body)
    expect(body).toMatchObject({ state: "manual", kind: null, submittedWatDay: null, submittedAt: null, sample: null, blockedReason: null, override: null })
    expect(body.manualCompletedAt).toBe("2026-11-07T09:00:00.000Z")
    const row = await rowOf(id)
    expect(row).toMatchObject({ submission_state: "manual", submission_kind: null })
    expect(row.submitted_local_day).toBeNull()
    expect(await database.db.selectFrom("submission_day").selectAll().where("candidate_id", "=", kofiId).execute()).toEqual([])
  })

  it("accepts every ApplicationState without a submission state (the user may have applied with their own documents)", async () => {
    for (const state of ["prepared", "generating", "documents_ready", "documents_blocked", "documents_failed"]) {
      const id = await seedApplication(kofiId, { state })
      await complete(kofi, id).expect(200)
    }
  })

  it("the Operator can complete a Draft too", async () => {
    const id = await seedApplication(database.operatorId)
    expect(submissionSchema.parse((await complete(ada, id).expect(200)).body).state).toBe("manual")
  })

  it("BRD:118 twice is 200 with the same manualCompletedAt and no second write", async () => {
    const id = await seedApplication(kofiId)
    const first = submissionSchema.parse((await complete(kofi, id).expect(200)).body)
    clock.set("2026-11-07T10:00:00.000Z")
    const second = submissionSchema.parse((await complete(kofi, id).expect(200)).body)
    expect(second.manualCompletedAt).toBe(first.manualCompletedAt)
    expect((await rowOf(id)).updated_at.toISOString()).toBe(first.manualCompletedAt)
  })

  it("minimal record and every sample state are 409 application_state_conflict with nothing written", async () => {
    const cases: Seed[] = [{ deleted: true }, { sampleState: "awaiting_review" }, { sampleState: "approved" }, { sampleState: "rejected" }]
    for (const seed of cases) {
      const id = await seedApplication(kofiId, seed)
      const before = JSON.stringify(await rowOf(id))
      const response = await complete(kofi, id).expect(409)
      expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "application_state_conflict", message: "This Application can't do that in its current state." })
      expect(JSON.stringify(await rowOf(id))).toBe(before)
    }
  })

  it("BRD:105 queued, in flight, confirmed, uncertain, declined and not_submitted are 409 for the Operator and for a non-Operator", async () => {
    for (const submissionState of ["queued", "submit_claimed", "submitting", "confirmed", "uncertain", "declined", "not_submitted"]) {
      for (const who of [{ client: kofi, owner: kofiId }, { client: ada, owner: database.operatorId }]) {
        const id = await seedApplication(who.owner, { submissionState, kind: "automatic" })
        const before = JSON.stringify(await rowOf(id))
        await complete(who.client, id).expect(409)
        expect(JSON.stringify(await rowOf(id)), submissionState).toBe(before)
      }
    }
  })

  it("BRD:99 the blocked path: Operator 200, a non-Operator 409 feature_not_yet_available with feature submission and nothing written", async () => {
    const mine = await seedApplication(kofiId, { submissionState: "blocked", kind: "automatic", blockedReason: "missing_approved_answer" })
    const before = JSON.stringify(await rowOf(mine))
    const response = await complete(kofi, mine).expect(409)
    expect(apiErrorResponseSchema.parse(response.body)).toEqual({ error: { code: "feature_not_yet_available", message: "This feature isn't available for your account yet.", feature: "submission" } })
    expect(JSON.stringify(await rowOf(mine))).toBe(before)
    const operators = await seedApplication(database.operatorId, { submissionState: "blocked", kind: "automatic", blockedReason: "missing_approved_answer" })
    expect(submissionSchema.parse((await complete(ada, operators).expect(200)).body).state).toBe("manual")
    expect((await rowOf(operators)).submitted_local_day).toBeNull()
  })

  it("BRD:124 another Candidate's Application, a random UUID and a non-UUID are 404 for every caller, and nothing changes", async () => {
    const adas = await seedApplication(database.operatorId)
    const kofis = await seedApplication(kofiId)
    const adasBefore = JSON.stringify(await rowOf(adas))
    const kofisBefore = JSON.stringify(await rowOf(kofis))
    for (const response of [await complete(kofi, adas), await complete(ada, kofis), await complete(kofi, randomUUID()), await complete(kofi, "not-a-uuid")]) {
      expect(response.status).toBe(404)
      expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "not_found", message: "Not found." })
    }
    expect(JSON.stringify(await rowOf(adas))).toBe(adasBefore)
    expect(JSON.stringify(await rowOf(kofis))).toBe(kofisBefore)
  })

  it("signed out is 401; a wrong CSRF token is 403", async () => {
    const id = await seedApplication(kofiId)
    await anonymous.http().post(manualCompletePath(id)).expect(401)
    await kofi.post(manualCompletePath(id)).set("x-csrf-token", "nope").expect(403)
    expect((await rowOf(id)).submission_state).toBeNull()
  })

  it("two concurrent calls on a Draft write one record", async () => {
    const id = await seedApplication(kofiId)
    const both = await Promise.all([complete(kofi, id), complete(kofi, id)])
    expect(both.map((r) => r.status)).toEqual([200, 200])
    expect(submissionSchema.parse(both[0]!.body).manualCompletedAt).toBe(submissionSchema.parse(both[1]!.body).manualCompletedAt)
  })
})

describe("C1 offer Outcome (BRD:143, :149, :154; ST:158)", () => {
  it("POST accepts offer with 201, PATCH edits to and from offer with 200 keeping createdAt", async () => {
    const id = await seedApplication(kofiId, { submissionState: "confirmed", kind: "automatic" })
    const created = outcomeSchema.parse((await kofi.post(applicationOutcomesPath(id)).send({ type: "offer" }).expect(201)).body)
    expect(created).toMatchObject({ type: "offer", source: "candidate", excerpt: null })
    clock.set("2026-11-07T11:00:00.000Z")
    const edited = outcomeSchema.parse((await kofi.patch(outcomePath(created.id)).send({ type: "interview_invitation" }).expect(200)).body)
    expect(edited).toMatchObject({ type: "interview_invitation", createdAt: created.createdAt })
    expect(edited.updatedAt).not.toBe(created.updatedAt)
    expect(outcomeSchema.parse((await kofi.patch(outcomePath(created.id)).send({ type: "offer" }).expect(200)).body).type).toBe("offer")
    const list = (await kofi.get(applicationOutcomesPath(id)).expect(200)).body.outcomes as { type: string }[]
    expect(list.map((o) => o.type)).toEqual(["offer"])
  })

  it("BRD:149 an unknown type, a missing type and an extra key are 400 on POST and PATCH", async () => {
    const id = await seedApplication(kofiId)
    const created = outcomeSchema.parse((await kofi.post(applicationOutcomesPath(id)).send({ type: "offer" }).expect(201)).body)
    for (const body of [{ type: "promotion" }, {}, { type: "offer", extra: 1 }]) {
      await kofi.post(applicationOutcomesPath(id)).send(body).expect(400)
      await kofi.patch(outcomePath(created.id)).send(body).expect(400)
    }
  })

  it("a minimal record refuses a new Outcome (409) and another Candidate's Application is 404", async () => {
    const minimal = await seedApplication(kofiId, { deleted: true })
    await kofi.post(applicationOutcomesPath(minimal)).send({ type: "offer" }).expect(409)
    const adas = await seedApplication(database.operatorId)
    await kofi.post(applicationOutcomesPath(adas)).send({ type: "offer" }).expect(404)
  })
})

describe("C4 board fields on GET /v1/applications (BRD:52; ST:128, :133)", () => {
  const list = async (who: SignedInCandidate) => applicationsResponseSchema.parse((await who.get(APPLICATIONS_PATH).expect(200)).body).applications

  it("every row carries the five keys; a Draft is all null/false", async () => {
    const id = await seedApplication(kofiId)
    const rows = await list(kofi)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, submissionState: null, submissionKind: null, sampleState: null, latestOutcome: null, requestForAction: false })
    expect(Object.keys((await kofi.get(APPLICATIONS_PATH).expect(200)).body.applications[0])).toEqual(expect.arrayContaining(["submissionState", "submissionKind", "sampleState", "latestOutcome", "requestForAction"]))
  })

  it("submission state, kind and sample state are returned as stored; manual is submissionState manual with kind null", async () => {
    const queued = await seedApplication(kofiId, { submissionState: "queued", kind: "automatic", createdAt: new Date("2026-11-03T00:00:00Z") })
    const sample = await seedApplication(kofiId, { submissionState: "confirmed", kind: "sample", sampleState: "approved", createdAt: new Date("2026-11-02T00:00:00Z") })
    const manual = await seedApplication(kofiId)
    await kofi.post(manualCompletePath(manual)).expect(200)
    const byId = new Map((await list(kofi)).map((row) => [row.id, row]))
    expect(byId.get(queued)).toMatchObject({ submissionState: "queued", submissionKind: "automatic", sampleState: null })
    expect(byId.get(sample)).toMatchObject({ submissionState: "confirmed", submissionKind: "sample", sampleState: "approved" })
    expect(byId.get(manual)).toMatchObject({ submissionState: "manual", submissionKind: null })
  })

  it("ST:133 the newest Outcome by (created_at, id) decides; ties break on id", async () => {
    const id = await seedApplication(kofiId, { submissionState: "confirmed", kind: "automatic" })
    await addOutcome(kofiId, id, "confirmation", new Date("2026-11-04T00:00:00Z"))
    const newest = await addOutcome(kofiId, id, "interview_invitation", new Date("2026-11-05T00:00:00Z"))
    const [row] = await list(kofi)
    expect(row!.latestOutcome).toEqual({ id: newest, type: "interview_invitation", createdAt: "2026-11-05T00:00:00.000Z" })

    const tie = await seedApplication(kofiId, { submissionState: "confirmed", kind: "automatic", createdAt: new Date("2026-11-02T00:00:00Z") })
    const low = await addOutcome(kofiId, tie, "confirmation", new Date("2026-11-06T00:00:00Z"), "00000000-0000-4000-8000-000000000001")
    const high = await addOutcome(kofiId, tie, "offer", new Date("2026-11-06T00:00:00Z"), "00000000-0000-4000-8000-000000000002")
    expect(low < high).toBe(true)
    const tied = (await list(kofi)).find((r) => r.id === tie)!
    expect(tied.latestOutcome).toMatchObject({ id: high, type: "offer" })
  })

  it("ST:128 request_for_action never becomes latestOutcome; requestForAction is true only while it is the newest overall", async () => {
    const id = await seedApplication(kofiId, { submissionState: "confirmed", kind: "automatic" })
    const interview = await addOutcome(kofiId, id, "interview_invitation", new Date("2026-11-04T00:00:00Z"))
    await addOutcome(kofiId, id, "request_for_action", new Date("2026-11-05T00:00:00Z"))
    expect((await list(kofi))[0]).toMatchObject({ latestOutcome: { id: interview, type: "interview_invitation" }, requestForAction: true })
    await addOutcome(kofiId, id, "offer", new Date("2026-11-06T00:00:00Z"))
    expect((await list(kofi))[0]).toMatchObject({ latestOutcome: { type: "offer" }, requestForAction: false })
    const only = await seedApplication(kofiId, { createdAt: new Date("2026-10-01T00:00:00Z") })
    await addOutcome(kofiId, only, "request_for_action", new Date("2026-11-05T00:00:00Z"))
    expect((await list(kofi)).find((r) => r.id === only)).toMatchObject({ latestOutcome: null, requestForAction: true })
  })

  it("a minimal record has latestOutcome null and requestForAction false but keeps its submission fields", async () => {
    const id = await seedApplication(kofiId, { submissionState: "confirmed", kind: "automatic", deleted: true })
    await addOutcome(kofiId, id, "offer", new Date("2026-11-05T00:00:00Z"))
    expect((await list(kofi))[0]).toMatchObject({ detailsDeletedAt: expect.any(String), submissionState: "confirmed", submissionKind: "automatic", latestOutcome: null, requestForAction: false })
  })

  it("the retention filter rows carry the same keys, and rows are the caller's own", async () => {
    await seedApplication(database.operatorId)
    await seedApplication(kofiId)
    expect(await list(kofi)).toHaveLength(1)
    const filtered = applicationsResponseSchema.parse((await kofi.get(`${APPLICATIONS_PATH}?retention=waiting`).expect(200)).body)
    for (const row of filtered.applications) expect(row).toHaveProperty("requestForAction")
  })

  it("the detail route keeps the v1.27.0 shape (ApplicationSummary unchanged)", async () => {
    const id = await seedApplication(database.operatorId, { submissionState: "confirmed", kind: "automatic" })
    const body = (await ada.get(`${APPLICATIONS_PATH}/${id}`).expect(200)).body as Record<string, unknown>
    for (const key of ["submissionState", "submissionKind", "sampleState", "latestOutcome", "requestForAction"]) expect(body).not.toHaveProperty(key)
  })
})
