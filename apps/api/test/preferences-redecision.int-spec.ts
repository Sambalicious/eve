import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { DEFAULT_ROLE_FAMILY_TIERS, ME_PREFERENCES_PATH, type PreferencesValues } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { TenantDatabase } from "../src/db/tenant-database.js"
import { NotificationRepository } from "../src/notification/notification.repository.js"
import { PreferencesSaveEffects } from "../src/preferences/preferences-save-effects.js"
import { PreferencesSaveLimiter } from "../src/preferences/preferences-save-limit.guard.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { asOperator } from "./support/operator-scope.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 B1 unit 5: a Job Preferences save re-decides the Candidate's
 * stored postings for the keyword and family (architecture.r6 "Save and
 * re-decision" steps 1 to 5 in B1; contract v1.25.0 "Side effects";
 * job-criteria-in-preferences.feature :446 to :602, R6-AC10 to AC12).
 * Real api and Postgres under forced RLS, through `PUT /v1/me/preferences`.
 * The race scenarios (:611, :625) are unit 7.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let kofiId: string
const clock = new TestClock("2026-10-21T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  kofiId = (await database.db.insertInto("candidate").values({ email: "kofi.redecide@example.test", google_sub: "sub-kofi-redecide", role: "candidate", onboarded_at: new Date() } as never).returning("id").executeTakeFirstOrThrow()).id
})

beforeEach(async () => {
  app.get(PreferencesSaveLimiter).reset()
  await database.db.deleteFrom("application").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

type Seed = Readonly<{ title: string | null; family?: string | null; status: string; skipReason?: string | null; holder?: string; prefilter?: "not_software_role" | null; version?: number }>

async function seed(state: Seed): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/globex/jobs/${id}`
  await insertPostingFor(
    database.db,
    state.holder ?? database.operatorId,
    {
      id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board",
      employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null,
      title: state.title, company: "Globex", posting_text: "Remote.",
      status: state.status, skip_reason: state.skipReason ?? null, skip_detail: state.status === "excluded" ? "pay" : null, evaluation_failure: null,
      role_family: state.family === undefined ? "senior_frontend" : state.family, discovered_at: new Date(), evaluated_at: new Date(),
    } as never,
    { keepFamily: true }
  )
  if (state.prefilter) await database.db.updateTable("job_posting").set({ prefilter_skip: state.prefilter }).where("id", "=", id).execute()
  if (state.version !== undefined) await database.db.updateTable("candidate_posting").set({ preferences_version: state.version }).where("job_posting_id", "=", id).execute()
  return id
}

async function current(): Promise<{ version: number; values: PreferencesValues }> {
  const row = await database.db.selectFrom("job_preferences").select(["version", "values"]).where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
  return { version: row.version, values: row.values as PreferencesValues }
}

/** Saves a change on top of Ada's current record through the api. */
async function save(change: Partial<PreferencesValues>, baseVersion?: number) {
  const { version, values } = await current()
  return ada.put(ME_PREFERENCES_PATH).send({ baseVersion: baseVersion ?? version, values: { ...values, ...change } })
}

const state = async (id: string, holder = database.operatorId) =>
  (await sql<{ status: string; skip_reason: string | null; skip_detail: string | null; preferences_version: number }>`
    select status, skip_reason, skip_detail, preferences_version from candidate_posting where candidate_id = ${holder}::uuid and job_posting_id = ${id}::uuid`.execute(database.db)).rows[0]!

const paid = async () =>
  (await sql<{ calls: number; spend: number }>`select (select count(*)::int from ai_call) as calls, (select count(*)::int from spend_entry) as spend`.execute(database.db)).rows[0]!

const tiers = (change: Record<string, unknown>) => ({ roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, ...change } as PreferencesValues["roleFamilyTiers"] })

describe("re-decision at save: steps 2 and 3 (R6-AC10)", () => {
  it(":446 setting a keyword skips a ranked posting whose title lacks it at once; no paid call", async () => {
    await save({ titleKeyword: null })
    const vue = await seed({ title: "Senior Vue Engineer", status: "ranked" })
    const before = await paid()
    const response = await save({ titleKeyword: "react" })
    expect(response.status).toBe(200)
    expect(await state(vue)).toEqual({ status: "skipped", skip_reason: "keyword_mismatch", skip_detail: null, preferences_version: response.body.version })
    expect(await paid()).toEqual(before)
  })

  it(":455 excluding a family skips its ranked postings; :463 it overrides an Eligibility exclusion", async () => {
    const ios = await seed({ title: "Senior iOS Engineer", family: "mobile", status: "ranked" })
    const android = await seed({ title: "Senior Android Engineer", family: "mobile", status: "excluded", skipReason: "violated_rule" })
    expect((await save(tiers({ mobile: "excluded" }))).status).toBe(200)
    expect(await state(ios)).toMatchObject({ status: "skipped", skip_reason: "excluded_role_family" })
    expect(await state(android)).toMatchObject({ status: "skipped", skip_reason: "excluded_role_family", skip_detail: null })
    const tabs = await ada.get("/v1/job-postings?tab=excluded_family").expect(200)
    expect(tabs.body.totalCount).toBe(2)
  })

  it(":469 clearing the keyword returns keyword mismatches to waiting; :477 un-excluding a family returns its postings", async () => {
    await save({ titleKeyword: "react", ...tiers({ mobile: "excluded" }) })
    const mismatches = await Promise.all([1, 2, 3, 4].map((n) => seed({ title: `Vue Engineer ${n}`, status: "skipped", skipReason: "keyword_mismatch" })))
    const families = await Promise.all([1, 2, 3].map((n) => seed({ title: `React Native Engineer ${n}`, family: "mobile", status: "skipped", skipReason: "excluded_role_family" })))
    const response = await save({ titleKeyword: null, ...tiers({ mobile: 2 }) })
    for (const id of [...mismatches, ...families]) expect(await state(id)).toEqual({ status: "waiting_to_be_checked", skip_reason: null, skip_detail: null, preferences_version: response.body.version })
  })

  it(":484 changing the keyword skips new mismatches and returns old ones that now match; :493 an old mismatch missing the new keyword stays", async () => {
    await save({ titleKeyword: "react" })
    const vue = await seed({ title: "Senior Vue Engineer", status: "skipped", skipReason: "keyword_mismatch" })
    const react = await seed({ title: "React Engineer", status: "ranked" })
    const angular = await seed({ title: "Senior Angular Engineer", status: "skipped", skipReason: "keyword_mismatch", version: 3 })
    expect((await save({ titleKeyword: "vue" })).status).toBe(200)
    expect(await state(vue)).toMatchObject({ status: "waiting_to_be_checked", skip_reason: null })
    expect(await state(react)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch" })
    expect(await state(angular)).toEqual({ status: "skipped", skip_reason: "keyword_mismatch", skip_detail: null, preferences_version: 3 })
  })

  it(":533 a pay floor and keyword in one save: stored Eligibility verdicts stay; an Eligibility exclusion missing the keyword is skipped", async () => {
    await save({ titleKeyword: null })
    const ranked = await seed({ title: "Senior React Engineer", status: "ranked" })
    const lead = await seed({ title: "Frontend Lead", status: "excluded", skipReason: "violated_rule" })
    expect((await save({ titleKeyword: "engineer", payFloor: { amount: "6000.00", currency: "USD", period: "month", basis: "gross" } })).status).toBe(200)
    expect(await state(ranked)).toMatchObject({ status: "ranked", skip_reason: null })
    expect(await state(lead)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch" })
  })

  it(":541 a pay-floor-only save changes no stored posting", async () => {
    const ids = [
      await seed({ title: "Senior Vue Engineer", status: "ranked", version: 2 }),
      await seed({ title: "Frontend Lead", status: "excluded", skipReason: "violated_rule", version: 2 }),
      await seed({ title: "Mobile Dev", status: "skipped", skipReason: "keyword_mismatch", version: 2 }),
    ]
    const before = await Promise.all(ids.map((id) => state(id)))
    expect((await save({ payFloor: { amount: "6000.00", currency: "USD", period: "month", basis: "gross" } })).status).toBe(200)
    expect(await Promise.all(ids.map((id) => state(id)))).toEqual(before)
  })

  it.each([
    ["waiting_to_be_checked", null, null],
    ["checking", null, null],
    ["evaluation_failed", null, null],
    ["skipped", "not_software_role", "not_software_role"],
    ["skipped", "unsupported_application_system", null],
  ] as const)(":547 a posting with status %s reason %s keeps its status", async (status, reason, prefilter) => {
    const id = await seed({ title: "Data Engineer", family: "data_ml", status, skipReason: reason, prefilter, version: 1 })
    const before = await state(id)
    expect((await save({ titleKeyword: "react" })).status).toBe(200)
    expect(await state(id)).toEqual(before)
  })

  it(":580 a save with no stored postings succeeds and writes none", async () => {
    const response = await save({ titleKeyword: "react" })
    expect(response.status).toBe(200)
    expect(Number((await sql<{ n: string }>`select count(*) as n from candidate_posting`.execute(database.db)).rows[0]!.n)).toBe(0)
  })

  it(":586 a newly set keyword overrides an Eligibility exclusion", async () => {
    await save({ titleKeyword: null })
    const vue = await seed({ title: "Senior Vue Engineer", status: "excluded", skipReason: "violated_rule" })
    expect((await save({ titleKeyword: "react" })).status).toBe(200)
    expect(await state(vue)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch", skip_detail: null })
  })

  it(":594 only changed rows take the new version; an unchanged ranked row keeps its version", async () => {
    await save({ titleKeyword: null })
    const { version } = await current()
    const vue = await seed({ title: "Senior Vue Engineer", status: "ranked", version })
    const react = await seed({ title: "React Engineer", status: "ranked", version })
    expect((await save({ titleKeyword: "react" }, version)).status).toBe(200)
    expect(await state(vue)).toMatchObject({ status: "skipped", skip_reason: "keyword_mismatch", preferences_version: version + 1 })
    expect(await state(react)).toMatchObject({ status: "ranked", preferences_version: version })
  })

  it(":602 a stale keyword save is refused and re-decides nothing", async () => {
    await save({ titleKeyword: null })
    const { version } = await current()
    const vue = await seed({ title: "Senior Vue Engineer", status: "ranked" })
    const response = await save({ titleKeyword: "react" }, version - 1)
    expect(response.status).toBe(409)
    expect(await state(vue)).toMatchObject({ status: "ranked" })
    expect((await current()).version).toBe(version)
  })
})

describe("atomicity and isolation (R6-AC11, R6-AC12)", () => {
  it(":613 a failure during re-decision rolls back the record, the version and every posting", async () => {
    await save({ titleKeyword: null })
    const before = await current()
    const vue = await seed({ title: "Senior Vue Engineer", status: "ranked" })
    const effects = app.get(PreferencesSaveEffects)
    const original = effects.afterSave.bind(effects)
    effects.afterSave = async (trx, saved) => {
      await original(trx, saved)
      throw new Error("injected failure after the posting update")
    }
    try {
      expect((await save({ titleKeyword: "react" })).status).toBe(500)
    } finally {
      effects.afterSave = original
    }
    expect(await current()).toEqual(before)
    expect(await state(vue)).toMatchObject({ status: "ranked", skip_reason: null })
    expect(Number((await sql<{ n: string }>`select count(*) as n from job_preferences_version where candidate_id = ${database.operatorId}::uuid and version > ${before.version}`.execute(database.db)).rows[0]!.n)).toBe(0)
  })

  it(":630 a save re-decides only the saving Candidate's postings; another Candidate holding the same posting is byte-equal", async () => {
    await save({ titleKeyword: null })
    const shared = await seed({ title: "Senior Vue Engineer", status: "ranked" })
    await database.db
      .insertInto("candidate_posting")
      .values({ candidate_id: kofiId, job_posting_id: shared, origin: "employer_board", status: "ranked", discovered_at: new Date(), evaluated_at: new Date() } as never)
      .execute()
    const kofiBefore = JSON.stringify(await state(shared, kofiId))
    expect((await save({ titleKeyword: "react" })).status).toBe(200)
    expect(await state(shared)).toMatchObject({ skip_reason: "keyword_mismatch" })
    expect(JSON.stringify(await state(shared, kofiId))).toBe(kofiBefore)
  })
})

describe("queued Applications (R6-4): a save drops none itself", () => {
  it(":714 a queued Application is still queued after a save that skips its posting, and the save logs no event", async () => {
    await save({ titleKeyword: null })
    const vue = await seed({ title: "Senior Vue Engineer", status: "ranked" })
    const url = `https://boards.greenhouse.io/globex/jobs/${vue}`
    const applicationId = randomUUID()
    await database.db
      .insertInto("application")
      .values({ candidate_id: database.operatorId, id: applicationId, job_posting_id: vue, application_url: url, requisition_id: vue.slice(0, 8), company: "Globex", role_title: "Senior Vue Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(), submission_state: "queued", submission_kind: "automatic" } as never)
      .execute()
    const events = async () => Number((await sql<{ n: string }>`select count(*) as n from submission_event where application_id = ${applicationId}::uuid`.execute(database.db)).rows[0]!.n)
    const before = await events()
    expect((await save({ titleKeyword: "react" })).status).toBe(200)
    expect(await state(vue)).toMatchObject({ skip_reason: "keyword_mismatch" })
    expect((await database.db.selectFrom("application").select("submission_state").where("id", "=", applicationId).executeTakeFirstOrThrow()).submission_state).toBe("queued")
    expect(await events()).toBe(before)
  })
})

describe("queued Applications at their next claim (R6-AC13, :670, :702, :708)", () => {
  async function queuedFor(postingId: string): Promise<string> {
    const applicationId = randomUUID()
    const url = `https://boards.greenhouse.io/globex/jobs/${postingId}`
    await database.db
      .insertInto("application")
      .values({ candidate_id: database.operatorId, id: applicationId, job_posting_id: postingId, application_url: url, requisition_id: postingId.slice(0, 8), company: `Globex ${postingId.slice(0, 4)}`, role_title: "Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(), submission_state: "queued", submission_kind: "automatic" } as never)
      .execute()
    return applicationId
  }
  const kinds = async (applicationId: string) => (await database.db.selectFrom("submission_event").select("kind").where("application_id", "=", applicationId).execute()).map((row) => row.kind)
  const claim = (applicationId: string) => asOperator(app, app.get(SubmissionRepository)).claim(applicationId, "automatic", "2026-10-21", clock.now())

  it.each([
    ["the title keyword react", "Senior Vue Engineer", "senior_frontend", { titleKeyword: "react" }],
    ["tiers with mobile excluded", "Senior Android Engineer", "mobile", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, mobile: "excluded" } }],
  ] as const)(":670 a save of %s moves the posting out of Ranked; its queued Application is dropped at the claim with queued_posting_preferences_changed", async (_label, title, family, change) => {
    await save({ titleKeyword: null })
    const posting = await seed({ title, family, status: "ranked" })
    const applicationId = await queuedFor(posting)
    expect((await save(change as Partial<PreferencesValues>)).status).toBe(200)
    expect(await claim(applicationId)).toEqual({ refused: "posting_closed" })
    expect(await kinds(applicationId)).toEqual(["queued_posting_preferences_changed"])
    // Merge with main 0422b14 (v1.24.0 AA-2.5, D8): a drop returns the Application to documents ready, not not_submitted.
    expect(await database.db.selectFrom("application").select(["submission_state", "state"]).where("id", "=", applicationId).executeTakeFirstOrThrow()).toEqual({ submission_state: null, state: "documents_ready" })
  })

  it(":702 a closed (not_checked) posting still logs queued_posting_dropped; :708 the daily summary's Dropped list counts both kinds", async () => {
    const closed = await seed({ title: "Senior React Engineer", status: "not_checked" })
    const closedApp = await queuedFor(closed)
    expect(await claim(closedApp)).toEqual({ refused: "posting_closed" })
    expect(await kinds(closedApp)).toEqual(["queued_posting_dropped"])
    const skipped = await seed({ title: "Senior Vue Engineer", status: "skipped", skipReason: "keyword_mismatch" })
    const skippedApp = await queuedFor(skipped)
    expect(await claim(skippedApp)).toEqual({ refused: "posting_closed" })
    expect(await kinds(skippedApp)).toEqual(["queued_posting_preferences_changed"])
    // :708 the daily summary's Dropped list holds both (dailySummaryFacts, the E3 query).
    const facts = await app.get(TenantDatabase).asOperator(() => app.get(NotificationRepository).dailySummaryFacts("2026-10-21"))
    expect(facts.dropped.map((row) => row.company).sort()).toEqual([`Globex ${closed.slice(0, 4)}`, `Globex ${skipped.slice(0, 4)}`].sort())
  })
})

describe(":695 the claim re-checks Eligibility against the current preferences version (R6-AC13, architecture r4 :426)", () => {
  async function queuedEligible(change: Readonly<{ employmentType?: "contract" | "direct"; text?: string }> = {}): Promise<{ applicationId: string; postingId: string }> {
    const postingId = await seed({ title: "Senior React Engineer", status: "ranked" })
    await database.db.updateTable("job_posting").set({ posting_text: change.text ?? "Remote, open to candidates in Nigeria. Independent contractor engagement." }).where("id", "=", postingId).execute()
    await database.db
      .insertInto("eligibility_result")
      .values({
        candidate_id: database.operatorId, job_posting_id: postingId, arrangement: "remote", relocation_country: null, employment_type: change.employmentType ?? "contract",
        rules: JSON.stringify([
          { rule: "location", result: "met", quote: "Remote, open to candidates in Nigeria" },
          { rule: "sponsorship", result: "not_applicable", quote: null },
          { rule: "pay", result: "unverified", quote: null },
          { rule: "hours", result: "unverified", quote: null },
          { rule: "industry", result: "met", quote: null },
          { rule: "seniority", result: "not_applicable", quote: null },
          { rule: "employment_type", result: "not_applicable", quote: null },
        ]),
        eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date(),
      } as never)
      .execute()
    const applicationId = randomUUID()
    const url = `https://boards.greenhouse.io/globex/jobs/${postingId}`
    await database.db
      .insertInto("application")
      .values({ candidate_id: database.operatorId, id: applicationId, job_posting_id: postingId, application_url: url, requisition_id: postingId.slice(0, 8), company: `Initech ${postingId.slice(0, 4)}`, role_title: "Senior React Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(), submission_state: "queued", submission_kind: "automatic" } as never)
      .execute()
    return { applicationId, postingId }
  }
  const claim = (applicationId: string) => asOperator(app, app.get(SubmissionRepository)).claim(applicationId, "automatic", "2026-10-21", clock.now())
  const kinds = async (applicationId: string) => (await database.db.selectFrom("submission_event").select("kind").where("application_id", "=", applicationId).execute()).map((row) => row.kind)

  it("an employment type no longer accepted drops the queued Application at its claim with queued_posting_preferences_changed", async () => {
    await save({ employmentTypes: ["direct", "employer_of_record", "contract"] })
    const { applicationId, postingId } = await queuedEligible()
    expect((await save({ employmentTypes: ["direct"] })).status).toBe(200)
    // The posting is still ranked: only the claim's Eligibility re-check sees the change.
    expect(await state(postingId)).toMatchObject({ status: "ranked" })
    expect(await claim(applicationId)).toEqual({ refused: "posting_closed" })
    expect(await kinds(applicationId)).toEqual(["queued_posting_preferences_changed"])
    // Merge with main 0422b14 (v1.24.0 AA-2.5, D8): a drop returns the Application to documents ready, not not_submitted.
    expect(await database.db.selectFrom("application").select(["submission_state", "state"]).where("id", "=", applicationId).executeTakeFirstOrThrow()).toEqual({ submission_state: null, state: "documents_ready" })
  })

  it("a change that leaves every rule as it was does not drop it (the re-check is not a drop on mere Unverified)", async () => {
    await save({ employmentTypes: ["direct", "employer_of_record", "contract"] })
    const { applicationId } = await queuedEligible({ employmentType: "direct", text: "Remote, open to candidates in Nigeria. Full-time permanent employee." })
    expect((await save({ employmentTypes: ["direct"], payFloor: { amount: "1500.00", currency: "USD", period: "month", basis: "gross" } })).status).toBe(200)
    const result = await claim(applicationId)
    expect(result).not.toEqual({ refused: "posting_closed" })
    expect(await kinds(applicationId)).not.toContain("queued_posting_preferences_changed")
  })
})

describe("apply anyway meets B1 (merge with main 6933243; CR-B1-02): an override never covers a rule it was not recorded against", () => {
  async function overrideFor(postingId: string, status: string): Promise<string> {
    const applicationId = randomUUID()
    const url = `https://boards.greenhouse.io/globex/jobs/${postingId}`
    await database.db
      .insertInto("application")
      .values({ candidate_id: database.operatorId, id: applicationId, job_posting_id: postingId, application_url: url, requisition_id: postingId.slice(0, 8), company: `Umbrella ${postingId.slice(0, 4)}`, role_title: status, state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(), submission_state: "queued", submission_kind: "automatic", candidate_override_at: new Date() } as never)
      .execute()
    return applicationId
  }
  const claim = (applicationId: string) => asOperator(app, app.get(SubmissionRepository)).claim(applicationId, "automatic", "2026-10-21", clock.now())

  // Merge with main 0422b14 (v1.24.0 AA-2.3, AA-2.7, TM-F-03): a legacy override (time only) never makes a non-ranked
  // posting submittable, and neither B1 skip reason is overridable. The claim drops it as override_mismatch: the
  // Candidate's override no longer applies, which is not a preferences drop, so it logs queued_posting_dropped.
  it.each([
    ["keyword_mismatch", "Senior Vue Engineer", "senior_frontend", { titleKeyword: "react" }],
    ["excluded_role_family", "Senior Android Engineer", "mobile", { roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS, mobile: "excluded" } }],
  ] as const)("a queued override whose posting a later save skips as %s is dropped as override_mismatch (queued_posting_dropped, not queued_posting_preferences_changed)", async (reason, title, family, change) => {
    await save({ titleKeyword: null, roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS } })
    const posting = await seed({ title, family, status: "ranked" })
    const applicationId = await overrideFor(posting, "override")
    expect((await save(change as Partial<PreferencesValues>)).status).toBe(200)
    expect(await state(posting)).toMatchObject({ status: "skipped", skip_reason: reason })
    expect(await claim(applicationId)).toEqual({ refused: "posting_closed" })
    expect(await database.db.selectFrom("submission_event").select(["kind", "detail"]).where("application_id", "=", applicationId).execute()).toEqual([{ kind: "queued_posting_dropped", detail: "override_mismatch" }])
  })

  // Architecture r6 CR-B1-02: the Eligibility re-check runs for every queued Application the status check finds
  // submittable, with or without an override; a recorded override (here a legacy `candidate_override_at` on a ranked
  // posting) never skips it. Under D47 the drop logs queued_posting_preferences_changed with detail not_ranked.
  it("CR-B1-02: an override does not skip the Eligibility re-check at its claim; a newly violated rule drops it", async () => {
    await save({ employmentTypes: ["direct", "employer_of_record", "contract"] })
    const posting = await seed({ title: "Senior React Engineer", status: "ranked" })
    await database.db.updateTable("job_posting").set({ posting_text: "Remote, open to candidates in Nigeria. Independent contractor engagement." }).where("id", "=", posting).execute()
    await database.db
      .insertInto("eligibility_result")
      .values({ candidate_id: database.operatorId, job_posting_id: posting, arrangement: "remote", relocation_country: null, employment_type: "contract", rules: JSON.stringify([{ rule: "location", result: "met", quote: "Remote, open to candidates in Nigeria" }, { rule: "employment_type", result: "not_applicable", quote: null }]), eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date() } as never)
      .execute()
    const applicationId = await overrideFor(posting, "override")
    expect((await save({ employmentTypes: ["direct"] })).status).toBe(200)
    expect(await claim(applicationId)).toEqual({ refused: "posting_closed" })
    expect(await database.db.selectFrom("submission_event").select(["kind", "detail"]).where("application_id", "=", applicationId).execute()).toEqual([{ kind: "queued_posting_preferences_changed", detail: "not_ranked" }])
    expect(await database.db.selectFrom("application").select(["submission_state", "state"]).where("id", "=", applicationId).executeTakeFirstOrThrow()).toEqual({ submission_state: null, state: "documents_ready" })
  })

  // CR-B1-02: a v1.24.0 Apply anyway override of a weak_core_match posting (through the real route) followed by an
  // Eligibility change. The override still applies to the unchanged decision, but it never covers an Eligibility
  // violation: the claim's re-check drops it and nothing is submitted.
  it("CR-B1-02: apply anyway on a weak_core_match posting, then accepted employment types narrowed to direct: the claim drops it, nothing submitted", async () => {
    await save({ employmentTypes: ["direct", "employer_of_record", "contract"] })
    const posting = await seed({ title: "Senior React Engineer", status: "skipped", skipReason: "weak_core_match" })
    await database.db.updateTable("job_posting").set({ posting_text: "Remote, open to candidates in Nigeria. Independent contractor engagement." }).where("id", "=", posting).execute()
    await database.db
      .insertInto("eligibility_result")
      .values({ candidate_id: database.operatorId, job_posting_id: posting, arrangement: "remote", relocation_country: null, employment_type: "contract", rules: JSON.stringify([{ rule: "location", result: "met", quote: "Remote, open to candidates in Nigeria" }, { rule: "employment_type", result: "not_applicable", quote: null }]), eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date() } as never)
      .execute()
    const offered = (await ada.get(`/v1/job-postings/${posting}`).expect(200)).body.applyAnyway
    expect(offered).toMatchObject({ offered: true, decision: { status: "skipped", skipReason: "weak_core_match", violatedRules: [] } })
    const created = await ada.post("/v1/applications").send({ jobPostingId: posting, acknowledgement: { confirmed: true, decision: offered.decision } })
    expect(created.status).toBe(201)
    const applicationId: string = created.body.application.id
    await database.db.updateTable("application").set({ state: "documents_ready", career_profile_version: 1, submission_state: "queued", submission_kind: "automatic" } as never).where("id", "=", applicationId).execute()
    expect(await database.db.selectFrom("application").select(["override_status", "override_skip_reason"]).where("id", "=", applicationId).executeTakeFirstOrThrow()).toEqual({ override_status: "skipped", override_skip_reason: "weak_core_match" })
    expect((await save({ employmentTypes: ["direct"] })).status).toBe(200)
    // The stored decision is unchanged (D21: an Eligibility field change re-decides no stored posting), so the override applies.
    expect(await state(posting)).toMatchObject({ status: "skipped", skip_reason: "weak_core_match" })
    expect(await claim(applicationId)).toEqual({ refused: "posting_closed" })
    expect(await database.db.selectFrom("submission_event").select(["kind", "detail"]).where("application_id", "=", applicationId).execute()).toEqual([{ kind: "queued_posting_preferences_changed", detail: "not_ranked" }])
    // Nothing submitted: no attempt claimed, no Submit click, no reserved browser cost.
    expect(await database.db.selectFrom("application").select(["submission_state", "state", "attempt_id", "submit_clicked_at"]).where("id", "=", applicationId).executeTakeFirstOrThrow()).toEqual({ submission_state: null, state: "documents_ready", attempt_id: null, submit_clicked_at: null })
    expect(await database.db.selectFrom("spend_entry").select("id").where("application_id", "=", applicationId).execute()).toEqual([])
  })
})
