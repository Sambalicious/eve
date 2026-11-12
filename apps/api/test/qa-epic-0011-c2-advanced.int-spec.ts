import type { INestApplication } from "@nestjs/common"
import { ADVANCED_ERROR_MESSAGES, AUTOMATIC_SUBMISSION_PATH, ME_ADVANCED_PATH, ME_PATH, apiErrorResponseSchema, meNoteDismissPath, meResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { backendPid, untilLockWait } from "./support/lock-wait.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { ME_KEYS, insertApplication, setAutomatic, setViewSetting, signInInvitee, tableDigests, viewSetting } from "./support/qa-epic-0011.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA test authoring, EPIC-0011 API-C2 (api-contract.md v1.28.0 "C2. Advanced: automatic applying").
 * Gherkin: advanced-switch.r1.feature ADV:17 to ADV:194 (AC-3.1, 3.4, 3.5, 3.8, 3.9, 7.4),
 * navigation.r1.feature NAV:152 (flag read failure is web-only), upgrade-and-compat.r1.feature UPG:92/UPG:116.
 * Also the QA rows for RLS on candidate_view_setting and the activation_state / candidate_view_setting lock race (D4).
 * Expected red until migration 0033 and the C2 routes land.
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
  await sql`delete from candidate_view_setting`.execute(database.db)
  for (const id of [database.operatorId, bisiId]) await database.db.deleteFrom("activation_state").where("candidate_id", "=", id).execute()
  await database.db.deleteFrom("application").execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const me = async (who: SignedInCandidate) => meResponseSchema.parse((await who.get(ME_PATH).expect(200)).body)
const gateOpen = (id: string) => setAutomatic(database.db, id, false)

describe("GET /v1/me (C2 fields)", () => {
  it("ADV:24 an account with no candidate_view_setting row reads all four flags false, and the body has exactly the contract keys", async () => {
    const response = await bisi.get(ME_PATH)
    expect(response.status).toBe(200)
    expect(Object.keys(response.body).sort()).toEqual([...ME_KEYS])
    expect(response.body).toMatchObject({ advancedEnabled: false, advancedLocked: false, simplerNoteDue: false, improveListDismissed: false, isOperator: false })
    expect(response.headers["cache-control"]).toMatch(/no-store/)
  })

  it("reads only the caller's own row: the Operator's flag does not leak to an invitee", async () => {
    await setViewSetting(database.db, database.operatorId, { advanced: true })
    expect((await me(bisi)).advancedEnabled).toBe(false)
    expect((await me(operator)).advancedEnabled).toBe(true)
  })

  it("ADV:30 advancedLocked mirrors activation_state.automatic_enabled, also for a non-Operator whose submission status route is 409", async () => {
    await setViewSetting(database.db, bisiId, { advanced: true })
    await setAutomatic(database.db, bisiId, true)
    expect(await me(bisi)).toMatchObject({ advancedEnabled: true, advancedLocked: true })
    expect((await bisi.get("/v1/submission/status")).status).toBe(409)
  })

  it("a legacy row that breaks the invariant (automatic on, flag off) reports the stored flag and advancedLocked true", async () => {
    await setViewSetting(database.db, bisiId, { advanced: false })
    await setAutomatic(database.db, bisiId, true)
    expect(await me(bisi)).toMatchObject({ advancedEnabled: false, advancedLocked: true })
  })

  it("AC-3.8 a signed-out request is 401", async () => {
    const response = await request(app.getHttpServer()).get(ME_PATH)
    expect(response.status).toBe(401)
  })
})

describe("PUT /v1/me/advanced", () => {
  it("ADV:61 turning on returns 200 with the full /v1/me body and stores the flag; the note and list flags are not touched", async () => {
    await setViewSetting(database.db, bisiId, { advanced: false, note: true })
    const response = await bisi.put(ME_ADVANCED_PATH).send({ enabled: true })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(meResponseSchema.parse(response.body)).toMatchObject({ advancedEnabled: true, advancedLocked: false, simplerNoteDue: true, improveListDismissed: false })
    expect(await viewSetting(database.db, bisiId)).toMatchObject({ advanced_enabled: true, simpler_note_due: true, improve_list_dismissed_at: null })
  })

  it("a first write creates the row with the other columns at their defaults, and a second device reads it (ADV:154)", async () => {
    expect(await viewSetting(database.db, bisiId)).toBeUndefined()
    await bisi.put(ME_ADVANCED_PATH).send({ enabled: true }).expect(200)
    expect(await viewSetting(database.db, bisiId)).toMatchObject({ advanced_enabled: true, simpler_note_due: false, improve_list_dismissed_at: null })
    // "Device B": a fresh session for the same Candidate.
    const deviceB = await new Browser(app, google).signIn({ sub: "300000000000000000011", email: "bisi@example.test", email_verified: true })
    expect(deviceB.sessionCookie).toBeTruthy()
    expect((await me(bisi)).advancedEnabled).toBe(true)
  })

  it("ADV:113 turning off while automatic is off returns 200 and the flag is false", async () => {
    await setViewSetting(database.db, bisiId, { advanced: true })
    const response = await bisi.put(ME_ADVANCED_PATH).send({ enabled: false })
    expect(response.status).toBe(200)
    expect(response.body.advancedEnabled).toBe(false)
  })

  it("ADV:106 turning off while automatic is on is 409 advanced_locked with the exact message, and the flag stays true", async () => {
    await setViewSetting(database.db, database.operatorId, { advanced: true })
    await setAutomatic(database.db, database.operatorId, true)
    const response = await operator.put(ME_ADVANCED_PATH).send({ enabled: false })
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "advanced_locked", message: ADVANCED_ERROR_MESSAGES.advanced_locked })
    expect(response.body.error.message).toBe("Advanced stays on while automatic applying is on. Turn off automatic applying first.")
    expect(await viewSetting(database.db, database.operatorId)).toMatchObject({ advanced_enabled: true })
  })

  it("ADV:119 setting true while automatic is on is idempotent: 200 and true", async () => {
    await setViewSetting(database.db, database.operatorId, { advanced: true })
    await setAutomatic(database.db, database.operatorId, true)
    const response = await operator.put(ME_ADVANCED_PATH).send({ enabled: true })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ advancedEnabled: true, advancedLocked: true })
  })

  it("a non-Operator whose automatic is backend-seeded on is locked the same way (ADV:93, UPG:66)", async () => {
    await setViewSetting(database.db, bisiId, { advanced: true })
    await setAutomatic(database.db, bisiId, true)
    const response = await bisi.put(ME_ADVANCED_PATH).send({ enabled: false })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe("advanced_locked")
  })

  it.each([{}, { enabled: "true" }, { enabled: null }, { enabled: 1 }, { enabled: true, candidateId: "00000000-0000-4000-8000-000000000001" }, { enabled: false, extra: 1 }])("ADV:160 body %j is 400 bad_request and nothing is written", async (body) => {
    await setViewSetting(database.db, bisiId, { advanced: true, note: true })
    const before = await viewSetting(database.db, bisiId)
    const response = await bisi.put(ME_ADVANCED_PATH).send(body)
    expect(response.status).toBe(400)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("bad_request")
    expect(await viewSetting(database.db, bisiId)).toEqual(before)
  })

  it("ADV:168 another Candidate's flag is never read or written by a request from Bisi", async () => {
    await setViewSetting(database.db, database.operatorId, { advanced: true })
    await bisi.put(ME_ADVANCED_PATH).send({ enabled: true, candidateId: database.operatorId }).expect(400)
    await bisi.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(200)
    expect(await viewSetting(database.db, database.operatorId)).toMatchObject({ advanced_enabled: true })
    expect(await viewSetting(database.db, bisiId)).toMatchObject({ advanced_enabled: false })
  })

  it("ADV:173 a signed-out PUT is 401 and a PUT without the CSRF header is 403 csrf_invalid, both before the body is read", async () => {
    const signedOut = await request(app.getHttpServer()).put(ME_ADVANCED_PATH).send({ enabled: true })
    expect(signedOut.status).toBe(401)
    const noCsrf = await request(app.getHttpServer()).put(ME_ADVANCED_PATH).set("cookie", bisi.cookie).send({ enabled: true })
    expect(noCsrf.status).toBe(403)
    expect(noCsrf.body.error.code).toBe("csrf_invalid")
    const noCsrfBadBody = await request(app.getHttpServer()).put(ME_ADVANCED_PATH).set("cookie", bisi.cookie).send({ enabled: "x" })
    expect(noCsrfBadBody.status).toBe(403)
    expect(await viewSetting(database.db, bisiId)).toBeUndefined()
  })
})

describe("ADV:72 (AC-3.4) the flag changes visibility only", () => {
  it("on then off leaves activation_state, controls, spend, queue and every Application byte-equal", async () => {
    await setAutomatic(database.db, database.operatorId, false)
    await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z") }).where("candidate_id", "=", database.operatorId).execute()
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    await insertApplication(database.db, database.operatorId, { submission_state: "queued", submission_kind: "automatic", queued_for_local_day: "2026-11-08" }, "Queued Co")
    await insertApplication(database.db, database.operatorId, {}, "Plain Co")
    const tables = ["activation_state", "control_state", "application", "submission_day", "submission_event", "notification_outbox", "outcome", "job_criteria", "job_preferences"]
    const before = await tableDigests(database.db, tables)
    await operator.put(ME_ADVANCED_PATH).send({ enabled: true }).expect(200)
    await operator.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(200)
    expect(await tableDigests(database.db, tables)).toEqual(before)
    await database.db.updateTable("control_state").set({ global_paused: false }).execute()
  })
})

describe("PUT /v1/submission/automatic keeps automatic_enabled ⇒ advanced_enabled (D4, ADV:93, UPG:116)", () => {
  async function operatorReady(advanced: boolean) {
    await setViewSetting(database.db, database.operatorId, { advanced })
    await database.db.insertInto("activation_state").values({ candidate_id: database.operatorId, gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: false, existing_applications_completed_at: new Date("2026-10-19T12:00:00Z") } as never).execute()
  }

  it("enabling automatic also turns the flag on, in one transaction, and the lock then shows in /v1/me", async () => {
    await operatorReady(false)
    const response = await operator.put(AUTOMATIC_SUBMISSION_PATH).send({ enabled: true })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(await viewSetting(database.db, database.operatorId)).toMatchObject({ advanced_enabled: true })
    expect(await me(operator)).toMatchObject({ advancedEnabled: true, advancedLocked: true })
  })

  it("enabling with no candidate_view_setting row creates the row with advanced true and other columns at defaults", async () => {
    await operatorReady(false)
    await sql`delete from candidate_view_setting`.execute(database.db)
    await operator.put(AUTOMATIC_SUBMISSION_PATH).send({ enabled: true }).expect(200)
    expect(await viewSetting(database.db, database.operatorId)).toMatchObject({ advanced_enabled: true, simpler_note_due: false, improve_list_dismissed_at: null })
  })

  it("a refused enable (gate not passed, 409 gate_requirements_unmet) leaves the flag as it was", async () => {
    await setViewSetting(database.db, database.operatorId, { advanced: false })
    await database.db.insertInto("activation_state").values({ candidate_id: database.operatorId, gate_passed_at: null, automatic_enabled: false, existing_applications_completed_at: null } as never).execute()
    const response = await operator.put(AUTOMATIC_SUBMISSION_PATH).send({ enabled: true })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe("gate_requirements_unmet")
    expect(await viewSetting(database.db, database.operatorId)).toMatchObject({ advanced_enabled: false })
  })

  it("disabling automatic never touches the flag: it stays on and the switch unlocks (ADV:48 unlock scenario)", async () => {
    await operatorReady(true)
    await operator.put(AUTOMATIC_SUBMISSION_PATH).send({ enabled: true }).expect(200)
    await operator.put(AUTOMATIC_SUBMISSION_PATH).send({ enabled: false }).expect(200)
    expect(await me(operator)).toMatchObject({ advancedEnabled: true, advancedLocked: false })
    await operator.put(ME_ADVANCED_PATH).send({ enabled: false }).expect(200)
  })

  it("UPG:53 / ADV:86 a non-Operator enabling automatic is 409 feature_not_yet_available and nothing is written", async () => {
    await gateOpen(bisiId)
    const response = await bisi.put(AUTOMATIC_SUBMISSION_PATH).send({ enabled: true })
    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({ code: "feature_not_yet_available", feature: "submission" })
    expect(await viewSetting(database.db, bisiId)).toBeUndefined()
  })
})

describe("POST /v1/me/notes/{note}/dismiss", () => {
  it("UPG:81 simpler_now clears the note, repeats as 200, and never changes the Advanced flag", async () => {
    await setViewSetting(database.db, bisiId, { advanced: false, note: true })
    const first = await bisi.post(meNoteDismissPath("simpler_now"))
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ simplerNoteDue: false, advancedEnabled: false })
    expect((await bisi.post(meNoteDismissPath("simpler_now"))).status).toBe(200)
    expect(await me(bisi)).toMatchObject({ simplerNoteDue: false })
  })

  it("improve_results records the first dismissal time and keeps it on a repeat", async () => {
    await bisi.post(meNoteDismissPath("improve_results")).expect(200)
    const first = (await viewSetting(database.db, bisiId))!.improve_list_dismissed_at
    expect(first).not.toBeNull()
    clock.set("2026-11-08T09:00:00.000Z")
    await bisi.post(meNoteDismissPath("improve_results")).expect(200)
    expect((await viewSetting(database.db, bisiId))!.improve_list_dismissed_at).toEqual(first)
    expect(await me(bisi)).toMatchObject({ improveListDismissed: true, advancedEnabled: false })
    clock.set("2026-11-07T09:00:00.000Z")
  })

  it("an unknown note is 404 not_found and writes nothing; a signed-out call is 401; a missing CSRF header is 403", async () => {
    const unknown = await bisi.post("/v1/me/notes/everything/dismiss")
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toEqual({ code: "not_found", message: "Not found." })
    expect(await viewSetting(database.db, bisiId)).toBeUndefined()
    expect((await request(app.getHttpServer()).post(meNoteDismissPath("simpler_now"))).status).toBe(401)
    expect((await request(app.getHttpServer()).post(meNoteDismissPath("simpler_now")).set("cookie", bisi.cookie)).status).toBe(403)
  })

  it("dismissing writes only the caller's row", async () => {
    await setViewSetting(database.db, database.operatorId, { advanced: true, note: true })
    await bisi.post(meNoteDismissPath("simpler_now")).expect(200)
    expect(await viewSetting(database.db, database.operatorId)).toMatchObject({ simpler_note_due: true })
  })
})

describe("RLS on candidate_view_setting (migration 0033, threat model)", () => {
  it("the runtime role sees only the bound Candidate's row, none when unbound, and cannot write another Candidate's row", async () => {
    const otherId = await insertSecondCandidate(database.db)
    await setViewSetting(database.db, database.operatorId, { advanced: true })
    await setViewSetting(database.db, otherId, { advanced: false, note: true })
    const runtime = createDatabase(database.url)
    try {
      const scoped = (id: string) =>
        runtime.transaction().execute(async (tx) => {
          await sql`select set_config('eve.candidate_id', ${id}, true)`.execute(tx)
          await sql`select public.bind_candidate(${id}::uuid)`.execute(tx)
          return (await sql<{ candidate_id: string }>`select candidate_id::text from candidate_view_setting`.execute(tx)).rows.map((r) => r.candidate_id)
        })
      expect(await scoped(database.operatorId)).toEqual([database.operatorId])
      expect(await scoped(otherId)).toEqual([otherId])
      const unbound = await runtime.transaction().execute(async (tx) => {
        await sql`select set_config('eve.candidate_id', ${otherId}, true)`.execute(tx)
        return (await sql`select candidate_id from candidate_view_setting`.execute(tx)).rows
      })
      expect(unbound).toEqual([])
      await expect(
        runtime.transaction().execute(async (tx) => {
          await sql`select set_config('eve.candidate_id', ${otherId}, true)`.execute(tx)
          await sql`select public.bind_candidate(${otherId}::uuid)`.execute(tx)
          await sql`update candidate_view_setting set advanced_enabled = true where candidate_id = ${database.operatorId}::uuid`.execute(tx)
          const rows = await sql`select 1 from candidate_view_setting where candidate_id = ${database.operatorId}::uuid and advanced_enabled = false`.execute(tx)
          if (rows.rows.length !== 0) throw new Error("rows of another Candidate were visible")
          await sql`insert into candidate_view_setting (candidate_id, updated_at) values (${database.operatorId}::uuid, now())`.execute(tx)
        })
      ).rejects.toThrow(/row-level security|duplicate key|violates/)
      expect(await viewSetting(database.db, database.operatorId)).toMatchObject({ advanced_enabled: true })
    } finally {
      await runtime.destroy()
    }
  })

  it("row-level security is enabled and forced on the table", async () => {
    const result = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'candidate_view_setting'`.execute(database.db)
    expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
  })
})

describe("D4 lock order and the activation_state / candidate_view_setting race", () => {
  it("PUT advanced=false racing PUT automatic=true never ends with automatic on and the flag off, never deadlocks, and every answer is 200 or 409", async () => {
    const outcomes: string[] = []
    for (let round = 0; round < 12; round++) {
      await sql`delete from candidate_view_setting`.execute(database.db)
      await database.db.deleteFrom("activation_state").where("candidate_id", "=", database.operatorId).execute()
      await setViewSetting(database.db, database.operatorId, { advanced: true })
      await database.db.insertInto("activation_state").values({ candidate_id: database.operatorId, gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: false, existing_applications_completed_at: new Date("2026-10-19T12:00:00Z") } as never).execute()
      const [off, on] = await Promise.all([operator.put(ME_ADVANCED_PATH).send({ enabled: false }), operator.put(AUTOMATIC_SUBMISSION_PATH).send({ enabled: true })])
      expect([200, 409], `round ${round} advanced=false: ${JSON.stringify(off.body)}`).toContain(off.status)
      expect(on.status, `round ${round} automatic=true: ${JSON.stringify(on.body)}`).toBe(200)
      const automatic = (await database.db.selectFrom("activation_state").select("automatic_enabled").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).automatic_enabled
      const flag = (await viewSetting(database.db, database.operatorId))!.advanced_enabled
      expect(automatic).toBe(true)
      expect(flag, `round ${round}`).toBe(true)
      outcomes.push(`${off.status}`)
    }
    expect(outcomes.length).toBe(12)
  })

  it("PUT advanced waits on the activation_state row lock held by a concurrent writer, then applies (the activation_state row is locked first)", async () => {
    await setViewSetting(database.db, database.operatorId, { advanced: true })
    await database.db.insertInto("activation_state").values({ candidate_id: database.operatorId, gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: false, existing_applications_completed_at: new Date("2026-10-19T12:00:00Z") } as never).execute()
    let release!: () => void
    let holderPid = 0
    const held = new Promise<void>((resolve) => {
      void database.db.transaction().execute(async (trx) => {
        holderPid = await backendPid(trx as never)
        await sql`select candidate_id from activation_state where candidate_id = ${database.operatorId}::uuid for update`.execute(trx)
        resolve()
        await new Promise<void>((done) => (release = done))
      })
    })
    await held
    const pending = operator.put(ME_ADVANCED_PATH).send({ enabled: false }).then((r) => r)
    try {
      await untilLockWait(database.db, "PUT /v1/me/advanced", "row", holderPid, 10_000)
    } finally {
      release()
    }
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.body.advancedEnabled).toBe(false)
  })
})
