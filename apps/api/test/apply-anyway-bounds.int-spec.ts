import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import {
  APPLY_ANYWAY_ERROR_MESSAGES,
  DELETE_DETAILS_PATH,
  type OverrideDecision,
  apiErrorResponseSchema,
  applicationDetailSchema,
  applicationsResponseSchema,
  createApplicationResponseSchema,
  jobPostingDetailSchema,
  removeFromQueuePath,
  sampleResultSchema,
  submissionListResponseSchema,
  submissionSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import * as bounds from "../src/db/migrations/0026-apply-anyway-bounds.js"
import { NotificationRepository } from "../src/notification/notification.repository.js"
import { SampleService } from "../src/submission/sample.service.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { SubmissionService } from "../src/submission/submission.service.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor, setCandidatePosting } from "./support/candidate-posting.js"
import { FakeAtsForms, STANDARD_FORM } from "./support/fake-ats-form.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * Backend author tests for api-contract.md v1.24.0 "Apply anyway: bounds and
 * consent" against the real api app and Postgres (the browser is the in-process
 * fake ATS form). Each case names its Gherkin line in apply-anyway.feature.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate
let anonymous: Browser
let storage: string
const forms = new FakeAtsForms()
const clock = new TestClock("2026-10-29T09:00:00.000Z")
const APPLY_HOST = "boards.greenhouse.io"

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-aa-bounds-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage }, formSessions: forms, questionSchemas: forms.questionSchemas })
  candidate = await signInCandidate(new Browser(app, google))
  anonymous = new Browser(app, google)
})

beforeEach(async () => {
  clock.set("2026-10-29T09:00:00.000Z")
  for (const table of ["notification_outbox", "submission_event", "application_form_read", "tailored_document", "application", "eligibility_result", "candidate_posting", "job_posting", "submission_day"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
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

type State = Readonly<{ status: "ranked" | "skipped" | "excluded" | "checking" | "waiting_to_be_checked" | "not_checked" | "evaluation_failed"; skipReason?: string | null; skipDetail?: string | null; violated?: readonly string[]; evaluationFailure?: string | null; applyMode?: "automatic" | "manual" }>

const WEAK: State = { status: "skipped", skipReason: "weak_core_match" }
const INDUSTRY: State = { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violated: ["industry"] }
const decisionOf = (state: State): OverrideDecision => ({
  status: state.status,
  skipReason: (state.skipReason ?? null) as OverrideDecision["skipReason"],
  skipDetail: state.skipDetail ?? null,
  violatedRules: [...(state.violated ?? [])],
})

/** EPIC-0002 B1 (merge with main 0422b14): a relocation to the United States gives the sponsorship answer its role location. */
async function setEligibility(postingId: string, violated: readonly string[], unverified: readonly string[] = []) {
  await database.db.deleteFrom("eligibility_result").where("job_posting_id", "=", postingId).execute()
  const names = [...new Set(["location", "sponsorship", "pay", "hours", "industry", ...violated, ...unverified])]
  const rules = names.map((rule) => ({ rule, result: violated.includes(rule) ? "violated" : unverified.includes(rule) ? "unverified" : "met", quote: null }))
  await database.db
    .insertInto("eligibility_result")
    .values({ candidate_id: database.operatorId, job_posting_id: postingId, arrangement: "relocation", relocation_country: "United States", employment_type: "direct", rules: JSON.stringify(rules), eligible: violated.length === 0, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: clock.now() })
    .execute()
}

/** A visible automatic posting held by the Operator in `state`. */
async function posting(state: State, company = `Co ${randomUUID().slice(0, 6)}`, requisition = `R-${randomUUID().slice(0, 6)}`) {
  const id = randomUUID()
  const url = `https://${APPLY_HOST}/${company.toLowerCase().replace(/\W+/g, "")}/jobs/${requisition}`
  await insertPostingFor(database.db, database.operatorId, {
    id,
    application_url: url,
    requisition_id: requisition,
    apply_url: url,
    application_system: "greenhouse",
    apply_mode: state.applyMode ?? "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Senior Frontend Engineer",
    company,
    posting_text: "Remote, open to candidates in Nigeria.",
    status: state.status,
    skip_reason: state.skipReason ?? null,
    skip_detail: state.skipDetail ?? null,
    evaluation_failure: state.evaluationFailure ?? null,
    role_family: "senior_frontend",
    discovered_at: clock.now(),
    evaluated_at: clock.now(),
  })
  // EPIC-0002 B1 (merge with main 0422b14): always an Eligibility row, so the sponsorship answer has its role location.
  await setEligibility(id, state.violated ?? [])
  return { id, company, requisition }
}

async function setState(postingId: string, state: State) {
  await setCandidatePosting(database.db, database.operatorId, postingId, { status: state.status, skip_reason: state.skipReason ?? null, skip_detail: state.skipDetail ?? null, evaluation_failure: state.evaluationFailure ?? null })
  await setEligibility(postingId, state.violated ?? [])
}

const hide = (postingId: string) => database.db.updateTable("job_posting").set({ posted_at: new Date("2026-08-01T09:00:00Z") }).where("id", "=", postingId).execute()
const ack = (decision: OverrideDecision) => ({ confirmed: true, decision })
const create = (jobPostingId: string, acknowledgement?: unknown) => candidate.post("/v1/applications").send(acknowledgement === undefined ? { jobPostingId } : { jobPostingId, acknowledgement })
const detail = async (postingId: string) => jobPostingDetailSchema.parse((await candidate.get(`/v1/job-postings/${postingId}`).expect(200)).body)
const row = (id: string) => database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
const appsFor = (postingId: string) => database.db.selectFrom("application").select("id").where("job_posting_id", "=", postingId).execute()
const events = (id: string) => database.db.selectFrom("submission_event").select(["kind", "detail"]).where("application_id", "=", id).orderBy("created_at").execute()
const service = () => asOperator(app, app.get(SubmissionService))
const repo = () => asOperator(app, app.get(SubmissionRepository))
const error = (body: unknown) => apiErrorResponseSchema.parse(body).error

const EMPTY_CONTENT = {
  resume: { kind: "resume", summary: [], experience: [], skills: [], education: [] },
  cover_letter: { kind: "cover_letter", greeting: "Dear team,", opening: null, paragraphs: [], closingLine: null, closing: "Regards," },
} as const

/** Creates through the real route (with the acknowledgement from the posting detail) and readies documents. */
async function readyVia(state: State, extra: Partial<{ submission_state: "queued"; submission_kind: "automatic" }> = {}) {
  const p = await posting(state)
  const offered = (await detail(p.id)).applyAnyway
  const response = await create(p.id, offered ? ack(offered.decision) : undefined)
  expect(response.status).toBe(201)
  const id = createApplicationResponseSchema.parse(response.body).application.id
  for (const kind of ["resume", "cover_letter"] as const) {
    await database.db
      .insertInto("tailored_document")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: JSON.stringify(EMPTY_CONTENT[kind]), pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: clock.now() })
      .execute()
  }
  await database.db.updateTable("application").set({ state: "documents_ready", career_profile_version: 1, ...extra }).where("id", "=", id).execute()
  return { id, postingId: p.id, company: p.company, requisition: p.requisition }
}
const queuedVia = (state: State) => readyVia(state, { submission_state: "queued", submission_kind: "automatic" })

describe("GET /v1/job-postings/{id}: applyAnyway and applicationId (AA-1.1, AA-1.4, AA-6)", () => {
  it(":44 an overridable posting offers the action with its current decision; :78 unverified rules are not violations", async () => {
    const weak = await posting(WEAK)
    expect(await detail(weak.id)).toMatchObject({ applyAnyway: { offered: true, decision: decisionOf(WEAK) }, applicationId: null })
    const industry = await posting(INDUSTRY)
    await setEligibility(industry.id, ["industry"], ["pay", "hours"])
    expect((await detail(industry.id)).applyAnyway).toEqual({ offered: true, decision: { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"] } })
  })

  it(":110 a stored rule unknown to the check (commute) beside industry: the detail parses, applyAnyway null, create 409 override_not_allowed", async () => {
    const state: State = { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violated: ["industry", "commute"] }
    const p = await posting(state)
    const body = await detail(p.id)
    expect(body.applyAnyway).toBeNull()
    expect(body.eligibility?.rules.map((rule) => rule.rule)).not.toContain("commute")
    expect(error((await create(p.id, ack(decisionOf(state)))).body).code).toBe("override_not_allowed")
  })

  it.each([
    ["ranked", { status: "ranked" } as State],
    ["excluded location", { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violated: ["location"] } as State],
    ["excluded industry and location", { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violated: ["location", "industry"] } as State],
    ["technology_mismatch", { status: "skipped", skipReason: "technology_mismatch" } as State],
    ["checking", { status: "checking" } as State],
    ["not_checked", { status: "not_checked" } as State],
  ])(":88 :120 :142 %s offers nothing", async (_name, state) => {
    expect((await detail((await posting(state)).id)).applyAnyway).toBeNull()
  })

  it(":159 a hidden overridable posting offers nothing", async () => {
    const p = await posting(WEAK)
    await hide(p.id)
    expect((await detail(p.id)).applyAnyway).toBeNull()
  })

  it(":1097 a ranked posting with an Application: applyAnyway null, applicationId set; :1074 an Application past the queue offers nothing", async () => {
    const ready = await readyVia({ status: "ranked" })
    expect(await detail(ready.postingId)).toMatchObject({ applyAnyway: null, applicationId: ready.id })
    await setState(ready.postingId, WEAK)
    expect((await detail(ready.postingId)).applyAnyway).toMatchObject({ offered: true })
    await database.db.updateTable("application").set({ submission_state: "confirmed", submission_kind: "automatic", confirmed_at: clock.now(), submit_clicked_at: clock.now() }).where("id", "=", ready.id).execute()
    expect(await detail(ready.postingId)).toMatchObject({ applyAnyway: null, applicationId: ready.id })
  })
})

describe("POST /v1/applications: order of checks (AA-1, AA-2.1, AA-7.3)", () => {
  it(":59 :274 confirming creates one Application storing the time and decision from the locked read", async () => {
    clock.set("2026-10-29T09:00:00.000Z")
    const p = await posting(INDUSTRY)
    const response = await create(p.id, ack(decisionOf(INDUSTRY)))
    expect(response.status).toBe(201)
    const created = createApplicationResponseSchema.parse(response.body)
    expect(created.application.override).toEqual({ createdAt: "2026-10-29T09:00:00.000Z", ...decisionOf(INDUSTRY), applies: true, notAppliesReason: null })
    expect(await row(created.application.id)).toMatchObject({ state: "prepared", override_created_at: new Date("2026-10-29T09:00:00.000Z"), override_status: "excluded", override_skip_reason: "violated_rule", override_skip_detail: "industry", override_violated_rules: ["industry"], candidate_override_at: null })
  })

  it(":185 the override never changes the posting's status, reason or rank", async () => {
    const p = await posting(WEAK)
    const before = await database.db.selectFrom("candidate_posting").selectAll().where("job_posting_id", "=", p.id).executeTakeFirstOrThrow()
    expect((await create(p.id, ack(decisionOf(WEAK)))).status).toBe(201)
    expect(await database.db.selectFrom("candidate_posting").selectAll().where("job_posting_id", "=", p.id).executeTakeFirstOrThrow()).toEqual(before)
  })

  it.each([
    ["location", ["location"]],
    ["pay", ["pay"]],
    ["hours", ["hours"]],
    ["sponsorship", ["sponsorship"]],
    ["industry plus location", ["location", "industry"]],
    ["commute (unknown to the check)", ["commute"]],
  ] as const)(":88 :110 an exclusion with %s is 409 override_not_allowed, even with a matching acknowledgement", async (_name, violated) => {
    const state: State = { status: "excluded", skipReason: "violated_rule", skipDetail: violated[0], violated }
    const p = await posting(state)
    const response = await create(p.id, ack(decisionOf(state)))
    expect(response.status).toBe(409)
    expect(error(response.body)).toEqual({ code: "override_not_allowed", message: APPLY_ANYWAY_ERROR_MESSAGES.override_not_allowed })
    expect(await appsFor(p.id)).toEqual([])
  })

  it(":120 a technology_mismatch skip is 409 override_not_allowed", async () => {
    const p = await posting({ status: "skipped", skipReason: "technology_mismatch" })
    expect(error((await create(p.id, ack(decisionOf(WEAK)))).body).code).toBe("override_not_allowed")
  })

  it(":120 v1.28.0 (owner decision 2026-11-10) an unsupported_application_system skip prepares a manual application", async () => {
    // The manual lane: nothing about the Match is overridden; Eve cannot submit here, so the documents
    // are prepared and the posting stays manual (the submission layer refuses to queue or send it).
    const state: State = { status: "skipped", skipReason: "unsupported_application_system", skipDetail: "We Work Remotely", applyMode: "manual" }
    const p = await posting(state)
    const response = await create(p.id, ack(decisionOf(state)))
    expect(response.status).toBe(201)
    expect((await appsFor(p.id)).length).toBe(1)
  })

  it(":135 a not_software_role posting is hidden: 409 posting_hidden", async () => {
    const p = await posting({ status: "skipped", skipReason: "not_software_role" })
    await database.db.updateTable("job_posting").set({ prefilter_skip: "not_software_role", role_family: null }).where("id", "=", p.id).execute()
    expect(error((await create(p.id, ack(decisionOf(WEAK)))).body).code).toBe("posting_hidden")
  })

  it.each(["checking", "waiting_to_be_checked", "not_checked", "evaluation_failed"] as const)(":142 a %s posting is 409 application_not_eligible", async (status) => {
    const p = await posting({ status })
    const response = await create(p.id, ack(decisionOf(WEAK)))
    expect(response.status).toBe(409)
    expect(error(response.body).code).toBe("application_not_eligible")
  })

  it(":159 a hidden overridable posting is posting_hidden before the override checks", async () => {
    const p = await posting(WEAK)
    await hide(p.id)
    expect(error((await create(p.id, ack(decisionOf(WEAK)))).body).code).toBe("posting_hidden")
  })

  it(":167 refusing an override leaves an existing Application unchanged", async () => {
    const ready = await readyVia({ status: "ranked" })
    const location: State = { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violated: ["location"] }
    await setState(ready.postingId, location)
    const before = await row(ready.id)
    expect(error((await create(ready.postingId, ack(decisionOf(location)))).body).code).toBe("override_not_allowed")
    expect(await row(ready.id)).toEqual(before)
  })

  it(":176 a claimed overridable decision on a non-overridable posting is override_not_allowed, not decision_changed", async () => {
    const p = await posting({ status: "excluded", skipReason: "violated_rule", skipDetail: "location", violated: ["location"] })
    expect(error((await create(p.id, ack(decisionOf(INDUSTRY)))).body).code).toBe("override_not_allowed")
  })

  it(":194 a ranked posting creates a normal Application with no acknowledgement; the acknowledgement is ignored", async () => {
    const p = await posting({ status: "ranked" })
    const created = createApplicationResponseSchema.parse((await create(p.id, ack(decisionOf(WEAK))).expect(201)).body)
    expect(created.application.override).toBeNull()
  })

  it.each([
    [":209 skipped", WEAK],
    [":216 Industry-only excluded", INDUSTRY],
  ])("%s without an acknowledgement is 409 override_acknowledgement_missing", async (_name, state) => {
    const p = await posting(state)
    const response = await create(p.id)
    expect(error(response.body)).toEqual({ code: "override_acknowledgement_missing", message: APPLY_ANYWAY_ERROR_MESSAGES.override_acknowledgement_missing })
    expect(await appsFor(p.id)).toEqual([])
    expect(error((await create(p.id, null)).body).code).toBe("override_acknowledgement_missing")
  })

  it.each([
    ["another skip reason", { ...decisionOf(WEAK), skipReason: "no_core_responsibilities" }],
    ["another status", { ...decisionOf(WEAK), status: "excluded" }],
    ["another detail", { ...decisionOf(WEAK), skipDetail: "x" }],
    ["a well-formed but wrong status", { ...decisionOf(WEAK), status: "checking" }],
  ] as const)(":223 an acknowledgement with %s is 409 override_decision_changed", async (_name, decision) => {
    const p = await posting(WEAK)
    const response = await create(p.id, ack(decision as OverrideDecision))
    expect(error(response.body)).toEqual({ code: "override_decision_changed", message: APPLY_ANYWAY_ERROR_MESSAGES.override_decision_changed })
    expect(await appsFor(p.id)).toEqual([])
  })

  it(":237 a different violated rule set is decision_changed; rule order does not matter", async () => {
    const p = await posting(INDUSTRY)
    expect(error((await create(p.id, ack({ ...decisionOf(INDUSTRY), violatedRules: ["industry", "pay"] }))).body).code).toBe("override_decision_changed")
  })

  it(":255 :263 after a refused change the new decision is accepted; a posting now ranked answers with override null", async () => {
    const p = await posting(WEAK)
    await setState(p.id, { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance" })
    expect(error((await create(p.id, ack(decisionOf(WEAK)))).body).code).toBe("override_decision_changed")
    const fresh = (await detail(p.id)).applyAnyway!.decision
    expect(createApplicationResponseSchema.parse((await create(p.id, ack(fresh)).expect(201)).body).application.override).toMatchObject({ skipDetail: "Active security clearance" })
    const r = await posting(WEAK)
    await setState(r.id, { status: "ranked" })
    expect(createApplicationResponseSchema.parse((await create(r.id, ack(decisionOf(WEAK))).expect(201)).body).application.override).toBeNull()
  })

  it("a malformed acknowledgement is 400 and nothing changes", async () => {
    const p = await posting(WEAK)
    for (const bad of [{ confirmed: false, decision: decisionOf(WEAK) }, { confirmed: true }, { confirmed: true, decision: { ...decisionOf(WEAK), extra: 1 } }, { confirmed: true, decision: { ...decisionOf(WEAK), violatedRules: ["Bad Rule"] } }]) {
      expect((await create(p.id, bad)).status).toBe(400)
    }
    expect(await appsFor(p.id)).toEqual([])
  })

  it(":1195 unauthenticated: 401, nothing created", async () => {
    const p = await posting(WEAK)
    expect((await anonymous.http().post("/v1/applications").send({ jobPostingId: p.id, acknowledgement: ack(decisionOf(WEAK)) })).status).toBe(401)
    expect(await appsFor(p.id)).toEqual([])
  })
})

describe("'anyway' on a posting that already has an Application (AA-6)", () => {
  it.each([
    ["documents ready, created while ranked", {}],
    ["queued, created while ranked", { submission_state: "queued", submission_kind: "automatic" }],
    ["documents ready, legacy override", { candidate_override_at: new Date("2026-10-28T11:00:00Z") }],
    ["queued for tomorrow, stale override", { submission_state: "queued", submission_kind: "automatic", queued_for_local_day: "2026-10-30", override_created_at: new Date("2026-10-27T09:00:00Z"), override_status: "skipped", override_skip_reason: "no_core_responsibilities", override_violated_rules: [] }],
  ] as const)(":1046 marks an existing unsent Application (%s); documents and submission state unchanged", async (_name, existing) => {
    const ready = await readyVia({ status: "ranked" })
    if (Object.keys(existing).length > 0) await database.db.updateTable("application").set(existing as never).where("id", "=", ready.id).execute()
    await setState(ready.postingId, WEAK)
    const before = await row(ready.id)
    const response = await create(ready.postingId, ack(decisionOf(WEAK)))
    expect(response.status).toBe(200)
    expect(createApplicationResponseSchema.parse(response.body)).toMatchObject({ created: false, application: { id: ready.id, override: { status: "skipped", skipReason: "weak_core_match", applies: true } } })
    const after = await row(ready.id)
    expect(after).toMatchObject({ override_status: "skipped", override_skip_reason: "weak_core_match", override_created_at: clock.now(), candidate_override_at: null })
    for (const key of ["state", "submission_state", "queued_for_local_day", "attempt_number", "career_profile_version"] as const) expect(after[key]).toEqual(before[key])
    expect(await appsFor(ready.postingId)).toHaveLength(1)
  })

  it.each([
    ["claimed", { submission_state: "submit_claimed", submission_kind: "automatic", attempt_id: randomUUID() }],
    ["submitting", { submission_state: "submitting", submission_kind: "automatic", attempt_id: randomUUID(), submit_clicked_at: new Date() }],
    ["confirmed", { submission_state: "confirmed", submission_kind: "automatic", confirmed_at: new Date(), submit_clicked_at: new Date() }],
    ["uncertain", { submission_state: "uncertain", submission_kind: "automatic", submit_clicked_at: new Date() }],
    ["blocked", { submission_state: "blocked", submission_kind: "automatic", blocked_reason: "login", blocked_at: new Date() }],
    ["manual", { submission_state: "manual", submission_kind: "automatic", manual_completed_at: new Date() }],
    ["not submitted", { submission_state: "not_submitted", submission_kind: "automatic" }],
    ["declined", { submission_state: "declined", submission_kind: "automatic", declined_reason: "x", declined_at: new Date() }],
    ["a sample awaiting review", { sample_state: "awaiting_review" }],
    ["a minimal record", { details_deleted_at: new Date(), details_deleted_by: "candidate", final_status: "documents_ready" }],
  ] as const)(":1074 an existing Application that is %s blocks the override: 409 override_application_state, unchanged", async (_name, existing) => {
    const ready = await readyVia({ status: "ranked" })
    await database.db.updateTable("application").set(existing as never).where("id", "=", ready.id).execute()
    await setState(ready.postingId, WEAK)
    expect((await detail(ready.postingId)).applyAnyway).toBeNull()
    const before = await row(ready.id)
    const response = await create(ready.postingId, ack(decisionOf(WEAK)))
    expect(error(response.body)).toEqual({ code: "override_application_state", message: APPLY_ANYWAY_ERROR_MESSAGES.override_application_state })
    expect(await row(ready.id)).toEqual(before)
  })

  it(":1105 pressing twice keeps one Application and the first override time; :459 deciding again replaces it", async () => {
    clock.set("2026-10-27T09:00:00.000Z")
    const p = await posting(WEAK)
    const first = createApplicationResponseSchema.parse((await create(p.id, ack(decisionOf(WEAK))).expect(201)).body)
    clock.set("2026-10-29T10:00:00.000Z")
    await create(p.id, ack(decisionOf(WEAK))).expect(200)
    expect((await row(first.application.id)).override_created_at).toEqual(new Date("2026-10-27T09:00:00.000Z"))
    await setState(p.id, INDUSTRY)
    const again = createApplicationResponseSchema.parse((await create(p.id, ack(decisionOf(INDUSTRY))).expect(200)).body)
    expect(again.application.override).toMatchObject({ createdAt: "2026-10-29T10:00:00.000Z", ...decisionOf(INDUSTRY), applies: true })
    expect(await appsFor(p.id)).toHaveLength(1)
  })
})

describe("override on reads: applies, notAppliesReason, posting, latestDrop (AA-4.3, AA-4.5)", () => {
  it(":283 the override follows the current decision on the detail, list and Submission", async () => {
    const prerequisite: State = { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Professional Kotlin Android experience" }
    const ready = await readyVia(prerequisite)
    const read = async () => applicationDetailSchema.parse((await candidate.get(`/v1/applications/${ready.id}`).expect(200)).body)
    expect(await read()).toMatchObject({ override: { applies: true, notAppliesReason: null }, posting: { status: "skipped", hidden: false }, latestDrop: null })
    await setState(ready.postingId, { status: "skipped", skipReason: "weak_core_match" })
    expect((await read()).override).toMatchObject({ applies: false, notAppliesReason: "decision_changed" })
    await setState(ready.postingId, { status: "not_checked" })
    expect((await read()).override).toMatchObject({ applies: false, notAppliesReason: "decision_changed" })
    await setState(ready.postingId, { status: "ranked" })
    expect((await read()).override).toMatchObject({ applies: true, notAppliesReason: null })
    await hide(ready.postingId)
    const hidden = await read()
    expect(hidden).toMatchObject({ override: { applies: false, notAppliesReason: "hidden" }, posting: { status: "ranked", hidden: true } })
    const listed = applicationsResponseSchema.parse((await candidate.get("/v1/applications").expect(200)).body).applications.find((app) => app.id === ready.id)
    expect(listed?.override).toEqual(hidden.override)
    expect(submissionSchema.parse((await candidate.get(`/v1/applications/${ready.id}/submission`).expect(200)).body).override).toEqual(hidden.override)
  })

  it(":471 :488 a legacy override has no decision and applies only on a visible ranked posting", async () => {
    const ready = await readyVia({ status: "ranked" })
    await database.db.updateTable("application").set({ candidate_override_at: new Date("2026-10-28T11:00:00Z") }).where("id", "=", ready.id).execute()
    const read = async () => applicationDetailSchema.parse((await candidate.get(`/v1/applications/${ready.id}`).expect(200)).body).override
    expect(await read()).toEqual({ createdAt: "2026-10-28T11:00:00.000Z", status: null, skipReason: null, skipDetail: null, violatedRules: null, applies: true, notAppliesReason: null })
    await setState(ready.postingId, WEAK)
    expect(await read()).toMatchObject({ applies: false, notAppliesReason: "legacy_no_decision" })
  })

  it(":705 :712 :720 override on both schemas and every list; null with no override", async () => {
    const plain = await readyVia({ status: "ranked" })
    const marked = await readyVia(WEAK)
    for (const id of [plain.id, marked.id]) await database.db.updateTable("application").set({ submission_state: "blocked", submission_kind: "automatic", blocked_reason: "login", blocked_at: clock.now() }).where("id", "=", id).execute()
    const rows = submissionListResponseSchema.parse((await candidate.get("/v1/submissions?view=blocked").expect(200)).body).rows
    expect(rows.find((r) => r.application.id === plain.id)).toMatchObject({ application: { override: null }, submission: { override: null } })
    expect(rows.find((r) => r.application.id === marked.id)).toMatchObject({ application: { override: { status: "skipped" } }, submission: { override: { status: "skipped" } } })
  })

  it("latestDrop: a drop after the override shows; a removal after it hides it", async () => {
    const q = await queuedVia({ status: "ranked" })
    await setState(q.postingId, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    const read = async () => applicationDetailSchema.parse((await candidate.get(`/v1/applications/${q.id}`).expect(200)).body)
    expect((await read()).latestDrop).toEqual({ at: clock.now().toISOString(), reason: "not_submittable" })
    await database.db.updateTable("application").set({ submission_state: "queued", submission_kind: "automatic" }).where("id", "=", q.id).execute()
    clock.set("2026-10-29T09:05:00.000Z")
    await candidate.post(removeFromQueuePath(q.id)).expect(200)
    expect((await read()).latestDrop).toBeNull()
  })
})

describe("automatic submission: the three checks (AA-2.3 to AA-2.6, D8)", () => {
  it(":306 a queued override whose decision still matches passes all three checks and is submitted", async () => {
    const q = await queuedVia(INDUSTRY)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    expect(forms.clicks).toHaveLength(1)
  })

  it(":318 a posting that becomes ranked is submitted as ranked", async () => {
    const q = await queuedVia(WEAK)
    await setState(q.postingId, { status: "ranked" })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
  })

  it.each([
    ["uncovered_mandatory_prerequisite", { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "x" } as State],
    ["excluded location", { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violated: ["location"] } as State],
    ["evaluation_failed", { status: "evaluation_failed", evaluationFailure: "provider_error" } as State],
  ])(":329 at the claim (%s before the claim): dropped, returns to documents ready, cap unchanged", async (_name, state) => {
    const q = await queuedVia(WEAK)
    await setState(q.postingId, state)
    expect(await asOperator(app, app.get(SubmissionRepository)).claim(q.id, "automatic", "2026-10-29", clock.now())).toEqual({ refused: "posting_closed" })
    expect(await row(q.id)).toMatchObject({ submission_state: null, submission_kind: null, state: "documents_ready", queued_for_local_day: null, override_skip_reason: "weak_core_match" })
    expect(await events(q.id)).toEqual([{ kind: "queued_posting_dropped", detail: "override_mismatch" }])
    expect(await repo().countForDay("2026-10-29")).toBe(0)
  })

  it.each([
    ["no_core_responsibilities", { status: "skipped", skipReason: "no_core_responsibilities" } as State],
    ["excluded industry", INDUSTRY],
    ["checking", { status: "checking" } as State],
  ])(":329 at the pre-attempt check (%s): dropped before any page opens", async (_name, state) => {
    const q = await queuedVia(WEAK)
    await setState(q.postingId, state)
    expect(await repo().dropQueuedUnlessRanked(q.id, clock.now())).toBe(true)
    expect(forms.opened).toBe(0)
    expect(await row(q.id)).toMatchObject({ submission_state: null, state: "documents_ready" })
    expect(await events(q.id)).toEqual([{ kind: "queued_posting_dropped", detail: "override_mismatch" }])
  })

  it.each([
    ["uncovered_mandatory_prerequisite", { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "x" } as State],
    ["excluded hours", { status: "excluded", skipReason: "violated_rule", skipDetail: "hours", violated: ["hours"] } as State],
    ["evaluation_failed", { status: "evaluation_failed", evaluationFailure: "provider_error" } as State],
  ])(":329 :405 at the pre-click check (%s while the form is filled): no click, documents ready, the cap slot freed", async (_name, state) => {
    const q = await queuedVia(WEAK)
    let changed = false
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, onFill: async () => void (changed || ((changed = true), await setState(q.postingId, state))) })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.clicks).toEqual([])
    expect(await row(q.id)).toMatchObject({ submission_state: null, state: "documents_ready", attempt_id: null, submitted_local_day: null, attempt_number: 0 })
    expect((await events(q.id)).filter((e) => e.kind === "queued_posting_dropped")).toEqual([{ kind: "queued_posting_dropped", detail: "override_mismatch" }])
    expect(await repo().countForDay("2026-10-29")).toBe(0)
  })

  it(":354 an Industry-only override is dropped when another violated rule is added", async () => {
    const q = await queuedVia(INDUSTRY)
    await setState(q.postingId, { ...INDUSTRY, violated: ["industry", "location"] })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.clicks).toEqual([])
  })

  it(":364 an override whose posting becomes hidden is dropped with detail hidden", async () => {
    const q = await queuedVia(WEAK)
    await hide(q.postingId)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(await events(q.id)).toEqual([{ kind: "queued_posting_dropped", detail: "hidden" }])
  })

  it(":376 :449 ranked, then another reason, then the overridden reason: comparison, not a latch", async () => {
    const q = await queuedVia(WEAK)
    await setState(q.postingId, { status: "skipped", skipReason: "technology_mismatch" })
    await setState(q.postingId, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
  })

  it(":392 a dropped override keeps documents, answers and the override record", async () => {
    const q = await queuedVia(WEAK)
    await database.db.insertInto("application_form_read").values({ candidate_id: database.operatorId, application_id: q.id, host: APPLY_HOST, controls: JSON.stringify([]), read_at: clock.now() }).execute()
    await setState(q.postingId, { status: "excluded", skipReason: "violated_rule", skipDetail: "pay", violated: ["pay"] })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(await database.db.selectFrom("tailored_document").select("kind").where("application_id", "=", q.id).execute()).toHaveLength(2)
    expect(await database.db.selectFrom("application_form_read").select("host").where("application_id", "=", q.id).execute()).toHaveLength(1)
    expect((await row(q.id)).override_skip_reason).toBe("weak_core_match")
  })

  it.each([
    ["closed", { status: "evaluation_failed", evaluationFailure: "posting_unavailable" } as State, "closed"],
    ["skipped by a save", WEAK, "not_ranked"],
    ["technology_mismatch", { status: "skipped", skipReason: "technology_mismatch" } as State, "not_ranked"],
    ["excluded hours", { status: "excluded", skipReason: "violated_rule", skipDetail: "hours", violated: ["hours"] } as State, "not_ranked"],
    ["checking at claim time", { status: "checking" } as State, "not_ranked"],
  ])(":418 a queued Application with no override whose posting is %s returns to documents ready", async (_name, state, detailValue) => {
    const q = await queuedVia({ status: "ranked" })
    await setState(q.postingId, state)
    expect(await asOperator(app, app.get(SubmissionRepository)).claim(q.id, "automatic", "2026-10-29", clock.now())).toEqual({ refused: "posting_closed" })
    expect(await row(q.id)).toMatchObject({ submission_state: null, state: "documents_ready" })
    expect(await events(q.id)).toEqual([{ kind: "queued_posting_dropped", detail: detailValue }])
  })

  it(":418 aged past 60 days: hidden, dropped with detail hidden; :439 a dropped Application can be decided again", async () => {
    const q = await queuedVia({ status: "ranked" })
    await hide(q.postingId)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(await events(q.id)).toEqual([{ kind: "queued_posting_dropped", detail: "hidden" }])
    const r = await queuedVia(WEAK)
    await setState(r.postingId, { status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Active security clearance" })
    expect(await service().submit(r.id, "automatic")).toMatchObject({ refusal: "posting_closed" })
    expect((await detail(r.postingId)).applyAnyway).toMatchObject({ offered: true, decision: { skipDetail: "Active security clearance" } })
  })

  it(":496 a queued legacy override is dropped at the next check; :1064 marking it by 'anyway' makes it sendable", async () => {
    const q = await queuedVia({ status: "ranked" })
    await database.db.updateTable("application").set({ candidate_override_at: new Date("2026-10-28T11:00:00Z") }).where("id", "=", q.id).execute()
    await setState(q.postingId, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    await database.db.updateTable("application").set({ submission_state: "queued", submission_kind: "automatic" }).where("id", "=", q.id).execute()
    await create(q.postingId, ack(decisionOf(WEAK))).expect(200)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
  })
})

describe("Activation Gate samples (AA-3)", () => {
  beforeEach(async () => {
    await database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false }).execute()
  })

  it(":547 an Application with an override (applying or legacy) cannot be made a sample: 409 sample_not_allowed", async () => {
    const marked = await readyVia(WEAK)
    let response = await candidate.post(`/v1/applications/${marked.id}/sample`)
    expect(error(response.body)).toEqual({ code: "sample_not_allowed", message: APPLY_ANYWAY_ERROR_MESSAGES.sample_not_allowed })
    const legacy = await readyVia({ status: "ranked" })
    await database.db.updateTable("application").set({ candidate_override_at: new Date() }).where("id", "=", legacy.id).execute()
    response = await candidate.post(`/v1/applications/${legacy.id}/sample`)
    expect(error(response.body).code).toBe("sample_not_allowed")
    expect((await row(legacy.id)).sample_state).toBeNull()
  })

  it(":565 a posting not ranked cannot be a sample; :580 ranked with no override still can", async () => {
    const ready = await readyVia({ status: "ranked" })
    await setState(ready.postingId, { status: "checking" })
    expect(error((await candidate.post(`/v1/applications/${ready.id}/sample`)).body).code).toBe("sample_not_allowed")
    await setState(ready.postingId, { status: "ranked" })
    expect(submissionSchema.parse((await candidate.post(`/v1/applications/${ready.id}/sample`).expect(200)).body).sample).toMatchObject({ state: "awaiting_review" })
  })

  it(":588 :599 :616 approval answers excluded, not_ranked or not_allowed, sends nothing and does not count", async () => {
    const cases = [
      [INDUSTRY, null, "excluded"],
      [WEAK, null, "not_ranked"],
      [{ status: "ranked" } as State, new Date(), "not_allowed"],
    ] as const
    for (const [state, legacy, result] of cases) {
      const ready = await readyVia({ status: "ranked" })
      await candidate.post(`/v1/applications/${ready.id}/sample`).expect(200)
      if (legacy) await database.db.updateTable("application").set({ candidate_override_at: legacy }).where("id", "=", ready.id).execute()
      await setState(ready.postingId, state)
      const first = sampleResultSchema.parse((await candidate.post(`/v1/applications/${ready.id}/sample/approve`).expect(200)).body)
      expect(first).toMatchObject({ result, alreadyDone: false, countingSamples: 0 })
      expect(await row(ready.id)).toMatchObject({ sample_state: "approved", submission_state: "not_submitted", submission_kind: "sample", sample_counts: false })
      expect(sampleResultSchema.parse((await candidate.post(`/v1/applications/${ready.id}/sample/approve`).expect(200)).body)).toMatchObject({ result, alreadyDone: true })
    }
    expect(forms.opened).toBe(0)
  })

  it(":637 preparing samples skips an Application with an override", async () => {
    await database.db.updateTable("career_profile_version").set({ status: "approved" }).where("candidate_id", "=", database.operatorId).execute()
    const marked = await readyVia({ status: "ranked" })
    await database.db.updateTable("application").set({ override_created_at: clock.now(), override_status: "skipped", override_skip_reason: "weak_core_match", override_violated_rules: [] }).where("id", "=", marked.id).execute()
    await asOperator(app, app.get(SampleService)).prepare()
    expect((await row(marked.id)).sample_state).toBeNull()
  })
})

describe("POST /v1/applications/{id}/remove-from-queue (AA-5)", () => {
  it(":920 :933 removes a queued Application: documents ready, everything kept, one queue_removed event, never claimed", async () => {
    const q = await queuedVia(WEAK)
    await database.db.updateTable("application").set({ queued_for_local_day: "2026-10-30", attempt_number: 1 }).where("id", "=", q.id).execute()
    const submission = submissionSchema.parse((await candidate.post(removeFromQueuePath(q.id)).send({}).expect(200)).body)
    expect(submission).toMatchObject({ state: null, kind: null, queuedForWatDay: null, attemptNumber: 1, override: { status: "skipped" } })
    expect(await row(q.id)).toMatchObject({ state: "documents_ready", override_skip_reason: "weak_core_match", attempt_number: 1 })
    expect(await events(q.id)).toEqual([{ kind: "queue_removed", detail: null }])
    expect(await asOperator(app, app.get(SubmissionRepository)).claim(q.id, "automatic", "2026-10-29", clock.now())).toEqual({ refused: "not_claimable" })
  })

  it(":997 a second removal answers the current state and writes nothing", async () => {
    const q = await queuedVia({ status: "ranked" })
    await candidate.post(removeFromQueuePath(q.id)).expect(200)
    expect(submissionSchema.parse((await candidate.post(removeFromQueuePath(q.id)).expect(200)).body).state).toBeNull()
    expect(await events(q.id)).toHaveLength(1)
  })

  it.each(["submit_claimed", "submitting", "confirmed", "uncertain", "blocked", "manual", "not_submitted", "declined"] as const)(":959 :981 removing in state %s is 409 application_state_conflict, nothing changes", async (state) => {
    const q = await readyVia({ status: "ranked" })
    await database.db.updateTable("application").set({ submission_state: state, submission_kind: "automatic", attempt_id: randomUUID(), submit_clicked_at: new Date(), blocked_reason: state === "blocked" ? "login" : null }).where("id", "=", q.id).execute()
    const before = await row(q.id)
    expect(error((await candidate.post(removeFromQueuePath(q.id))).body).code).toBe("application_state_conflict")
    expect(await row(q.id)).toEqual(before)
  })

  it("a minimal record is 409; a body with a key is 400; a non-UUID id is 404", async () => {
    const q = await queuedVia({ status: "ranked" })
    expect((await candidate.post(removeFromQueuePath(q.id)).send({ x: 1 })).status).toBe(400)
    await database.db.updateTable("application").set({ submission_state: null, submission_kind: null }).where("id", "=", q.id).execute()
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [q.id] }).expect(200)
    await database.db.updateTable("application").set({ submission_state: "queued", submission_kind: "automatic" }).where("id", "=", q.id).execute()
    expect(error((await candidate.post(removeFromQueuePath(q.id))).body).code).toBe("application_state_conflict")
    expect((await candidate.post(removeFromQueuePath("not-a-uuid"))).status).toBe(404)
  })

  it.each([["global_paused"], ["cost_paused"]] as const)(":1004 works while %s", async (pause) => {
    const q = await queuedVia({ status: "ranked" })
    await database.db.updateTable("control_state").set({ [pause]: true }).execute()
    expect(submissionSchema.parse((await candidate.post(removeFromQueuePath(q.id)).expect(200)).body).state).toBeNull()
  })

  it(":1017 a removed Application is queued again only by POST …/queue", async () => {
    const q = await queuedVia({ status: "ranked" })
    await candidate.post(removeFromQueuePath(q.id)).expect(200)
    expect(submissionSchema.parse((await candidate.post(`/v1/applications/${q.id}/queue`).expect(200)).body).state).toBe("queued")
  })

  it(":973 a removal and a claim racing never both succeed", async () => {
    for (let round = 0; round < 5; round += 1) {
      const q = await queuedVia({ status: "ranked" })
      const [removed, claimed] = await Promise.all([candidate.post(removeFromQueuePath(q.id)), asOperator(app, app.get(SubmissionRepository)).claim(q.id, "automatic", "2026-10-29", clock.now())])
      const claimWon = "attemptId" in claimed
      expect(removed.status === 200 && removed.body.state === null).toBe(!claimWon)
      if (claimWon) expect(error(removed.body).code).toBe("application_state_conflict")
      await database.db.deleteFrom("submission_day").execute()
    }
  })

  it("TM-F-02: a pre-claim block or cap carry-over landing after a removal does not undo it", async () => {
    const q = await queuedVia({ status: "ranked" })
    await candidate.post(removeFromQueuePath(q.id)).expect(200)
    await repo().block(q.id, null, { reason: "login", detail: "x" }, clock.now(), "automatic")
    expect(await row(q.id)).toMatchObject({ submission_state: null, blocked_reason: null })
    // A page block found while the page was open: the queued Application is blocked as before.
    const other = await queuedVia({ status: "ranked" })
    await repo().block(other.id, null, { reason: "login", detail: "x" }, clock.now(), "automatic")
    expect(await row(other.id)).toMatchObject({ submission_state: "blocked", blocked_reason: "login" })
  })

  it(":1035 unauthenticated removal is 401", async () => {
    const q = await queuedVia({ status: "ranked" })
    expect((await anonymous.http().post(removeFromQueuePath(q.id))).status).toBe(401)
    expect((await row(q.id)).submission_state).toBe("queued")
  })
})

describe("deleting detailed records and the daily summary facts (AA-7.1, AA-4.6)", () => {
  it(":1117 :821 delete-details clears every override field; override is null on the minimal record", async () => {
    const ready = await readyVia(WEAK)
    await database.db.updateTable("application").set({ candidate_override_at: new Date() }).where("id", "=", ready.id).execute()
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [ready.id] }).expect(200)
    expect(await row(ready.id)).toMatchObject({ candidate_override_at: null, override_created_at: null, override_status: null, override_skip_reason: null, override_skip_detail: null, override_violated_rules: null })
    const detailBody = applicationDetailSchema.parse((await candidate.get(`/v1/applications/${ready.id}`).expect(200)).body)
    expect(detailBody).toMatchObject({ override: null, posting: null, latestDrop: null })
  })

  it(":857 :944 the summary facts carry each drop's detail and override; a removal is not listed", async () => {
    const dropped = await queuedVia(WEAK)
    await setState(dropped.postingId, { status: "skipped", skipReason: "no_core_responsibilities" })
    expect(await service().submit(dropped.id, "automatic")).toMatchObject({ refusal: "posting_closed" })
    const removed = await queuedVia({ status: "ranked" })
    await candidate.post(removeFromQueuePath(removed.id)).expect(200)
    const facts = await app.get(TenantDatabase).asOperator(() => app.get(NotificationRepository).dailySummaryFacts("2026-10-29"))
    expect(facts.dropped).toEqual([{ role: "Senior Frontend Engineer", company: dropped.company, detail: "override_mismatch", override: true }])
  })
})

describe("migration 0026 legacy move (AA-2.7 :517, AA-7.6)", () => {
  it("down then up: candidate_override_at moves to override_created_at with no decision; the constraint holds", async () => {
    const ready = await readyVia({ status: "ranked" })
    await bounds.down(database.db as never)
    await database.db.updateTable("application").set({ candidate_override_at: new Date("2026-10-28T11:00:00Z") }).where("id", "=", ready.id).execute()
    await bounds.up(database.db as never)
    expect(await row(ready.id)).toMatchObject({ candidate_override_at: null, override_created_at: new Date("2026-10-28T11:00:00Z"), override_status: null, override_skip_reason: null, override_skip_detail: null, override_violated_rules: null })
    await expect(sql`update application set override_status = 'skipped' where id = ${ready.id}`.execute(database.db)).rejects.toThrow(/application_override_decision_check/)
    await expect(sql`update application set override_created_at = now(), override_status = 'ranked', override_violated_rules = '{}' where id = ${ready.id}`.execute(database.db)).rejects.toThrow(/check/)
    const marker = await sql<{ n: number }>`select count(*)::int as n from migration_marker where name = '0026-apply-anyway-bounds'`.execute(database.db)
    expect(marker.rows[0]!.n).toBe(1)
  })
})
