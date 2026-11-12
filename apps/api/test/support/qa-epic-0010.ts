import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { type Kysely, sql } from "kysely"
import { HttpResponse, http } from "msw"

import { SESSION_COOKIE } from "../../src/auth/cookies.js"
import type { Database } from "../../src/db/schema.js"
import { DiscoveryService } from "../../src/discovery/discovery.service.js"
import { Browser } from "./browser.js"
import { FakeAnthropic, OutboundRecorder } from "./fake-anthropic.js"
import { FakeGoogle } from "./fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./postgres.js"
import { SignedInCandidate, signInCandidate } from "./signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./test-app.js"
import { TestClock } from "./test-clock.js"

/**
 * QA test authoring, step [5e], EPIC-0010 (pasted job descriptions; api-contract.md v1.27.0,
 * gherkin/*.feature, threat-model.md, copy-deck.r1.md). Fixtures and the exact strings the
 * qa-epic-0010-*.int-spec.ts files assert. QA-owned and independent of the implementation:
 * messages are copied from copy-deck.r1.md / api-contract.md byte for byte, not imported
 * from @eve/contracts or the api, so a wrong string in the product fails the test.
 *
 * Columns the v1.27.0 migration adds (`owner_candidate_id`, `paste_fingerprint`) and the
 * widened `origin` value are read and written with raw SQL, so this file type-checks before
 * the backend adds them to `schema.ts`.
 */

export const PASTE_PATH = "/v1/job-postings/links"

/** api-contract.md v1.27.0 "New error codes" (= copy-deck.r1.md C-PD-21..28) and the reused messages. */
export const PD_COPY = {
  descriptionShort: "Too short to check. Paste the full description, at least 200 characters.", // C-PD-21
  descriptionLong: "Over the 30,000-character limit. Shorten it to check this job.", // C-PD-22
  titleMissing: "Enter the job title.", // C-PD-23
  companyMissing: "Enter the company.", // C-PD-24
  titleTooLong: "Job title is over 200 characters. Shorten it.", // C-PD-25
  companyTooLong: "Company is over 200 characters. Shorten it.", // C-PD-25b
  employerPageUnreadable: "Eve couldn't read the employer's page. Enter the Job title and Company to use your description.", // C-PD-27
  stillChecking: "Eve is still checking your earlier description for this job. Try again when that finishes.", // C-PD-28
  manualOnly: "This Application is manual only. Eve never sends it, so it can't be queued or used as a sample. Nothing changed.", // manual_application_only (no copy slot)
  overrideNotAllowed: "This posting's reason can't be overridden. Nothing changed.", // C-AA-10
  notEligible: "This Job Posting is still being checked or couldn't be checked, so it can't become an Application yet.", // application_not_eligible
  linkInvalid: "Enter a full link that starts with https:// or http://.", // C-VAL-LINK-2
} as const

/** The six field codes and their messages (contract table). */
export const FIELD_CODE_MESSAGE = {
  job_description_too_short: PD_COPY.descriptionShort,
  job_description_too_long: PD_COPY.descriptionLong,
  job_title_required: PD_COPY.titleMissing,
  job_title_too_long: PD_COPY.titleTooLong,
  company_required: PD_COPY.companyMissing,
  company_too_long: PD_COPY.companyTooLong,
} as const

export const TITLE = "Senior Frontend Engineer"
export const COMPANY = "Paystack"

const DESC_BASE =
  "Senior Frontend Engineer\n\nAbout the role\nPaystack helps businesses in Africa get paid by anyone, anywhere in the world. " +
  "We are looking for a Senior Frontend Engineer to build merchant-facing products.\n\nWhat you will do\n" +
  "- Build React features with TypeScript for the merchant dashboard.\n- Design GraphQL queries with the API team.\n" +
  "- Mentor engineers and review code.\n\nRequirements\n- Five years building web applications with React.\n" +
  "- Strong TypeScript.\n- Experience with GraphQL.\n\nLocation: Remote, open to candidates in Nigeria. Core hours 10:00 to 18:00 WAT.\n" +
  "Salary USD 60,000 to 80,000 per year.\n"

/**
 * DESC-PAYSTACK (paste-description.feature fixture): a 1,240-character plain-text description of
 * "Senior Frontend Engineer" at "Paystack" asking for React, TypeScript and GraphQL, with no
 * instructions to the assistant. `marker` makes each test's text unique and traceable in model
 * requests, logs and the database.
 */
export function descPaystack(marker = "QA-EPIC-0010"): string {
  const head = `${DESC_BASE}Reference ${marker}.\n`
  const filler = "We value clear writing, steady delivery and kind code review. "
  let text = head
  while (text.length < 1240) text += filler
  return text.slice(0, 1239).trimEnd().padEnd(1239, ".") + "."
}

/** DESC-PAYSTACK-V2 (re-paste-and-duplicates.feature): DESC-PAYSTACK with one added sentence. */
export function descPaystackV2(marker = "QA-EPIC-0010"): string {
  return `${descPaystack(marker)} Experience with Storybook is a plus.`
}

/** A description of exactly `length` characters after normalising (no leading/trailing whitespace). */
export function descriptionOfLength(length: number, marker = "QA-LEN"): string {
  const seed = `${marker} Build React features for merchants. `
  let text = ""
  while (text.length < length) text += seed
  text = text.slice(0, length)
  // Never end on whitespace, so trimming keeps the exact length.
  return text.endsWith(" ") ? `${text.slice(0, -1)}x` : text
}

/** Links used across the EPIC-0010 Gherkin files. */
export const LINKS = {
  linkedIn: "https://www.linkedin.com/jobs/view/4012345678",
  flutterwave: "https://careers.flutterwave.com/jobs/senior-frontend-42",
  workday: "https://acme.wd5.myworkdayjobs.com/en-US/job/R-77",
  greenhouse: "https://boards.greenhouse.io/acme/jobs/4012345",
  greenhouseMissing: "https://boards.greenhouse.io/acme/jobs/4019999",
  greenhouseNoContent: "https://boards.greenhouse.io/acme/jobs/4019998",
  greenhouseExcluded: "https://boards.greenhouse.io/acme/jobs/4012346",
  lever: "https://jobs.lever.co/acme/7f3c2a10-1111-2222-3333-444455556666",
  leverMissing: "https://jobs.lever.co/acme/fe-missing-1",
  leverUndated: "https://jobs.lever.co/acme/fe-undated-1",
  ashby: "https://jobs.ashbyhq.com/beta/0a1b2c3d-0000-1111-2222-333344445555",
  ashbyMissing: "https://jobs.ashbyhq.com/beta/0a1b2c3d-0000-1111-2222-999999999999",
  greenhouseLookalike: "https://boards.greenhouse.io.evil.com/x/jobs/1",
} as const

/** The public API URL each ATS link is looked up at (apps/api/src/discovery/sources/ats-lookup.ts). */
export const ATS_API = {
  greenhouse: (id: string) => `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${id}`,
  lever: (id: string) => `https://api.lever.co/v0/postings/acme/${id}`,
  ashby: "https://api.ashbyhq.com/posting-api/job-board/beta",
} as const

/** A 2,400-character employer description ("the employer's text", RP:46). */
export const EMPLOYER_TEXT = (() => {
  let text = "Remote, open to candidates in Nigeria. Acme builds payment APIs for merchants. Build React features. Mentor engineers. "
  while (text.length < 2400) text += "Acme ships carefully and reviews every change. "
  return text.slice(0, 2400)
})()

/** Dated 2026-10-28 (inside the 60-day window of the 2026-11-02 test clock), Frontend, mid-or-higher. */
export const EMPLOYER_POSTED = "2026-10-28T09:00:00Z"

export const atsStubs = {
  greenhouseOk: (id = "4012345", title = TITLE, company = "Acme") =>
    http.get(ATS_API.greenhouse(id), () =>
      HttpResponse.json({ id: Number(id), title, absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`, requisition_id: id, company_name: company, location: { name: "Remote" }, content: EMPLOYER_TEXT, first_published: EMPLOYER_POSTED })
    ),
  greenhouse404: (id = "4019999") => http.get(ATS_API.greenhouse(id), () => HttpResponse.json({ status: 404 }, { status: 404 })),
  greenhouseNoContent: (id = "4019998") => http.get(ATS_API.greenhouse(id), () => HttpResponse.json({ id: Number(id), title: TITLE, absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`, content: "" })),
  leverOk: (id = "7f3c2a10-1111-2222-3333-444455556666", title = TITLE) =>
    http.get(ATS_API.lever(id), () => HttpResponse.json({ id, text: title, hostedUrl: `https://jobs.lever.co/acme/${id}`, descriptionPlain: EMPLOYER_TEXT, createdAt: Date.parse(EMPLOYER_POSTED) })),
  leverUndated: () => http.get(ATS_API.lever("fe-undated-1"), () => HttpResponse.json({ id: "fe-undated-1", text: TITLE, hostedUrl: LINKS.leverUndated, descriptionPlain: EMPLOYER_TEXT })),
  /** Stands in for "times out": the same lookup-failure branch (BoardReadError) without waiting BOARD_TIMEOUT_MS. */
  leverNetworkFailure: (id = "fe-missing-1") => http.get(ATS_API.lever(id), () => HttpResponse.error()),
  ashbyOk: (title = TITLE) =>
    http.get(ATS_API.ashby, () =>
      HttpResponse.json({ jobs: [{ id: "0a1b2c3d-0000-1111-2222-333344445555", title, jobUrl: LINKS.ashby, isListed: true, location: "Remote", descriptionPlain: EMPLOYER_TEXT, publishedAt: EMPLOYER_POSTED }] })
    ),
  ashby500: () => http.get(ATS_API.ashby, () => HttpResponse.json({ error: "x" }, { status: 500 })),
} as const

/** A strong extraction answer for the evaluation stub (as qa-check-this-job-paste.int-spec.ts). */
export const STRONG_EXTRACTION = {
  workArrangement: "remote",
  locationQuote: "Remote, open to candidates in Nigeria",
  relocationCountry: null,
  relocationQuote: null,
  sponsorshipQuote: null,
  payQuote: "Salary USD 60,000 to 80,000 per year",
  hoursQuote: "Core hours 10:00 to 18:00 WAT",
  employerBusiness: "payments for businesses",
  businessQuote: "Paystack helps businesses in Africa get paid",
  employmentType: null,
  coreResponsibilities: [
    { text: "Build React features", quote: "Build React features with TypeScript for the merchant dashboard", factId: "F1" },
    { text: "Mentor engineers", quote: "Mentor engineers and review code", factId: "F3" },
  ],
  mandatoryPrerequisites: [],
  niceToHave: [],
}

export const SECTIONS = [
  {
    id: "s1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021-2026",
    sourceQuote: null,
    facts: [
      { id: "F1", text: "Built a React and TypeScript merchant dashboard from scratch to production", sourceQuote: null },
      { id: "F3", text: "Mentored 6 junior developers", sourceQuote: null },
    ],
  },
]

/** Every row the paste path writes, in delete order, for a clean start. */
export const POSTING_TABLES = ["ai_call", "match_evidence", "eligibility_result", "candidate_posting", "job_posting"] as const

export type StoredPasted = Readonly<{
  id: string
  origin: string
  owner_candidate_id: string | null
  paste_fingerprint: string | null
  application_url: string | null
  apply_url: string | null
  apply_mode: string
  requisition_id: string
  title: string
  company: string
  posting_text: string
  technologies: unknown
  ats_skills: unknown
  role_family: string | null
}>

/** Every `job_posting` row, with the v1.27.0 columns, read as the superuser (RLS does not bind it). */
export async function allPostings(db: Kysely<Database>): Promise<StoredPasted[]> {
  const { rows } = await sql<StoredPasted>`select id, origin, owner_candidate_id, paste_fingerprint, application_url, apply_url, apply_mode, requisition_id,
      title, company, posting_text, technologies, ats_skills, role_family from job_posting order by discovered_at, id`.execute(db)
  return rows
}

/** The Candidate's holds (`candidate_posting`) with the posting's link and origin. */
export async function holdsOf(db: Kysely<Database>, candidateId: string): Promise<{ job_posting_id: string; origin: string; status: string; skip_reason: string | null; application_url: string | null; posting_text: string }[]> {
  const { rows } = await sql<{ job_posting_id: string; origin: string; status: string; skip_reason: string | null; application_url: string | null; posting_text: string }>`
    select cp.job_posting_id, cp.origin, cp.status, cp.skip_reason, p.application_url, p.posting_text
      from candidate_posting cp join job_posting p on p.id = cp.job_posting_id
     where cp.candidate_id = ${candidateId} order by cp.discovered_at, cp.job_posting_id`.execute(db)
  return rows
}

/** Rows (any table) whose posting text contains `marker`: "stored nowhere" checks. */
export async function postingsContaining(db: Kysely<Database>, marker: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from job_posting where posting_text like ${`%${marker}%`} or title like ${`%${marker}%`} or company like ${`%${marker}%`}`.execute(db)
  return rows[0]?.n ?? 0
}

/** Sets the session Candidate's decision on a posting, as an evaluation would leave it. */
export async function decide(
  db: Kysely<Database>,
  candidateId: string,
  postingId: string,
  status: "ranked" | "skipped" | "excluded" | "checking" | "waiting_to_be_checked" | "not_checked" | "evaluation_failed",
  options: Readonly<{ skipReason?: string | null; skipDetail?: string | null; violated?: readonly string[] }> = {}
): Promise<void> {
  const skipReason = options.skipReason ?? (status === "excluded" ? "violated_rule" : null)
  const violated = options.violated ?? []
  await db
    .updateTable("candidate_posting")
    .set({
      status,
      skip_reason: skipReason,
      skip_detail: options.skipDetail ?? (status === "excluded" ? (violated[0] ?? null) : null),
      evaluation_failure: status === "evaluation_failed" ? "provider_error" : null,
      evaluated_at: ["checking", "waiting_to_be_checked", "not_checked"].includes(status) ? null : new Date(),
    })
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", postingId)
    .execute()
  await db.deleteFrom("eligibility_result").where("candidate_id", "=", candidateId).where("job_posting_id", "=", postingId).execute()
  if (!["ranked", "skipped", "excluded"].includes(status)) return
  const rules = [
    ...violated.map((rule) => ({ rule, result: "violated", quote: `QA quote for ${rule}` })),
    ...(violated.includes("location") ? [] : [{ rule: "location", result: "met", quote: "Remote, open to candidates in Nigeria" }]),
  ]
  await db
    .insertInto("eligibility_result")
    .values({ candidate_id: candidateId, job_posting_id: postingId, arrangement: "remote", relocation_country: null, employment_type: "direct", rules: JSON.stringify(rules), eligible: violated.length === 0, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date() })
    .execute()
}

/** Valid empty tailored document content per kind (the api parses it on read). */
const EMPTY_TAILORED_CONTENT = {
  resume: { kind: "resume", summary: [], experience: [], skills: [], education: [] },
  cover_letter: { kind: "cover_letter", greeting: "Dear team,", opening: null, paragraphs: [], closingLine: null, closing: "Regards," },
} as const

/** Puts an Application in documents ready, not queued, with both documents, as generation leaves it. */
export async function documentsReady(db: Kysely<Database>, candidateId: string, applicationId: string): Promise<void> {
  for (const kind of ["resume", "cover_letter"] as const) {
    await db
      .insertInto("tailored_document")
      .values({ candidate_id: candidateId, id: randomUUID(), application_id: applicationId, kind, career_profile_version: 1, content: JSON.stringify(EMPTY_TAILORED_CONTENT[kind]), pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: new Date() })
      .execute()
  }
  await db.updateTable("application").set({ state: "documents_ready", career_profile_version: 1 }).where("id", "=", applicationId).execute()
}

/** Everything a refused submission action must leave unchanged (PD-4.1, C-18). */
export async function submissionSnapshot(db: Kysely<Database>, candidateId: string): Promise<unknown> {
  const applications = await db.selectFrom("application").selectAll().where("candidate_id", "=", candidateId).orderBy("id").execute()
  const events = await db.selectFrom("submission_event").selectAll().where("candidate_id", "=", candidateId).orderBy("id").execute()
  const days = await db.selectFrom("submission_day").selectAll().where("candidate_id", "=", candidateId).execute()
  const activation = await db.selectFrom("activation_state").selectAll().where("candidate_id", "=", candidateId).execute()
  return { applications: applications.map((row) => ({ ...row, updated_at: null })), events, days, activation }
}

/** Requests the evaluation stub received whose prompt contains `marker` (one evaluation per accepted text). */
export function requestsWith(requests: readonly { body: Record<string, unknown> }[], marker: string): number {
  return requests.filter((request) => JSON.stringify(request.body).includes(marker)).length
}

// ── Stack ──────────────────────────────────────────────────────────────────────

export type PasteStack = Readonly<{
  database: TestDatabase
  google: FakeGoogle
  anthropic: FakeAnthropic
  outbound: OutboundRecorder
  app: INestApplication
  clock: TestClock
  ada: SignedInCandidate
  /** "bola@example.com" in the Gherkin: an invited Candidate whose postings may not be evaluated yet (D13). */
  bola: SignedInCandidate
  bolaId: string
  storage: string
  /** POST /v1/job-postings/links as `who`, then waits for in-process evaluation to settle. */
  paste(who: SignedInCandidate, body: Record<string, unknown>): Promise<Response>
  settle(): Promise<void>
  /** Clean posting, application and pause state between tests. */
  reset(): Promise<void>
  stop(): Promise<void>
}>

type Response = Awaited<ReturnType<SignedInCandidate["post"]>>

const BOLA_SUB = "200000000000000010010"
const BOLA_EMAIL = "bola.epic0010@example.test"

/**
 * Boots the real api (Fastify, Postgres, in-process evaluation) with the Google and model fakes,
 * the Operator (Ada) and one invitee (Bola), both with an approved Career Profile and Frontend
 * targets, and the AI provider approved. Clock: 2026-11-02 09:00 WAT (paste-description.feature).
 */
export async function startPasteStack(): Promise<PasteStack> {
  const clock = new TestClock("2026-11-02T08:00:00.000Z")
  const storage = await mkdtemp(join(tmpdir(), "ja-qa-epic0010-"))
  markStorageMigratedSync(storage)
  const database = await startMigratedDatabase()
  const google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  const anthropic = new FakeAnthropic(google.server)
  const outbound = new OutboundRecorder(google.server)
  const app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage } })
  const ada = await signInCandidate(new Browser(app, google))

  const bolaId = (await database.db.insertInto("candidate").values({ email: BOLA_EMAIL, google_sub: BOLA_SUB, role: "candidate", onboarded_at: new Date() } as never).returning("id").executeTakeFirstOrThrow()).id
  await database.db.insertInto("job_criteria").values({ candidate_id: bolaId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: BOLA_SUB, email: BOLA_EMAIL, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  const bola = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, BOLA_EMAIL)

  await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  for (const candidateId of [database.operatorId, bolaId]) {
    await database.db.updateTable("job_criteria").set({ min_core_match_percent: 70, frameworks: [], technologies: [], target_role_families: ["senior_frontend"], seniority_floor: "hide_entry_level" }).where("candidate_id", "=", candidateId).execute()
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: candidateId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(SECTIONS), created_at: new Date(), approved_at: new Date() })
      .execute()
  }

  const settle = () => app.get(DiscoveryService).settled()
  return {
    database,
    google,
    anthropic,
    outbound,
    app,
    clock,
    ada,
    bola,
    bolaId,
    storage,
    settle,
    async paste(who, body) {
      const response = await who.post(PASTE_PATH).send(body)
      await settle()
      return response
    },
    async reset() {
      await settle()
      google.server.resetHandlers()
      anthropic.install()
      anthropic.reset()
      outbound.reset()
      for (const table of ["notification_outbox", "submission_event", "tailored_document", "application", "submission_day"] as const) await database.db.deleteFrom(table).execute()
      for (const table of POSTING_TABLES) await database.db.deleteFrom(table).execute()
      await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
    },
    async stop() {
      await app?.close()
      google?.close()
      await database?.stop()
      await rm(storage, { recursive: true, force: true })
    },
  }
}
