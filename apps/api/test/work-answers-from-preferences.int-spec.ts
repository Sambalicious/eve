import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import type { PreferencesValues } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { answerFor } from "../src/submission/answer-assignment.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 B1 unit 6: answer sources read each Candidate's Job Preferences
 * for the work context (never `candidate_setting.work_authorization`) and the
 * Application's stored Eligibility result for the role location
 * (eligibility-under-job-preferences.feature :558, :573, :668; architecture r4
 * "Work-authorization and sponsorship answers under Job Preferences").
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let operatorValues: PreferencesValues
const SELECT = { kind: "select" as const, options: ["Please select", "Yes", "No"] }

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock: new TestClock("2026-10-21T09:00:00.000Z") })
  operatorValues = (await database.db.selectFrom("job_preferences").select("values").where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).values as PreferencesValues
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

async function candidate(email: string, values: Partial<PreferencesValues> | null): Promise<string> {
  const id = (await database.db.insertInto("candidate").values({ email, google_sub: `sub-${email}`, role: "candidate", onboarded_at: new Date() } as never).returning("id").executeTakeFirstOrThrow()).id
  // A free-text setting that would have blocked or misled slice 5: it must not be read.
  await database.db.insertInto("candidate_setting").values({ candidate_id: id, work_authorization: "Nigeria and the United States", updated_at: new Date() } as never).onConflict((oc) => oc.column("candidate_id").doUpdateSet({ work_authorization: "Nigeria and the United States" })).execute()
  if (values !== null) await database.db.insertInto("job_preferences").values({ candidate_id: id, version: 1, values: JSON.stringify({ ...operatorValues, ...values }) } as never).execute()
  return id
}

/** An Application for `holder` with a stored Eligibility result: relocation to `destination`, or remote naming `quote`. */
async function application(holder: string, location: Readonly<{ destination?: string; quote?: string }>): Promise<string> {
  const postingId = randomUUID()
  const url = `https://boards.greenhouse.io/globex/jobs/${postingId}`
  await database.db
    .insertInto("job_posting")
    .values({ id: postingId, application_url: url, requisition_id: postingId.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", title: "Engineer", company: "Globex", structured: "{}", discovered_at: new Date() } as never)
    .execute()
  await database.db.insertInto("candidate_posting").values({ candidate_id: holder, job_posting_id: postingId, origin: "employer_board", status: "ranked", discovered_at: new Date(), evaluated_at: new Date() } as never).execute()
  await database.db
    .insertInto("eligibility_result")
    .values({
      candidate_id: holder, job_posting_id: postingId, arrangement: location.destination ? "relocation" : "remote", relocation_country: location.destination ?? null, employment_type: null,
      rules: JSON.stringify([{ rule: "location", result: "met", quote: location.quote ?? `Relocation to ${location.destination}` }]), eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date(),
    } as never)
    .execute()
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({ candidate_id: holder, id, job_posting_id: postingId, application_url: url, requisition_id: postingId.slice(0, 8), company: "Globex", role_title: "Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date() } as never)
    .execute()
  return id
}

const asCandidate = <T>(id: string, work: () => Promise<T>) => CandidateScope.run(id, work)
const schemaAnswer = (label: string, sources: Parameters<typeof answerFor>[1]) =>
  answerFor({ ref: "f1", label: "(page label ignored)", required: true, ...SELECT, fieldName: "question_1", schemaQuestion: { text: label, fieldName: "question_1" } }, sources)

describe("answer sources from Job Preferences", () => {
  it(":668 two Candidates at once: Kenya is No for Kofi (GH) and Yes for Wanjiru (KE); the free-text setting is never read", async () => {
    const kofi = await candidate("kofi.work@example.test", { homeCountry: "GH", workAuthorizedCountries: ["GH"] })
    const wanjiru = await candidate("wanjiru.work@example.test", { homeCountry: "KE", workAuthorizedCountries: ["KE"] })
    const repo = app.get(SubmissionRepository)
    const [kofiSources, wanjiruSources] = await Promise.all([
      asCandidate(kofi, async () => repo.loadAnswerSources(await application(kofi, { quote: "Remote, open to candidates in Kenya" }))),
      asCandidate(wanjiru, async () => repo.loadAnswerSources(await application(wanjiru, { quote: "Remote, open to candidates in Kenya" }))),
    ])
    expect(kofiSources.work).toEqual({ home: "GH", authorized: ["GH"], sponsorshipNeeded: true })
    expect(wanjiruSources.work).toEqual({ home: "KE", authorized: ["KE"], sponsorshipNeeded: true })
    expect(schemaAnswer("Are you authorized to work in Kenya?", kofiSources)).toMatchObject({ value: "No" })
    expect(schemaAnswer("Are you authorized to work in Kenya?", wanjiruSources)).toMatchObject({ value: "Yes" })
    expect(schemaAnswer("Are you authorized to work in the United States?", kofiSources)).toMatchObject({ value: "No" })
  })

  it.each([
    [true, "Netherlands", "Yes"],
    [true, "South Africa", "No"],
    [true, "Kenya", "No"],
    [false, "Netherlands", "No"],
  ] as const)(":558 Wanjiru (KE; KE, ZA), need %s, relocation to %s: sponsorship %s", async (need, destination, answer) => {
    const wanjiru = await candidate(`wanjiru.${randomUUID().slice(0, 6)}@example.test`, { homeCountry: "KE", workAuthorizedCountries: ["KE", "ZA"], sponsorshipNeededForRelocation: need })
    const sources = await asCandidate(wanjiru, async () => app.get(SubmissionRepository).loadAnswerSources(await application(wanjiru, { destination })))
    expect(schemaAnswer("Will you now or in the future require visa sponsorship?", sources)).toMatchObject({ kind: "value", value: answer, source: "rule_sponsorship" })
  })

  it("the Operator: migrated values give OWNER_WORK_CONTEXT, whatever her old free-text setting says", async () => {
    await database.db.updateTable("candidate_setting").set({ work_authorization: "garbled text slice 5 would block" }).where("candidate_id", "=", database.operatorId).execute()
    const sources = await asCandidate(database.operatorId, async () => app.get(SubmissionRepository).loadAnswerSources(await application(database.operatorId, { destination: "Germany" })))
    expect(sources.work).toEqual({ home: "NG", authorized: ["NG"], sponsorshipNeeded: true })
    expect(schemaAnswer("Are you authorized to work in Nigeria?", sources)).toMatchObject({ value: "Yes" })
    expect(schemaAnswer("Will you require visa sponsorship?", sources)).toMatchObject({ value: "Yes" })
  })

  it("no Job Preferences record: work is null and every work question blocks", async () => {
    const invitee = await candidate("invitee.work@example.test", null)
    const sources = await asCandidate(invitee, async () => app.get(SubmissionRepository).loadAnswerSources(await application(invitee, { destination: "Germany" })))
    expect(sources.work).toBeNull()
    for (const label of ["Are you authorized to work in Nigeria?", "Will you require visa sponsorship?"]) expect(schemaAnswer(label, sources)).toMatchObject({ reason: "missing_approved_answer" })
  })

  it("no stored Eligibility result: the role location is unclear and a sponsorship question blocks", async () => {
    const kofi = await candidate("kofi.noelig@example.test", { homeCountry: "GH", workAuthorizedCountries: ["GH"] })
    const applicationId = await application(kofi, { destination: "Germany" })
    await sql`delete from eligibility_result where candidate_id = ${kofi}::uuid`.execute(database.db)
    const sources = await asCandidate(kofi, () => app.get(SubmissionRepository).loadAnswerSources(applicationId))
    expect(sources.roleLocation).toEqual({ kind: "unclear" })
    expect(schemaAnswer("Will you require visa sponsorship?", sources)).toMatchObject({ reason: "missing_approved_answer" })
  })
})
