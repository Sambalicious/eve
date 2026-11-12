import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { APPLICATIONS_PATH, ME_PREFERENCES_PATH, type PreferencesValues, createApplicationResponseSchema, jobPostingDetailSchema, JOB_POSTINGS_PATH, preferencesResponseSchema, preferencesValuesSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { StoredRule } from "../src/db/schema.js"
import { PreferencesSaveLimiter } from "../src/preferences/preferences-save-limit.guard.js"
import { SubmissionService } from "../src/submission/submission.service.js"
import { Browser } from "./support/browser.js"
import { FakeAtsForms, STANDARD_FORM, STANDARD_SCHEMA } from "./support/fake-ats-form.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { EMPTY_TAILORED_CONTENT, WEAK, ack, insertDecidedPosting, overrideColumns, submissionEvents } from "./support/qa-apply-anyway-bounds.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA test authoring, run epic-0002-b1-2 attempt qa-tests-2 (QA-authored,
 * independent of the implementation). architecture.r6.md "B1 amendment (code
 * review CR-B1-02): Eligibility re-check and Apply anyway" (2026-11-01):
 *
 *   The Eligibility re-check runs for every queued Application whose drop
 *   detail is null, including one with an Apply anyway override recorded. A
 *   recorded override never skips it. A newly violated rule drops the
 *   Application, logs `queued_posting_preferences_changed` with detail
 *   `not_ranked` (D47), and follows v1.24.0's Drop rule (back to documents
 *   ready, AA-2.5).
 *
 * Real paths: the override is recorded by `POST /v1/applications` with the
 * acknowledgement (v1.24.0 AA-1.1, AA-2.2); the Candidate narrows accepted
 * employment types through `PUT /v1/me/preferences`; the real
 * `SubmissionService.submit(…, "automatic")` runs against the in-process fake
 * Greenhouse form (no network). Fixtures write only what the real pipeline
 * would have produced before these steps: the posting's stored decision and
 * Eligibility result, and the tailored documents plus the queued state that
 * document generation and queueing would leave (no model call).
 */
const APPLY_HOST = "boards.greenhouse.io"
/** 09:00 WAT on 2026-10-29. */
const NOW = "2026-10-29T08:00:00.000Z"
const TODAY = "2026-10-29"
const POSTING_TEXT = "Relocation to the United States. Independent contractor engagement."

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let storage: string
const forms = new FakeAtsForms()
const clock = new TestClock(NOW)

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-b1-qa-override-elig-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage }, formSessions: forms, questionSchemas: forms.questionSchemas })
  ada = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  clock.set(NOW)
  app.get(PreferencesSaveLimiter).reset()
  for (const table of ["notification_outbox", "submission_event", "application_form_read", "tailored_document", "outcome", "application", "match_evidence", "eligibility_result", "candidate_posting", "job_posting", "submission_day"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
  await sql`update job_criteria set target_role_families = default, seniority_floor = default, min_core_match_percent = 70, frameworks = '{}', technologies = '{}', version = 1`.execute(database.db)
  forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, schema: STANDARD_SCHEMA })
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

const now = () => clock.now()

/** Saves `change` on top of the Operator's current Job Preferences through the real route. */
async function savePreferences(change: Partial<PreferencesValues>): Promise<void> {
  app.get(PreferencesSaveLimiter).reset()
  const current = preferencesResponseSchema.parse((await ada.get(ME_PREFERENCES_PATH).expect(200)).body)
  const values: PreferencesValues = preferencesValuesSchema.parse({ ...current.values, ...change })
  const saved = await ada.put(ME_PREFERENCES_PATH).send({ baseVersion: current.version, values })
  expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  expect(preferencesResponseSchema.parse(saved.body).values.employmentTypes).toEqual(values.employmentTypes)
}

/**
 * A visible Greenhouse posting skipped as `weak_core_match` (no violated rules), whose stored
 * Eligibility result says: relocation to the United States, employment type `contract`, the
 * employment type rule met under the preferences at evaluation time.
 */
async function weakContractPosting() {
  const posting = await insertDecidedPosting(database.db, database.operatorId, now(), { decision: WEAK, company: "Contoso Contracting", title: "Senior Frontend Engineer" })
  await database.db.updateTable("job_posting").set({ posting_text: POSTING_TEXT }).where("id", "=", posting.id).execute()
  const rules: StoredRule[] = [
    { rule: "location", result: "met", quote: "Relocation to the United States" },
    { rule: "employment_type", result: "met", quote: "Independent contractor engagement" },
  ]
  await database.db.deleteFrom("eligibility_result").where("candidate_id", "=", database.operatorId).where("job_posting_id", "=", posting.id).execute()
  await database.db
    .insertInto("eligibility_result")
    .values({ candidate_id: database.operatorId, job_posting_id: posting.id, arrangement: "relocation", relocation_country: "United States", employment_type: "contract", rules: JSON.stringify(rules), eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: now() })
    .execute()
  return posting
}

/**
 * Apply anyway through `POST /v1/applications` with the acknowledgement of the current decision,
 * then the state document generation and queueing leave: documents ready, tailored documents, queued
 * automatic for today.
 */
async function applyAnywayQueued(posting: Awaited<ReturnType<typeof weakContractPosting>>): Promise<string> {
  const detail = jobPostingDetailSchema.parse((await ada.get(`${JOB_POSTINGS_PATH}/${posting.id}`).expect(200)).body)
  expect(detail.applyAnyway).toEqual({ offered: true, decision: ack(WEAK).decision })
  const response = await ada.post(APPLICATIONS_PATH).send({ jobPostingId: posting.id, acknowledgement: ack(WEAK) })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  const body = createApplicationResponseSchema.parse(response.body)
  expect(body.application.override).toMatchObject({ ...ack(WEAK).decision, applies: true, notAppliesReason: null })
  const id = body.application.id
  expect(await overrideColumns(database.db, id)).toMatchObject({ override_status: "skipped", override_skip_reason: "weak_core_match", override_violated_rules: [] })
  for (const kind of ["resume", "cover_letter"] as const) {
    await database.db
      .insertInto("tailored_document")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: JSON.stringify(EMPTY_TAILORED_CONTENT[kind]), pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: now() })
      .execute()
  }
  await database.db
    .updateTable("application")
    .set({ state: "documents_ready", submission_state: "queued", submission_kind: "automatic", queued_for_local_day: TODAY, updated_at: now() } as never)
    .where("id", "=", id)
    .execute()
  return id
}

const applicationRow = (id: string) =>
  database.db.selectFrom("application").select(["state", "submission_state", "submission_kind", "queued_for_local_day"]).where("id", "=", id).executeTakeFirstOrThrow()

const postingState = async (postingId: string) =>
  database.db.selectFrom("candidate_posting").select(["status", "skip_reason"]).where("candidate_id", "=", database.operatorId).where("job_posting_id", "=", postingId).executeTakeFirstOrThrow()

describe("CR-B1-02: a recorded Apply anyway override never skips the Eligibility re-check (architecture.r6 B1 amendment, 2026-11-01)", () => {
  it("weak_core_match override (contract posting) queued, then accepted employment types narrowed to 'direct': automatic submission is not attempted; dropped to documents ready; queued_posting_preferences_changed / not_ranked; nothing entered, no click", async () => {
    await savePreferences({ employmentTypes: ["direct", "employer_of_record", "contract"] })
    const posting = await weakContractPosting()
    const id = await applyAnywayQueued(posting)

    await savePreferences({ employmentTypes: ["direct"] })
    // D21: an Eligibility-field save does not re-decide the stored posting, so the override still applies by its decision.
    expect(await postingState(posting.id)).toEqual({ status: "skipped", skip_reason: "weak_core_match" })

    const result = await asOperator(app, app.get(SubmissionService)).submit(id, "automatic")
    expect(forms.filled).toEqual([])
    expect(forms.clicks).toEqual([])
    expect(result).toEqual({ result: "refused", refusal: "posting_closed" })
    // v1.24.0 Drop rule (AA-2.5): back to documents ready.
    expect(await applicationRow(id)).toEqual({ state: "documents_ready", submission_state: null, submission_kind: null, queued_for_local_day: null })
    // D47: the failed Eligibility re-check is a B1 cause, logged as queued_posting_preferences_changed with detail not_ranked.
    expect(await submissionEvents(database.db, id)).toEqual([{ kind: "queued_posting_preferences_changed", detail: "not_ranked" }])
  })

  it("control: the same override with a save that leaves every Eligibility rule as it was is submitted", async () => {
    await savePreferences({ employmentTypes: ["direct", "employer_of_record", "contract"] })
    const posting = await weakContractPosting()
    const id = await applyAnywayQueued(posting)

    // A save through the route that still accepts contract: no rule changes.
    await savePreferences({ employmentTypes: ["direct", "contract"] })

    const result = await asOperator(app, app.get(SubmissionService)).submit(id, "automatic")
    expect(result).toEqual({ result: "confirmed" })
    expect(forms.clicks).toHaveLength(1)
    const kinds = (await submissionEvents(database.db, id)).map((event) => event.kind)
    expect(kinds).not.toContain("queued_posting_preferences_changed")
    expect(kinds).not.toContain("queued_posting_dropped")
    expect((await applicationRow(id)).submission_state).toBe("confirmed")
  })
})
