import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { INestApplication } from "@nestjs/common"
import { ME_PREFERENCES_PATH, type PreferencesValues, preferencesResponseSchema, preferencesValuesSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { PreferencesSaveLimiter } from "../src/preferences/preferences-save-limit.guard.js"
import { WORK_LABELS_FILE, WORK_SNAPSHOT_FILE, buildWorkSnapshot } from "../src/submission/__golden__/work-question-regression.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { SubmissionService } from "../src/submission/submission.service.js"
import { OWNER_WORK_CONTEXT } from "../src/submission/work-context.js"
import type { FormControl } from "../src/submission/form-session.js"
import { Browser } from "./support/browser.js"
import { insertEligibilityFor, insertPostingFor } from "./support/candidate-posting.js"
import { FakeAtsForms, STANDARD_FORM, STANDARD_SCHEMA } from "./support/fake-ats-form.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 B1 continuation (run epic-0002-b1-2, qa-tests-1): CR-B1-01 / code
 * review F-01 through the real answer path. architecture.r6.md "B1 amendment
 * (code review CR-B1-01): work-question step 6": an "outside / other than /
 * apart from X" phrase, "any other country", or an EU/Europe entry answers "No"
 * only when every authorized country is excluded; otherwise the answer is
 * `unclear`, which takes an exact custom Approved Answer or hard-blocks.
 *
 * The Operator saves her countries through `PUT /v1/me/preferences`; the
 * Application is submitted by the real SubmissionService against the
 * in-process fake Greenhouse form, whose API schema carries the work question
 * matched to its control by name (scope 05d). Nothing reaches a network host.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let storage: string
const forms = new FakeAtsForms()
const clock = new TestClock("2026-10-31T09:00:00.000Z")
const APPLY_HOST = "boards.greenhouse.io"
const YES_NO = ["Yes", "No"]

/** The three exclusion phrasings of the amendment (P1, P2, P3), X = Nigeria. */
const P1 = "Are you authorized to work outside Nigeria?"
const P2 = "Are you authorized to work in any country other than Nigeria?"
const P3 = "Are you authorized to work apart from Nigeria?"
const ANY_OTHER = "Are you authorized to work in any other country?"
const EU = "Are you authorized to work in the EU?"
const EUROPE = "Are you authorized to work in Europe?"

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-b1-qa-work-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage }, formSessions: forms, questionSchemas: forms.questionSchemas })
  ada = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  clock.set("2026-10-31T09:00:00.000Z")
  app.get(PreferencesSaveLimiter).reset()
  for (const table of ["notification_outbox", "submission_event", "tailored_document", "application", "candidate_posting", "job_posting", "submission_day", "approved_answer"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-30T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

/** Saves the Operator's countries authorized without sponsorship through the real preferences route (home NG first). */
type Country = PreferencesValues["workAuthorizedCountries"][number]

async function saveCountries(authorized: readonly Country[]): Promise<void> {
  app.get(PreferencesSaveLimiter).reset()
  const current = preferencesResponseSchema.parse((await ada.get(ME_PREFERENCES_PATH).expect(200)).body)
  const values: PreferencesValues = preferencesValuesSchema.parse({ ...current.values, homeCountry: "NG", workAuthorizedCountries: [...authorized] })
  const saved = await ada.put(ME_PREFERENCES_PATH).send({ baseVersion: current.version, values })
  expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  expect(preferencesResponseSchema.parse(saved.body).values.workAuthorizedCountries).toEqual(authorized)
}

/** A queued automatic Application for a ranked Greenhouse posting, with tailored documents (as submission.int-spec readyApplication). */
async function queuedApplication(): Promise<string> {
  const postingId = randomUUID()
  const requisition = `R-${randomUUID().slice(0, 6)}`
  const url = `https://${APPLY_HOST}/globex/jobs/${requisition}`
  await insertPostingFor(database.db, database.operatorId, {
    id: postingId, application_url: url, requisition_id: requisition, apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board",
    employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company: "Globex",
    posting_text: "Relocation to the United States.", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend",
    discovered_at: new Date(), evaluated_at: new Date(),
  })
  await insertEligibilityFor(database.db, database.operatorId, postingId)
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({
      candidate_id: database.operatorId, id, job_posting_id: postingId, application_url: url, requisition_id: requisition, company: "Globex", role_title: "Senior Frontend Engineer",
      state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(),
      submission_state: "queued", submission_kind: "automatic",
    } as never)
    .execute()
  for (const kind of ["resume", "cover_letter"] as const) {
    await database.db
      .insertInto("tailored_document")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: "{}", pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: new Date() })
      .execute()
  }
  return id
}

/** The standard form plus one required work question, schema-matched by field name as Greenhouse's API returns it. */
function useWorkForm(label: string): void {
  const control: FormControl = { ref: "auth", label, kind: "select", required: true, options: ["Please select", ...YES_NO], fieldName: "question_auth", fieldId: "question_auth" }
  forms.use({ host: APPLY_HOST, controls: [...STANDARD_FORM, control], schema: [...STANDARD_SCHEMA, { text: label, fieldName: "question_auth", options: YES_NO }] })
}

async function submit(label: string) {
  useWorkForm(label)
  const id = await queuedApplication()
  const result = await asOperator(app, app.get(SubmissionService)).submit(id, "automatic")
  const row = await database.db.selectFrom("application").select(["submission_state", "blocked_reason", "blocked_detail"]).where("id", "=", id).executeTakeFirstOrThrow()
  const authFills = forms.filled.filter((fill) => fill.ref === "auth").map((fill) => fill.value)
  return { id, result, row, authFills, clicks: forms.clicks.length }
}

const MULTI_COUNTRY: ReadonlyArray<readonly [authorized: readonly Country[], label: string]> = [
  // Amendment table: [NG, GB] P1, P2, P3 → unclear; "any other country" → unclear.
  [["NG", "GB"], P1],
  [["NG", "GB"], P2],
  [["NG", "GB"], P3],
  [["NG", "GB"], ANY_OTHER],
  // 6b: `eu` / `europe` cover REGION_MEMBERS.europe, which holds GB.
  [["NG", "GB"], EU],
  [["NG", "GB"], EUROPE],
  // EU-member second country: [NG, DE] EU / Europe → unclear (amendment table), and the exclusion phrasings.
  [["NG", "DE"], EU],
  [["NG", "DE"], EUROPE],
  [["NG", "DE"], P1],
  [["NG", "DE"], P2],
  [["NG", "DE"], P3],
  [["NG", "DE"], ANY_OTHER],
]

describe("CR-B1-01: a Candidate authorized in two countries never gets a false 'No' (architecture.r6 B1 amendment, step 6)", () => {
  it("the saved countries reach the answer sources as the work context", async () => {
    await saveCountries(["NG", "GB"])
    const id = await queuedApplication()
    const sources = await asOperator(app, app.get(SubmissionRepository)).loadAnswerSources(id)
    expect(sources.work).toEqual({ home: "NG", authorized: ["NG", "GB"], sponsorshipNeeded: true })
  })

  it.each(MULTI_COUNTRY)("%j, %s: no Approved Answer → hard block (missing_approved_answer), nothing entered, no click, never 'No'", async (authorized, label) => {
    await saveCountries(authorized)
    const outcome = await submit(label)
    expect(outcome.authFills).not.toContain("No")
    expect(outcome.authFills).toEqual([])
    expect(outcome.clicks).toBe(0)
    expect(outcome.result).toEqual({ result: "blocked" })
    expect(outcome.row).toMatchObject({ submission_state: "blocked", blocked_reason: "missing_approved_answer" })
    expect(outcome.row.blocked_detail).toContain(label)
  })

  it.each(MULTI_COUNTRY)("%j, %s: an exact custom Approved Answer is used instead of 'No'", async (authorized, label) => {
    await saveCountries(authorized)
    await ada.post("/v1/approved-answers").send({ group: "custom", question: label, value: "Yes" }).expect(201)
    const outcome = await submit(label)
    expect(outcome.authFills).toEqual(["Yes"])
    expect(outcome.result).toEqual({ result: "confirmed" })
  })
})

describe("the single-country Operator [NG] still answers 'No' (amendment: 'Equivalence for [NG]')", () => {
  it.each([P1, P2, P3, ANY_OTHER, EU, EUROPE])("[NG], %s: 'No' is entered and the Submission is confirmed", async (label) => {
    await saveCountries(["NG"])
    const outcome = await submit(label)
    expect(outcome.authFills).toEqual(["No"])
    expect(outcome.result).toEqual({ result: "confirmed" })
  })
})

/**
 * qa-tests-2 (run epic-0002-b1-2): SEC-B1-2-01 qualified-name guard, architecture.r6.md
 * step 6b (2026-11-01 amendment, fixtures table). An `OTHER_PLACES` match immediately
 * preceded by a place qualifier (`new`, `north`, `northern`, ..., or hyphenated as
 * `north-western`) answers `unclear`, never "No". A match that already includes its
 * qualifier (`northern ireland` for [NG], `new zealand`) is unaffected.
 *
 * Not asserted here: the fixtures-table row "[NG] …in South Africa? → not_authorized".
 * "south africa" contains `africa`, which is in slice 5's NIGERIA_OR_WIDER (step 5), so
 * slice 5 and this candidate both answer `unclear` before step 6 is reached. The row
 * contradicts the unchanged step 5; reported to the architect in qa-tests.r1.md.
 */
const NORTHERN_IRELAND = "Are you authorized to work in Northern Ireland?"
const NEW_MEXICO = "Are you authorized to work in New Mexico?"
const NEW_ENGLAND = "Are you authorized to work in New England?"
const NW_CANADA = "Are you authorized to work in north-western Canada?"
const NEW_ZEALAND = "Are you authorized to work in New Zealand?"

const QUALIFIED_UNCLEAR: ReadonlyArray<readonly [authorized: readonly Country[], label: string]> = [
  // GB authorized: the GB entry holding `northern ireland` is removed, so `ireland` matches after "Northern".
  [["NG", "GB"], NORTHERN_IRELAND],
  // IE authorized: the `ireland` entry is removed; the GB entry `northern ireland` names a non-authorized place, but the table says unclear.
  [["NG", "IE"], NORTHERN_IRELAND],
  // US authorized: `mexico` / `england` follow the qualifier "New".
  [["NG", "US"], NEW_MEXICO],
  [["NG", "US"], NEW_ENGLAND],
  // Hyphenated qualifier before `canada`.
  [["NG", "US"], NW_CANADA],
  // [NG]: the guard applies in every context. Was "No" in slice 5, now unclear (never a false answer).
  [["NG"], NEW_MEXICO],
]

describe("SEC-B1-2-01: a place qualifier before a listed country name takes the unclear path, never 'No' (architecture.r6 step 6b guard)", () => {
  it.each(QUALIFIED_UNCLEAR)("%j, %s: no Approved Answer → hard block (missing_approved_answer), nothing entered, no click, never 'No'", async (authorized, label) => {
    await saveCountries(authorized)
    const outcome = await submit(label)
    expect(outcome.authFills).not.toContain("No")
    expect(outcome.authFills).toEqual([])
    expect(outcome.clicks).toBe(0)
    expect(outcome.result).toEqual({ result: "blocked" })
    expect(outcome.row).toMatchObject({ submission_state: "blocked", blocked_reason: "missing_approved_answer" })
    expect(outcome.row.blocked_detail).toContain(label)
  })

  it.each(QUALIFIED_UNCLEAR)("%j, %s: an exact custom Approved Answer is used instead of 'No'", async (authorized, label) => {
    await saveCountries(authorized)
    await ada.post("/v1/approved-answers").send({ group: "custom", question: label, value: "Yes" }).expect(201)
    const outcome = await submit(label)
    expect(outcome.authFills).toEqual(["Yes"])
    expect(outcome.result).toEqual({ result: "confirmed" })
  })
})

describe("SEC-B1-2-01 controls: a qualifier that is part of the matched entry still answers 'No' for [NG] (fixtures table, unchanged)", () => {
  it.each([NEW_ZEALAND, NORTHERN_IRELAND])("[NG], %s: 'No' is entered and the Submission is confirmed", async (label) => {
    await saveCountries(["NG"])
    const outcome = await submit(label)
    expect(outcome.authFills).toEqual(["No"])
    expect(outcome.result).toEqual({ result: "confirmed" })
  })
})

describe("the A0 work-question golden stays byte-equal (apps/api/src/submission/__golden__/work-question-regression.spec.ts)", () => {
  it("the Operator's migrated preferences load as OWNER_WORK_CONTEXT, and the golden built with it equals the committed snapshot", async () => {
    // A fresh database copy would carry the migrated values; here the Operator saves [NG] back through the route first.
    await saveCountries(["NG"])
    const id = await queuedApplication()
    const sources = await asOperator(app, app.get(SubmissionRepository)).loadAnswerSources(id)
    expect(sources.work).toEqual(OWNER_WORK_CONTEXT)
    const golden = (file: string) => readFile(fileURLToPath(new URL(`../src/submission/__golden__/${file}`, import.meta.url)), "utf8")
    expect(buildWorkSnapshot(await golden(WORK_LABELS_FILE))).toBe(await golden(WORK_SNAPSHOT_FILE))
  })
})
