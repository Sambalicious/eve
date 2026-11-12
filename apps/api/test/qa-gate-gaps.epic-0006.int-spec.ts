import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { JOB_POSTINGS_CHECK_AGAIN_PATH, SAMPLES_PREPARE_PATH, checkAgainResponseSchema, prepareSamplesResultSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CandidateScope } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { PostingEvaluator } from "../src/discovery/posting-evaluator.js"
import { NotificationRepository } from "../src/notification/notification.repository.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { SubmissionService } from "../src/submission/submission.service.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeAtsForms, STANDARD_FORM } from "./support/fake-ats-form.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_ANTHROPIC_MODEL, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { DEFAULT_TARGETS, TODAY, clearPostings, list, queuedEvaluations, resetCriteria, seed, setCriteria, statusOf, wat } from "./support/epic-0006.js"

/**
 * EPIC-0006 QA gate r1 (step [6a], fresh session): tests for acceptance criteria
 * the earlier gate listed as uncovered. Source: prd.r3.md and gherkin r5
 * (check-again-and-worker-key.feature AC-7.6 scenarios,
 * hidden-postings-applications-and-links.feature AC-3.9 sample queue and queued
 * drop, AC-3.10 daily summary). Real api, real Postgres; the model gateway and
 * the ATS form are the existing fakes (AC-7.8).
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
/** The same api with no Anthropic key, as the worker before AC-7.2. */
let noKeyApp: INestApplication
let ada: SignedInCandidate
let adaId: string
const forms = new FakeAtsForms()
const clock = new TestClock(TODAY)

const SECTIONS = [{ id: "s1", kind: "experience", title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021-2024", sourceQuote: null, facts: [{ id: "F1", text: "Built a React dashboard", sourceQuote: null }] }]

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock, formSessions: forms, questionSchemas: forms.questionSchemas })
  noKeyApp = await createTestApp({ databaseUrl: database.url, clock, config: { anthropic: anthropicConfig(undefined, TEST_ANTHROPIC_MODEL) } })
  ada = await signInCandidate(new Browser(app, google))
  adaId = database.operatorId
})

beforeEach(async () => {
  clock.set(TODAY)
  anthropic.install()
  anthropic.reset()
  forms.use({ host: "boards.greenhouse.io", controls: STANDARD_FORM })
  for (const table of ["notification_outbox", "submission_event", "tailored_document", "eligibility_result"] as const) await database.db.deleteFrom(table).execute()
  await clearPostings(database.db)
  await resetCriteria(database.db)
  await database.db.deleteFrom("spend_entry").where("category", "<>", "hosting").execute()
  await database.db.deleteFrom("career_profile_version").execute()
  await database.db.deleteFrom("ai_provider_approval").execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false, cost_paused_month: null }).execute()
  await database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false, existing_applications_completed_at: null }).execute()
})

afterAll(async () => {
  await noKeyApp?.close()
  await app?.close()
  google?.close()
  await database?.stop()
})

const approveProvider = () => ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
const approveProfile = () =>
  database.db.insertInto("career_profile_version").values({ candidate_id: adaId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(SECTIONS), created_at: new Date(), approved_at: new Date() }).execute()
const aiSpendRows = async () => Number((await sql<{ n: string }>`select count(*) as n from spend_entry where category = 'ai'`.execute(database.db)).rows[0]!.n)

/** "the worker processes the queue": every queued evaluate.posting job, through the evaluator of `on`, in its Candidate's scope. */
async function drain(on: INestApplication): Promise<void> {
  for (const job of await queuedEvaluations(database.db)) await CandidateScope.run(job.candidateId ?? adaId, () => on.get(PostingEvaluator).evaluate(job.postingId))
  await sql`delete from pgboss.job where name = 'evaluate.posting'`.execute(database.db)
}

describe("AC-7.6 @AC-7.6 a missing precondition makes each posting fail again with the same kind and no spend (check-again:545-578)", () => {
  it.each([
    ["the worker has no ANTHROPIC_API_KEY", "not_configured", async () => { await approveProvider(); await approveProfile() }, () => noKeyApp],
    ["the Anthropic provider is not approved", "not_approved", async () => approveProfile(), () => app],
    ["no Career Profile is approved", "no_career_profile", async () => { await approveProvider() }, () => app],
  ] as const)("check-again:546 %s: 3 postings fail again as %s, no model call, no spend", async (_label, kind, given, worker) => {
    await given()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push(await seed(database.db, adaId, { title: `Senior Frontend Engineer ${i}` }, { status: "evaluation_failed", evaluationFailure: kind }))
    expect(checkAgainResponseSchema.parse((await ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({}).expect(200)).body)).toEqual({ queued: 3, movedTo: "checking" })
    await drain(worker())
    for (const id of ids) expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: "evaluation_failed", evaluation_failure: kind })
    expect(anthropic.requests).toHaveLength(0)
    expect(await aiSpendRows()).toBe(0)
  })

  it("check-again:562 @AC-7.7 after a failed retry the posting still shows its not_configured kind and Check again still counts it", async () => {
    await approveProvider()
    await approveProfile()
    const id = await seed(database.db, adaId, { title: "Senior Frontend Engineer", company: "Globex" }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    await ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({}).expect(200)
    await drain(noKeyApp)
    const page = await list(ada, "tab=all")
    expect(page.postings.find((p) => p.id === id)).toMatchObject({ status: "evaluation_failed", evaluationFailure: "not_configured" })
    expect(page.recheckableCount).toBe(1)
  })

  it("check-again:571 a retry that fails with a different kind records the new kind (provider_error stands in for timed_out: a 60 s gateway deadline)", async () => {
    await approveProvider()
    await approveProfile()
    const id = await seed(database.db, adaId, { title: "Senior Frontend Engineer", company: "Globex" }, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    anthropic.replyWithStatus(500)
    await ada.post(JOB_POSTINGS_CHECK_AGAIN_PATH).send({}).expect(200)
    await drain(app)
    expect(anthropic.requests).toHaveLength(1)
    expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: "evaluation_failed", evaluation_failure: "provider_error" })
  })
})

/** A documents-ready Application on `postingId`, with strong Match evidence and an eligible result for the Operator. */
async function readyApplication(postingId: string, company: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await database.db
    .insertInto("eligibility_result")
    .values({ candidate_id: adaId, job_posting_id: postingId, arrangement: "remote", relocation_country: null, employment_type: "direct", rules: JSON.stringify([{ rule: "location", result: "met", quote: "Remote" }]), eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date() })
    .execute()
  await database.db
    .insertInto("application")
    .values({ candidate_id: adaId, id, job_posting_id: postingId, application_url: `https://boards.greenhouse.io/qa6/jobs/${postingId}`, requisition_id: postingId.slice(0, 13), company, role_title: "Senior Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(), ...extra } as never)
    .execute()
  return id
}

const sampleState = async (id: string) => (await database.db.selectFrom("application").select("sample_state").where("id", "=", id).executeTakeFirstOrThrow()).sample_state

describe("AC-3.9 @AC-3.9 the Activation Gate sample queue never picks a hidden posting (applications-and-links:151)", () => {
  it("the first-ranked data_ml posting is not picked under the defaults, and is picked once data_ml is targeted", async () => {
    await approveProfile()
    const hiddenPosting = await seed(database.db, adaId, { title: "Senior Data Engineer", company: "Initech", family: "data_ml" }, { status: "ranked", covered: 10 })
    const visiblePosting = await seed(database.db, adaId, { title: "Senior Frontend Engineer", company: "Acme" }, { status: "ranked", covered: 8 })
    const hiddenApp = await readyApplication(hiddenPosting, "Initech")
    const visibleApp = await readyApplication(visiblePosting, "Acme")
    expect(prepareSamplesResultSchema.parse((await ada.post(SAMPLES_PREPARE_PATH).expect(200)).body)).toEqual({ created: 1, stoppedBy: "no_candidates" })
    expect(await sampleState(visibleApp)).toBe("awaiting_review")
    expect(await sampleState(hiddenApp)).toBeNull()
    // Control: the same posting becomes a sample once it is visible, so visibility alone kept it out.
    await setCriteria(database.db, adaId, { targets: [...DEFAULT_TARGETS, "data_ml"] })
    expect(prepareSamplesResultSchema.parse((await ada.post(SAMPLES_PREPARE_PATH).expect(200)).body)).toEqual({ created: 1, stoppedBy: "no_candidates" })
    expect(await sampleState(hiddenApp)).toBe("awaiting_review")
  })
})

describe("AC-3.9 @AC-3.9 a queued automatic Application whose posting ages past 60 days is dropped before submission (applications-and-links:143)", () => {
  it("visible at age 60; at 2026-10-25 WAT the submission worker drops it, opens no form and logs queued_posting_dropped", async () => {
    await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
    const posting = await seed(database.db, adaId, { title: "Senior Frontend Engineer", company: "Acme", postedAt: wat("2026-08-25", "10:00") }, { status: "ranked" })
    const appId = await readyApplication(posting, "Acme", { submission_state: "queued", submission_kind: "automatic" })
    const repo = asOperator(app, app.get(SubmissionRepository))
    expect(await repo.dropQueuedUnlessRanked(appId, clock.now())).toBe(false)
    clock.set("2026-10-25T00:01:00+01:00")
    expect(await asOperator(app, app.get(SubmissionService)).submit(appId, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.opened).toBe(0)
    expect(forms.clicks).toEqual([])
    const events = await database.db.selectFrom("submission_event").select("kind").where("application_id", "=", appId).execute()
    expect(events.map((e) => e.kind)).toEqual(["queued_posting_dropped"])
  })
})

describe("AC-3.10 @AC-3.10 the daily summary's skipped list leaves out hidden postings (applications-and-links:207)", () => {
  it("of four decided postings, the skipped list holds only the visible skip; the off-target ones are left out", async () => {
    const day = "2026-10-20"
    await seed(database.db, adaId, { title: "Hotline Paralegal", company: "Acme Legal", family: null, prefilterSkip: "not_software_role", marker: "none" }, { status: "skipped", skipReason: "not_software_role" })
    await seed(database.db, adaId, { title: "Solutions Architect", company: "Globex", family: "solutions_customer" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    await seed(database.db, adaId, { title: "Frontend Engineer", company: "Initech" }, { status: "skipped", skipReason: "weak_core_match", covered: 5 })
    await seed(database.db, adaId, { title: "Senior Frontend Engineer", company: "Hooli" }, { status: "evaluation_failed", evaluationFailure: "provider_error" })
    const facts = await app.get(TenantDatabase).asOperator(() => app.get(NotificationRepository).dailySummaryFacts(day))
    expect(facts.skipped.map((row) => row.company)).toEqual(["Initech"])
    // Control: targeting Solutions brings Globex back, so visibility alone left it out. A not_software_role skip stays out (AC-1.7).
    await setCriteria(database.db, adaId, { targets: [...DEFAULT_TARGETS, "solutions_customer"] })
    const again = await app.get(TenantDatabase).asOperator(() => app.get(NotificationRepository).dailySummaryFacts(day))
    expect(again.skipped.map((row) => row.company).sort()).toEqual(["Globex", "Initech"])
  })
})
