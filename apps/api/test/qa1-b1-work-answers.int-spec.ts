import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { type PreferencesValues, preferencesValuesSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { answerFor } from "../src/submission/answer-assignment.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 B1 QA gate gap tests (qa-1): the three Operator scenarios of
 * eligibility-under-job-preferences.feature :668, :677 and :689, through the real
 * SubmissionRepository answer sources over a migrated database. The Operator's
 * Job Preferences are the record 0018 and 0027 store, with only the fields the
 * scenario names changed. Her free-text setting stays "none outside Nigeria".
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let migrated: PreferencesValues
const SELECT = { kind: "select" as const, options: ["Please select", "Yes", "No"] }

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock: new TestClock("2026-10-23T09:00:00.000Z") })
  const row = await database.db.selectFrom("job_preferences").select("values").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
  migrated = preferencesValuesSchema.parse(row.values)
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

beforeEach(async () => {
  await database.db.updateTable("candidate_setting").set({ work_authorization: "none outside Nigeria" }).where("candidate_id", "=", database.operatorId).execute()
})

async function adaPreferences(change: Partial<PreferencesValues>): Promise<void> {
  const values = preferencesValuesSchema.parse({ ...migrated, ...change })
  await database.db.updateTable("job_preferences").set({ values: JSON.stringify(values) } as never).where("candidate_id", "=", database.operatorId).execute()
}

/** An Operator Application whose stored Eligibility result locates the role by relocation to `destination`. */
async function adaApplication(destination: string): Promise<string> {
  const ada = database.operatorId
  const postingId = randomUUID()
  const url = `https://boards.greenhouse.io/qa1/jobs/${postingId}`
  await database.db
    .insertInto("job_posting")
    .values({ id: postingId, application_url: url, requisition_id: postingId.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", title: "Senior Frontend Engineer", company: "QA1", structured: "{}", discovered_at: new Date() } as never)
    .execute()
  await database.db.insertInto("candidate_posting").values({ candidate_id: ada, job_posting_id: postingId, origin: "employer_board", status: "ranked", discovered_at: new Date(), evaluated_at: new Date() } as never).execute()
  await database.db
    .insertInto("eligibility_result")
    .values({
      candidate_id: ada, job_posting_id: postingId, arrangement: "relocation", relocation_country: destination, employment_type: null,
      rules: JSON.stringify([{ rule: "location", result: "met", quote: `Relocation to ${destination}` }]), eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date(),
    } as never)
    .execute()
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({ candidate_id: ada, id, job_posting_id: postingId, application_url: url, requisition_id: postingId.slice(0, 8), company: "QA1", role_title: "Senior Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date() } as never)
    .execute()
  return id
}

async function adaSources(destination: string) {
  const applicationId = await adaApplication(destination)
  return CandidateScope.run(database.operatorId, () => app.get(SubmissionRepository).loadAnswerSources(applicationId))
}

const schemaAnswer = (label: string, sources: Parameters<typeof answerFor>[1]) =>
  answerFor({ ref: "f1", label: "(page label ignored)", required: true, ...SELECT, fieldName: "question_1", schemaQuestion: { text: label, fieldName: "question_1" } }, sources)

describe("the Operator's work answers come from her Job Preferences (eligibility-under-job-preferences.feature)", () => {
  it(":668 with work authorization Nigeria, United Kingdom and free text 'none outside Nigeria', a role in Germany: 'authorized in the UK' is Yes", async () => {
    await adaPreferences({ homeCountry: "NG", workAuthorizedCountries: ["NG", "GB"], sponsorshipNeededForRelocation: true })
    const sources = await adaSources("Germany")
    expect(sources.work).toEqual({ home: "NG", authorized: ["NG", "GB"], sponsorshipNeeded: true })
    expect(JSON.stringify(sources)).not.toContain("none outside Nigeria")
    expect(schemaAnswer("Are you authorized to work in the United Kingdom?", sources)).toMatchObject({ kind: "value", value: "Yes" })
  })

  it.each([
    ["Germany", "Yes"],
    ["Nigeria", "No"],
  ] as const)(":677 work authorization Nigeria, sponsorship need yes, a role in %s: the sponsorship answer is %s", async (destination, answer) => {
    await adaPreferences({ homeCountry: "NG", workAuthorizedCountries: ["NG"], sponsorshipNeededForRelocation: true })
    const sources = await adaSources(destination)
    expect(schemaAnswer("Will you now or in the future require visa sponsorship?", sources)).toMatchObject({ kind: "value", value: answer, source: "rule_sponsorship" })
  })

  it(":689 'authorized in the United Kingdom and Ireland' with Nigeria, United Kingdom still blocks: no answer is entered", async () => {
    await adaPreferences({ homeCountry: "NG", workAuthorizedCountries: ["NG", "GB"] })
    const sources = await adaSources("Germany")
    const outcome = schemaAnswer("Are you authorized to work in the United Kingdom and Ireland?", sources)
    expect(outcome).toMatchObject({ reason: "missing_approved_answer" })
    expect(outcome).not.toHaveProperty("value")
  })
})
