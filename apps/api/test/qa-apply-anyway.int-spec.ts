import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { apiErrorResponseSchema, createApplicationResponseSchema, submissionStatusSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import * as applyAnyway from "../src/db/migrations/0025-apply-anyway.js"
import { SubmissionService } from "../src/submission/submission.service.js"
import { Browser } from "./support/browser.js"
import { FakeAtsForms, STANDARD_FORM } from "./support/fake-ats-form.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { AA_COPY, type Decision, EMPTY_TAILORED_CONTENT, INDUSTRY, RANKED, WEAK, ack, excluded, hidePosting, insertDecidedPosting, overrideColumns, redecide, statusOnly } from "./support/qa-apply-anyway-bounds.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA (apply anyway). First written for the PR #55 gate against the v1.23.0
 * unbounded override (candidate c24d4f1); updated in QA test authoring for
 * api-contract.md v1.24.0 "Apply anyway: bounds and consent" and
 * gherkin/apply-anyway.feature. Each case that asserted the superseded v1.23.0
 * behaviour now asserts the v1.24.0 one, with the Gherkin line in its name:
 * the create needs an acknowledgement, only weak-Match skips and Industry-only
 * exclusions are overridable, "anyway" marks an existing unsent Application,
 * and every posting-not-submittable drop returns the Application to documents
 * ready (no longer `not_submitted`). The detailed scenario coverage is in
 * qa-apply-anyway-bounds.int-spec.ts; this file keeps the #55 regressions.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate
let storage: string
const forms = new FakeAtsForms()
const clock = new TestClock("2026-10-20T09:00:00.000Z")
const APPLY_HOST = "boards.greenhouse.io"

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-qa-anyway-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage }, formSessions: forms, questionSchemas: forms.questionSchemas })
  candidate = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  clock.set("2026-10-20T09:00:00.000Z")
  for (const table of ["notification_outbox", "submission_event", "tailored_document", "application", "eligibility_result", "candidate_posting", "job_posting", "existing_application", "submission_day"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false, existing_applications_completed_at: null }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
  forms.use({ host: APPLY_HOST, controls: STANDARD_FORM })
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

const service = () => asOperator(app, app.get(SubmissionService))
const row = (id: string) => database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
const passGate = () => database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()

/** A visible automatic Greenhouse posting held by the Operator with `decision`. */
const posting = (company: string, decision: Decision) => insertDecidedPosting(database.db, database.operatorId, clock.now(), { company, decision })
const setDecision = (postingId: string, decision: Decision) => redecide(database.db, database.operatorId, postingId, clock.now(), decision)

/** The create as the v1.24.0 web sends it: an acknowledgement for an overridable posting, none for a ranked one. */
const create = (jobPostingId: string, decision: Decision) => candidate.post("/v1/applications").send(decision.status === "ranked" ? { jobPostingId } : { jobPostingId, acknowledgement: ack(decision) })

/** Through the real route; then documents ready and queued, as generation and the queue route leave it. */
async function queuedVia(company: string, decision: Decision) {
  const p = await posting(company, decision)
  const response = await create(p.id, decision)
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  const id = createApplicationResponseSchema.parse(response.body).application.id
  for (const kind of ["resume", "cover_letter"] as const) {
    await database.db
      .insertInto("tailored_document")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: JSON.stringify(EMPTY_TAILORED_CONTENT[kind]), pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: new Date() })
      .execute()
  }
  await database.db.updateTable("application").set({ state: "documents_ready", career_profile_version: 1, submission_state: "queued", submission_kind: "automatic" }).where("id", "=", id).execute()
  return { id, postingId: p.id, url: p.url, requisition: p.requisition }
}

/** v1.24.0 drop (AA-2.5, D8): back to documents ready, not queued (was `not_submitted` in v1.23.0). */
async function expectDroppedToDocumentsReady(id: string) {
  expect(await row(id)).toMatchObject({ state: "documents_ready", submission_state: null, submission_kind: null, queued_for_local_day: null })
}

describe("POST /v1/applications: which statuses are refused (contract v1.24.0)", () => {
  it.each(["checking", "waiting_to_be_checked", "not_checked", "evaluation_failed"] as const)("apply-anyway:142 a visible %s posting is 409 application_not_eligible with its message and creates nothing", async (status) => {
    const p = await posting("Refused Co", statusOnly(status))
    const response = await create(p.id, statusOnly(status))
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "application_not_eligible", message: AA_COPY.notEligible })
    expect(await database.db.selectFrom("application").select("id").where("job_posting_id", "=", p.id).execute()).toEqual([])
  })

  it.each([
    ["skipped", WEAK],
    ["excluded", INDUSTRY],
  ] as const)("apply-anyway:159 a hidden %s posting is 409 posting_hidden before the override checks; no override is created", async (_label, decision) => {
    const p = await posting("Hidden Co", decision)
    await hidePosting(database.db, p.id)
    const response = await create(p.id, decision)
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("posting_hidden")
    expect(await database.db.selectFrom("application").select("id").where("job_posting_id", "=", p.id).execute()).toEqual([])
  })

  it("apply-anyway:1105 a second create on a weak-skip posting with the same acknowledgement returns the first override (200, created false), still one Application", async () => {
    const p = await posting("Twice Co", WEAK)
    const first = createApplicationResponseSchema.parse((await create(p.id, WEAK).expect(201)).body)
    const second = createApplicationResponseSchema.parse((await create(p.id, WEAK).expect(200)).body)
    expect(second).toMatchObject({ created: false, application: { id: first.application.id } })
    expect(await database.db.selectFrom("application").select("id").where("job_posting_id", "=", p.id).execute()).toHaveLength(1)
  })

  it("apply-anyway:88 (was 201 under v1.23.0) an exclusion with a non-industry violated rule is 409 override_not_allowed", async () => {
    const p = await posting("Location Co", excluded("location"))
    const response = await create(p.id, excluded("location"))
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({ code: "override_not_allowed", message: AA_COPY.overrideNotAllowed })
  })
})

describe("'Prepare documents anyway' on a posting that already has an Application (#55 F-03 / CR-AA-03)", () => {
  it("apply-anyway:1046 + :1064 an Application created while ranked, its posting then weak-skipped: 'anyway' records the override on it and it is submitted", async () => {
    await passGate()
    const q = await queuedVia("Earlier Co", RANKED)
    expect((await overrideColumns(database.db, q.id)).override_created_at).toBeNull()
    await setDecision(q.postingId, WEAK)
    const again = createApplicationResponseSchema.parse((await create(q.postingId, WEAK).expect(200)).body)
    expect(again).toMatchObject({ created: false, application: { id: q.id, override: { skipReason: "weak_core_match", applies: true } } })
    expect(await overrideColumns(database.db, q.id)).toMatchObject({ override_status: "skipped", override_skip_reason: "weak_core_match" })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
  })
})

describe("a queued override when its posting's status or visibility changes", () => {
  it.each([
    ["skipped", WEAK],
    ["excluded", INDUSTRY],
  ] as const)("apply-anyway:364 a %s override whose posting becomes hidden is dropped to documents ready with no page opened", async (_label, decision) => {
    await passGate()
    const q = await queuedVia(`Hide ${decision.status}`, decision)
    await hidePosting(database.db, q.postingId)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.opened).toBe(0)
    await expectDroppedToDocumentsReady(q.id)
  })

  it("apply-anyway:329 an Industry-only override whose posting becomes evaluation_failed is dropped to documents ready", async () => {
    await passGate()
    const q = await queuedVia("Excl Failed Co", INDUSTRY)
    await setDecision(q.postingId, statusOnly("evaluation_failed"))
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.opened).toBe(0)
    await expectDroppedToDocumentsReady(q.id)
  })

  it("apply-anyway:318 an override whose posting moves skipped -> ranked is submitted and keeps its override mark", async () => {
    await passGate()
    const q = await queuedVia("Up Co", WEAK)
    await setDecision(q.postingId, RANKED)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    expect((await overrideColumns(database.db, q.id)).override_created_at).not.toBeNull()
  })

  it("apply-anyway:329 (was submitted under v1.23.0) skipped -> ranked -> excluded location: the override no longer applies and is dropped", async () => {
    await passGate()
    const q = await queuedVia("Flip Co", WEAK)
    await setDecision(q.postingId, RANKED)
    await setDecision(q.postingId, excluded("location"))
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.clicks).toEqual([])
    await expectDroppedToDocumentsReady(q.id)
  })

  it("apply-anyway:329 an override whose posting is mid re-check (checking) is dropped to documents ready", async () => {
    await passGate()
    const q = await queuedVia("Recheck Co", WEAK)
    await setDecision(q.postingId, statusOnly("checking"))
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    await expectDroppedToDocumentsReady(q.id)
  })

  it("apply-anyway:418 a no-override Application created on ranked whose posting is later weak-skipped is dropped to documents ready", async () => {
    await passGate()
    const q = await queuedVia("Plain Co", RANKED)
    await setDecision(q.postingId, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    await expectDroppedToDocumentsReady(q.id)
  })
})

describe("apply-anyway:525 @AA-2.8 every submission rule still applies to an applying override", () => {
  it("the daily cap: a 6th automatic submission that is an override is refused and carried to tomorrow, no page opened", async () => {
    await passGate()
    for (let i = 0; i < 5; i += 1) expect(await service().submit((await queuedVia(`Cap ${i}`, RANKED)).id, "automatic")).toEqual({ result: "confirmed" })
    const q = await queuedVia("Cap Override", WEAK)
    const opened = forms.opened
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "cap_reached" })
    expect(forms.opened).toBe(opened)
    expect(await row(q.id)).toMatchObject({ submission_state: "queued" })
    expect(submissionStatusSchema.parse((await candidate.get("/v1/submission/status").expect(200)).body)).toMatchObject({ todayCount: 5, queuedForTomorrow: 1 })
  })

  it("an Industry-only override counts toward the cap once confirmed", async () => {
    await passGate()
    expect(await service().submit((await queuedVia("Counted", INDUSTRY)).id, "automatic")).toEqual({ result: "confirmed" })
    expect(submissionStatusSchema.parse((await candidate.get("/v1/submission/status").expect(200)).body).todayCount).toBe(1)
  })

  it("global pause: an override starts nothing", async () => {
    await passGate()
    const q = await queuedVia("Paused Co", WEAK)
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "paused" })
    expect(forms.opened).toBe(0)
    expect((await row(q.id)).submission_state).toBe("queued")
  })

  it("cost pause: an override starts nothing", async () => {
    await passGate()
    const q = await queuedVia("Cost Co", INDUSTRY)
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "paused" })
    expect(forms.opened).toBe(0)
  })

  it("Activation Gate not passed: an override is refused and logged, no page", async () => {
    const q = await queuedVia("Gate Co", WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "gate_not_passed" })
    expect(forms.opened).toBe(0)
  })

  it("automatic submission off: the daily run submits no override", async () => {
    await passGate()
    await database.db.updateTable("activation_state").set({ automatic_enabled: false }).execute()
    await queuedVia("Off Co", WEAK)
    expect(await service().runDaily()).toEqual({ submitted: 0, carriedOver: 0, stoppedBy: "automatic_disabled" })
    expect(forms.opened).toBe(0)
  })

  it("an existing application on the same requisition refuses an override as duplicate; nothing clicked", async () => {
    await passGate()
    const q = await queuedVia("Dup Co", INDUSTRY)
    await candidate.post("/v1/existing-applications").send({ company: "Dup Co", roleTitle: "Frontend Lead", applicationUrl: q.url, requisitionId: q.requisition, appliedOn: "2026-09-30" }).expect(201)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "duplicate" })
    expect(forms.clicks).toEqual([])
  })

  it("an override at a company with an active Application is held for same-company review", async () => {
    await passGate()
    expect(await service().submit((await queuedVia("Same Co", RANKED)).id, "automatic")).toEqual({ result: "confirmed" })
    const q = await queuedVia("same co", WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "blocked" })
    expect(await row(q.id)).toMatchObject({ blocked_reason: "same_company_review" })
    expect(forms.clicks).toHaveLength(1)
  })

  it("the daily run picks up applying overrides with ranked ones and stops at the cap", async () => {
    await passGate()
    const overrides = [await queuedVia("Run Skip", WEAK), await queuedVia("Run Excl", INDUSTRY)]
    for (let i = 0; i < 4; i += 1) await queuedVia(`Run ${i}`, RANKED)
    expect(await service().runDaily()).toEqual({ submitted: 5, carriedOver: 1, stoppedBy: "cap_reached" })
    const states = await Promise.all(overrides.map(async (o) => (await row(o.id)).submission_state))
    expect(states.every((s) => s === "confirmed" || s === "queued")).toBe(true)
  })
})

describe("migration 0025-apply-anyway on existing rows (still frozen under 0026)", () => {
  it("down then up: an existing Application survives with candidate_override_at null, the column is nullable timestamptz with no default, the marker is recorded", async () => {
    const p = await posting("Legacy Co", RANKED)
    const created = createApplicationResponseSchema.parse((await create(p.id, RANKED).expect(201)).body)
    // Drive the module directly (not the Migrator), so kysely_migration is untouched.
    await applyAnyway.down(database.db as never)
    const columnsAfterDown = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_name = 'application' and column_name = 'candidate_override_at'`.execute(database.db)
    expect(columnsAfterDown.rows[0]!.n).toBe(0)
    expect(await database.db.selectFrom("application").select("id").where("id", "=", created.application.id).execute()).toHaveLength(1)
    await applyAnyway.up(database.db as never)
    const column = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
      select is_nullable, data_type, column_default from information_schema.columns where table_name = 'application' and column_name = 'candidate_override_at'`.execute(database.db)
    expect(column.rows).toEqual([{ is_nullable: "YES", data_type: "timestamp with time zone", column_default: null }])
    expect((await row(created.application.id)).candidate_override_at).toBeNull()
    const marker = await sql<{ n: number }>`select count(*)::int as n from migration_marker where name = '0025-apply-anyway'`.execute(database.db)
    expect(marker.rows[0]!.n).toBe(1)
    // The runtime role can still record an override after the re-add.
    const q = await posting("After Up Co", INDUSTRY)
    expect((await create(q.id, INDUSTRY)).status).toBe(201)
  })
})
