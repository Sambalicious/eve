import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type INestApplication, type INestApplicationContext, Logger, type LoggerService } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { NOTIFICATION_STATUS_PATH, notificationStatusSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { GmailSmtpMailer } from "../src/notification/mailer.js"
import { type MailerConfig, mailerConfig } from "../src/notification/mailer-config.js"
import { MAX_ATTEMPTS, NotificationSender, RETRY_DELAYS_MS } from "../src/notification/notification-sender.js"
import { NotificationWorkerModule } from "../src/notification/notification.module.js"
import { CLOCK } from "../src/shared/clock.js"
import { SpendLedger } from "../src/spend/spend-ledger.js"
import { FORM_SESSION_FACTORY } from "../src/submission/form-session.js"
import { QUESTION_SCHEMAS } from "../src/submission/question-schema.js"
import { SubmissionService } from "../src/submission/submission.service.js"
import { NotificationJobs } from "../src/worker/notification-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { Browser } from "./support/browser.js"
import { FakeAtsForms, STANDARD_FORM } from "./support/fake-ats-form.js"
import { FakeGoogle } from "./support/fake-google.js"
import { FakeSmtp, header, plainText } from "./support/fake-smtp.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { PUBLIC_ORIGIN, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { NotificationRepository } from "../src/notification/notification.repository.js"

/**
 * Slice 6 notifications against real Postgres, the real api app, and an
 * in-process fake SMTP server on 127.0.0.1 (smtp-server). The Gmail SMTP
 * adapter is the production class pointed at the fake server; nothing reaches
 * a real mail server.
 */
const SENDER = "ada.okafor@gmail.com"
/** notifications.feature @ac-7.6: the sentinel app password. Synthetic, never a real credential. */
const APP_PASSWORD_SHOWN = "abcd efgh ijkl mnop"
const APP_PASSWORD = "abcdefghijklmnop"
const APPLY_HOST = "boards.greenhouse.io"

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate
let unauthenticated: Browser
let storage: string
let smtp: FakeSmtp
let config: MailerConfig
let sender: INestApplicationContext
const forms = new FakeAtsForms()
const clock = new TestClock("2026-10-20T09:00:00.000Z")
const logs: string[] = []

/** Every Nest log line from both the api and the sender, for the redaction checks. */
const capture: LoggerService = {
  log: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
  warn: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
  error: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
  debug: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
  verbose: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
}

const FAST_TIMEOUTS = { connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 1_500 }

async function bootSender(): Promise<INestApplicationContext> {
  const { ConfigModule } = await import("../src/config/config.module.js")
  const { DatabaseModule } = await import("../src/db/database.module.js")
  const { ClockModule } = await import("../src/shared/clock.js")
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ databaseUrl: database.url, statementTimeoutMs: 60_000, anthropic: anthropicConfig(undefined, "claude-haiku-5-5") }),
      ClockModule,
      DatabaseModule,
      NotificationWorkerModule.forRoot(config, { mailer: new GmailSmtpMailer(config, FAST_TIMEOUTS) }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  moduleRef.useLogger(capture)
  await moduleRef.init()
  return moduleRef
}

beforeAll(async () => {
  Logger.overrideLogger(capture)
  storage = await mkdtemp(join(tmpdir(), "ja-notify-int-"))
  markStorageMigratedSync(storage)
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  smtp = new FakeSmtp(SENDER, APP_PASSWORD)
  await smtp.start()
  config = mailerConfig({ user: SENDER, to: SENDER, dashboardOrigin: PUBLIC_ORIGIN, transport: { host: "127.0.0.1", port: smtp.port, secure: false, ignoreTLS: true }, appPassword: APP_PASSWORD })
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage }, formSessions: forms, questionSchemas: forms.questionSchemas })
  candidate = await signInCandidate(new Browser(app, google))
  unauthenticated = new Browser(app, google)
  sender = await bootSender()
})

beforeEach(async () => {
  clock.set("2026-10-20T09:00:00.000Z")
  smtp.reset()
  for (const table of ["notification_outbox", "notification_sender_state", "submission_event", "tailored_document", "application", "eligibility_result", "candidate_posting", "job_posting"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
  forms.use({ host: APPLY_HOST, controls: STANDARD_FORM })
})

afterEach(() => {
  expect(logs.join("\n")).not.toContain(APP_PASSWORD)
  expect(logs.join("\n")).not.toContain(APP_PASSWORD_SHOWN)
})

afterAll(async () => {
  await sender?.close()
  await app?.close()
  await smtp?.stop()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
  Logger.overrideLogger(false)
})

type PostingSeed = { company?: string; role?: string; requisition?: string; status?: "ranked" | "skipped" | "excluded"; skipReason?: string | null; skipDetail?: string | null; evaluatedAt?: Date }

async function posting(seed: PostingSeed = {}): Promise<string> {
  const id = randomUUID()
  const requisition = seed.requisition ?? `R-${id.slice(0, 6)}`
  const url = `https://${APPLY_HOST}/${(seed.company ?? "acme").toLowerCase().replace(/\W+/g, "")}/jobs/${requisition}`
  await insertPostingFor(database.db, database.operatorId, {
      id,
      application_url: url,
      requisition_id: requisition,
      apply_url: url,
      application_system: "greenhouse",
      apply_mode: "automatic",
      origin: "employer_board",
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      title: seed.role ?? "Senior Frontend Engineer",
      company: seed.company ?? "Acme Payments",
      posting_text: "Remote, open to candidates in Nigeria.",
      status: seed.status ?? "ranked",
      skip_reason: seed.skipReason ?? null,
      skip_detail: seed.skipDetail ?? null,
      evaluation_failure: null,
      role_family: "senior_frontend",
      discovered_at: seed.evaluatedAt ?? clock.now(),
      evaluated_at: seed.evaluatedAt ?? clock.now(),
    })
  return id
}

/** A documents-ready Application queued for automatic submission. */
async function queuedApplication(seed: PostingSeed = {}) {
  const postingId = await posting(seed)
  const row = await database.db.selectFrom("job_posting").select(["application_url", "requisition_id", "company", "title"]).where("id", "=", postingId).executeTakeFirstOrThrow()
  await database.db
    .insertInto("eligibility_result")
    // EPIC-0002 B1 unit 6: the sponsorship answer reads the role's location; a role outside Nigeria keeps slice 5's "Yes".
    .values({ candidate_id: database.operatorId, job_posting_id: postingId, arrangement: "relocation", relocation_country: "United States", employment_type: "direct", rules: JSON.stringify([{ rule: "location", result: "met", quote: "Relocation to United States" }, { rule: "pay", result: "unverified", quote: null }]), eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: clock.now() })
    .execute()
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({ candidate_id: database.operatorId, id, job_posting_id: postingId, application_url: row.application_url, requisition_id: row.requisition_id, company: row.company, role_title: row.title, state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: clock.now(), updated_at: clock.now(), submission_state: "queued", submission_kind: "automatic" })
    .execute()
  for (const kind of ["resume", "cover_letter"] as const) {
    await database.db
      .insertInto("tailored_document")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: "{}", pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: clock.now() })
      .execute()
  }
  return { id, requisition: row.requisition_id }
}

const submissions = () => asOperator(app, app.get(SubmissionService))
/** The worker sends in the Operator's scope (Operator rows only until slice F). */
const send = () => sender.get(TenantDatabase).asOperator(() => sender.get(NotificationSender).sendDue())
const applicationRow = (id: string) => database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
const outboxRows = () => database.db.selectFrom("notification_outbox").selectAll().orderBy("created_at").execute()
const texts = () => smtp.received.map((email) => plainText(email.raw))
const subjects = () => smtp.received.map((email) => header(email.raw, "Subject"))

/** Runs the sender until the row has had every attempt, moving the clock past each backoff. */
async function exhaustAttempts(): Promise<void> {
  await send()
  for (const delay of RETRY_DELAYS_MS) {
    clock.set(new Date(clock.now().getTime() + delay + 1_000))
    await send()
  }
}

describe("E1: one email per Confirmed Submission (AC 7.1, 7.4, 7.5)", () => {
  it("is sent from the Candidate's Gmail, signed in with the app password, naming company, role, requisition, with dashboard links", async () => {
    const { id, requisition } = await queuedApplication({ requisition: "R-1042" })
    expect(await submissions().submit(id, "automatic")).toEqual({ result: "confirmed" })
    expect(await send()).toEqual({ sent: 1, retrying: 0, failed: 0, skipped: null })

    expect(smtp.received).toHaveLength(1)
    const [email] = smtp.received
    expect(email!.authUser).toBe(SENDER)
    expect(email!.from).toBe(SENDER)
    expect(email!.to).toEqual([SENDER])
    expect(header(email!.raw, "From")?.replace(/"/g, "")).toBe(`Eve <${SENDER}>`)
    expect(header(email!.raw, "Subject")).toBe(`Applied: Senior Frontend Engineer at Acme Payments (${requisition})`)
    const text = plainText(email!.raw)
    for (const line of ["Company: Acme Payments", "Role: Senior Frontend Engineer", "Requisition ID: R-1042", "Employment type: Direct employment", "Unverified: pay", "Automatic submissions today: 1 of 5."]) {
      expect(text).toContain(line)
    }
    for (const anchor of ["#resume", "#cover-letter", "#answers"]) expect(text).toContain(`${PUBLIC_ORIGIN}/applications/${id}${anchor}`)
    expect(email!.raw).not.toMatch(/Content-Disposition: attachment/i)
    expect(await outboxRows()).toMatchObject([{ kind: "confirmed", status: "sent", attempts: 1 }])
  })

  it("F-QA6-01: 'Automatic submissions today' counts only Confirmed Submissions, like the daily summary and the dashboard", async () => {
    const { id } = await queuedApplication({ company: "Acme Payments" })
    expect(await submissions().submit(id, "automatic")).toEqual({ result: "confirmed" })
    const day = (await applicationRow(id)).submitted_local_day
    for (const state of ["submitting", "submit_claimed", "uncertain"] as const) {
      const other = await queuedApplication({ company: `In flight ${state}` })
      await database.db.updateTable("application").set({ submission_state: state, submitted_local_day: day, submit_clicked_at: clock.now() }).where("id", "=", other.id).execute()
    }
    await send()
    const confirmed = smtp.received.filter((email) => header(email.raw, "Subject")?.startsWith("Applied:"))
    expect(confirmed).toHaveLength(1)
    expect(plainText(confirmed[0]!.raw)).toContain("Automatic submissions today: 1 of 5.")
  })

  it("a second confirmation (the Candidate's mark after page evidence) adds no second email (duplicate)", async () => {
    const { id } = await queuedApplication()
    await submissions().submit(id, "automatic")
    await database.db.updateTable("application").set({ submission_state: "uncertain" }).where("id", "=", id).execute()
    await candidate.post(`/v1/applications/${id}/mark-confirmed`).expect(200)
    await send()
    expect(smtp.received).toHaveLength(1)
    expect((await outboxRows()).filter((row) => row.kind === "confirmed")).toHaveLength(1)
  })

  it("marking an Uncertain Submission confirmed sends E1 with 'Marked confirmed by you'", async () => {
    const { id } = await queuedApplication()
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, afterSubmit: "Processing" })
    expect(await submissions().submit(id, "automatic")).toEqual({ result: "uncertain" })
    await send()
    expect(smtp.received).toHaveLength(0)
    await candidate.post(`/v1/applications/${id}/mark-confirmed`).expect(200)
    await send()
    expect(texts()[0]).toContain("Confirmed by: Marked confirmed by you")
  })

  it("no email for an Uncertain Submission, including a CAPTCHA after the click (AC 6.13, 6.14)", async () => {
    const { id } = await queuedApplication()
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, afterSubmit: "Please complete the CAPTCHA challenge: I'm not a robot" })
    expect(await submissions().submit(id, "automatic")).toEqual({ result: "uncertain" })
    expect(await send()).toEqual({ sent: 0, retrying: 0, failed: 0, skipped: null })
    expect(smtp.received).toEqual([])
    expect(await outboxRows()).toMatchObject([{ kind: "uncertain", status: "skipped" }])
  })
})

describe("E2: one email per Blocked Application (AC 7.2)", () => {
  it("states the reason and links to the Blocked Application", async () => {
    const { id } = await queuedApplication({ company: "Northwind Health", role: "Frontend Lead", requisition: "NW-55" })
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, text: "Sign in to continue. Email Password" })
    expect(await submissions().submit(id, "automatic")).toEqual({ result: "blocked" })
    await send()
    expect(subjects()).toEqual(["Needs you: Frontend Lead at Northwind Health (Login)"])
    expect(texts()[0]).toContain("Reason: Login")
    expect(texts()[0]).toContain(`Open this Blocked Application: ${PUBLIC_ORIGIN}/applications/${id}`)
  })

  it("the seventh reason names the field, never the value the assistant set", async () => {
    const { id } = await queuedApplication({ company: "Northwind Health", role: "Frontend Lead", requisition: "NW-55" })
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, tamper: { ref: "location", value: "Somewhere else" } })
    expect(await submissions().submit(id, "automatic")).toEqual({ result: "blocked" })
    await send()
    expect(subjects()).toEqual(["Needs you: Frontend Lead at Northwind Health (Automation couldn't complete the form)"])
    const text = texts()[0]!
    expect(text).toContain('"Where are you currently located?"')
    expect(text).toContain("The assistant stopped before the submit button, so the employer received nothing.")
    // The values the backend set (from settings and contact details) and the tampered value never appear.
    for (const value of ["Lagos, Nigeria", "Somewhere else", "ada@example.com", "+234"]) expect(smtp.received[0]!.raw).not.toContain(value)
  })
})

describe("SMTP failures never resubmit or change the Application (AC 6.15, 7.7)", () => {
  it("AC 6.15: with every send forced to fail, the form is submitted exactly once and the Application stays Confirmed", async () => {
    smtp.reset("refuse_auth")
    const { id } = await queuedApplication({ requisition: "R-1042" })
    expect(await submissions().submit(id, "automatic")).toEqual({ result: "confirmed" })
    const before = await applicationRow(id)
    await exhaustAttempts()
    // The daily submission run after the failures picks nothing up again.
    await submissions().runDaily()

    expect(forms.clicks).toHaveLength(1)
    expect(await applicationRow(id)).toEqual(before)
    expect(smtp.authAttempts).toHaveLength(MAX_ATTEMPTS)
    expect(smtp.received).toEqual([])
    expect(await outboxRows()).toMatchObject([{ kind: "confirmed", status: "failed", attempts: MAX_ATTEMPTS, last_error: "auth_failed" }])
    const events = await database.db.selectFrom("submission_event").select("kind").where("application_id", "=", id).execute()
    expect(events.filter((event) => event.kind.startsWith("claim"))).toEqual([])
  })

  it.each([
    ["refuse_auth", "auth_failed"],
    ["refuse_send", "send_refused"],
    ["hang", "timeout"],
  ] as const)("Gmail SMTP %s: logged without the app password, the Blocked Application unchanged, no attempt starts", async (mode, code) => {
    const { id } = await queuedApplication({ company: "Northwind Health", role: "Frontend Lead", requisition: "NW-55" })
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, text: "Sign in to continue. Email Password" })
    await submissions().submit(id, "automatic")
    const before = await applicationRow(id)
    const opened = forms.opened
    smtp.reset(mode)
    logs.length = 0
    await send()

    expect(await outboxRows()).toMatchObject([{ kind: "blocked", status: "pending", attempts: 1, last_error: code }])
    expect(logs.some((line) => line.includes(`not sent (${code})`))).toBe(true)
    expect(await applicationRow(id)).toEqual(before)
    expect(forms.opened).toBe(opened)
    if (mode !== "hang") expect(smtp.authAttempts.at(-1)?.password).toBe(APP_PASSWORD)
  })

  it("a retry after a transient failure sends exactly one email", async () => {
    const { id } = await queuedApplication()
    smtp.reset("refuse_send")
    await submissions().submit(id, "automatic")
    await send()
    smtp.mode = "accept"
    await send()
    expect(smtp.received).toHaveLength(0)
    clock.set(new Date(clock.now().getTime() + RETRY_DELAYS_MS[0] + 1_000))
    await send()
    await send()
    expect(smtp.received).toHaveLength(1)
    expect(await outboxRows()).toMatchObject([{ status: "sent", attempts: 2 }])
  })
})

describe("C-NOTIFY-1: GET /v1/notifications/status", () => {
  it("requires a session", async () => {
    await unauthenticated.http().get(NOTIFICATION_STATUS_PATH).expect(401)
  })

  it("reports the latest final failure and clears it after a later send, never returning the address or password", async () => {
    await database.db.insertInto("notification_sender_state").values({ singleton: true, configured: true, updated_at: clock.now() }).execute()
    smtp.reset("refuse_auth")
    const { id } = await queuedApplication()
    await submissions().submit(id, "automatic")
    await exhaustAttempts()
    const failed = await candidate.get(NOTIFICATION_STATUS_PATH).expect(200)
    expect(notificationStatusSchema.parse(failed.body)).toEqual({
      senderConfigured: true,
      pendingCount: 0,
      latestFailure: { failedAt: clock.now().toISOString(), emailType: "confirmed_submission", applicationId: id, watDay: null },
      costPauseEmailFailedAt: null,
      accessRequests: { waiting: 0, failed: 0 },
    })
    expect(failed.headers["cache-control"]).toBe("no-store")
    expect(JSON.stringify(failed.body)).not.toContain(SENDER)

    smtp.reset("accept")
    const blocked = await queuedApplication({ company: "Northwind Health" })
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM, text: "Sign in to continue. Email Password" })
    await submissions().submit(blocked.id, "automatic")
    clock.set(new Date(clock.now().getTime() + 1_000))
    await send()
    expect(notificationStatusSchema.parse((await candidate.get(NOTIFICATION_STATUS_PATH).expect(200)).body).latestFailure).toBeNull()
  })

  it("with no sender state recorded, the sender reads as not configured", async () => {
    expect(notificationStatusSchema.parse((await candidate.get(NOTIFICATION_STATUS_PATH).expect(200)).body)).toEqual({ senderConfigured: false, pendingCount: 0, latestFailure: null, costPauseEmailFailedAt: null, accessRequests: { waiting: 0, failed: 0 } })
  })

  it("v1.11.0: a cost-pause email that failed every attempt is reported in costPauseEmailFailedAt, not latestFailure", async () => {
    await database.db.insertInto("notification_sender_state").values({ singleton: true, configured: true, updated_at: clock.now() }).execute()
    const failedAt = new Date("2026-10-20T10:00:00Z")
    await database.db
      .insertInto("notification_outbox")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: null, kind: "cost_pause", local_day: null, payload: JSON.stringify({ month: "2026-10-01", spentMicros: 1, ceilingMicros: 2, action: null, estimateMicros: null, pausedAt: failedAt.toISOString() }), created_at: failedAt, sent_at: null, status: "failed", attempts: 4, last_failed_at: failedAt })
      .execute()
    expect(notificationStatusSchema.parse((await candidate.get(NOTIFICATION_STATUS_PATH).expect(200)).body)).toEqual({
      senderConfigured: true,
      pendingCount: 0,
      latestFailure: null,
      costPauseEmailFailedAt: failedAt.toISOString(),
      accessRequests: { waiting: 0, failed: 0 },
    })
  })
})

describe("email links require dashboard authentication (AC 7.4)", () => {
  it("the data behind every link refuses an unauthenticated request with no document or answer content", async () => {
    const { id } = await queuedApplication()
    await submissions().submit(id, "automatic")
    for (const path of [`/v1/applications/${id}`, `/v1/applications/${id}/documents/resume.pdf`, `/v1/applications/${id}/documents/cover-letter.pdf`, `/v1/applications/${id}/form-answers`]) {
      const response = await unauthenticated.http().get(path).expect(401)
      expect(response.body).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } })
    }
  })
})

describe("E3: the daily summary (AC 7.3)", () => {
  it("lists skipped roles with reasons, failures and Uncertain Submissions, once per WAT day", async () => {
    clock.set("2026-10-20T19:00:00.000Z") // 20:00 WAT
    await posting({ company: "Hooli", role: "Product Designer", status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Figma" })
    await posting({ company: "Contoso", role: "Frontend Engineer", status: "skipped", skipReason: "unsupported_application_system", skipDetail: "Workday" })
    await posting({ company: "Lucky Odds Ltd", role: "Senior Frontend Engineer", status: "excluded", skipReason: "violated_rule", skipDetail: "industry" })
    await posting({ company: "Yesterday Co", status: "skipped", skipReason: "weak_core_match", evaluatedAt: new Date("2026-10-19T12:00:00Z") })
    const failure = await queuedApplication({ company: "Initech", role: "Frontend Lead" })
    await database.db.updateTable("application").set({ state: "documents_blocked", blocked_document: "resume", blocked_claim: "Led a team of 40", submission_state: null, updated_at: clock.now() }).where("id", "=", failure.id).execute()
    const uncertain = await queuedApplication({ company: "Umbrella", role: "Fullstack Engineer" })
    await database.db
      .updateTable("application")
      .set({ submission_state: "uncertain", submitted_local_day: "2026-10-20", submit_clicked_at: new Date("2026-10-20T09:15:00Z"), captcha_after_submit: true })
      .where("id", "=", uncertain.id)
      .execute()
    const closed = await queuedApplication({ company: "Initech", role: "Fullstack Engineer", status: "excluded" })
    await submissions().submit(closed.id, "automatic")

    const jobs = await bootWorker()
    try {
      clock.set("2026-10-20T20:00:00.000Z") // 21:00 WAT
      expect(await jobs.get(NotificationJobs).enqueueDailySummary()).toBe(true)
      expect(await jobs.get(NotificationJobs).enqueueDailySummary()).toBe(false)
    } finally {
      await jobs.close()
    }
    await send()
    const summaries = smtp.received.filter((email) => header(email.raw, "Subject")?.startsWith("Eve, 20 Oct 2026"))
    expect(summaries).toHaveLength(1)
    const text = plainText(summaries[0]!.raw)
    expect(text).toContain("Product Designer at Hooli: your profile doesn't show a required prerequisite")
    expect(text).toContain("Frontend Engineer at Contoso: Eve can't apply through this employer's application system. You can prepare it anyway, then apply on the employer's site.")
    expect(text).toContain("Senior Frontend Engineer at Lucky Odds Ltd: doesn't fit your industry rule")
    expect(text).toContain("Frontend Lead at Initech: document validation blocked")
    expect(text).toContain("Fullstack Engineer at Umbrella, submitted 10:15 WAT. A CAPTCHA appeared after the submit click, so receipt can't be confirmed; it won't be retried.")
    expect(text).toContain("Fullstack Engineer at Initech: posting closed")
    expect(text).not.toContain("Yesterday Co")
    const summaryRows = await database.db.selectFrom("notification_outbox").select(["status", sql<string>`local_day::text`.as("day")]).where("kind", "=", "daily_summary").execute()
    expect(summaryRows).toEqual([{ status: "sent", day: "2026-10-20" }])
  })

  it("EPIC-0006 (AC-3.10): the skipped list leaves out postings hidden for the Operator; no new line", async () => {
    clock.set("2026-10-20T19:00:00.000Z")
    await posting({ company: "Hooli", role: "Senior Frontend Engineer", status: "skipped", skipReason: "weak_core_match" })
    const hidden = await posting({ company: "Globex", role: "Senior Data Engineer", status: "skipped", skipReason: "weak_core_match" })
    await database.db.updateTable("job_posting").set({ role_family: "data_ml" }).where("id", "=", hidden).execute()
    const facts = await app.get(TenantDatabase).asOperator(() => app.get(NotificationRepository).dailySummaryFacts("2026-10-20"))
    expect(facts.skipped.map((row) => row.company)).toEqual(["Hooli"])
  })

  // applications-and-links:207 (r6, P18); api-contract.r1 "Other"; Q3-2: the failure list is Application document failures on visible postings only.
  it("EPIC-0006 (AC-3.10): the failure list leaves out Application failures on postings hidden for the Operator; no new line", async () => {
    clock.set("2026-10-20T19:00:00.000Z")
    const hidden = await queuedApplication({ company: "Globex", role: "Solutions Architect" })
    const visible = await queuedApplication({ company: "Hooli", role: "Senior Frontend Engineer" })
    const posting = await database.db.selectFrom("application").select("job_posting_id").where("id", "=", hidden.id).executeTakeFirstOrThrow()
    await database.db.updateTable("job_posting").set({ role_family: "solutions_customer" }).where("id", "=", posting.job_posting_id).execute()
    await database.db.updateTable("application").set({ state: "documents_failed", submission_state: null, updated_at: clock.now() }).where("id", "=", hidden.id).execute()
    await database.db.updateTable("application").set({ state: "documents_blocked", blocked_document: "resume", blocked_claim: "Led a team of 40", submission_state: null, updated_at: clock.now() }).where("id", "=", visible.id).execute()
    const facts = await app.get(TenantDatabase).asOperator(() => app.get(NotificationRepository).dailySummaryFacts("2026-10-20"))
    expect(facts.failures.map((row) => row.company)).toEqual(["Hooli"])
    // Control: once solutions_customer is targeted the same failure is listed, so visibility alone left it out.
    const criteria = () => database.db.updateTable("job_criteria").where("candidate_id", "=", database.operatorId)
    await criteria().set({ target_role_families: sql`array_append(target_role_families, 'solutions_customer')` }).execute()
    try {
      const after = await app.get(TenantDatabase).asOperator(() => app.get(NotificationRepository).dailySummaryFacts("2026-10-20"))
      expect(after.failures.map((row) => row.company).sort()).toEqual(["Globex", "Hooli"])
    } finally {
      await criteria().set({ target_role_families: sql`array_remove(target_role_families, 'solutions_customer')` }).execute()
    }
  })

  // EPIC-0004 criteria-decision.feature @ac-5.9 (both daily-summary scenarios).
  it("lists technology_mismatch skips with the dashboard line and the plain reason for weak_core_match", async () => {
    clock.set("2026-10-20T19:00:00.000Z")
    await posting({ company: "Umbrella", role: "Backend Engineer", status: "skipped", skipReason: "technology_mismatch" })
    await posting({ company: "Hooli", role: "Mobile Engineer", status: "skipped", skipReason: "uncovered_mandatory_prerequisite", skipDetail: "Kotlin" })
    await posting({ company: "Initech", role: "Frontend Engineer", status: "skipped", skipReason: "weak_core_match" })
    await database.db.insertInto("notification_outbox").values({ id: randomUUID(), candidate_id: database.operatorId, application_id: null, kind: "daily_summary", local_day: "2026-10-20", created_at: clock.now(), sent_at: null }).execute()
    await send()
    const text = texts()[0]!
    expect(text).toContain("Backend Engineer at Umbrella: doesn't mention your frameworks or technologies")
    expect(text).toContain("Mobile Engineer at Hooli: your profile doesn't show a required prerequisite")
    expect(text).toContain("Frontend Engineer at Initech: your profile backs too few of the core responsibilities")
    expect(text).not.toContain("is below your")
  })

  it("an empty day still gets one summary with the none lines", async () => {
    await database.db.insertInto("notification_outbox").values({ candidate_id: database.operatorId, id: randomUUID(), application_id: null, kind: "daily_summary", local_day: "2026-10-20", created_at: clock.now(), sent_at: null }).execute()
    await send()
    const text = texts()[0]!
    for (const line of ["No jobs were ruled out.", "Nothing failed.", "No unsure sends."]) expect(text).toContain(line)
  })
})

describe("E4: the cost ceiling pause email (AC 10.2, AC 7.5)", () => {
  beforeEach(async () => {
    await database.db.deleteFrom("spend_entry").execute()
    await database.db.deleteFrom("spend_month").execute()
  })

  it("crossing the ceiling sends one email from the Candidate's Gmail; later refusals send none", async () => {
    const ledger = app.get(SpendLedger)
    // The month starts with the default USD 24 hosting accrual; seed the rest up to USD 49.80.
    const seedMicros = 49_800_000 - (await ledger.month()).spent
    const seed = await ledger.reserve({ category: "ai", purpose: "seed", estimateMicros: seedMicros, action: null })
    expect(seed.ok).toBe(true)
    if (seed.ok) await ledger.settle(seed.id, seedMicros)
    expect(await ledger.reserve({ category: "browser", purpose: "browser_attempt", estimateMicros: 300_000, action: "form filling" })).toEqual({ ok: false, refusal: "cost_paused" })
    await send()
    expect(smtp.received).toHaveLength(1)
    expect(smtp.received[0]!.authUser).toBe(SENDER)
    expect(smtp.received[0]!.to).toEqual([SENDER])
    expect(header(smtp.received[0]!.raw, "Subject")).toBe("Paid automation paused: monthly cost ceiling")
    const text = plainText(smtp.received[0]!.raw)
    expect(text).toContain("Spent this month: USD 49.80")
    expect(text).toContain("Next paid action: form filling, estimated USD 0.30")
    expect(text).toContain(`${PUBLIC_ORIGIN}/settings#cost`)

    clock.set("2026-10-26T09:00:00.000Z")
    expect((await ledger.reserve({ category: "email", purpose: "t", estimateMicros: 10_000, action: null })).ok).toBe(false)
    expect((await ledger.reserve({ category: "ai", purpose: "t", estimateMicros: 10_000, action: null })).ok).toBe(false)
    await send()
    expect(smtp.received).toHaveLength(1)
    expect((await outboxRows()).filter((row) => row.kind === "cost_pause")).toHaveLength(1)
  })
})

/** The real WorkerModule (pg-boss, every job class) with the fake SMTP Mailer settings. */
async function bootWorker(options: { mailer?: MailerConfig | null; dailySummaryEnabled?: boolean } = {}): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      WorkerModule.forRoot({
        databaseUrl: database.url,
        anthropic: anthropicConfig(undefined, "claude-haiku-5-5"),
        candidateStorageDir: storage,
        mailer: options.mailer === undefined ? config : options.mailer,
        dailySummaryEnabled: options.dailySummaryEnabled ?? false,
      }),
    ],
  })
    .overrideProvider(WorkerHeartbeat)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(FORM_SESSION_FACTORY)
    .useValue(forms)
    .overrideProvider(QUESTION_SCHEMAS)
    .useValue(forms.questionSchemas)
    .compile()
  moduleRef.useLogger(capture)
  await moduleRef.init()
  return moduleRef
}

describe("worker start", () => {
  it("records whether the sender is configured; with no Gmail settings rows stay pending and nothing crashes", async () => {
    const { id } = await queuedApplication()
    await submissions().submit(id, "automatic")
    const worker = await bootWorker({ mailer: null })
    try {
      expect(await worker.get(NotificationJobs).sendDue()).toEqual({ sent: 0, retrying: 0, failed: 0, skipped: "not_configured" })
      expect(await outboxRows()).toMatchObject([{ status: "pending", attempts: 0 }])
      expect((await database.db.selectFrom("notification_sender_state").selectAll().executeTakeFirstOrThrow()).configured).toBe(false)
    } finally {
      await worker.close()
    }
    expect(smtp.authAttempts).toEqual([])
  })

  it("a row left sending by a crash is failed as interrupted and never resent", async () => {
    const { id } = await queuedApplication()
    await submissions().submit(id, "automatic")
    await database.db.updateTable("notification_outbox").set({ status: "sending", attempts: 1 }).execute()
    const worker = await bootWorker()
    try {
      expect(await outboxRows()).toMatchObject([{ status: "failed", last_error: "interrupted" }])
      await worker.get(NotificationJobs).sendDue()
    } finally {
      await worker.close()
    }
    expect(smtp.received).toEqual([])
  })

  it("the daily summary schedule exists only when enabled", async () => {
    const schedules = () => sql<{ name: string }>`select name from pgboss.schedule order by name`.execute(database.db).then((result) => result.rows.map((row) => row.name))
    const off = await bootWorker()
    await off.close()
    expect(await schedules()).not.toContain("notification.daily-summary")
    expect(await schedules()).toContain("notification.send")
    const on = await bootWorker({ dailySummaryEnabled: true })
    await on.close()
    expect(await schedules()).toContain("notification.daily-summary")
    const offAgain = await bootWorker()
    await offAgain.close()
    expect(await schedules()).not.toContain("notification.daily-summary")
  })
})

describe("the app password stays in the server environment (AC 7.6)", () => {
  it("is in no database table after a day of notifications, including a failed send", async () => {
    const ok = await queuedApplication()
    await submissions().submit(ok.id, "automatic")
    await send()
    smtp.reset("refuse_auth")
    const bad = await queuedApplication({ company: "Northwind Health" })
    await submissions().submit(bad.id, "automatic")
    await send()
    const tables = await sql<{ name: string }>`
      select format('%I.%I', table_schema, table_name) as name from information_schema.tables
      where table_schema in ('public', 'pgboss') and table_type = 'BASE TABLE'`.execute(database.db)
    let dump = ""
    for (const { name } of tables.rows) {
      const { rows } = await sql<{ row: string }>`select row_to_json(t)::text as row from ${sql.raw(name)} t`.execute(database.db)
      dump += rows.map((row) => row.row).join("\n")
    }
    expect(dump.length).toBeGreaterThan(1000)
    expect(dump).toContain("Acme Payments")
    expect(dump).not.toContain(APP_PASSWORD)
    expect(dump).not.toContain(APP_PASSWORD_SHOWN)
  })
})
