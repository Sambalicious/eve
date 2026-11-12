import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication, INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import {
  APPLICATIONS_PATH,
  DEFAULT_SENIORITY_FLOOR,
  DEFAULT_TARGET_ROLE_FAMILIES,
  DELETE_DETAILS_PATH,
  JOB_CRITERIA_PATH,
  JOB_POSTINGS_PATH,
  SAMPLES_PREPARE_PATH,
  apiErrorResponseSchema,
  applicationDetailSchema,
  applicationsResponseSchema,
  createApplicationResponseSchema,
  jobPostingDetailSchema,
  jobPostingsResponseSchema,
  prepareSamplesResultSchema,
  sampleResultSchema,
  submissionListResponseSchema,
  submissionSchema,
} from "@eve/contracts"
import { type Transaction, sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { WORKER_STATEMENT_TIMEOUT_MS, createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { GmailSmtpMailer } from "../src/notification/mailer.js"
import { type MailerConfig, mailerConfig } from "../src/notification/mailer-config.js"
import { NotificationSender } from "../src/notification/notification-sender.js"
import { NotificationWorkerModule } from "../src/notification/notification.module.js"
import { RetentionRunner } from "../src/records/retention-runner.js"
import { CLOCK } from "../src/shared/clock.js"
import { SampleSubmissionRunner } from "../src/submission/sample-submission-runner.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { SubmissionService } from "../src/submission/submission.service.js"
import { Browser } from "./support/browser.js"
import { setCriteria, signInSecondCandidate } from "./support/epic-0006.js"
import { FakeAtsForms, STANDARD_FORM } from "./support/fake-ats-form.js"
import { FakeGoogle } from "./support/fake-google.js"
import { FakeSmtp, plainText } from "./support/fake-smtp.js"
import { backendPid, untilLockWait } from "./support/lock-wait.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import {
  AA_COPY,
  CLEARANCE,
  type Decision,
  INDUSTRY,
  KOTLIN,
  NO_CORE,
  type Posting,
  type PostingSpec,
  RANKED,
  WEAK,
  ack,
  applicationSnapshot,
  applicationsFor,
  excluded,
  formControlCount,
  hidePosting,
  insertApplication,
  insertDecidedPosting,
  overrideColumns,
  redecide,
  setLegacyOverride,
  setOldImageOverride,
  setOverride,
  skipped,
  statusOnly,
  submissionEvents,
  tailoredCount,
} from "./support/qa-apply-anyway-bounds.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { PUBLIC_ORIGIN, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA test authoring, step [5e] (apply anyway, bounds and consent). QA-authored,
 * independent of the implementation. Targets api-contract.md v1.24.0 "Apply
 * anyway: bounds and consent" and gherkin/apply-anyway.feature (each test name
 * starts with `apply-anyway:<line>` and its @AA tags), plus the r-AA amended
 * scenarios in gherkin/SUMMARY.md (`r-AA <file>:<line>`). Real api app, real
 * Postgres (runtime role for HTTP), the in-process fake ATS form (no network)
 * and an in-process fake SMTP server.
 *
 * The three submission checks are exercised one at a time through the
 * repository methods the contract names (`claim`, `dropQueuedUnlessRanked`,
 * `markSubmitting`), as submission.int-spec.ts does for SEC-014 and SEC-017,
 * and end to end through `SubmissionService.submit` with fake-form hooks.
 *
 * Written before the candidate exists: expected red until the backend lands
 * migration 0026, the new create checks, the override fields and the
 * remove-from-queue route.
 */
const SENDER = "ada.okafor@gmail.com"
const APP_PASSWORD = "abcdefghijklmnop"
const APPLY_HOST = "boards.greenhouse.io"
/** 09:00 WAT on 2026-10-29. */
const NOW = "2026-10-29T08:00:00.000Z"
const TODAY = "2026-10-29"
const EARLIER = new Date("2026-10-28T11:00:00Z")

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate
let anonymous: Browser
let kofi: SignedInCandidate
let storage: string
let smtp: FakeSmtp
let mailer: MailerConfig
let sender: INestApplicationContext
const forms = new FakeAtsForms()
const clock = new TestClock(NOW)

async function bootSender(): Promise<INestApplicationContext> {
  const { ConfigModule } = await import("../src/config/config.module.js")
  const { DatabaseModule } = await import("../src/db/database.module.js")
  const { ClockModule } = await import("../src/shared/clock.js")
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ databaseUrl: database.url, statementTimeoutMs: 60_000, anthropic: anthropicConfig(undefined, "claude-haiku-5-5") }),
      ClockModule,
      DatabaseModule,
      NotificationWorkerModule.forRoot(mailer, { mailer: new GmailSmtpMailer(mailer, { connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 1_500 }) }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  moduleRef.useLogger(false)
  await moduleRef.init()
  return moduleRef
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-qa-aa-bounds-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  smtp = new FakeSmtp(SENDER, APP_PASSWORD)
  await smtp.start()
  mailer = mailerConfig({ user: SENDER, to: SENDER, dashboardOrigin: PUBLIC_ORIGIN, transport: { host: "127.0.0.1", port: smtp.port, secure: false, ignoreTLS: true }, appPassword: APP_PASSWORD })
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage }, formSessions: forms, questionSchemas: forms.questionSchemas })
  candidate = await signInCandidate(new Browser(app, google))
  anonymous = new Browser(app, google)
  kofi = (await signInSecondCandidate(app, google, database.db, { sub: "200000000000000000aa1", email: "kofi.aa@example.test" })).candidate
  sender = await bootSender()
})

beforeEach(async () => {
  clock.set(NOW)
  smtp.reset()
  for (const table of [
    "notification_outbox",
    "notification_sender_state",
    "submission_event",
    "application_form_read",
    "tailored_document",
    "outcome",
    "application",
    "match_evidence",
    "eligibility_result",
    "candidate_posting",
    "job_posting",
    "existing_application",
    "submission_day",
    "retention_run",
  ] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false, existing_applications_completed_at: null }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
  await sql`update job_criteria set target_role_families = default, seniority_floor = default, min_core_match_percent = 70, frameworks = '{}', technologies = '{}', version = 1`.execute(database.db)
  forms.use({ host: APPLY_HOST, controls: STANDARD_FORM })
})

afterAll(async () => {
  await sender?.close()
  await app?.close()
  await smtp?.stop()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

// ── helpers ────────────────────────────────────────────────────

const ada = () => database.operatorId
const now = () => clock.now()
const service = () => asOperator(app, app.get(SubmissionService))
const repo = () => asOperator(app, app.get(SubmissionRepository))
const row = (id: string) => database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
const passGate = () => database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()

const posting = (spec: PostingSpec) => insertDecidedPosting(database.db, ada(), now(), spec)
const decide = (p: Posting, decision: Decision) => redecide(database.db, ada(), p.id, now(), decision)

const createRaw = (body: Record<string, unknown>) => candidate.post(APPLICATIONS_PATH).send(body)
/** `decision` undefined: no acknowledgement key; null: `acknowledgement: null`. */
const create = (p: Posting, decision?: Decision | null) => createRaw(decision === undefined ? { jobPostingId: p.id } : { jobPostingId: p.id, acknowledgement: decision === null ? null : ack(decision) })

function expectRefused(response: { status: number; body: unknown }, code: string, message?: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(409)
  const error = apiErrorResponseSchema.parse(response.body).error
  expect(error.code).toBe(code)
  if (message !== undefined) expect(error.message).toBe(message)
}

const postingDetail = async (p: Posting) => jobPostingDetailSchema.parse((await candidate.get(`${JOB_POSTINGS_PATH}/${p.id}`).expect(200)).body)
const applicationDetail = async (id: string) => applicationDetailSchema.parse((await candidate.get(`${APPLICATIONS_PATH}/${id}`).expect(200)).body)
const submissionOf = async (id: string) => submissionSchema.parse((await candidate.get(`${APPLICATIONS_PATH}/${id}/submission`).expect(200)).body)
const removeFromQueue = (id: string, who: SignedInCandidate = candidate) => who.post(`${APPLICATIONS_PATH}/${id}/remove-from-queue`).send({})

/** Today's automatic count is `n`: Confirmed automatic Applications submitted today on other postings. */
async function confirmedToday(n: number) {
  for (let i = 0; i < n; i += 1) {
    const p = await posting({ decision: RANKED, company: `Done ${i} Co` })
    await insertApplication(database.db, ada(), p, now(), { submissionState: "confirmed", extra: { submitted_local_day: TODAY, submit_clicked_at: now(), confirmed_at: now(), evidence_kind: "confirmation_page", attempt_id: randomUUID(), attempt_number: 1 } })
  }
}

/** A queued automatic Application on a posting with `spec.decision`, with documents; `override` stores a decision, a legacy time, or nothing. */
async function queuedOverride(spec: PostingSpec, override: Decision | "legacy" | null, seed: Parameters<typeof insertApplication>[4] = {}) {
  const p = await posting(spec)
  const id = await insertApplication(database.db, ada(), p, now(), { submissionState: "queued", queuedForLocalDay: TODAY, ...seed })
  if (override === "legacy") await setLegacyOverride(database.db, id, EARLIER)
  else if (override !== null) await setOverride(database.db, id, EARLIER, override)
  return { id, posting: p }
}

/** Contract "Drop": returned to documents ready, not queued. */
async function expectDocumentsReady(id: string) {
  expect(await row(id)).toMatchObject({ state: "documents_ready", submission_state: null, submission_kind: null, queued_for_local_day: null })
}

/** The single `queued_posting_dropped` event's detail. */
async function dropDetail(id: string) {
  const events = (await submissionEvents(database.db, id)).filter((e) => e.kind === "queued_posting_dropped")
  expect(events, "exactly one queued_posting_dropped event").toHaveLength(1)
  return events[0]!.detail
}

const send = () => sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())
const summaryRow = (day = TODAY) => database.db.insertInto("notification_outbox").values({ id: randomUUID(), candidate_id: ada(), application_id: null, kind: "daily_summary", local_day: day, created_at: now(), sent_at: null }).execute()

/** The decoded text/html part (quoted-printable), tags stripped and the usual entities decoded. */
function htmlText(raw: string): string {
  const match = /Content-Type: text\/html[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n--/i.exec(raw)
  const body = (match?.[1] ?? "").replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  return Buffer.from(body, "latin1")
    .toString("utf8")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

const linesOf = (text: string) => text.split(/\r?\n/).map((l) => l.trim())

// ════════════════════════════════════════════════════════════
// AA-1. Which decisions can be overridden (POST /v1/applications order of checks)
// ════════════════════════════════════════════════════════════

const OVERRIDABLE: readonly (readonly [string, Decision])[] = [
  ["weak_core_match", WEAK],
  ["uncovered_mandatory_prerequisite", KOTLIN],
  ["no_core_responsibilities", NO_CORE],
  ["Industry-only exclusion", INDUSTRY],
]

describe("AA-1.1 overridable decisions: applyAnyway is offered and the create records the decision", () => {
  it.each(OVERRIDABLE)("apply-anyway:44 @AA-1.1 @AA-4.1 %s: JobPostingDetail.applyAnyway carries the current decision, applicationId null", async (_label, decision) => {
    const p = await posting({ decision, requisition: "R-4101" })
    const detail = await postingDetail(p)
    expect(detail.applyAnyway).toEqual({ offered: true, decision: ack(decision).decision })
    expect(detail.applicationId).toBeNull()
  })

  it.each(OVERRIDABLE)("apply-anyway:59 @AA-1.1 @AA-2.2 %s: a create with the matching acknowledgement is 201 and stores the decision on one Application", async (_label, decision) => {
    await passGate()
    const p = await posting({ decision, requisition: "R-4101" })
    const response = await create(p, decision)
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const body = createApplicationResponseSchema.parse(response.body)
    expect(body.created).toBe(true)
    expect(body.application.override).toMatchObject({ ...ack(decision).decision, applies: true, notAppliesReason: null })
    expect(await applicationsFor(database.db, p.id)).toHaveLength(1)
    expect(await overrideColumns(database.db, body.application.id)).toMatchObject({
      override_status: decision.status,
      override_skip_reason: decision.skipReason,
      override_skip_detail: decision.skipDetail,
      override_violated_rules: [...decision.violatedRules],
      candidate_override_at: null,
    })
    expect((await row(body.application.id)).state).toBe("prepared")
  })

  it("apply-anyway:78 @AA-1.1 unverified and not-applicable rules beside a violated industry rule stay overridable; violatedRules is exactly [industry]", async () => {
    const p = await posting({
      decision: INDUSTRY,
      company: "Lucky Odds Ltd",
      requisition: "LO-11",
      rules: [
        { rule: "location", result: "met", quote: "Remote" },
        { rule: "sponsorship", result: "not_applicable", quote: null },
        { rule: "pay", result: "unverified", quote: null },
        { rule: "hours", result: "unverified", quote: null },
      ],
    })
    expect((await postingDetail(p)).applyAnyway?.decision.violatedRules).toEqual(["industry"])
    expect((await create(p, INDUSTRY)).status).toBe(201)
  })
})

describe("AA-1.2 to AA-1.4 non-overridable decisions are refused and nothing is written", () => {
  it.each([[["location"]], [["sponsorship"]], [["pay"]], [["hours"]], [["industry", "location"]], [["industry", "sponsorship"]], [["industry", "pay"]], [["industry", "hours"]]] as const)(
    "apply-anyway:88 @AA-1.2 @AA-1.3 @AA-1.4 excluded with violated rules %j: applyAnyway null, create 409 override_not_allowed (C-AA-10), not application_not_eligible",
    async (rules) => {
      const decision = excluded(...rules)
      const p = await posting({ decision, company: "Initech", requisition: "IN-21" })
      expect((await postingDetail(p)).applyAnyway).toBeNull()
      const response = await create(p, decision)
      expectRefused(response, "override_not_allowed", AA_COPY.overrideNotAllowed)
      expect(apiErrorResponseSchema.parse(response.body).error.message).not.toBe(AA_COPY.notEligible)
      expect(await applicationsFor(database.db, p.id)).toEqual([])
    }
  )

  it("apply-anyway:110 @AA-1.2 @AA-1.4 a stored rule unknown to the check (commute) beside industry is echoed (no 400) and refused override_not_allowed", async () => {
    const decision = excluded("industry", "commute")
    const p = await posting({ decision, requisition: "IN-22" })
    expect((await postingDetail(p)).applyAnyway).toBeNull()
    expectRefused(await create(p, decision), "override_not_allowed", AA_COPY.overrideNotAllowed)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it("contract 'Overridable decision': an excluded posting with no Eligibility result is not overridable", async () => {
    const decision: Decision = { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: [] }
    const p = await posting({ decision, noEligibility: true })
    expect((await postingDetail(p)).applyAnyway).toBeNull()
    expectRefused(await create(p, decision), "override_not_allowed", AA_COPY.overrideNotAllowed)
  })

  it.each([["technology_mismatch", null]] as const)(
    "apply-anyway:120 @AA-1.2 @AA-1.3 @AA-1.4 skipped for %s: applyAnyway null, create 409 override_not_allowed",
    async (reason, detail) => {
    const decision = skipped(reason, detail)
    const p = await posting({ decision, company: "Contoso", requisition: "CO-31" })
      expect((await postingDetail(p)).applyAnyway).toBeNull()
      expectRefused(await create(p, decision), "override_not_allowed", AA_COPY.overrideNotAllowed)
      expect(await applicationsFor(database.db, p.id)).toEqual([])
    }
  )

  it("apply-anyway:135 @AA-1.2 @AA-1.4 a not_software_role posting is hidden: create 409 posting_hidden", async () => {
    const decision = skipped("not_software_role")
    const p = await posting({ decision, title: "Sales Engineer", company: "Hooli", requisition: "HO-41", prefilterNotSoftware: true })
    expectRefused(await create(p, decision), "posting_hidden", AA_COPY.postingHidden)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it.each(["checking", "waiting_to_be_checked", "not_checked", "evaluation_failed"] as const)(
    "apply-anyway:142 @AA-1.2 @AA-7.3 a visible %s posting: applyAnyway null, create 409 application_not_eligible with its exact message",
    async (status) => {
      const decision = statusOnly(status)
      const p = await posting({ decision, requisition: "UM-51" })
      expect((await postingDetail(p)).applyAnyway).toBeNull()
      expectRefused(await create(p, decision), "application_not_eligible", AA_COPY.notEligible)
      expect(await applicationsFor(database.db, p.id)).toEqual([])
    }
  )

  it("apply-anyway:159 @AA-1.2 @AA-7.2 @AA-7.5 a hidden posting (role family unchecked) with an overridable decision: posting_hidden before the override checks", async () => {
    const p = await posting({ decision: WEAK, title: "Senior Platform Engineer", company: "Lumon", requisition: "LU-61", family: "data_ml" })
    expect((await postingDetail(p)).applyAnyway).toBeNull()
    expectRefused(await create(p, WEAK), "posting_hidden", AA_COPY.postingHidden)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it("contract step 3: a hidden posting that already has an Application is posting_hidden whatever the acknowledgement, Application unchanged", async () => {
    const p = await posting({ decision: WEAK, hidden: true })
    const id = await insertApplication(database.db, ada(), p, now())
    const before = await applicationSnapshot(database.db, id)
    expectRefused(await create(p, WEAK), "posting_hidden", AA_COPY.postingHidden)
    expect(await applicationSnapshot(database.db, id)).toBe(before)
  })

  it("apply-anyway:167 @AA-1.2 refusing an override leaves an existing documents-ready Application with no override unchanged", async () => {
    const decision = excluded("location")
    const p = await posting({ decision, requisition: "IN-23" })
    const id = await insertApplication(database.db, ada(), p, now(), { formControls: 3 })
    const before = await applicationSnapshot(database.db, id)
    expectRefused(await create(p, decision), "override_not_allowed", AA_COPY.overrideNotAllowed)
    expect(await applicationSnapshot(database.db, id)).toBe(before)
    expect((await overrideColumns(database.db, id)).override_created_at).toBeNull()
    expect(await tailoredCount(database.db, id)).toBe(2)
  })

  it("apply-anyway:176 @AA-1.4 an acknowledgement claiming an overridable decision for a non-overridable posting is override_not_allowed (step 6 before step 8)", async () => {
    const p = await posting({ decision: excluded("location"), requisition: "IN-24" })
    expectRefused(await create(p, WEAK), "override_not_allowed", AA_COPY.overrideNotAllowed)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it("contract step 2: a posting the session Candidate does not hold is 404 not_found, never a 409", async () => {
    const p = await posting({ decision: WEAK })
    const response = await kofi.post(APPLICATIONS_PATH).send({ jobPostingId: p.id, acknowledgement: ack(WEAK) })
    expect(response.status).toBe(404)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("not_found")
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it.each([
    ["an unknown key", { ...ack(WEAK), extra: 1 }],
    ["confirmed false", { confirmed: false, decision: ack(WEAK).decision }],
    ["a status outside the enum", { confirmed: true, decision: { ...ack(WEAK).decision, status: "maybe" } }],
    ["a skip reason outside the enum", { confirmed: true, decision: { ...ack(WEAK).decision, skipReason: "vibes" } }],
    ["a bad rule name", { confirmed: true, decision: { ...ack(INDUSTRY).decision, violatedRules: ["Industry!"] } }],
    ["duplicate rules", { confirmed: true, decision: { ...ack(INDUSTRY).decision, violatedRules: ["industry", "industry"] } }],
    ["a skip detail over 500 characters", { confirmed: true, decision: { ...ack(KOTLIN).decision, skipDetail: "x".repeat(501) } }],
  ])("contract step 1: a malformed acknowledgement (%s) is 400 bad_request and nothing changes", async (_label, acknowledgement) => {
    const p = await posting({ decision: WEAK })
    const response = await createRaw({ jobPostingId: p.id, acknowledgement })
    expect(response.status).toBe(400)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("bad_request")
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it("contract: a well-formed but wrong acknowledgement (status checking) is not a 400; it reaches step 8 (override_decision_changed)", async () => {
    const p = await posting({ decision: WEAK })
    expectRefused(await create(p, statusOnly("checking")), "override_decision_changed", AA_COPY.overrideDecisionChanged)
  })

  it("apply-anyway:1195 @permission @AA-2.1 an unauthenticated create with an acknowledgement is 401 and creates nothing", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4701" })
    const response = await anonymous.http().post(APPLICATIONS_PATH).send({ jobPostingId: p.id, acknowledgement: ack(WEAK) })
    expect(response.status).toBe(401)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })
})

describe("AA-1.5, AA-1.6 the posting is never changed and the ranked path is unchanged", () => {
  it("apply-anyway:185 @AA-1.5 an override never changes the posting's status, reason, rank or tab", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4101" })
    const held = () => database.db.selectFrom("candidate_posting").selectAll().where("job_posting_id", "=", p.id).execute()
    const before = await held()
    expect((await create(p, WEAK)).status).toBe(201)
    expect(await held()).toEqual(before)
    expect(await postingDetail(p)).toMatchObject({ status: "skipped", skipReason: "weak_core_match", rank: null })
    const tab = async (name: string) => jobPostingsResponseSchema.parse((await candidate.get(`${JOB_POSTINGS_PATH}?tab=${name}&limit=100`).expect(200)).body).postings.map((x) => x.id)
    expect(await tab("skipped")).toContain(p.id)
    expect(await tab("ranked")).not.toContain(p.id)
  })

  it("apply-anyway:194 @AA-1.6 @AA-6.4 a ranked posting with no acknowledgement: 201 with override null, no override columns", async () => {
    const p = await posting({ decision: RANKED, company: "Globex", title: "Frontend Lead", requisition: "L-77" })
    const body = createApplicationResponseSchema.parse((await create(p).expect(201)).body)
    expect(body.application.override).toBeNull()
    expect((await overrideColumns(database.db, body.application.id)).override_created_at).toBeNull()
  })

  it("contract step 5: an acknowledgement on a ranked posting is ignored (201, override null); a repeat is 200 created false", async () => {
    const p = await posting({ decision: RANKED })
    const first = createApplicationResponseSchema.parse((await create(p, WEAK).expect(201)).body)
    expect(first.application.override).toBeNull()
    const second = createApplicationResponseSchema.parse((await create(p, WEAK).expect(200)).body)
    expect(second).toMatchObject({ created: false, application: { id: first.application.id, override: null } })
  })
})

// ════════════════════════════════════════════════════════════
// AA-2.1, AA-2.2 acknowledgement and stored decision
// ════════════════════════════════════════════════════════════

describe("AA-2.1 the acknowledgement must be present and equal the current decision", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
  ] as const)("apply-anyway:209 @AA-2.1 @AA-7.3 a weak-skip posting with the acknowledgement %s: 409 override_acknowledgement_missing (C-AA-12)", async (_label, value) => {
    const p = await posting({ decision: WEAK, requisition: "R-4102" })
    expectRefused(await create(p, value), "override_acknowledgement_missing", AA_COPY.overrideAcknowledgementMissing)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it("apply-anyway:216 @AA-2.1 @AA-7.3 an Industry-only exclusion with no acknowledgement: 409 override_acknowledgement_missing (C-AA-12)", async () => {
    const p = await posting({ decision: INDUSTRY, requisition: "LO-12" })
    expectRefused(await create(p), "override_acknowledgement_missing", AA_COPY.overrideAcknowledgementMissing)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it.each([
    ["weak_core_match", WEAK],
    ["a different prerequisite", CLEARANCE],
    ["no_core_responsibilities", NO_CORE],
    ["an Industry-only exclusion", INDUSTRY],
  ] as const)("apply-anyway:223 @AA-2.1 @AA-7.3 a Kotlin-prerequisite posting acknowledged as %s: 409 override_decision_changed (C-AA-9)", async (_label, acknowledged) => {
    const p = await posting({ decision: KOTLIN, requisition: "R-4103" })
    expectRefused(await create(p, acknowledged), "override_decision_changed", AA_COPY.overrideDecisionChanged)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it("apply-anyway:237 @AA-2.1 an acknowledged rule set {industry, hours} against current {industry}: 409 override_decision_changed", async () => {
    const p = await posting({ decision: INDUSTRY, requisition: "LO-13" })
    expectRefused(await create(p, excluded("industry", "hours")), "override_decision_changed", AA_COPY.overrideDecisionChanged)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it("apply-anyway:244 + :255 @AA-2.1 @AA-4.2 the decision changes while the dialog is open: refused, the detail serves the new decision, and confirming that stores it", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4104" })
    const shown = (await postingDetail(p)).applyAnyway!.decision
    await decide(p, CLEARANCE)
    expectRefused(await createRaw({ jobPostingId: p.id, acknowledgement: { confirmed: true, decision: shown } }), "override_decision_changed", AA_COPY.overrideDecisionChanged)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
    const reloaded = (await postingDetail(p)).applyAnyway
    expect(reloaded?.decision).toEqual(ack(CLEARANCE).decision)
    const created = createApplicationResponseSchema.parse((await createRaw({ jobPostingId: p.id, acknowledgement: { confirmed: true, decision: reloaded!.decision } }).expect(201)).body)
    expect(await overrideColumns(database.db, created.application.id)).toMatchObject({ override_skip_reason: "uncovered_mandatory_prerequisite", override_skip_detail: "Active security clearance" })
  })

  it("apply-anyway:263 @AA-2.1 @AA-1.6 a posting that became ranked before Confirm: the stale acknowledgement gives a normal Application (201, override null)", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4105" })
    await decide(p, RANKED)
    const body = createApplicationResponseSchema.parse((await create(p, WEAK).expect(201)).body)
    expect(body.application.override).toBeNull()
    expect((await overrideColumns(database.db, body.application.id)).override_created_at).toBeNull()
  })

  it("apply-anyway:274 @AA-2.2 the override stores the request time and the decision from the locked read", async () => {
    clock.set("2026-10-29T09:00:00.000Z") // 10:00 WAT
    const p = await posting({ decision: INDUSTRY, company: "Lucky Odds Ltd", requisition: "LO-14" })
    const body = createApplicationResponseSchema.parse((await create(p, INDUSTRY).expect(201)).body)
    expect(new Date(body.application.override!.createdAt).toISOString()).toBe("2026-10-29T09:00:00.000Z")
    expect(await overrideColumns(database.db, body.application.id)).toEqual({
      override_created_at: new Date("2026-10-29T09:00:00.000Z"),
      override_status: "excluded",
      override_skip_reason: "violated_rule",
      override_skip_detail: "industry",
      override_violated_rules: ["industry"],
      candidate_override_at: null,
    })
  })
})

// ════════════════════════════════════════════════════════════
// AA-2.3, AA-4.3 applies and notAppliesReason
// ════════════════════════════════════════════════════════════

describe("AA-2.3 / AA-4.3 whether an override applies follows the current decision", () => {
  const CASES: readonly (readonly [string, Decision, boolean, boolean, string | null])[] = [
    ["visible, same prerequisite", KOTLIN, false, true, null],
    ["visible and ranked", RANKED, false, true, null],
    ["visible, different prerequisite", CLEARANCE, false, false, "decision_changed"],
    ["visible, weak_core_match", WEAK, false, false, "decision_changed"],
    ["visible, excluded location", excluded("location"), false, false, "decision_changed"],
    ["visible, evaluation_failed", statusOnly("evaluation_failed"), false, false, "decision_changed"],
    ["visible, checking", statusOnly("checking"), false, false, "decision_changed"],
    ["visible, waiting_to_be_checked", statusOnly("waiting_to_be_checked"), false, false, "decision_changed"],
    ["visible, not_checked", statusOnly("not_checked"), false, false, "decision_changed"],
    ["hidden, same prerequisite", KOTLIN, true, false, "hidden"],
    ["hidden and ranked", RANKED, true, false, "hidden"],
    ["hidden, excluded location", excluded("location"), true, false, "hidden"],
  ]

  it.each(CASES)("apply-anyway:283 @AA-2.3 @AA-4.3 stored Kotlin prerequisite, posting now %s: applies/notAppliesReason equal on the detail, the list and the Submission", async (_label, current, hidden, applies, reason) => {
    const p = await posting({ decision: KOTLIN, requisition: "R-4106" })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOverride(database.db, id, EARLIER, KOTLIN)
    await decide(p, current)
    if (hidden) await hidePosting(database.db, p.id)
    const detail = await applicationDetail(id)
    expect(detail.override).toMatchObject({ applies, notAppliesReason: reason, status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Professional Kotlin Android experience", violatedRules: [] })
    expect(detail.posting).toEqual({ status: current.status, hidden })
    const listed = applicationsResponseSchema.parse((await candidate.get(APPLICATIONS_PATH).expect(200)).body).applications.find((a) => a.id === id)
    expect(listed?.override).toEqual(detail.override)
    expect((await submissionOf(id)).override).toEqual(detail.override)
  })

  it("apply-anyway:705 @AA-4.3 the summary and its Submission carry the same override: stored time and decision, applies true, notAppliesReason null", async () => {
    const p = await posting({ decision: INDUSTRY, requisition: "LO-18" })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOverride(database.db, id, new Date("2026-10-29T09:00:00.000Z"), INDUSTRY)
    const summary = (await applicationDetail(id)).override
    expect(summary).toMatchObject({ status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"], applies: true, notAppliesReason: null })
    expect(new Date(summary!.createdAt).toISOString()).toBe("2026-10-29T09:00:00.000Z")
    expect((await submissionOf(id)).override).toEqual(summary)
  })

  it("apply-anyway:712 @AA-4.3 @AA-4.7 an Application with no override exposes override null on the detail, the list and the Submission", async () => {
    const p = await posting({ decision: RANKED, requisition: "L-77" })
    const id = await insertApplication(database.db, ada(), p, now())
    expect((await applicationDetail(id)).override).toBeNull()
    expect(applicationsResponseSchema.parse((await candidate.get(APPLICATIONS_PATH).expect(200)).body).applications.find((a) => a.id === id)?.override).toBeNull()
    expect((await submissionOf(id)).override).toBeNull()
  })

  it("apply-anyway:720 @AA-4.4 Blocked and Uncertain rows of GET /v1/submissions carry the override on the summary and on the Submission", async () => {
    const blockedPosting = await posting({ decision: WEAK, company: "Blocked Co" })
    const blocked = await insertApplication(database.db, ada(), blockedPosting, now(), { submissionState: "blocked", extra: { blocked_reason: "missing_approved_answer", blocked_at: now() } })
    const uncertainPosting = await posting({ decision: WEAK, company: "Uncertain Co" })
    const uncertain = await insertApplication(database.db, ada(), uncertainPosting, now(), { submissionState: "uncertain", extra: { submit_clicked_at: now(), submitted_local_day: TODAY, attempt_id: randomUUID(), attempt_number: 1 } })
    for (const id of [blocked, uncertain]) await setOverride(database.db, id, EARLIER, WEAK)
    for (const [view, id] of [["blocked", blocked], ["uncertain", uncertain]] as const) {
      const rows = submissionListResponseSchema.parse((await candidate.get(`/v1/submissions?view=${view}`).expect(200)).body).rows
      const found = rows.find((r) => r.application.id === id)
      expect(found?.application.override).toMatchObject({ skipReason: "weak_core_match" })
      expect(found?.submission.override).toEqual(found?.application.override)
    }
  })

  it.each([null, "queued"] as const)("apply-anyway:778 @AA-4.3 @AA-4.5 @AA-2.3 submission state %s, override on a visible ranked posting: applies true", async (submissionState) => {
    const p = await posting({ decision: RANKED, requisition: "R-4313" })
    const id = await insertApplication(database.db, ada(), p, now(), { submissionState })
    await setOverride(database.db, id, EARLIER, WEAK)
    expect((await applicationDetail(id)).override).toMatchObject({ applies: true, notAppliesReason: null })
  })

  it.each([
    [null, excluded("location"), false, "decision_changed"],
    [null, NO_CORE, false, "decision_changed"],
    [null, statusOnly("checking"), false, "decision_changed"],
    [null, statusOnly("evaluation_failed"), false, "decision_changed"],
    [null, WEAK, true, "hidden"],
    ["queued", excluded("location"), false, "decision_changed"],
    ["queued", statusOnly("checking"), false, "decision_changed"],
    ["queued", WEAK, true, "hidden"],
  ] as const)("apply-anyway:747 @AA-4.5 submission state %s, stored weak skip, posting now %o (hidden %s): the backend half (applies false, reason %s, posting)", async (submissionState, current, hidden, reason) => {
    const p = await posting({ decision: WEAK, requisition: "R-4309" })
    const id = await insertApplication(database.db, ada(), p, now(), { submissionState })
    await setOverride(database.db, id, EARLIER, WEAK)
    await decide(p, current)
    if (hidden) await hidePosting(database.db, p.id)
    const detail = await applicationDetail(id)
    expect(detail.override).toMatchObject({ applies: false, notAppliesReason: reason })
    expect(detail.posting).toEqual({ status: current.status, hidden })
    expect(detail.detailsDeletedAt ?? null).toBeNull()
  })

  it("contract 'ApplicationDetail': posting is null when the Candidate no longer holds the posting; the override reads decision_changed", async () => {
    const p = await posting({ decision: WEAK })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOverride(database.db, id, EARLIER, WEAK)
    await database.db.deleteFrom("candidate_posting").where("candidate_id", "=", ada()).where("job_posting_id", "=", p.id).execute()
    const detail = await applicationDetail(id)
    expect(detail.posting).toBeNull()
    expect(detail.override).toMatchObject({ applies: false, notAppliesReason: "decision_changed" })
  })
})

describe("AA-2.7 legacy overrides (time only) apply only on a visible ranked posting", () => {
  it("apply-anyway:471 @AA-2.7 a legacy override on a visible weak-skip posting: applies false, legacy_no_decision, stored fields null, createdAt kept", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4115" })
    const id = await insertApplication(database.db, ada(), p, now())
    await setLegacyOverride(database.db, id, EARLIER)
    const override = (await applicationDetail(id)).override
    expect(override).toMatchObject({ applies: false, notAppliesReason: "legacy_no_decision", status: null, skipReason: null, skipDetail: null, violatedRules: null })
    expect(new Date(override!.createdAt).toISOString()).toBe(EARLIER.toISOString())
  })

  it("apply-anyway:480 @AA-2.7 @AA-4.3 a hidden legacy override reports hidden first", async () => {
    const p = await posting({ decision: WEAK, hidden: true })
    const id = await insertApplication(database.db, ada(), p, now())
    await setLegacyOverride(database.db, id, EARLIER)
    expect((await applicationDetail(id)).override).toMatchObject({ applies: false, notAppliesReason: "hidden" })
  })

  it("apply-anyway:488 @AA-2.7 @AA-4.3 a legacy override on a visible ranked posting applies", async () => {
    const p = await posting({ decision: RANKED })
    const id = await insertApplication(database.db, ada(), p, now())
    await setLegacyOverride(database.db, id, EARLIER)
    expect((await applicationDetail(id)).override).toMatchObject({ applies: true, notAppliesReason: null })
  })

  it("contract 'Migration': candidate_override_at written by a v1.23.x image during a rolling deploy reads as a legacy override", async () => {
    const p = await posting({ decision: WEAK })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOldImageOverride(database.db, id, new Date("2026-10-29T07:00:00Z"))
    expect((await applicationDetail(id)).override).toMatchObject({ applies: false, notAppliesReason: "legacy_no_decision", status: null })
  })

  it("apply-anyway:496 @AA-2.7 @AA-2.4 a queued legacy override is dropped at the claim to documents ready (detail override_mismatch); nothing submitted", async () => {
    await passGate()
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4116" }, "legacy")
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    await expectDocumentsReady(q.id)
    expect(await dropDetail(q.id)).toBe("override_mismatch")
    expect(forms.clicks).toEqual([])
  })

  it("contract 'Automatic submission': a bare candidate_override_at (old image) never makes an excluded posting submittable", async () => {
    await passGate()
    const q = await queuedOverride({ decision: INDUSTRY }, null)
    await setOldImageOverride(database.db, q.id, new Date("2026-10-29T07:00:00Z"))
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.clicks).toEqual([])
    await expectDocumentsReady(q.id)
  })
})

// ════════════════════════════════════════════════════════════
// AA-2.4 to AA-2.6 the three submission checks
// ════════════════════════════════════════════════════════════

/** Runs `change` once, at the first fill (the form is being filled; the claim has happened). */
function onFirstFill(change: () => Promise<void>) {
  let fired = false
  return async () => {
    if (fired) return
    fired = true
    await change()
  }
}

describe("AA-2.4 the three checks accept an override whose decision still applies", () => {
  it("apply-anyway:306 @AA-2.3 @AA-2.4 a queued Industry-only override still matching is submitted end to end; count 1 -> 2; no drop event", async () => {
    await passGate()
    await confirmedToday(1)
    const q = await queuedOverride({ decision: INDUSTRY, company: "Lucky Odds Ltd", requisition: "LO-15" }, INDUSTRY)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    expect(forms.clicks).toHaveLength(1)
    expect(await repo().countForDay(TODAY)).toBe(2)
    expect((await submissionEvents(database.db, q.id)).map((e) => e.kind)).not.toContain("queued_posting_dropped")
  })

  it("apply-anyway:306 @AA-2.4 each check on its own accepts it: pre-attempt keeps it queued, the claim succeeds, the pre-click check answers submitting", async () => {
    await passGate()
    const q = await queuedOverride({ decision: INDUSTRY }, INDUSTRY)
    expect(await repo().dropQueuedUnlessRanked(q.id, now())).toBe(false)
    const claim = await repo().claim(q.id, "automatic", TODAY, now())
    expect(claim).toHaveProperty("attemptId")
    expect(await repo().markSubmitting(q.id, (claim as { attemptId: string }).attemptId, "automatic", now())).toBe("submitting")
  })

  it("apply-anyway:318 @AA-2.3 a posting that became ranked is submitted as ranked whatever the override stores", async () => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4107" }, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    expect(forms.clicks).toHaveLength(1)
  })

  it("apply-anyway:449 @AA-2.6 a decision that changes and changes back before any check still applies (comparison, not a latch)", async () => {
    await passGate()
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4113" }, WEAK)
    await decide(q.posting, skipped("technology_mismatch"))
    await decide(q.posting, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    expect(forms.clicks).toHaveLength(1)
  })
})

describe("AA-2.4 / AA-2.5 a queued override that no longer applies is dropped at each check to documents ready (CR-AA-07: each check on its own)", () => {
  const CLAIM: readonly (readonly [string, Decision])[] = [
    ["skipped uncovered_mandatory_prerequisite", CLEARANCE],
    ["excluded location", excluded("location")],
    ["evaluation_failed", statusOnly("evaluation_failed")],
  ]
  const PRE_ATTEMPT: readonly (readonly [string, Decision])[] = [
    ["skipped no_core_responsibilities", NO_CORE],
    ["excluded industry", INDUSTRY],
    ["checking", statusOnly("checking")],
  ]
  const PRE_CLICK: readonly (readonly [string, Decision])[] = [
    ["skipped uncovered_mandatory_prerequisite", CLEARANCE],
    ["excluded hours", excluded("hours")],
    ["evaluation_failed", statusOnly("evaluation_failed")],
  ]

  it.each(CLAIM)("apply-anyway:329 @AA-2.4 @AA-2.5 at the claim (%s before it): refused posting_closed, documents ready, detail override_mismatch, count still 1", async (_label, next) => {
    await passGate()
    await confirmedToday(1)
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4108" }, WEAK)
    await decide(q.posting, next)
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    await expectDocumentsReady(q.id)
    expect(await dropDetail(q.id)).toBe("override_mismatch")
    expect(await repo().countForDay(TODAY)).toBe(1)
  })

  it.each(CLAIM)("apply-anyway:329 @AA-7.5 end to end (%s before the run): no page opened, nothing clicked, documents ready, count still 1", async (_label, next) => {
    await passGate()
    await confirmedToday(1)
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4108" }, WEAK)
    await decide(q.posting, next)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.opened).toBe(0)
    expect(forms.clicks).toEqual([])
    await expectDocumentsReady(q.id)
    expect(await repo().countForDay(TODAY)).toBe(1)
  })

  it.each(PRE_ATTEMPT)("apply-anyway:329 @AA-2.4 at the pre-attempt check (%s after the claim decision, before the lease): dropped to documents ready, detail override_mismatch", async (_label, next) => {
    await passGate()
    await confirmedToday(1)
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4108" }, WEAK)
    await decide(q.posting, next)
    expect(await repo().dropQueuedUnlessRanked(q.id, now())).toBe(true)
    await expectDocumentsReady(q.id)
    expect(await dropDetail(q.id)).toBe("override_mismatch")
    expect(await repo().countForDay(TODAY)).toBe(1)
  })

  it.each(PRE_CLICK)("apply-anyway:329 @AA-2.4 @AA-2.5 at the pre-click check (%s after the claim): posting_closed, claim undone, documents ready, slot free", async (_label, next) => {
    await passGate()
    await confirmedToday(1)
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4108" }, WEAK)
    const attemptBefore = (await row(q.id)).attempt_number
    const claim = await repo().claim(q.id, "automatic", TODAY, now())
    expect(claim).toHaveProperty("attemptId")
    await decide(q.posting, next)
    expect(await repo().markSubmitting(q.id, (claim as { attemptId: string }).attemptId, "automatic", now())).toBe("posting_closed")
    expect(await row(q.id)).toMatchObject({ state: "documents_ready", submission_state: null, submission_kind: null, queued_for_local_day: null, attempt_id: null, submitted_local_day: null, submit_clicked_at: null, attempt_number: attemptBefore })
    expect(await dropDetail(q.id)).toBe("override_mismatch")
    expect(await repo().countForDay(TODAY)).toBe(1)
  })

  it.each(PRE_CLICK)("apply-anyway:329 end to end (%s while the form is filled): filled, never clicked, documents ready, count still 1", async (_label, next) => {
    await passGate()
    await confirmedToday(1)
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4108" }, WEAK)
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, onFill: onFirstFill(() => decide(q.posting, next)) })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.filled.length).toBeGreaterThan(0)
    expect(forms.clicks).toEqual([])
    await expectDocumentsReady(q.id)
    expect(await repo().countForDay(TODAY)).toBe(1)
  })

  it("apply-anyway:354 @AA-2.4 @AA-2.3 an Industry-only override is dropped at the claim when location joins the violated set (skip detail still industry)", async () => {
    await passGate()
    const q = await queuedOverride({ decision: INDUSTRY, requisition: "LO-16" }, INDUSTRY)
    await decide(q.posting, excluded("industry", "location"))
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    await expectDocumentsReady(q.id)
    expect(forms.clicks).toEqual([])
  })

  it("apply-anyway:364 @AA-2.4 @AA-7.5 a queued override whose posting becomes hidden (role family unchecked) is dropped at the claim with detail hidden", async () => {
    await passGate()
    const q = await queuedOverride({ decision: WEAK, requisition: "LU-62" }, WEAK)
    await setCriteria(database.db, ada(), { targets: ["backend"] })
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    await expectDocumentsReady(q.id)
    expect(await dropDetail(q.id)).toBe("hidden")
  })

  it("apply-anyway:376 @AA-2.4 @AA-2.3 @AA-7.5 ranked, then a different reason, then the overridden reason: applies, dropped at the claim, then accepted again", async () => {
    await passGate()
    const p = await posting({ decision: WEAK, requisition: "R-4109" })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOverride(database.db, id, EARLIER, WEAK)
    await decide(p, RANKED)
    expect((await applicationDetail(id)).override).toMatchObject({ applies: true })
    await decide(p, skipped("uncovered_mandatory_prerequisite", "Active security clearance"))
    await candidate.post(`${APPLICATIONS_PATH}/${id}/queue`).expect(200)
    expect(await repo().claim(id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    await expectDocumentsReady(id)
    await decide(p, WEAK)
    expect((await applicationDetail(id)).override).toMatchObject({ applies: true, notAppliesReason: null })
    await candidate.post(`${APPLICATIONS_PATH}/${id}/queue`).expect(200)
    expect(await repo().claim(id, "automatic", TODAY, now())).toHaveProperty("attemptId")
  })

  it("apply-anyway:392 @AA-2.5 a dropped override keeps documents, 6 form answers and its override; queued day cleared; event logged; no slot used", async () => {
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4110" }, WEAK, { formControls: 6 })
    const overrideBefore = await overrideColumns(database.db, q.id)
    await decide(q.posting, excluded("pay"))
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    expect(await row(q.id)).toMatchObject({ state: "documents_ready", submission_state: null, queued_for_local_day: null })
    expect(await tailoredCount(database.db, q.id)).toBe(2)
    expect(await formControlCount(database.db, q.id)).toBe(6)
    expect(await overrideColumns(database.db, q.id)).toEqual(overrideBefore)
    expect((await submissionEvents(database.db, q.id)).map((e) => e.kind)).toContain("queued_posting_dropped")
    expect(await repo().countForDay(TODAY)).toBe(0)
  })

  it("apply-anyway:405 @AA-2.5 a drop at the pre-click check frees the claimed slot: count stays 4 and the next automatic submission is the fifth", async () => {
    await passGate()
    await confirmedToday(4)
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4111" }, WEAK)
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, onFill: onFirstFill(() => decide(q.posting, NO_CORE)) })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.clicks).toEqual([])
    await expectDocumentsReady(q.id)
    expect(await repo().countForDay(TODAY)).toBe(4)
    const next = await queuedOverride({ decision: RANKED, company: "Globex" }, null)
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM })
    expect(await service().submit(next.id, "automatic")).toEqual({ result: "confirmed" })
    expect(await repo().countForDay(TODAY)).toBe(5)
  })
})

describe("AA-2.5 every non-submittable queued automatic Application (no override) returns to documents ready with the drop detail", () => {
  const CAUSES: readonly (readonly [string, (p: Posting) => Promise<void>, string])[] = [
    ["the Job Posting has closed (evaluation_failed posting_unavailable)", (p) => redecide(database.db, ada(), p.id, now(), statusOnly("evaluation_failed"), { evaluationFailure: "posting_unavailable" }), "closed"],
    ["a criteria save re-decided it skipped weak_core_match", (p) => decide(p, WEAK), "not_ranked"],
    ["a criteria save re-decided it skipped technology_mismatch", (p) => decide(p, skipped("technology_mismatch")), "not_ranked"],
    ["re-evaluated as excluded hours", (p) => decide(p, excluded("hours")), "not_ranked"],
    ["hidden because it aged past 60 days", (p) => hidePosting(database.db, p.id), "hidden"],
    ["being re-checked (checking) at claim time", (p) => decide(p, statusOnly("checking")), "not_ranked"],
  ]

  it.each(CAUSES)("apply-anyway:418 @AA-2.5 @AA-7.3 %s: dropped at the claim to documents ready, documents and answers kept, detail %s", async (_label, cause, detail) => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED, company: "Initech", requisition: "IN-71" }, null, { formControls: 4 })
    await cause(q.posting)
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    await expectDocumentsReady(q.id)
    expect(await tailoredCount(database.db, q.id)).toBe(2)
    expect(await formControlCount(database.db, q.id)).toBe(4)
    expect(await dropDetail(q.id)).toBe(detail)
  })

  it.each(CAUSES)("apply-anyway:418 end to end, %s: never submitted, documents ready", async (_label, cause) => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED, company: "Initech", requisition: "IN-71" }, null)
    await cause(q.posting)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.clicks).toEqual([])
    await expectDocumentsReady(q.id)
  })

  it("apply-anyway:439 @AA-2.5 @P2 a dropped Application (documents ready) no longer blocks deciding again: applyAnyway is offered with the new decision", async () => {
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4112" }, WEAK)
    await decide(q.posting, CLEARANCE)
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    const detail = await postingDetail(q.posting)
    expect(detail.applyAnyway).toEqual({ offered: true, decision: ack(CLEARANCE).decision })
    expect(detail.applicationId).toBe(q.id)
  })

  it("apply-anyway:459 @AA-2.6 @AA-6.2 deciding again replaces the stored decision and takes the request time; applies true", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4114" })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOverride(database.db, id, new Date("2026-10-27T09:00:00Z"), WEAK)
    await decide(p, INDUSTRY)
    clock.set("2026-10-29T10:00:00.000Z") // 11:00 WAT
    const body = createApplicationResponseSchema.parse((await create(p, INDUSTRY).expect(200)).body)
    expect(body).toMatchObject({ created: false, application: { id, override: { status: "excluded", skipReason: "violated_rule", skipDetail: "industry", violatedRules: ["industry"], applies: true } } })
    expect(await overrideColumns(database.db, id)).toMatchObject({ override_created_at: new Date("2026-10-29T10:00:00.000Z"), override_status: "excluded", override_violated_rules: ["industry"] })
  })
})

describe("r-AA amended scenarios: no-override drops return to documents ready", () => {
  it("r-AA daily-cap-and-duplicates.feature:270 a fresh attempt after 'not submitted' whose posting closed is dropped to documents ready with attempt number 1", async () => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED, company: "Fresh Co" }, null, { attemptNumber: 1, extra: { marked_not_submitted_at: EARLIER } })
    await redecide(database.db, ada(), q.posting.id, now(), statusOnly("evaluation_failed"), { evaluationFailure: "posting_unavailable" })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    await expectDocumentsReady(q.id)
    expect((await row(q.id)).attempt_number).toBe(1)
    expect((await row(q.id)).marked_not_submitted_at).toEqual(EARLIER)
  })

  it("r-AA match-and-ranking.feature:85 a weak-Match queued Application with no override is never submitted to fill an unused slot", async () => {
    await passGate()
    const q = await queuedOverride({ decision: WEAK, company: "Weak Co" }, null)
    expect(await service().runDaily()).toMatchObject({ submitted: 0 })
    expect(forms.clicks).toEqual([])
    await expectDocumentsReady(q.id)
  })

  it("r-AA EPIC-0006 hidden-postings-applications-and-links.feature:134 unchecking 'Platform engineering' and saving Job criteria (real route) drops the queued Application to documents ready", async () => {
    // F-QG-6: the family-uncheck path itself, through PUT /v1/candidate-settings/job-criteria, not hidePosting.
    await passGate()
    const q = await queuedOverride({ decision: RANKED, title: "Senior Platform Engineer", company: "Lumon", requisition: "LU-134", family: "platform_engineering" }, null, { formControls: 6 })
    expect((await postingDetail(q.posting)).hiddenReason).toBeNull()
    const targetRoleFamilies = DEFAULT_TARGET_ROLE_FAMILIES.filter((family) => family !== "platform_engineering")
    await candidate
      .put(JOB_CRITERIA_PATH)
      .send({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies, seniorityFloor: DEFAULT_SENIORITY_FLOOR })
      .expect(200)
    expect((await postingDetail(q.posting)).hiddenReason).toBe("off_target")
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "posting_closed" })
    expect(forms.clicks).toEqual([])
    await expectDocumentsReady(q.id)
    expect(await tailoredCount(database.db, q.id)).toBe(2)
    expect(await formControlCount(database.db, q.id)).toBe(6)
    expect(await dropDetail(q.id)).toBe("hidden")
  })
})

// ════════════════════════════════════════════════════════════
// AA-2.8 every other submission rule still applies to an applying override
// ════════════════════════════════════════════════════════════

describe("AA-2.8 the usual submission rules hold for a queued override whose decision still applies", () => {
  it("apply-anyway:525 @AA-2.8 cap reached (5 today): no attempt starts and it stays queued for tomorrow", async () => {
    await passGate()
    await confirmedToday(5)
    const q = await queuedOverride({ decision: WEAK, company: "Acme Payments", requisition: "R-4119" }, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "cap_reached" })
    expect(forms.opened).toBe(0)
    expect((await row(q.id)).submission_state).toBe("queued")
  })

  it.each([
    ["global pause", { global_paused: true }],
    ["cost pause", { cost_paused: true }],
  ] as const)("apply-anyway:525 @AA-2.8 %s on: no attempt starts", async (_label, pause) => {
    await passGate()
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4119" }, WEAK)
    await database.db.updateTable("control_state").set(pause).execute()
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "paused" })
    expect(forms.opened).toBe(0)
    expect((await row(q.id)).submission_state).toBe("queued")
  })

  it("apply-anyway:525 @AA-2.8 gate not passed: refused and logged, no page", async () => {
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4119" }, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "gate_not_passed" })
    expect((await submissionEvents(database.db, q.id)).map((e) => e.kind)).toContain("automatic_refused_gate_not_passed")
    expect(forms.opened).toBe(0)
  })

  it("apply-anyway:525 @AA-2.8 automatic submission disabled: the daily run starts nothing", async () => {
    await passGate()
    await database.db.updateTable("activation_state").set({ automatic_enabled: false }).execute()
    await queuedOverride({ decision: WEAK, requisition: "R-4119" }, WEAK)
    expect(await service().runDaily()).toMatchObject({ submitted: 0, stoppedBy: "automatic_disabled" })
    expect(forms.opened).toBe(0)
  })

  it("apply-anyway:525 @AA-2.8 an existing application recorded for the requisition: refused as a duplicate, nothing clicked", async () => {
    await passGate()
    const q = await queuedOverride({ decision: INDUSTRY, requisition: "R-4119" }, INDUSTRY)
    await candidate.post("/v1/existing-applications").send({ company: "Acme Payments", roleTitle: "Frontend Lead", applicationUrl: q.posting.url, requisitionId: q.posting.requisition, appliedOn: "2026-09-30" }).expect(201)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "refused", refusal: "duplicate" })
    expect(forms.clicks).toEqual([])
  })

  it("apply-anyway:525 @AA-2.8 the company has an active Application: held for same-company review", async () => {
    await passGate()
    const other = await posting({ decision: RANKED, company: "Acme Payments", requisition: "R-1042" })
    await insertApplication(database.db, ada(), other, now(), { submissionState: "confirmed", extra: { submitted_local_day: TODAY, submit_clicked_at: now(), attempt_id: randomUUID(), attempt_number: 1 } })
    const q = await queuedOverride({ decision: WEAK, company: "Acme Payments", requisition: "R-4119" }, WEAK)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "blocked" })
    expect(await row(q.id)).toMatchObject({ blocked_reason: "same_company_review" })
  })

  it("apply-anyway:525 @AA-2.8 the form redirects off the application host: Blocked, Automation couldn't complete the form", async () => {
    await passGate()
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4119" }, WEAK)
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, redirectTo: "apply.thirdparty-forms.example" })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "blocked" })
    expect(await row(q.id)).toMatchObject({ submission_state: "blocked", blocked_reason: "automation_incomplete" })
    expect(forms.clicks).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════
// AA-3. Activation Gate samples
// ════════════════════════════════════════════════════════════

/** `n` approved samples that count toward the five. */
async function approvedSamples(n: number) {
  for (let i = 0; i < n; i += 1) {
    const p = await posting({ decision: RANKED, company: `Sample ${i} Co` })
    await insertApplication(database.db, ada(), p, now(), { submissionState: "confirmed", submissionKind: "sample", extra: { sample_state: "approved", sample_counts: true, submit_clicked_at: now(), attempt_id: randomUUID(), attempt_number: 1 } })
  }
}

async function approvedProfile() {
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: ada(), version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: "[]", created_at: now(), approved_at: now() })
    .onConflict((oc) => oc.doNothing())
    .execute()
}

async function strongMatch(postingId: string) {
  await database.db
    .insertInto("match_evidence")
    .values({ candidate_id: ada(), job_posting_id: postingId, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: 8, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: now(), criteria_version: 1 })
    .execute()
}

const makeSample = (id: string) => candidate.post(`${APPLICATIONS_PATH}/${id}/sample`).send({})
const approveSample = async (id: string) => sampleResultSchema.parse((await candidate.post(`${APPLICATIONS_PATH}/${id}/sample/approve`).send({}).expect(200)).body)

describe("AA-3.1 an Application with an override, or whose posting is not ranked, cannot be made a sample", () => {
  it.each([
    ["an applying weak override, posting still weak", WEAK, WEAK as Decision | "legacy"],
    ["a weak override that no longer applies, posting excluded location", excluded("location"), WEAK as Decision | "legacy"],
    ["a weak override, posting ranked", RANKED, WEAK as Decision | "legacy"],
    ["a legacy override, posting ranked", RANKED, "legacy" as Decision | "legacy"],
  ] as const)("apply-anyway:547 @AA-3.1 %s: 409 sample_not_allowed (C-AA-37), not a sample, submission state unchanged", async (_label, current, override) => {
    const p = await posting({ decision: current, requisition: "R-4201" })
    const id = await insertApplication(database.db, ada(), p, now())
    if (override === "legacy") await setLegacyOverride(database.db, id, EARLIER)
    else await setOverride(database.db, id, EARLIER, override)
    expectRefused(await makeSample(id), "sample_not_allowed", AA_COPY.sampleNotAllowed)
    expect(await row(id)).toMatchObject({ sample_state: null, submission_state: null })
  })

  it.each([
    ["skipped weak_core_match", WEAK],
    ["excluded industry", INDUSTRY],
    ["evaluation_failed", statusOnly("evaluation_failed")],
  ] as const)("apply-anyway:565 @AA-3.1 no override, posting visible and %s: 409 sample_not_allowed", async (_label, current) => {
    const p = await posting({ decision: current, requisition: "R-4202" })
    const id = await insertApplication(database.db, ada(), p, now())
    expectRefused(await makeSample(id), "sample_not_allowed", AA_COPY.sampleNotAllowed)
    expect((await row(id)).sample_state).toBeNull()
  })

  it("apply-anyway:580 @AA-3.1 a ranked Application with no override can still be made a sample", async () => {
    const p = await posting({ decision: RANKED, requisition: "R-4203" })
    const id = await insertApplication(database.db, ada(), p, now())
    const submission = submissionSchema.parse((await makeSample(id).expect(200)).body)
    expect(submission.sample).toMatchObject({ state: "awaiting_review" })
  })
})

describe("AA-3.2 / AA-3.3 approving and attempting a sample whose posting changed", () => {
  async function awaitingSample(current: Decision, override: Decision | null = null) {
    const p = await posting({ decision: RANKED, company: "Initech" })
    const id = await insertApplication(database.db, ada(), p, now(), { extra: { sample_state: "awaiting_review" } })
    if (override) await setOverride(database.db, id, EARLIER, override)
    await decide(p, current)
    return { id, posting: p }
  }

  it("apply-anyway:588 @AA-3.2 posting now excluded (location): result excluded, not submitted, count still 2", async () => {
    await approvedSamples(2)
    const s = await awaitingSample(excluded("location"))
    const result = await approveSample(s.id)
    expect(result).toMatchObject({ result: "excluded", countingSamples: 2 })
    expect(await row(s.id)).toMatchObject({ submission_state: "not_submitted", submission_kind: "sample", sample_counts: false })
  })

  it.each([
    ["skipped weak_core_match", WEAK],
    ["evaluation_failed", statusOnly("evaluation_failed")],
    ["checking", statusOnly("checking")],
  ] as const)("apply-anyway:599 @AA-3.2 posting now %s: result not_ranked, not_submitted kind sample, counts false, count still 2", async (_label, current) => {
    await approvedSamples(2)
    const s = await awaitingSample(current)
    const result = await approveSample(s.id)
    expect(result).toMatchObject({ result: "not_ranked", countingSamples: 2 })
    expect(await row(s.id)).toMatchObject({ sample_state: "approved", submission_state: "not_submitted", submission_kind: "sample", sample_counts: false })
    expect(await approveSample(s.id)).toMatchObject({ result: "not_ranked", alreadyDone: true })
  })

  it("apply-anyway:616 @AA-3.2 a sample awaiting review with an override recorded, posting ranked: result not_allowed, nothing sent, count still 2", async () => {
    await approvedSamples(2)
    const s = await awaitingSample(RANKED, WEAK)
    const result = await approveSample(s.id)
    expect(result).toMatchObject({ result: "not_allowed", countingSamples: 2 })
    expect(await row(s.id)).toMatchObject({ submission_state: "not_submitted", submission_kind: "sample", sample_counts: false })
    expect(forms.clicks).toEqual([])
  })

  it("apply-anyway:626 @AA-3.3 a sample whose posting is skipped while the form is filled is not clicked: not_submitted, sample_posting_dropped not_ranked, count still 2", async () => {
    await approvedSamples(2)
    const s = await awaitingSample(RANKED)
    expect(await approveSample(s.id)).toMatchObject({ result: "pending" })
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, onFill: onFirstFill(() => decide(s.posting, WEAK)) })
    await asOperator(app, new SampleSubmissionRunner(service(), app.get(SubmissionRepository), clock)).run(s.id)
    expect(forms.clicks).toEqual([])
    expect(await row(s.id)).toMatchObject({ submission_state: "not_submitted", submission_kind: "sample", sample_counts: false, submit_clicked_at: null })
    expect(await submissionEvents(database.db, s.id)).toContainEqual({ kind: "sample_posting_dropped", detail: "not_ranked" })
    expect(await approveSample(s.id)).toMatchObject({ result: "not_ranked", countingSamples: 2 })
  })

  it("apply-anyway:637 @AA-3.4 preparing samples picks the ranked eligible posting only, and skips an Application with an override (ranked or Industry-excluded)", async () => {
    await approvedProfile()
    const ranked = await posting({ decision: RANKED, company: "Ranked Co", requisition: "R-4208" })
    await strongMatch(ranked.id)
    const rankedApp = await insertApplication(database.db, ada(), ranked, now())
    const industry = await posting({ decision: INDUSTRY, company: "Lucky Odds Ltd", requisition: "LO-17" })
    await strongMatch(industry.id)
    const industryApp = await insertApplication(database.db, ada(), industry, now())
    await setOverride(database.db, industryApp, EARLIER, INDUSTRY)
    const rankedOverride = await posting({ decision: RANKED, company: "Override Co" })
    await strongMatch(rankedOverride.id)
    const rankedOverrideApp = await insertApplication(database.db, ada(), rankedOverride, now())
    await setOverride(database.db, rankedOverrideApp, EARLIER, WEAK)
    const result = prepareSamplesResultSchema.parse((await candidate.post(SAMPLES_PREPARE_PATH).send({}).expect(200)).body)
    expect(result.created).toBe(1)
    expect((await row(rankedApp)).sample_state).toBe("awaiting_review")
    expect((await row(industryApp)).sample_state).toBeNull()
    expect((await row(rankedOverrideApp)).sample_state).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════
// AA-5. Remove from queue
// ════════════════════════════════════════════════════════════

describe("AA-5 POST /v1/applications/{id}/remove-from-queue", () => {
  it("apply-anyway:920 @AA-5.2 removing returns to documents ready and keeps documents, 6 answers, the override and attempt number 0; one queue_removed event", async () => {
    await passGate()
    const q = await queuedOverride({ decision: WEAK, requisition: "R-4403" }, WEAK, { formControls: 6 })
    const overrideBefore = await overrideColumns(database.db, q.id)
    const response = await removeFromQueue(q.id)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(submissionSchema.parse(response.body).state).toBeNull()
    expect(await row(q.id)).toMatchObject({ state: "documents_ready", submission_state: null, submission_kind: null, queued_for_local_day: null, attempt_number: 0 })
    expect(await tailoredCount(database.db, q.id)).toBe(2)
    expect(await formControlCount(database.db, q.id)).toBe(6)
    expect(await overrideColumns(database.db, q.id)).toEqual(overrideBefore)
    expect(await submissionEvents(database.db, q.id)).toEqual([{ kind: "queue_removed", detail: null }])
  })

  it.each([
    ["Queued for tomorrow", { queuedForLocalDay: "2026-10-30" }],
    ["Queued again (fresh attempt)", { attemptNumber: 1, extra: { marked_not_submitted_at: EARLIER } }],
  ] as const)("apply-anyway:888 @AA-5.1 a %s Application is removable (state queued)", async (_label, seed) => {
    const q = await queuedOverride({ decision: RANKED }, null, seed)
    expect((await removeFromQueue(q.id)).status).toBe(200)
    await expectDocumentsReady(q.id)
  })

  it("apply-anyway:933 @AA-5.2 a removed Application is never claimed and uses no slot; count stays 2", async () => {
    await passGate()
    await confirmedToday(2)
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4404" }, null)
    await removeFromQueue(q.id).expect(200)
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "not_claimable" })
    expect(await service().runDaily()).toMatchObject({ submitted: 0 })
    expect(forms.opened).toBe(0)
    expect(await repo().countForDay(TODAY)).toBe(2)
  })

  it("apply-anyway:944 @AA-5.2 the daily summary lists a removed Application neither under Skipped nor as dropped", async () => {
    clock.set("2026-10-29T18:00:00.000Z")
    const q = await queuedOverride({ decision: RANKED, company: "Initech", title: "Frontend Lead" }, null)
    await removeFromQueue(q.id).expect(200)
    await summaryRow()
    await send()
    const text = plainText(smtp.received.at(-1)!.raw)
    expect(text).not.toContain("Frontend Lead at Initech")
  })

  it.each(["submit_claimed", "submitting"] as const)("apply-anyway:959 @AA-5.3 the claim got there first (%s): 409 application_state_conflict, nothing changes", async (state) => {
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4406" }, null)
    await database.db
      .updateTable("application")
      .set({ submission_state: state, attempt_id: randomUUID(), attempt_number: 1, submitted_local_day: TODAY, submit_clicked_at: state === "submitting" ? now() : null })
      .where("id", "=", q.id)
      .execute()
    const before = await applicationSnapshot(database.db, q.id)
    const response = await removeFromQueue(q.id)
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("application_state_conflict")
    expect(await applicationSnapshot(database.db, q.id)).toBe(before)
    expect(await submissionEvents(database.db, q.id)).toEqual([])
  })

  it("apply-anyway:973 @AA-5.3 remove and claim racing on one Application never both succeed (both take the row FOR UPDATE)", async () => {
    await passGate()
    for (let round = 0; round < 5; round += 1) {
      const q = await queuedOverride({ decision: RANKED, company: `Race ${round} Co`, requisition: "R-4407" }, null)
      const [removal, claim] = await Promise.all([removeFromQueue(q.id), repo().claim(q.id, "automatic", TODAY, now())])
      const removed = removal.status === 200
      const claimed = "attemptId" in claim
      expect([removed, claimed].filter(Boolean)).toHaveLength(1)
      if (removed) {
        expect(claim).toEqual({ refused: "not_claimable" })
        await expectDocumentsReady(q.id)
      } else {
        expect(removal.status).toBe(409)
        expect(apiErrorResponseSchema.parse(removal.body).error.code).toBe("application_state_conflict")
        expect((await row(q.id)).submission_state).toBe("submit_claimed")
      }
    }
  })

  it("apply-anyway:973 @AA-5.3 a removal waits for a claim holding the row lock, then answers 409 (deterministic order)", async () => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4407" }, null)
    let release!: () => void
    let pid!: number
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = database.db.transaction().execute(async (trx: Transaction<Database>) => {
      pid = await backendPid(trx)
      await trx.selectFrom("application").select("id").where("id", "=", q.id).forUpdate().execute()
      await trx.updateTable("application").set({ submission_state: "submit_claimed", attempt_id: randomUUID(), attempt_number: 1, submitted_local_day: TODAY }).where("id", "=", q.id).execute()
      locked()
      await new Promise<void>((resolve) => (release = resolve))
    })
    await isLocked
    const removal = removeFromQueue(q.id).then((r) => r)
    try {
      await untilLockWait(database.db, "the removal", "row", pid)
    } finally {
      release()
      await holder
    }
    const response = await removal
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("application_state_conflict")
  })

  it.each([
    ["a Confirmed Submission", { submission_state: "confirmed", submit_clicked_at: new Date(NOW), attempt_number: 1 }],
    ["an Uncertain Submission", { submission_state: "uncertain", submit_clicked_at: new Date(NOW), attempt_number: 1 }],
    ["a Blocked Application", { submission_state: "blocked", blocked_reason: "login", blocked_at: new Date(NOW) }],
    ["a Manual Application", { submission_state: "manual" }],
    ["not submitted", { submission_state: "not_submitted" }],
    ["declined", { submission_state: "declined", declined_at: new Date(NOW) }],
  ] as const)("apply-anyway:981 @AA-5.3 removing %s: 409 application_state_conflict and the Application is unchanged", async (_label, patch) => {
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4408" }, null)
    await database.db.updateTable("application").set(patch as never).where("id", "=", q.id).execute()
    const before = await applicationSnapshot(database.db, q.id)
    const response = await removeFromQueue(q.id)
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("application_state_conflict")
    expect(await applicationSnapshot(database.db, q.id)).toBe(before)
  })

  it("contract row 2: removing an Application whose details are deleted is 409 application_state_conflict", async () => {
    const q = await queuedOverride({ decision: RANKED }, null)
    await database.db.updateTable("application").set({ details_deleted_at: now(), details_deleted_by: "candidate", final_status: "queued" }).where("id", "=", q.id).execute()
    const response = await removeFromQueue(q.id)
    expect(response.status).toBe(409)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("application_state_conflict")
  })

  it("apply-anyway:997 @AA-5.3 a second removal from another tab answers 200 with the current state (documents ready); one queue_removed event", async () => {
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4409" }, null)
    await removeFromQueue(q.id).expect(200)
    const second = await removeFromQueue(q.id)
    expect(second.status).toBe(200)
    expect(submissionSchema.parse(second.body).state).toBeNull()
    expect((await submissionEvents(database.db, q.id)).filter((e) => e.kind === "queue_removed")).toHaveLength(1)
  })

  it.each([
    ["global pause", { global_paused: true }],
    ["cost pause", { cost_paused: true }],
  ] as const)("apply-anyway:1004 @AA-5.4 remove works during the %s, and the pause stays on", async (_label, pause) => {
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4410" }, null)
    await database.db.updateTable("control_state").set(pause).execute()
    await removeFromQueue(q.id).expect(200)
    await expectDocumentsReady(q.id)
    expect(await database.db.selectFrom("control_state").select(["global_paused", "cost_paused"]).executeTakeFirstOrThrow()).toMatchObject(pause)
  })

  it("apply-anyway:1017 @AA-5.5 a removed Application is queued again through the existing POST …/queue path", async () => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4411" }, null)
    await removeFromQueue(q.id).expect(200)
    const queued = submissionSchema.parse((await candidate.post(`${APPLICATIONS_PATH}/${q.id}/queue`).send({}).expect(200)).body)
    expect(queued.state).toBe("queued")
  })

  it("apply-anyway:1025 @AA-5.5 a removed Uncertain fresh attempt keeps attempt number 1: re-queued, uncertain again -> 2, then 'not submitted' is final", async () => {
    await passGate()
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, afterSubmit: "" })
    const q = await queuedOverride({ decision: RANKED, company: "Fresh Co", requisition: "R-3003" }, null)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "uncertain" })
    expect(submissionSchema.parse((await candidate.post(`${APPLICATIONS_PATH}/${q.id}/mark-not-submitted`).send({}).expect(200)).body).state).toBe("queued")
    await removeFromQueue(q.id).expect(200)
    expect((await row(q.id)).attempt_number).toBe(1)
    await candidate.post(`${APPLICATIONS_PATH}/${q.id}/queue`).send({}).expect(200)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "uncertain" })
    expect((await row(q.id)).attempt_number).toBe(2)
    expect(submissionSchema.parse((await candidate.post(`${APPLICATIONS_PATH}/${q.id}/mark-not-submitted`).send({}).expect(200)).body).state).toBe("not_submitted")
  })

  it("apply-anyway:1035 @permission @AA-5.3 an unauthenticated removal is 401 and the Application stays queued", async () => {
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4412" }, null)
    const response = await anonymous.http().post(`${APPLICATIONS_PATH}/${q.id}/remove-from-queue`).send({})
    expect(response.status).toBe(401)
    expect((await row(q.id)).submission_state).toBe("queued")
  })

  it("apply-anyway:1202 @permission @AA-5.3 another Candidate removing this Candidate's Application gets 404 (not 409 feature_not_yet_available); still queued", async () => {
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4702" }, null)
    const response = await removeFromQueue(q.id, kofi)
    expect(response.status).toBe(404)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("not_found")
    expect((await row(q.id)).submission_state).toBe("queued")
  })

  it("contract: a non-UUID id is 404; a body with any key is 400; no CSRF is 403", async () => {
    expect((await candidate.post(`${APPLICATIONS_PATH}/not-a-uuid/remove-from-queue`).send({})).status).toBe(404)
    const q = await queuedOverride({ decision: RANKED }, null)
    const bad = await candidate.post(`${APPLICATIONS_PATH}/${q.id}/remove-from-queue`).send({ force: true })
    expect(bad.status).toBe(400)
    expect(apiErrorResponseSchema.parse(bad.body).error.code).toBe("bad_request")
    const noCsrf = await anonymous.http().post(`${APPLICATIONS_PATH}/${q.id}/remove-from-queue`).set("cookie", candidate.cookie).send({})
    expect(noCsrf.status).toBe(403)
    expect((await row(q.id)).submission_state).toBe("queued")
  })
})

// ════════════════════════════════════════════════════════════
// AA-6. A posting that already has an Application
// ════════════════════════════════════════════════════════════

describe("AA-6 'anyway' on a posting that already has an Application", () => {
  const MARKABLE: readonly (readonly [string, Parameters<typeof insertApplication>[4], Decision | "legacy" | null])[] = [
    ["documents ready, created while ranked", {}, null],
    ["queued, created while ranked", { submissionState: "queued", queuedForLocalDay: TODAY }, null],
    ["documents ready with a legacy override", {}, "legacy"],
    ["documents ready with an override that no longer applies", {}, NO_CORE],
    ["queued for tomorrow with an override that no longer applies", { submissionState: "queued", queuedForLocalDay: "2026-10-30" }, NO_CORE],
  ]

  it.each(MARKABLE)("apply-anyway:1046 @AA-6.1 existing Application %s: marked (200 created false), one Application, documents and submission state unchanged", async (_label, seed, existing) => {
    const p = await posting({ decision: WEAK, requisition: "R-4501" })
    const id = await insertApplication(database.db, ada(), p, now(), { formControls: 2, ...seed })
    if (existing === "legacy") await setLegacyOverride(database.db, id, EARLIER)
    else if (existing !== null) await setOverride(database.db, id, EARLIER, existing)
    const before = await row(id)
    const response = await create(p, WEAK)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(createApplicationResponseSchema.parse(response.body)).toMatchObject({ created: false, application: { id, override: { status: "skipped", skipReason: "weak_core_match", applies: true } } })
    expect(await applicationsFor(database.db, p.id)).toHaveLength(1)
    expect(await overrideColumns(database.db, id)).toMatchObject({ override_created_at: now(), override_status: "skipped", override_skip_reason: "weak_core_match", override_violated_rules: [], candidate_override_at: null })
    const after = await row(id)
    for (const key of ["state", "submission_state", "submission_kind", "queued_for_local_day", "attempt_number", "career_profile_version"] as const) expect(after[key]).toEqual(before[key])
    expect(await tailoredCount(database.db, id)).toBe(2)
    expect(await formControlCount(database.db, id)).toBe(2)
  })

  it("apply-anyway:1064 @AA-6.1 @AA-2.3 a queued Application created while ranked, marked by 'anyway' before the next check, is then submitted", async () => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED, requisition: "R-4502" }, null)
    await decide(q.posting, WEAK)
    await create(q.posting, WEAK).expect(200)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    expect(forms.clicks).toHaveLength(1)
  })

  const PAST_QUEUE: readonly (readonly [string, Record<string, unknown>])[] = [
    ["claimed for submission", { submission_state: "submit_claimed", submission_kind: "automatic", attempt_id: randomUUID(), attempt_number: 1 }],
    ["being submitted", { submission_state: "submitting", submission_kind: "automatic", attempt_id: randomUUID(), attempt_number: 1, submit_clicked_at: new Date(NOW), submitted_local_day: TODAY }],
    ["a Confirmed Submission", { submission_state: "confirmed", submission_kind: "automatic", attempt_number: 1 }],
    ["an Uncertain Submission", { submission_state: "uncertain", submission_kind: "automatic", attempt_number: 1 }],
    ["a Blocked Application", { submission_state: "blocked", submission_kind: "automatic", blocked_reason: "login" }],
    ["a Manual Application", { submission_state: "manual" }],
    ["not submitted", { submission_state: "not_submitted", submission_kind: "automatic" }],
    ["declined at same-company review", { submission_state: "declined", submission_kind: "automatic" }],
    ["an Activation Gate sample awaiting review", { sample_state: "awaiting_review" }],
    ["a minimal record with detailed records deleted", { details_deleted_at: new Date(NOW), details_deleted_by: "candidate", final_status: "documents_ready", role_title: null }],
  ]

  it.each(PAST_QUEUE)("apply-anyway:1074 @AA-6.3 existing Application %s: applyAnyway null, create 409 override_application_state (C-AA-11), unchanged", async (_label, extra) => {
    const p = await posting({ decision: WEAK, requisition: "R-4503" })
    const id = await insertApplication(database.db, ada(), p, now(), { extra })
    const before = await applicationSnapshot(database.db, id)
    const detail = await postingDetail(p)
    expect(detail.applyAnyway).toBeNull()
    expect(detail.applicationId).toBe(id)
    expectRefused(await create(p, WEAK), "override_application_state", AA_COPY.overrideApplicationState)
    expect(await applicationSnapshot(database.db, id)).toBe(before)
  })

  it("contract step 8 before step 9: a stale acknowledgement against a non-markable Application hears override_decision_changed first", async () => {
    const p = await posting({ decision: WEAK })
    await insertApplication(database.db, ada(), p, now(), { submissionState: "confirmed", extra: { attempt_number: 1 } })
    expectRefused(await create(p, NO_CORE), "override_decision_changed", AA_COPY.overrideDecisionChanged)
  })

  it("apply-anyway:1097 @AA-6.4 a ranked posting with a documents-ready Application: applyAnyway null and applicationId set", async () => {
    const p = await posting({ decision: RANKED, requisition: "R-4504" })
    const id = await insertApplication(database.db, ada(), p, now())
    expect(await postingDetail(p)).toMatchObject({ applyAnyway: null, applicationId: id })
  })

  it("apply-anyway:1105 @AA-6.1 'anyway' twice on the same decision: one Application, one override, the first time kept", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4505" })
    const first = createApplicationResponseSchema.parse((await create(p, WEAK).expect(201)).body)
    const firstAt = (await overrideColumns(database.db, first.application.id)).override_created_at
    clock.set("2026-10-29T08:05:00.000Z")
    const second = createApplicationResponseSchema.parse((await create(p, WEAK).expect(200)).body)
    expect(second).toMatchObject({ created: false, application: { id: first.application.id } })
    expect(await applicationsFor(database.db, p.id)).toHaveLength(1)
    expect((await overrideColumns(database.db, first.application.id)).override_created_at).toEqual(firstAt)
  })

  it("apply-anyway:1105 @duplicate two concurrent 'anyway' creates on the same decision leave one Application", async () => {
    const p = await posting({ decision: WEAK })
    const responses = await Promise.all([create(p, WEAK), create(p, WEAK)])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    expect(await applicationsFor(database.db, p.id)).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════
// AA-7.1 deleting details, AA-7.5 races
// ════════════════════════════════════════════════════════════

describe("AA-7.1 deleting detailed records clears every override field", () => {
  it("apply-anyway:1117 @AA-7.1 by the Candidate (delete-details): no override time or stored decision; legacy column null; override null in the API", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4601" })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOverride(database.db, id, EARLIER, WEAK)
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [id] }).expect(200)
    expect(await overrideColumns(database.db, id)).toEqual({ override_created_at: null, override_status: null, override_skip_reason: null, override_skip_detail: null, override_violated_rules: null, candidate_override_at: null })
    const detail = await applicationDetail(id)
    expect(detail.override).toBeNull()
    expect(detail.posting).toBeNull()
    expect(detail.latestDrop).toBeNull()
  })

  it("apply-anyway:1117 @AA-7.1 by automatic expiry 12 months after creation (retention.daily): every override field cleared", async () => {
    clock.set("2026-10-20T02:00:00.000Z")
    const created = new Date("2025-10-20T08:15:00Z")
    const p = await posting({ decision: WEAK, requisition: "R-4601" })
    const id = await insertApplication(database.db, ada(), p, now(), { createdAt: created, documents: false })
    await setOverride(database.db, id, created, WEAK)
    await setOldImageOverride(database.db, id, created)
    await database.db.insertInto("retention_run").values({ candidate_id: ada(), id: randomUUID(), wat_date: "2026-06-01", started_at: new Date("2026-06-01T02:00:00Z"), finished_at: new Date("2026-06-01T02:00:01Z"), outcome: "completed" }).execute()
    const workerDb = createDatabase(database.url, { statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS })
    try {
      clock.set("2026-10-20T02:00:00.000Z")
      await new RetentionRunner(new TenantDatabase(workerDb), clock).run()
    } finally {
      await workerDb.destroy()
    }
    expect((await row(id)).details_deleted_at).not.toBeNull()
    expect(await overrideColumns(database.db, id)).toEqual({ override_created_at: null, override_status: null, override_skip_reason: null, override_skip_detail: null, override_violated_rules: null, candidate_override_at: null })
  })

  it("apply-anyway:821 @AA-4.4 @AA-7.1 the minimal record's summary carries override null", async () => {
    const p = await posting({ decision: WEAK, requisition: "R-4311" })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOverride(database.db, id, EARLIER, WEAK)
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [id] }).expect(200)
    expect(applicationsResponseSchema.parse((await candidate.get(APPLICATIONS_PATH).expect(200)).body).applications.find((a) => a.id === id)?.override ?? null).toBeNull()
  })
})

describe("AA-7.5 a create racing a Job criteria save stores the decision of whichever committed first", () => {
  /** A save holding the criteria row FOR UPDATE with `change` applied, committed on `commit()`. */
  async function heldSave(change: (trx: Transaction<Database>) => Promise<void>) {
    let commit!: () => void
    let done!: Promise<void>
    let pid!: number
    await new Promise<void>((resolve) => {
      done = database.db.transaction().execute(async (trx) => {
        pid = await backendPid(trx)
        await trx.selectFrom("job_criteria").select("version").where("candidate_id", "=", ada()).forUpdate().execute()
        await change(trx)
        resolve()
        await new Promise<void>((release) => (commit = release))
      })
    })
    return { pid, commit: async () => (commit(), await done) }
  }
  const toWeak = (postingId: string) => async (trx: Transaction<Database>) => {
    await trx.updateTable("candidate_posting").set({ status: "skipped", skip_reason: "weak_core_match", skip_detail: null }).where("candidate_id", "=", ada()).where("job_posting_id", "=", postingId).execute()
  }

  it("apply-anyway:1174 @AA-7.5 @AA-2.1 @AA-2.2 the save first: the create waits on the criteria lock, then reads the new decision and is refused C-AA-9", async () => {
    const p = await posting({ decision: CLEARANCE, requisition: "R-4604" })
    const save = await heldSave(toWeak(p.id))
    let response: Awaited<ReturnType<typeof create>> | undefined
    try {
      const pending = create(p, CLEARANCE).then((r) => (response = r))
      await untilLockWait(database.db, "the create", "row", save.pid)
      expect(response).toBeUndefined()
      await save.commit()
      await pending
    } finally {
      await save.commit().catch(() => undefined)
    }
    expectRefused(response!, "override_decision_changed", AA_COPY.overrideDecisionChanged)
    expect(await applicationsFor(database.db, p.id)).toEqual([])
  })

  it("apply-anyway:1174 @AA-7.5 the create first: the override stores the pre-save decision; the posting is then skipped weak_core_match and the override no longer applies", async () => {
    const p = await posting({ decision: CLEARANCE, requisition: "R-4604" })
    const created = createApplicationResponseSchema.parse((await create(p, CLEARANCE).expect(201)).body)
    const save = await heldSave(toWeak(p.id))
    await save.commit()
    expect(await overrideColumns(database.db, created.application.id)).toMatchObject({ override_skip_reason: "uncovered_mandatory_prerequisite", override_skip_detail: "Active security clearance" })
    expect(await postingDetail(p)).toMatchObject({ status: "skipped", skipReason: "weak_core_match" })
    expect((await applicationDetail(created.application.id)).override).toMatchObject({ applies: false, notAppliesReason: "decision_changed" })
  })
})

// ════════════════════════════════════════════════════════════
// AA-4.6 emails (Confirmed, Blocked, daily summary)
// ════════════════════════════════════════════════════════════

const squash = (text: string) => text.replace(/\s+/g, " ")
const emailWithSubject = (prefix: string) => smtp.received.find((email) => /Subject: (.*)/.exec(email.raw)?.[1]?.includes(prefix) || email.raw.includes(`Subject: ${prefix}`))

describe("AA-4.6 emails mark an override Application", () => {
  it.each([
    ["weak_core_match", WEAK, "your profile backing too few of the core responsibilities"],
    ["no_core_responsibilities", NO_CORE, "no core responsibilities found"],
    ["uncovered_mandatory_prerequisite", CLEARANCE, 'your profile not showing a required prerequisite "Active security clearance"'],
  ] as const)("apply-anyway:829 @AA-4.6 Confirmed email for a %s override carries C-AA-32 right after 'Sent:', in the text and HTML parts", async (_label, decision, reason) => {
    await passGate()
    const q = await queuedOverride({ decision, company: "Acme Payments", requisition: "R-4312" }, decision)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    await send()
    expect(smtp.received).toHaveLength(1)
    const raw = smtp.received[0]!.raw
    const text = linesOf(plainText(raw))
    const sent = text.findIndex((l) => l.startsWith("Sent:"))
    expect(sent).toBeGreaterThanOrEqual(0)
    expect(text[sent + 1]).toBe(AA_COPY.emailOverrideFact(reason))
    expect(squash(htmlText(raw))).toContain(AA_COPY.emailOverrideFact(reason))
  })

  it("apply-anyway:829 @AA-4.6 Blocked email (Missing Approved Answer) for an Industry-only override carries C-AA-32 right after 'Reason:', in both parts", async () => {
    await passGate()
    const q = await queuedOverride({ decision: INDUSTRY, company: "Acme Payments", requisition: "R-4312" }, INDUSTRY)
    forms.use({ host: APPLY_HOST, controls: [...STANDARD_FORM, { ref: "proud", label: "Describe a project you are proud of.", kind: "textarea", required: true }] })
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "blocked" })
    expect((await row(q.id)).blocked_reason).toBe("missing_approved_answer")
    await send()
    const raw = smtp.received[0]!.raw
    const text = linesOf(plainText(raw))
    const reasonLine = text.findIndex((l) => l.startsWith("Reason:"))
    expect(text[reasonLine + 1]).toBe(AA_COPY.emailOverrideFact("the posting not fitting your industry rule"))
    expect(squash(htmlText(raw))).toContain(AA_COPY.emailOverrideFact("the posting not fitting your industry rule"))
  })

  it("contract 'Notifications': a legacy override gets no Override fact line in the Confirmed email (C-AA-33 reserved)", async () => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED }, "legacy")
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    await send()
    expect(plainText(smtp.received[0]!.raw)).not.toContain("Override:")
  })

  it("apply-anyway:844 @AA-4.6 the daily summary appends ' [Override]' to the Submitted, Uncertain, Failures and Skipped lines of override Applications, in both parts", async () => {
    clock.set("2026-10-29T18:00:00.000Z")
    const at = new Date("2026-10-29T09:04:00.000Z")
    const submitted = await posting({ decision: RANKED, title: "Senior Frontend Engineer", company: "Acme Payments", requisition: "R-4312" })
    const submittedId = await insertApplication(database.db, ada(), submitted, now(), { submissionState: "confirmed", extra: { submitted_local_day: TODAY, submit_clicked_at: at, confirmed_at: at, attempt_id: randomUUID(), attempt_number: 1 } })
    const uncertain = await posting({ decision: RANKED, title: "Frontend Engineer", company: "Lucky Odds Ltd" })
    const uncertainId = await insertApplication(database.db, ada(), uncertain, now(), { submissionState: "uncertain", extra: { submitted_local_day: TODAY, submit_clicked_at: at, attempt_id: randomUUID(), attempt_number: 1 } })
    const failure = await posting({ decision: RANKED, title: "Frontend Lead", company: "Initech" })
    const failureId = await insertApplication(database.db, ada(), failure, now(), { state: "documents_ready", extra: { state: "documents_blocked", blocked_document: "resume", blocked_claim: "Led a team of 40", updated_at: now() } })
    const skippedPosting = await posting({ decision: WEAK, title: "Mobile Engineer", company: "Globex" })
    const skippedId = await insertApplication(database.db, ada(), skippedPosting, now())
    for (const id of [submittedId, uncertainId, failureId]) await setOverride(database.db, id, EARLIER, WEAK)
    await setOverride(database.db, skippedId, EARLIER, WEAK)
    await summaryRow()
    await send()
    const raw = smtp.received.at(-1)!.raw
    const text = linesOf(plainText(raw))
    const html = squash(htmlText(raw))
    const marked = (start: string) => {
      const found = text.find((l) => l.startsWith(start))
      expect(found, `a line starting "${start}"`).toBeDefined()
      expect(found!.endsWith(AA_COPY.summaryMarker.trim())).toBe(true)
      expect(found).toContain(AA_COPY.summaryMarker)
      expect(html).toContain(squash(found!))
    }
    marked("Senior Frontend Engineer at Acme Payments (R-4312")
    marked("Frontend Engineer at Lucky Odds Ltd, submitted")
    marked("Frontend Lead at Initech:")
    marked("Mobile Engineer at Globex: your profile backs too few of the core responsibilities")
  })

  it("apply-anyway:844b @AA-4.6 with Advanced off the daily summary has no ' [Override]' marker", async () => {
    clock.set("2026-10-29T18:00:00.000Z")
    const at = new Date("2026-10-29T09:04:00.000Z")
    const submitted = await posting({ decision: RANKED, title: "Senior Frontend Engineer", company: "Acme Payments", requisition: "R-4312" })
    const submittedId = await insertApplication(database.db, ada(), submitted, now(), { submissionState: "confirmed", extra: { submitted_local_day: TODAY, submit_clicked_at: at, confirmed_at: at, attempt_id: randomUUID(), attempt_number: 1 } })
    await setOverride(database.db, submittedId, EARLIER, WEAK)
    const setAdvanced = (on: boolean) => database.db.updateTable("candidate_view_setting").set({ advanced_enabled: on }).where("candidate_id", "=", ada()).execute()
    await setAdvanced(false)
    try {
      await summaryRow()
      await send()
      const text = linesOf(plainText(smtp.received.at(-1)!.raw))
      expect(text.some((line) => line.includes("[Override]"))).toBe(false)
      expect(text.some((line) => line.startsWith("Senior Frontend Engineer at Acme Payments (R-4312"))).toBe(true)
    } finally {
      // The flag is per Candidate and survives the file's resets; later tests expect Ada to be an Advanced user.
      await setAdvanced(true)
    }
  })

  it("apply-anyway:857 @AA-4.6 @AA-2.4 a queued override dropped at a check is listed under Skipped with C-AA-35, never 'posting closed'", async () => {
    clock.set("2026-10-29T10:00:00.000Z")
    const q = await queuedOverride({ decision: WEAK, title: "Frontend Engineer", company: "Lucky Odds Ltd" }, WEAK)
    await decide(q.posting, NO_CORE)
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    clock.set("2026-10-29T18:00:00.000Z")
    await summaryRow()
    await send()
    const text = linesOf(plainText(smtp.received.at(-1)!.raw))
    expect(text).toContain(`Frontend Engineer at Lucky Odds Ltd: ${AA_COPY.summaryOverrideDropped}${AA_COPY.summaryMarker}`)
    expect(text).not.toContain(`Frontend Engineer at Lucky Odds Ltd: ${AA_COPY.postingClosed}`)
  })

  it("r-AA notifications.feature:104 a closed queued posting with no override is listed as 'posting closed' (no marker)", async () => {
    clock.set("2026-10-29T10:00:00.000Z")
    const q = await queuedOverride({ decision: RANKED, title: "Backend Engineer", company: "Umbrella" }, null)
    await redecide(database.db, ada(), q.posting.id, now(), statusOnly("evaluation_failed"), { evaluationFailure: "posting_unavailable" })
    expect(await repo().claim(q.id, "automatic", TODAY, now())).toEqual({ refused: "posting_closed" })
    clock.set("2026-10-29T18:00:00.000Z")
    await summaryRow()
    await send()
    const text = linesOf(plainText(smtp.received.at(-1)!.raw))
    expect(text).toContain(`Backend Engineer at Umbrella: ${AA_COPY.postingClosed}`)
  })

  it("apply-anyway:877 @AA-4.7 no override: neither the Confirmed email nor the daily summary carries C-AA-32 or C-AA-34", async () => {
    await passGate()
    const q = await queuedOverride({ decision: RANKED, title: "Frontend Lead", company: "Globex", requisition: "L-79" }, null)
    expect(await service().submit(q.id, "automatic")).toEqual({ result: "confirmed" })
    clock.set("2026-10-29T18:00:00.000Z")
    await summaryRow()
    await send()
    for (const email of smtp.received) {
      expect(plainText(email.raw)).not.toContain("Override:")
      expect(plainText(email.raw)).not.toContain(AA_COPY.summaryMarker)
    }
    expect(emailWithSubject("Applied:")).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════
// Migration 0026-apply-anyway-bounds (run last: it drops and re-adds columns on this file's database)
// ════════════════════════════════════════════════════════════

describe("migration 0026-apply-anyway-bounds (AA-2.7, AA-7.6)", () => {
  type Module = { up: (db: unknown) => Promise<void>; down: (db: unknown) => Promise<void> }
  const NAME_PATTERN = /^\d{4}-apply-anyway-bounds$/

  async function migration(): Promise<{ name: string; module: Module }> {
    const { migrationsFor } = await import("../src/db/migrations/index.js")
    const all = migrationsFor({ operatorGoogleSub: undefined }) as Record<string, Module>
    const name = Object.keys(all).find((key) => NAME_PATTERN.test(key))
    expect(name, "a migration named NNNN-apply-anyway-bounds (api-contract.md v1.24.0, 0026 unless renumbered at merge, D19)").toBeDefined()
    // Merge with main 0422b14 (D19): EPIC-0002 B1's 0027-preferences-version merged after it and is the only later one.
    expect(Object.keys(all).sort().filter((key) => key > name!), "only B1's 0027 and ATS 0028 to 0030 and EPIC-0010 0031 and stuck checking 0032 and EPIC-0011 0033 and EPIC-0012 0034 follow the bounds migration").toEqual(["0027-preferences-version", "0028-ats-skills", "0029-ats-fit", "0030-ats-minimum", "0031-pasted-description", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0036-retry-failed-checks", "0037-retry-backfill", "0038-lead-pipeline", "0039-blocked-claim-cause", "0040-outreach-messages", "0041-lead-policy-binding"])
    return { name: name!, module: all[name!]! }
  }

  const columns = async () =>
    (await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_name = 'application' and column_name in ('override_created_at', 'override_status', 'override_skip_reason', 'override_skip_detail', 'override_violated_rules', 'candidate_override_at')
      order by column_name`.execute(database.db)).rows
  const marker = async (name: string) => (await sql<{ n: number }>`select count(*)::int as n from migration_marker where name = ${name}`.execute(database.db)).rows[0]!.n

  it("apply-anyway:517 @AA-2.7 up adds the five nullable columns, the decision check constraint and the marker", async () => {
    const { name } = await migration()
    expect(await columns()).toEqual([
      { column_name: "candidate_override_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "override_created_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "override_skip_detail", data_type: "text", is_nullable: "YES" },
      { column_name: "override_skip_reason", data_type: "text", is_nullable: "YES" },
      { column_name: "override_status", data_type: "text", is_nullable: "YES" },
      { column_name: "override_violated_rules", data_type: "ARRAY", is_nullable: "YES" },
    ])
    expect(await marker(name)).toBe(1)
    const constraint = await sql<{ n: number }>`select count(*)::int as n from pg_constraint where conname = 'application_override_decision_check'`.execute(database.db)
    expect(constraint.rows[0]!.n).toBe(1)
  })

  it("contract 'Migration': the check constraints refuse a stored decision without a time, and an override_status outside skipped/excluded", async () => {
    const p = await posting({ decision: WEAK })
    const id = await insertApplication(database.db, ada(), p, now())
    await expect(sql`update application set override_status = 'skipped', override_violated_rules = '{}' where id = ${id}`.execute(database.db)).rejects.toMatchObject({ code: "23514" })
    await expect(sql`update application set override_created_at = now(), override_status = 'ranked', override_violated_rules = '{}' where id = ${id}`.execute(database.db)).rejects.toMatchObject({ code: "23514" })
    await expect(sql`update application set override_created_at = now(), override_skip_reason = 'weak_core_match' where id = ${id}`.execute(database.db)).rejects.toMatchObject({ code: "23514" })
  })

  it("apply-anyway:517 @AA-2.7 @AA-7.6 down then up: a v1.23.x candidate_override_at moves to override_created_at with no decision backfilled; candidate_override_at cleared; untouched rows stay null", async () => {
    const { name, module } = await migration()
    const legacyPosting = await posting({ decision: WEAK, requisition: "R-4118" })
    const legacy = await insertApplication(database.db, ada(), legacyPosting, now())
    const plainPosting = await posting({ decision: RANKED })
    const plain = await insertApplication(database.db, ada(), plainPosting, now())
    await module.down(database.db)
    try {
      expect((await columns()).map((c) => c.column_name)).toEqual(["candidate_override_at"])
      expect(await marker(name)).toBe(0)
      const legacyAt = new Date("2026-10-28T11:00:00.000Z")
      await sql`update application set candidate_override_at = ${legacyAt} where id = ${legacy}`.execute(database.db)
    } finally {
      await module.up(database.db)
    }
    expect(await overrideColumns(database.db, legacy)).toEqual({
      override_created_at: new Date("2026-10-28T11:00:00.000Z"),
      override_status: null,
      override_skip_reason: null,
      override_skip_detail: null,
      override_violated_rules: null,
      candidate_override_at: null,
    })
    expect(await overrideColumns(database.db, plain)).toEqual({ override_created_at: null, override_status: null, override_skip_reason: null, override_skip_detail: null, override_violated_rules: null, candidate_override_at: null })
    expect(await marker(name)).toBe(1)
    expect((await applicationDetail(legacy)).override).toMatchObject({ applies: false, notAppliesReason: "legacy_no_decision", status: null })
  })

  it("contract 'Migration' down: drops the constraint and the five columns, does not copy times back into candidate_override_at; up again restores the schema", async () => {
    const { module } = await migration()
    const p = await posting({ decision: WEAK })
    const id = await insertApplication(database.db, ada(), p, now())
    await setOverride(database.db, id, EARLIER, WEAK)
    await module.down(database.db)
    try {
      expect((await columns()).map((c) => c.column_name)).toEqual(["candidate_override_at"])
      expect((await sql<{ candidate_override_at: Date | null }>`select candidate_override_at from application where id = ${id}`.execute(database.db)).rows[0]!.candidate_override_at).toBeNull()
      const constraint = await sql<{ n: number }>`select count(*)::int as n from pg_constraint where conname = 'application_override_decision_check'`.execute(database.db)
      expect(constraint.rows[0]!.n).toBe(0)
    } finally {
      await module.up(database.db)
    }
    expect((await columns()).length).toBe(6)
    // The runtime role (the api's own connection) still records an override after the re-add (grants cover the columns).
    const q = await posting({ decision: INDUSTRY })
    expect((await create(q, INDUSTRY)).status).toBe(201)
  })
})
