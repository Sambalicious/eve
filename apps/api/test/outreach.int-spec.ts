import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type INestApplication, Logger } from "@nestjs/common"
import { ANTHROPIC_TERMS, DELETE_DETAILS_PATH, GLOBAL_PAUSE_PATH, applicationDetailSchema, applicationsResponseSchema } from "@eve/contracts"
import { type Insertable, type Kysely, sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { CandidateScope } from "../src/db/candidate-scope.js"
import { WORKER_STATEMENT_TIMEOUT_MS, createDatabase } from "../src/db/create-database.js"
import type { ApplicationTable, Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { OutreachService } from "../src/outreach/outreach.service.js"
import { RetentionRunner } from "../src/records/retention-runner.js"
import { SpendLedger } from "../src/spend/spend-ledger.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import {
  TEST_ANTHROPIC_KEY,
  TEST_ANTHROPIC_MODEL,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  createTestApp,
  markStorageMigratedSync,
} from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA test authoring, step [5e], EPIC-0014 Outreach messages (api-contract.md v1.31.0,
 * gherkin/outreach-*.feature, architecture.r1.md D1 to D14).
 *
 * Black box: every assertion is made through the three published routes or through the database
 * as a Candidate binding sees it. Route paths, counts and copy strings are written here rather
 * than imported from the product, so a drift in `@eve/contracts` or the api fails this file.
 * Outreach rows are seeded with SQL (contract section 12: "seed … through SQL under the
 * Candidate's binding when a test must bypass a writer"); no repository is mocked.
 *
 * The implementation does not exist in this worktree yet, so most tests fail at run time. That
 * is expected: they are the gate the implementation must satisfy.
 */

type Kind = "referral_request" | "introduction" | "application_note"

/** api-contract.md section 4: path slugs against JSON kinds. */
const SLUGS: Record<Kind, string> = {
  referral_request: "referral-request",
  introduction: "introduction",
  application_note: "application-note",
}

/** api-contract.md section 2 "Order of checks": the exact not-found body. */
const NOT_FOUND = { error: { code: "not_found", message: "Not found." } }
const CSRF_INVALID = { error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } }
const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in to continue." } }
const NAME_INVALID = {
  error: {
    code: "outreach_reader_name_invalid",
    message: "Use letters, spaces, hyphens, apostrophes and full stops, up to 40 characters.",
  },
}

const outreachPath = (applicationId: string) => `/v1/applications/${applicationId}/outreach`
const writePath = (applicationId: string, kind: Kind) => `${outreachPath(applicationId)}/${SLUGS[kind]}/write`
const namePath = (applicationId: string, kind: Kind) => `${outreachPath(applicationId)}/${SLUGS[kind]}/reader-name`

/** The gherkin Background facts, as the profile stores them (ids are what the model cites as F1 to F4). */
const F1 = { id: "6f1c0e8a-1111-4a6b-9a01-000000000001", text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", sourceQuote: null }
const F3 = { id: "6f1c0e8a-3333-4a6b-9a01-000000000003", text: "Mentored 6 junior developers", sourceQuote: null }
const F4 = { id: "6f1c0e8a-4444-4a6b-9a01-000000000004", text: "Cut release cycle from 2 weeks to 3 days", sourceQuote: null }
const F2 = { id: "6f1c0e8a-2222-4a6b-9a01-000000000002", text: "Senior Frontend Engineer at Brightwave Ltd, 2021–2024", sourceQuote: null }
const V1 = [{ id: "s1", kind: "experience", title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021–2024", sourceQuote: null, facts: [F1, F2, F3, F4] }]

/** A fact whose text is nowhere else, so a log line that carries fact text can be caught (AC 12.5). */
const F5 = { id: "6f1c0e8a-5555-4a6b-9a01-000000000005", text: "Led the Zorvex billing migration at Brightwave Ltd", sourceQuote: null }
const V1_WITH_F5 = [{ ...V1[0]!, facts: [F1, F2, F3, F4, F5] }]

/** outreach-kinds-and-budgets.feature, "the usual reply" for each kind. */
const USUAL_REFERRAL = {
  sentences: [
    { kind: "statement", text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
    { kind: "statement", text: "I mentored 6 junior developers.", factIds: ["F3"] },
    {
      kind: "ask",
      text: "Would you be open to referring me for {role_phrase} at {company_phrase}, with no pressure at all if the answer is no?",
      factIds: [],
    },
  ],
}
const USUAL_NOTE = {
  sentences: [
    { kind: "statement", text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
    { kind: "statement", text: "I mentored 6 junior developers.", factIds: ["F3"] },
  ],
}
const USUAL_INTRODUCTION = {
  sentences: [
    { kind: "statement", text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
    { kind: "statement", text: "I cut our release cycle from 2 weeks to 3 days.", factIds: ["F4"] },
    { kind: "ask", text: "Could we have a short conversation, or could you point me to the right person?", factIds: [] },
  ],
}

/** outreach-blocked-quote.feature, "the blocked reply" for the Referral request. */
const BLOCKED_REFERRAL = {
  sentences: [
    { kind: "statement", text: "I built the merchant dashboard in Angular.", factIds: ["F1"] },
    { kind: "statement", text: "I mentored 12 junior developers.", factIds: ["F3"] },
    { kind: "ask", text: "Would you be open to referring me for {role_phrase} at {company_phrase}, with no pressure at all if the answer is no?", factIds: [] },
  ],
}
const BLOCKED_SENTENCE = "I built the merchant dashboard in Angular."

/** The usual Referral reply: its Ask writes the tokens, so each Application is filled with its own role and company (AC 9.5, AC 9.6). */
const referralBodyFor = (role: string, company: string) =>
  `${USUAL_REFERRAL.sentences[0]!.text} ${USUAL_REFERRAL.sentences[1]!.text} Would you be open to referring me for the ${role} role at ${company}, with no pressure at all if the answer is no?`

/** A judge answer that supports every line it is sent (the documents suites' fixture). */
const SUPPORTS_ALL = { results: Array.from({ length: 200 }, (_, id) => ({ id, supported: true })) }

const BODY_REFERRAL =
  "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I mentored 6 junior developers. " +
  "Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs, with no pressure at all if the answer is no?"
const BODY_NOTE = "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I mentored 6 junior developers."
const BODY_INTRODUCTION =
  "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I cut our release cycle from 2 weeks to 3 days. " +
  "Could we have a short conversation, or could you point me to the right person?"

/** contract 7.3: every figure in this epic counts Unicode code points, a line break counting as one. */
const codePoints = (text: string) => Array.from(text).length

/** Every object key in a response body, at any depth (AC 13.2: no Outreach field anywhere). */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf)
  if (value === null || typeof value !== "object") return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...keysOf(nested)])
}

/** The field names that exist only on the Outreach routes (contract 5.2 and 5.3). */
const OUTREACH_ONLY_KEYS = ["outreach", "outreachItems", "outreachMessages", "outreachKind", "outreachStatus", "outreachText", "readerName", "firstFailedSentence", "lastFailure"]

/** What a log value may be (architecture r1 D7): an event, a row key, a closed enum, a count or a flag. */
const CLOSED_LOG_VALUE =
  /^(outreach\.[a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|referral_request|introduction|application_note|ready|blocked|over_budget|paused|failed:[a-z_]+|stored|none|not_approved|not_configured|provider_error|timed_out|invalid_output|no_career_profile|interrupted|unexpected)$/

/**
 * A sentence of exactly `length` code points built from whole words only, so a budget test never
 * fails on a mid-word cut. Every word is drawn from a fact of the approved version (or is a neutral
 * lower-case word for an Ask), and the scripted judge supports all of them.
 */
function sentenceOfLength(length: number, filler: readonly string[]): string {
  // The first word keeps its capital (a sanctioned sentence opener); every other word is lower-case,
  // so no generated sentence reads as a proper name, a technology or a title.
  const words = [filler[0]!, ...filler.slice(1).map((word) => word.toLowerCase())]
  const rest = words.slice(1)
  let text = words[0]!
  let index = 0
  while (text.length + 1 + rest[index % rest.length]!.length + 1 <= length - 1) {
    text += ` ${rest[index % rest.length]!}`
    index += 1
  }
  if (length - 1 - text.length === 1) text = text.slice(0, text.lastIndexOf(" "))
  let gap = length - 1 - text.length
  while (gap > 0) {
    if (gap === 2) {
      text += " a"
      gap -= 2
    } else if (gap === 3) {
      text += " to"
      gap -= 3
    } else if (gap === 4) {
      text += " ltd"
      gap -= 4
    } else {
      text += " a"
      gap -= 2
    }
  }
  return `${text}.`
}
const FACT_WORDS = ["I", "built", "a", "react", "and", "typescript", "merchant", "dashboard", "from", "scratch", "to", "production", "at", "brightwave", "ltd"]
const ASK_WORDS = ["Would", "you", "be", "open", "to", "a", "short", "conversation", "or", "could", "point", "me", "the", "right", "person"]
const statementOf = (length: number, factIds: string[] = ["F1"]) => ({ kind: "statement" as const, text: sentenceOfLength(length, FACT_WORDS), factIds })
const askOf = (length: number) => ({ kind: "ask" as const, text: sentenceOfLength(length, ASK_WORDS), factIds: [] as string[] })

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let otherCandidateId: string
let storage: string
let workerDb: Kysely<Database>
const clock = new TestClock("2026-11-10T09:00:00.000Z")

const NOW = new Date("2026-11-10T09:00:00.000Z")
const POSTING_ID = "00000000-0000-4000-8000-000000000e14"
const APPLICATION_ID = "00000000-0000-4000-8000-000000000a14"
const OTHER_APPLICATION_ID = "00000000-0000-4000-8000-000000000b14"
const PASTED_POSTING_ID = "00000000-0000-4000-8000-000000000f14"
const PASTED_APPLICATION_ID = "00000000-0000-4000-8000-000000000c14"

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-outreach-int-"))
  markStorageMigratedSync(join(storage, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({
    databaseUrl: database.url,
    clock,
    config: {
      candidateStorageDir: join(storage, "candidates"),
      anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5"),
    },
  })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
  otherCandidateId = await insertSecondCandidate(database.db)
  workerDb = createDatabase(database.url, { statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS })
})

beforeEach(async () => {
  clock.set("2026-11-10T09:00:00.000Z")
  anthropic.install()
  anthropic.reset()
  for (const table of ["tailored_document", "ai_call", "application", "eligibility_result", "candidate_posting", "job_posting", "career_profile_version", "retention_run", "outreach_message"] as const) {
    await sql`delete from ${sql.table(table)}`.execute(database.db)
  }
  await database.db.deleteFrom("ai_provider_approval").execute()
  await database.db.deleteFrom("spend_entry").execute()
  await database.db.deleteFrom("spend_month").execute()
  await database.db
    .updateTable("control_state")
    .set({
      global_paused: false,
      global_paused_at: null,
      cost_paused: false,
      cost_paused_at: null,
      cost_paused_month: null,
      cost_pause_action: null,
      cost_pause_estimate_micros: null,
      cost_pause_cleared_at: null,
    })
    .execute()
  await database.db.deleteFrom("candidate_contact").where("candidate_id", "=", otherCandidateId).execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "", lines: "[]" }).where("candidate_id", "=", database.operatorId).execute()

  await insertPostingFor(database.db, database.operatorId, {
    id: POSTING_ID,
    application_url: "https://boards.greenhouse.io/northwind/jobs/14",
    requisition_id: "R-OM-14",
    apply_url: "https://boards.greenhouse.io/northwind/jobs/14",
    application_system: "Greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Senior Frontend Engineer",
    company: "Northwind Labs",
    posting_text: "Build design systems with React and TypeScript. You will mentor engineers and ship weekly.",
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: NOW,
    evaluated_at: NOW,
  })
  await insertApplication(APPLICATION_ID, database.operatorId)
})

// The Run's log line is captured by one test; nothing else in this file spies.
afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await workerDb?.destroy()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

async function insertApplication(id: string, candidateId: string, detailsDeleted = false, overrides: Partial<Insertable<ApplicationTable>> = {}): Promise<void> {
  const row: Insertable<ApplicationTable> = {
    id,
    candidate_id: candidateId,
    job_posting_id: POSTING_ID,
    application_url: "https://boards.greenhouse.io/northwind/jobs/14",
    requisition_id: id.slice(-4),
    company: "Northwind Labs",
    role_title: "Senior Frontend Engineer",
    state: "documents_ready",
    career_profile_version: 1,
    blocked_document: null,
    blocked_claim: null,
    failure: null,
    details_deleted_at: detailsDeleted ? NOW : null,
    final_status: detailsDeleted ? "documents_ready" : null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
  await database.db.insertInto("application").values(row).execute()
}

/** The approved Career Profile and provider approval a Run needs, unless a test removes one. */
async function readyToWrite(options: { approveProfile?: boolean; approveProvider?: boolean } = {}): Promise<void> {
  if (options.approveProvider !== false) await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: ANTHROPIC_TERMS.checkedOn }).expect(200)
  if (options.approveProfile !== false) {
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(V1), created_at: NOW, approved_at: NOW })
      .execute()
  }
  await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] }).expect(200)
}

type SeedRow = Readonly<{
  readerName?: string | null
  body?: string | null
  profileVersion?: number | null
  writtenAt?: Date | null
  lastFailure?: string | null
  firstFailedSentence?: string | null
  running?: boolean
}>

/** Writes one outreach row as the table's own checks require (body, sentences, version and date are all or none). */
async function seedOutreach(applicationId: string, kind: Kind, row: SeedRow = {}): Promise<void> {
  const body = row.body === undefined ? null : row.body
  const profileVersion = body === null ? null : (row.profileVersion ?? 1)
  const writtenAt = body === null ? null : (row.writtenAt ?? NOW)
  const sentences = body === null ? null : JSON.stringify([{ kind: "statement", text: body, factIds: ["F1"] }])
  await sql`
    insert into outreach_message
      (id, candidate_id, application_id, kind, reader_name, body, sentences, profile_version, written_at,
       last_failure, first_failed_sentence, run_status, run_id, run_started_at, created_at, updated_at)
    values
      (${randomUUID()}, ${database.operatorId}, ${applicationId}, ${kind}, ${row.readerName ?? null}, ${body},
       ${sentences}::jsonb, ${profileVersion}, ${writtenAt}, ${row.lastFailure ?? null},
       ${row.firstFailedSentence ?? null}, ${row.running === true ? "running" : "idle"},
       ${row.running === true ? randomUUID() : null}, ${row.running === true ? NOW : null}, ${NOW}, ${NOW})
  `.execute(database.db)
}

async function readOutreach(applicationId = APPLICATION_ID): Promise<{ items: OutreachItem[]; approvedProfileVersion: number | null }> {
  return (await candidate.get(outreachPath(applicationId)).expect(200)).body as { items: OutreachItem[]; approvedProfileVersion: number | null }
}

type OutreachItem = Readonly<{
  kind: Kind
  status: "idle" | "running"
  readerName: string | null
  text: string | null
  profileVersion: number | null
  writtenAt: string | null
  lastFailure: string | null
  firstFailedSentence: string | null
}>

const itemOf = (items: readonly OutreachItem[], kind: Kind): OutreachItem => {
  const item = items.find((entry) => entry.kind === kind)
  if (!item) throw new Error(`no ${kind} item`)
  return item
}

/** Polls the read until the kind settles, as the page's 2,000 ms poll does (contract 4.2). */
async function settle(kind: Kind, applicationId = APPLICATION_ID, timeoutMs = 25_000): Promise<OutreachItem> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { items } = await readOutreach(applicationId)
    const item = itemOf(items, kind)
    if (item.status === "idle") return item
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`the ${kind} Run did not settle within ${timeoutMs} ms`)
}

/** Queues the generation reply, then the judge reply the pipeline may make (at most one). */
function scriptRun(reply: unknown): void {
  anthropic.replyWithObject(reply)
  anthropic.replyWithObject(SUPPORTS_ALL)
}

const countAiCalls = async (purpose?: string) => {
  const result = await sql<{ n: string }>`
    select count(*)::text as n from ai_call where application_id = ${APPLICATION_ID}${purpose === undefined ? sql`` : sql` and purpose = ${purpose}`}
  `.execute(database.db)
  return Number(result.rows[0]?.n ?? "0")
}

describe("outreach-section.feature / outreach-availability.feature: the read", () => {
  it("returns exactly three items in the fixed order with the approved profile version, and synthesises Not written items", async () => {
    await readyToWrite()
    const response = await candidate.get(outreachPath(APPLICATION_ID)).expect(200)
    const body = response.body as { items: OutreachItem[]; approvedProfileVersion: number | null }
    expect(body.items.map((item) => item.kind)).toEqual(["referral_request", "introduction", "application_note"])
    expect(body.approvedProfileVersion).toBe(1)
    expect(Object.keys(body).sort()).toEqual(["approvedProfileVersion", "items"])
    for (const item of body.items) {
      expect(item).toMatchObject({
        status: "idle",
        readerName: null,
        text: null,
        profileVersion: null,
        writtenAt: null,
        lastFailure: null,
        firstFailedSentence: null,
      })
      // Every item carries the required, nullable sentence field (contract 5.2).
      expect(Object.keys(item).sort()).toEqual(["firstFailedSentence", "kind", "lastFailure", "profileVersion", "readerName", "status", "text", "writtenAt"])
    }
    expect(await countAiCalls()).toBe(0)
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it("returns the Ready text, its profile version and date, and the stored Reader name", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL })
    const item = itemOf((await readOutreach()).items, "referral_request")
    expect(item.text).toBe(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
    expect(item.profileVersion).toBe(1)
    expect(item.writtenAt).not.toBeNull()
    expect(item.readerName).toBe("Amara Okafor")
    expect(item.lastFailure).toBeNull()
  })

  it("keeps a blocked Run's first failed sentence in its own field, never in the text (AC 1.5, AC 2.4)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_REFERRAL, lastFailure: "blocked", firstFailedSentence: BLOCKED_SENTENCE })
    await seedOutreach(APPLICATION_ID, "introduction", { lastFailure: "provider_error" })
    const { items } = await readOutreach()
    const blocked = itemOf(items, "referral_request")
    expect(blocked.text).toBe(`Hello,\n\n${BODY_REFERRAL}`)
    expect(blocked.firstFailedSentence).toBe(BLOCKED_SENTENCE)
    expect(blocked.text).not.toContain(BLOCKED_SENTENCE)
    expect(itemOf(items, "introduction").firstFailedSentence).toBeNull()
    expect(itemOf(items, "application_note").firstFailedSentence).toBeNull()
  })

  it("maps a row running for over 10 minutes to idle with cause interrupted (contract 4.1)", async () => {
    await readyToWrite()
    await sql`
      insert into outreach_message (id, candidate_id, application_id, kind, reader_name, body, sentences, profile_version, written_at, last_failure, first_failed_sentence, run_status, run_id, run_started_at, created_at, updated_at)
      values (${randomUUID()}, ${database.operatorId}, ${APPLICATION_ID}, 'referral_request', null, null, null, null, null, null, null, 'running', ${randomUUID()}, ${new Date(NOW.getTime() - 11 * 60_000)}, ${NOW}, ${NOW})
    `.execute(database.db)
    const item = itemOf((await readOutreach()).items, "referral_request")
    expect(item).toMatchObject({ status: "idle", lastFailure: "interrupted", firstFailedSentence: null })
  })
})

describe("outreach-section.feature: the Application summary and detail are unchanged (AC 13.2)", () => {
  it("adds no Outreach field to either response, and both strict schemas still parse them", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL, lastFailure: "blocked", firstFailedSentence: BLOCKED_SENTENCE })
    const listResponse = await candidate.get("/v1/applications").expect(200)
    const detailResponse = await candidate.get(`/v1/applications/${APPLICATION_ID}`).expect(200)

    // Parsing is the assertion: either schema refuses an unknown key, so a new field would fail here.
    const listed = applicationsResponseSchema.parse(listResponse.body).applications.find((application) => application.id === APPLICATION_ID)
    expect(listed).toBeDefined()
    const detail = applicationDetailSchema.parse(detailResponse.body)
    expect(detail.id).toBe(APPLICATION_ID)
    expect(applicationDetailSchema.safeParse({ ...detailResponse.body, outreach: [] }).success).toBe(false)

    // No Outreach field sits at any depth of either body, with a Ready and a blocked text stored.
    for (const body of [listResponse.body, detailResponse.body]) {
      const keys = new Set(keysOf(body))
      for (const key of OUTREACH_ONLY_KEYS) expect(keys).not.toContain(key)
    }
  })
})

describe("outreach-availability.feature: 404 and authentication on all three routes", () => {
  it("answers the same not-found for a missing id, a malformed id, another Candidate's Application and a details-deleted Application", async () => {
    await readyToWrite()
    await database.db.updateTable("application").set({ candidate_id: otherCandidateId }).where("id", "=", APPLICATION_ID).execute()
    const foreign = await candidate.get(outreachPath(APPLICATION_ID)).expect(404)
    await insertApplication(OTHER_APPLICATION_ID, database.operatorId, true)
    const deleted = await candidate.get(outreachPath(OTHER_APPLICATION_ID)).expect(404)
    const missing = await candidate.get(outreachPath(randomUUID())).expect(404)
    const malformed = await candidate.get(outreachPath("not-a-uuid")).expect(404)
    expect(foreign.body).toEqual(NOT_FOUND)
    expect(deleted.body).toEqual(NOT_FOUND)
    expect(missing.body).toEqual(NOT_FOUND)
    expect(malformed.body).toEqual(NOT_FOUND)
  })

  it("answers the same not-found on write and reader-name for a details-deleted Application, and starts nothing", async () => {
    await readyToWrite()
    await insertApplication(OTHER_APPLICATION_ID, database.operatorId, true)
    expect((await candidate.post(writePath(OTHER_APPLICATION_ID, "referral_request")).expect(404)).body).toEqual(NOT_FOUND)
    expect((await candidate.put(namePath(OTHER_APPLICATION_ID, "introduction")).send({ readerName: "Amara Okafor" }).expect(404)).body).toEqual(NOT_FOUND)
    expect(anthropic.requests).toHaveLength(0)
    expect(await countAiCalls()).toBe(0)
  })

  it("404s an unknown kind slug on both state-changing routes", async () => {
    await readyToWrite()
    const write = await candidate.post(`${outreachPath(APPLICATION_ID)}/not-a-kind/write`).expect(404)
    const name = await candidate.put(`${outreachPath(APPLICATION_ID)}/application_note/reader-name`).send({ readerName: "Amara" }).expect(404)
    expect(write.body).toEqual(NOT_FOUND)
    expect(name.body).toEqual(NOT_FOUND)
  })

  // CR-6: Fastify parses the body before the Nest guard and handler, so the pre-body gate answers
  // steps 1 to 3 and the 404 rule itself. No body error may pre-empt the not-found.
  it("answers 404, not a body error, when the path is unknown or foreign and the body is malformed", async () => {
    await readyToWrite()
    const unknown = await candidate.put(namePath(randomUUID(), "introduction")).set("content-type", "application/json").send("{not json").expect(404)
    const malformedId = await candidate.put(namePath("not-a-uuid", "introduction")).set("content-type", "application/json").send("{not json").expect(404)
    const unknownKind = await candidate.put(`${outreachPath(APPLICATION_ID)}/not-a-kind/reader-name`).set("content-type", "application/json").send("{not json").expect(404)
    const wrongType = await candidate.put(namePath(randomUUID(), "introduction")).set("content-type", "text/plain").send("hello").expect(404)
    await database.db.updateTable("application").set({ candidate_id: otherCandidateId }).where("id", "=", APPLICATION_ID).execute()
    const foreign = await candidate.put(namePath(APPLICATION_ID, "introduction")).set("content-type", "application/json").send("{not json").expect(404)
    for (const response of [unknown, malformedId, unknownKind, wrongType, foreign]) expect(response.body).toEqual(NOT_FOUND)
  })

  it("still answers a body error for a live Application: the gate only moves the path and the 404 ahead", async () => {
    await readyToWrite()
    const malformed = await candidate.put(namePath(APPLICATION_ID, "introduction")).set("content-type", "application/json").send("{not json").expect(400)
    expect(malformed.body.error.code).toBe("bad_request")
    const wrongType = await candidate.put(namePath(APPLICATION_ID, "introduction")).set("content-type", "application/xml").send("<nope/>").expect(415)
    expect(wrongType.body.error.code).toBe("unsupported_media_type")
  })

  it("refuses a signed-out read as every other Application route does", async () => {
    const response = await browser.http().get(outreachPath(APPLICATION_ID))
    expect([401]).toContain(response.status)
    expect(response.body).toEqual(UNAUTHENTICATED)
  })

  it("refuses a write and a reader-name save with no CSRF token, before touching the Application (403)", async () => {
    await readyToWrite()
    const write = await browser.http().post(writePath(APPLICATION_ID, "referral_request")).set("cookie", candidate.cookie)
    expect(write.status).toBe(403)
    expect(write.body).toEqual(CSRF_INVALID)
    const name = await browser.http().put(namePath(APPLICATION_ID, "introduction")).set("cookie", candidate.cookie).send({ readerName: "Amara" })
    expect(name.status).toBe(403)
    expect(name.body).toEqual(CSRF_INVALID)
    expect(await countAiCalls()).toBe(0)
  })
})

describe("outreach-write-again.feature: the 202 write and polling", () => {
  it("answers 202 with running, then the poll settles on a Ready text with its version and date", async () => {
    await readyToWrite()
    scriptRun(USUAL_REFERRAL)
    const started = await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    expect(started.body).toMatchObject({ kind: "referral_request", status: "running", lastFailure: null, firstFailedSentence: null })

    const item = await settle("referral_request")
    expect(item.status).toBe("idle")
    expect(item.text).toBe(`Hello,\n\n${BODY_REFERRAL}`)
    expect(item.profileVersion).toBe(1)
    expect(item.writtenAt).not.toBeNull()
    expect(item.lastFailure).toBeNull()
    expect(item.firstFailedSentence).toBeNull()
    expect(itemOf((await readOutreach()).items, "referral_request").text).toBe(item.text)
    expect(await countAiCalls("outreach_message")).toBe(1)
  })

  it("gives an Introduction with a blank Reader name the blank-name greeting and no sign-off", async () => {
    await readyToWrite()
    scriptRun(USUAL_INTRODUCTION)
    await candidate.post(writePath(APPLICATION_ID, "introduction")).expect(202)
    const item = await settle("introduction")
    expect(item.text).toBe(`Hello,\n\n${BODY_INTRODUCTION}`)
    expect(item.lastFailure).toBeNull()
    expect(item.text).not.toMatch(/Best,|Kind regards|Regards/)
  })

  it("replaces the earlier text only on success and clears the earlier cause", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { body: "An older text.", lastFailure: "provider_error" })
    scriptRun(USUAL_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item.lastFailure).toBeNull()
    expect(item.text).toBe(`Hello,\n\n${BODY_REFERRAL}`)
    expect(item.text).not.toContain("An older text.")
  })

  it("starts nothing new for a second request while the first Run is in flight, and reserves no second cost (AC 7.6)", async () => {
    await readyToWrite()
    anthropic.replyWithObjectWhenReleased(USUAL_REFERRAL)
    anthropic.replyWithObject(SUPPORTS_ALL)
    const first = await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    await anthropic.waitForHeld(1)
    const second = await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    expect(first.body.status).toBe("running")
    expect(second.body.status).toBe("running")
    anthropic.releaseHeld()
    await settle("referral_request")
    expect(await countAiCalls("outreach_message")).toBe(1)
  })

  // outreach-blocked-quote.feature: "Starting the next Run hides and clears the quote" (AC 7.4, 7.10).
  // The claim is the only writer that may clear the sentence, and it must do so before the new Run can fail,
  // so the stored cause and sentence are gone while the Run is still in flight.
  it("clears the stored blocked cause and first failed sentence in the claim (AC 7.4, 7.10)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL, lastFailure: "blocked", firstFailedSentence: BLOCKED_SENTENCE })
    anthropic.replyWithObjectWhenReleased(USUAL_REFERRAL)
    anthropic.replyWithObject(SUPPORTS_ALL)
    const started = await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    await anthropic.waitForHeld(1)
    expect(started.body).toMatchObject({ status: "running", lastFailure: null, firstFailedSentence: null })
    const stored = await sql<{ last_failure: string | null; first_failed_sentence: string | null }>`
      select last_failure, first_failed_sentence from outreach_message
      where application_id = ${APPLICATION_ID} and kind = 'referral_request'
    `.execute(database.db)
    expect(stored.rows[0]).toEqual({ last_failure: null, first_failed_sentence: null })
    expect(itemOf((await readOutreach()).items, "referral_request")).toMatchObject({ status: "running", lastFailure: null, firstFailedSentence: null })
    anthropic.releaseHeld()
    await settle("referral_request")
  })
})

describe("outreach-reader-name.feature: the Reader name", () => {
  it("saves a name trimmed and collapsed, and recomposes the greeting on the returned text", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_REFERRAL })
    const response = await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: "  Amara   Okafor  " }).expect(200)
    expect((response.body as OutreachItem).readerName).toBe("Amara Okafor")
    expect((response.body as OutreachItem).text).toBe(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
    expect(itemOf((await readOutreach()).items, "referral_request").readerName).toBe("Amara Okafor")
  })

  it.each([
    ["Amara Okafor", "Amara Okafor"],
    ["Jean-Luc Picard", "Jean-Luc Picard"],
    ["Shaun O'Brien", "Shaun O'Brien"],
    ["Shaun O’Brien", "Shaun O’Brien"],
    ["St. John", "St. John"],
    ["María José", "María José"],
    ["李伟", "李伟"],
    ["محمد علي", "محمد علي"],
    ["Dr.", "Dr."],
    ["A", "A"],
    ["Alexandria Wilhelmina Montgomery-Smithes", "Alexandria Wilhelmina Montgomery-Smithes"],
  ])("saves the valid name %s exactly as typed", async (typed, stored) => {
    await readyToWrite()
    const response = await candidate.put(namePath(APPLICATION_ID, "introduction")).send({ readerName: typed }).expect(200)
    expect((response.body as OutreachItem).readerName).toBe(stored)
  })

  it.each([
    ["41 characters", "Alexandria Wilhelmina Montgomery-Smithess"],
    ["a digit", "Amara2"],
    ["an at sign", "amara@northwind"],
    ["a slash", "Amara/Okafor"],
    ["a colon", "Amara: CEO"],
    ["a bracket", "Amara (CTO)"],
    ["an emoji", "Amara 🚀"],
    ["a link shape", "https://linkedin.com/in/amara"],
    ["a domain shape", "www.amara.dev"],
    ["no letter", "-"],
    ["a line break", "Amara\nOkafor"],
  ])("refuses %s with 422 and saves nothing, keeping the earlier name", async (_why, typed) => {
    await readyToWrite()
    await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: "Amara Okafor" }).expect(200)
    const response = await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: typed }).expect(422)
    expect(response.body).toEqual(NAME_INVALID)
    expect(itemOf((await readOutreach()).items, "referral_request").readerName).toBe("Amara Okafor")
  })

  it.each([["three spaces", "   "], ["a tab", "\t"], ["spaces and a tab", " \t "]])("clears the saved name with %s", async (_what, typed) => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL })
    const response = await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: typed }).expect(200)
    expect((response.body as OutreachItem).readerName).toBeNull()
    expect((response.body as OutreachItem).text).toBe(`Hello,\n\n${BODY_REFERRAL}`)
  })

  it("clears the name for Application note without a greeting line", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "application_note", { readerName: "Dana Whitfield", body: BODY_NOTE })
    const response = await candidate.put(namePath(APPLICATION_ID, "application_note")).send({ readerName: null }).expect(200)
    expect((response.body as OutreachItem).text).toBe(BODY_NOTE)
  })

  it.each([
    ["a missing key", {}],
    ["an unknown extra key", { readerName: "Amara", extra: true }],
    ["a non-string value", { readerName: 42 }],
  ])("refuses %s in the body with 400 bad_request", async (_what, body) => {
    await readyToWrite()
    const response = await candidate.put(namePath(APPLICATION_ID, "referral_request")).send(body).expect(400)
    expect(response.body.error.code).toBe("bad_request")
  })

  it("saves a name while a Run is in flight and returns the running item (AC 5.5)", async () => {
    await readyToWrite()
    anthropic.replyWithObjectWhenReleased(USUAL_REFERRAL)
    anthropic.replyWithObject(SUPPORTS_ALL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    await anthropic.waitForHeld(1)
    const response = await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: "Amara Okafor" }).expect(200)
    expect(response.body).toMatchObject({ status: "running", readerName: "Amara Okafor" })
    anthropic.releaseHeld()
    const item = await settle("referral_request")
    expect(item.text).toBe(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
  })

  it("nulls a stored first failed sentence that holds the new name, keeping the blocked cause (contract 4.3)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { lastFailure: "blocked", firstFailedSentence: "I mentored Amara Okafor's team." })
    const response = await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: "Amara Okafor" }).expect(200)
    expect(response.body).toMatchObject({ lastFailure: "blocked", firstFailedSentence: null })
  })

  it("makes no model call and writes no metering row when a name is saved", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_REFERRAL })
    const before = itemOf((await readOutreach()).items, "referral_request")
    await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: "Amara Okafor" }).expect(200)
    const after = itemOf((await readOutreach()).items, "referral_request")
    expect(anthropic.requests).toHaveLength(0)
    expect(await countAiCalls()).toBe(0)
    expect(after.profileVersion).toBe(before.profileVersion)
    expect(after.writtenAt).toBe(before.writtenAt)
    expect(after.text?.split("\n\n")[1]).toBe(BODY_REFERRAL)
  })
})

describe("outreach-truth-rule.feature: the truth rule end to end", () => {
  it("ends blocked when every statement fails, stores and returns the first failed sentence and no text (AC 2.9, 7.10)", async () => {
    await readyToWrite()
    scriptRun(BLOCKED_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item.lastFailure).toBe("blocked")
    expect(item.text).toBeNull()
    expect(item.firstFailedSentence).toBe(BLOCKED_SENTENCE)
    expect(item.profileVersion).toBeNull()
  })

  it("keeps the earlier text beside a blocked cause and leaves the quote in its own field (AC 7.2, 7.3)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL })
    scriptRun(BLOCKED_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item.text).toBe(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
    expect(item.lastFailure).toBe("blocked")
    expect(item.firstFailedSentence).toBe(BLOCKED_SENTENCE)
  })

  it("ends blocked with no sentence when only the Ask is missing (I4)", async () => {
    await readyToWrite()
    scriptRun({ sentences: [USUAL_REFERRAL.sentences[0]!, USUAL_REFERRAL.sentences[1]!] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ lastFailure: "blocked", firstFailedSentence: null, text: null })
  })

  it("stores nothing about the sentences a successful Run dropped, in the row or the response (AC 2.11)", async () => {
    await readyToWrite()
    scriptRun({ sentences: [...USUAL_REFERRAL.sentences, { kind: "statement", text: BLOCKED_SENTENCE, factIds: ["F1"] }] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item.lastFailure).toBeNull()
    expect(item.firstFailedSentence).toBeNull()
    expect(item.text).not.toContain("Angular")
    const stored = await sql<{ last_failure: string | null; first_failed_sentence: string | null }>`
      select last_failure, first_failed_sentence from outreach_message where application_id = ${APPLICATION_ID} and kind = 'referral_request'
    `.execute(database.db)
    expect(stored.rows[0]).toEqual({ last_failure: null, first_failed_sentence: null })
    const anywhere = await sql<{ n: string }>`select count(*)::text as n from outreach_message where body like '%Angular%' or sentences::text like '%Angular%'`.execute(database.db)
    expect(Number(anywhere.rows[0]?.n)).toBe(0)
  })

  it("removes a statement that fails a claim rule from every field of the successful text (AC 2.3)", async () => {
    await readyToWrite()
    scriptRun({ sentences: [...USUAL_REFERRAL.sentences, { kind: "statement", text: "I mentored 12 junior developers.", factIds: ["F3"] }] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item.text).toContain("I mentored 6 junior developers.")
    expect(item.text).not.toContain("12 junior developers")
    expect(item.lastFailure).toBeNull()
  })

  it("never introduces an Ask into an Application note (AC 3)", async () => {
    await readyToWrite()
    scriptRun({ sentences: [...USUAL_NOTE.sentences, { kind: "ask", text: "Would you be open to a short conversation?", factIds: [] }] })
    await candidate.post(writePath(APPLICATION_ID, "application_note")).expect(202)
    const item = await settle("application_note")
    expect(item.lastFailure).toBeNull()
    expect(item.text).toBe(BODY_NOTE)
    expect(item.text).not.toContain("?")
  })

  // r7: an Ask's exemption is the tokens only; the judge sees the stored form.
  it("sends the judge the Ask as it will be stored, the real role and company filled in, never blanked (r7)", async () => {
    await readyToWrite()
    scriptRun(USUAL_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item.text).toBe(`Hello,\n\n${BODY_REFERRAL}`)
    const judged = JSON.stringify(anthropic.requests.at(-1)!.body)
    expect(judged).toContain("referring me for the Senior Frontend Engineer role at Northwind Labs, with no pressure")
    expect(judged).not.toContain("for the role at the company")
    expect(judged).not.toContain("{role_phrase}")
  })

  it("blocks an Ask that writes the target's name instead of the tokens, with no judge call for it (r7)", async () => {
    await readyToWrite()
    const claim = "Would you refer me, since Northwind Labs is my employer?"
    scriptRun({ sentences: [USUAL_REFERRAL.sentences[0]!, USUAL_REFERRAL.sentences[1]!, { kind: "ask", text: claim, factIds: [] }] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ lastFailure: "blocked", firstFailedSentence: claim, text: null })
    expect(anthropic.requests).toHaveLength(1)
  })

  it("blocks a token-form Ask that reads as a claim when the judge, reading the real text, refuses it (r7)", async () => {
    await readyToWrite()
    const claim = "Would you refer me, since I'm at {company_phrase}?"
    anthropic.replyWithObject({ sentences: [USUAL_REFERRAL.sentences[0]!, USUAL_REFERRAL.sentences[1]!, { kind: "ask", text: claim, factIds: [] }] })
    anthropic.replyWithObject({ results: [{ id: 0, supported: false }] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ lastFailure: "blocked", firstFailedSentence: claim, text: null })
    expect(JSON.stringify(anthropic.requests.at(-1)!.body)).toContain("since I'm at Northwind Labs")
  })

  it("uses the latest approved version, never a newer draft", async () => {
    await readyToWrite({ approveProfile: false })
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 2, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(V1), created_at: NOW, approved_at: NOW })
      .execute()
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 3, status: "draft", source: "edit", resume_upload_id: null, sections: JSON.stringify([{ ...V1[0]!, facts: [F1, F2, F3, F4, { id: "6f1c0e8a-9999-4a6b-9a01-000000000006", text: "Built a GraphQL gateway at Brightwave Ltd", sourceQuote: null }] }]), created_at: NOW, approved_at: null })
      .execute()
    expect((await readOutreach()).approvedProfileVersion).toBe(2)
    scriptRun(USUAL_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item.profileVersion).toBe(2)
    expect(anthropic.requests.length).toBeGreaterThan(0)
    expect(JSON.stringify(anthropic.requests[0]!.body)).not.toContain("GraphQL gateway")
  })

  it("does not put the Reader name in the prompt (AC 5.8, AC 2.2)", async () => {
    await readyToWrite()
    await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: "Zephyrine Quillfeather" }).expect(200)
    scriptRun(USUAL_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    await settle("referral_request")
    for (const request of anthropic.requests) {
      expect(JSON.stringify(request.body)).not.toContain("Zephyrine")
      expect(JSON.stringify(request.body)).not.toContain("Quillfeather")
    }
  })

  it("does not send an earlier first failed sentence back to the model (AC 11.5)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { lastFailure: "blocked", firstFailedSentence: "I led the Zorvex billing migration." })
    scriptRun(USUAL_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    await settle("referral_request")
    for (const request of anthropic.requests) expect(JSON.stringify(request.body)).not.toContain("Zorvex")
  })

  // outreach-truth-rule.feature, "Only approved facts, the role, the company and the posting reach Anthropic".
  // Every stored answer, pay figure, Outcome and other Application is given a word that is nowhere else,
  // so one leak into either call's body names the field it came from.
  it("sends no approved answer, salary, Outcome or other Application to Anthropic (AC 2.2)", async () => {
    await readyToWrite()
    await database.db
      .insertInto("approved_answer")
      .values({ id: randomUUID(), candidate_id: database.operatorId, answer_group: "standard", topic: "notice_period", skill: null, question: null, answer_key: "standard:notice_period", value: "Quibbleforth, thirty days", created_at: NOW, updated_at: NOW })
      .execute()
    await database.db
      .insertInto("gross_salary_answer")
      .values({ candidate_id: database.operatorId, kind: "gross_salary_policy", amount: "483921.00", currency: "NGN", period: "year", updated_at: NOW })
      .execute()
    await database.db
      .insertInto("outcome")
      .values({ id: randomUUID(), candidate_id: database.operatorId, application_id: APPLICATION_ID, type: "offer", excerpt: "A Vexingly generous offer", created_at: NOW, updated_at: NOW })
      .execute()
    await insertApplication(OTHER_APPLICATION_ID, database.operatorId, false, { company: "Marzipan Holdings", role_title: "Marzipan Platform Engineer" })

    scriptRun(USUAL_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    await settle("referral_request")

    // The Run really called the model with this Application's own target, so the absences below mean something.
    expect(anthropic.requests.length).toBeGreaterThan(0)
    const sent = anthropic.requests.map((request) => JSON.stringify(request.body)).join("\n")
    expect(sent).toContain("Northwind Labs")
    for (const secret of ["Quibbleforth", "483921", "Vexingly", "Marzipan"]) expect(sent).not.toContain(secret)
  })
})

describe("outreach-kinds-and-budgets.feature: the 400 code-point sentence limit and budget arithmetic", () => {
  it("ends invalid_output and stores no sentence for a reply holding a sentence over 400 characters", async () => {
    await readyToWrite()
    scriptRun({ sentences: [{ kind: "statement", text: "x".repeat(401), factIds: ["F1"] }, USUAL_REFERRAL.sentences[2]!] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ lastFailure: "invalid_output", firstFailedSentence: null, text: null })
  })

  it("returns a first failed sentence of exactly 400 code points whole, with no cut or ellipsis (AC 11.4)", async () => {
    await readyToWrite()
    const exactly400 = sentenceOfLength(400, FACT_WORDS)
    expect(codePoints(exactly400)).toBe(400)
    await seedOutreach(APPLICATION_ID, "referral_request", { lastFailure: "blocked", firstFailedSentence: exactly400 })
    const item = itemOf((await readOutreach()).items, "referral_request")
    expect(item.firstFailedSentence).toBe(exactly400)
    expect(codePoints(item.firstFailedSentence ?? "")).toBe(400)
    expect(item.firstFailedSentence).not.toContain("…")
  })

  it("refuses a stored first failed sentence of 401 code points at the storage bound", async () => {
    await readyToWrite()
    await expect(seedOutreach(APPLICATION_ID, "referral_request", { lastFailure: "blocked", firstFailedSentence: sentenceOfLength(401, FACT_WORDS) })).rejects.toThrow()
    expect(itemOf((await readOutreach()).items, "referral_request").firstFailedSentence).toBeNull()
  })

  it.each([
    ["referral_request", 200, 248, 100, 550, 600],
    ["introduction", 300, 328, 120, 750, 800],
    ["application_note", 200, 249, null, 450, 500],
  ] as const)("keeps a %s body exactly at its budget with every sentence", async (kind, first, last, ask, body, total) => {
    await readyToWrite()
    const sentences = [statementOf(first), statementOf(last), ...(ask === null ? [] : [askOf(ask)])]
    scriptRun({ sentences })
    await candidate.post(writePath(APPLICATION_ID, kind)).expect(202)
    const item = await settle(kind)
    expect(item.lastFailure).toBeNull()
    const copied = item.text ?? ""
    const copiedBody = copied.includes("\n\n") ? copied.slice(copied.indexOf("\n\n") + 2) : copied
    expect(codePoints(copiedBody)).toBe(body)
    expect(codePoints(copied)).toBeLessThanOrEqual(total)
    for (const sentence of sentences) expect(copiedBody).toContain(sentence.text)
  })

  it.each([
    ["referral_request", 200, 249, 100, 301],
    ["introduction", 300, 329, 120, 421],
    ["application_note", 200, 250, null, 200],
  ] as const)("removes the last statement whole when a %s body is one character over budget", async (kind, first, last, ask, kept) => {
    await readyToWrite()
    const drop = statementOf(last)
    scriptRun({ sentences: [statementOf(first), drop, ...(ask === null ? [] : [askOf(ask)])] })
    await candidate.post(writePath(APPLICATION_ID, kind)).expect(202)
    const item = await settle(kind)
    expect(item.lastFailure).toBeNull()
    const copiedBody = (item.text ?? "").split("\n\n").at(-1) ?? ""
    expect(copiedBody).not.toContain(drop.text)
    expect(codePoints(copiedBody)).toBe(kept)
  })

  it("never removes the Ask to fit, even when it is the longest sentence (AC 4.3)", async () => {
    await readyToWrite()
    const ask = askOf(400)
    const second = statementOf(101)
    scriptRun({ sentences: [statementOf(100), second, ask] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item.lastFailure).toBeNull()
    const copiedBody = (item.text ?? "").split("\n\n").at(-1) ?? ""
    expect(copiedBody).toContain(ask.text)
    expect(copiedBody).not.toContain(second.text)
    expect(codePoints(copiedBody)).toBe(501)
  })

  it("ends over_budget with no text and no sentence when the first statement and the Ask alone are too long (AC 4.4)", async () => {
    await readyToWrite()
    scriptRun({ sentences: [statementOf(400), statementOf(100), askOf(160)] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ lastFailure: "over_budget", text: null, firstFailedSentence: null })
  })
})

describe("outreach-pause-and-cost.feature: pauses", () => {
  it("starts no Run while the global pause is on, stores no cause and keeps the earlier text", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL })
    await candidate.put(GLOBAL_PAUSE_PATH).send({ paused: true }).expect(200)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ status: "idle", lastFailure: null, firstFailedSentence: null, text: `Hi Amara Okafor,\n\n${BODY_REFERRAL}` })
    expect(await countAiCalls()).toBe(0)
    expect(anthropic.requests).toHaveLength(0)
  })

  it("starts no Run when the month's spend is at the ceiling, and turns the cost pause on", async () => {
    await readyToWrite()
    await seedSpend(50_000_000)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ status: "idle", lastFailure: null, firstFailedSentence: null })
    expect(await countAiCalls()).toBe(0)
    const controls = (await candidate.get("/v1/controls").expect(200)).body as { costPause: unknown }
    expect(controls.costPause).not.toBeNull()
  })
})

describe("outreach-availability.feature: a Run needs an approved profile, approval and a key", () => {
  it("ends not_approved and stores no sentence when Anthropic is not approved", async () => {
    await readyToWrite({ approveProvider: false })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ lastFailure: "not_approved", text: null, firstFailedSentence: null })
    expect(anthropic.requests).toHaveLength(0)
  })

  it("ends no_career_profile when no approved version exists, but a newer draft does", async () => {
    await readyToWrite({ approveProfile: false })
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 1, status: "draft", source: "edit", resume_upload_id: null, sections: JSON.stringify(V1), created_at: NOW, approved_at: null })
      .execute()
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    const item = await settle("referral_request")
    expect(item).toMatchObject({ lastFailure: "no_career_profile", text: null, firstFailedSentence: null })
    expect(anthropic.requests).toHaveLength(0)
  })
})

describe("outreach-availability.feature: each Application has its own texts, and a posting-less one still writes", () => {
  // outreach-availability.feature, "Each Application has its own three texts" and "A missing posting text
  // does not stop a Run" (AC 9.5, AC 9.6). The contract's documented outcome for a Run whose posting row
  // is unavailable is a normal ready Run built from the role and the company alone (section 8, row 9.6).
  it("writes the second Application without touching the first, and writes with no posting text (AC 9.5, AC 9.6)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL })
    await insertApplication(OTHER_APPLICATION_ID, database.operatorId, false, { role_title: "Staff Engineer" })

    // The second Application at the same company starts with its own three Not written items.
    for (const item of (await readOutreach(OTHER_APPLICATION_ID)).items) {
      expect(item).toMatchObject({ status: "idle", readerName: null, text: null, profileVersion: null, writtenAt: null, lastFailure: null, firstFailedSentence: null })
    }
    scriptRun(USUAL_REFERRAL)
    await candidate.post(writePath(OTHER_APPLICATION_ID, "referral_request")).expect(202)
    const second = await settle("referral_request", OTHER_APPLICATION_ID)
    expect(second).toMatchObject({ lastFailure: null, firstFailedSentence: null })
    expect(second.text).toBe(`Hello,\n\n${referralBodyFor("Staff Engineer", "Northwind Labs")}`)
    // Nothing was shared, copied across or reused: the first Application keeps its own text and name.
    expect(itemOf((await readOutreach()).items, "referral_request")).toMatchObject({ readerName: "Amara Okafor", text: `Hi Amara Okafor,\n\n${BODY_REFERRAL}` })

    // A pasted Application whose posting row is unavailable: the Run uses the role and company only.
    await insertPostingFor(database.db, database.operatorId, {
      id: PASTED_POSTING_ID,
      application_url: `urn:eve:pasted:${PASTED_POSTING_ID}`,
      requisition_id: `pasted:${PASTED_POSTING_ID}`,
      apply_url: `urn:eve:pasted:${PASTED_POSTING_ID}`,
      application_system: "none",
      apply_mode: "manual",
      origin: "pasted_description",
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      owner_candidate_id: database.operatorId,
      title: "Pasted Platform Engineer",
      company: "Pasteboard Ltd",
      posting_text: "A private pasted description that must not reach the model.",
      status: "ranked",
      skip_reason: null,
      skip_detail: null,
      evaluation_failure: null,
      role_family: "senior_frontend",
      discovered_at: NOW,
      evaluated_at: NOW,
    })
    await insertApplication(PASTED_APPLICATION_ID, database.operatorId, false, {
      job_posting_id: PASTED_POSTING_ID,
      application_url: `urn:eve:pasted:${PASTED_POSTING_ID}`,
      requisition_id: `pasted:${PASTED_POSTING_ID}`,
      company: "Pasteboard Ltd",
      role_title: "Pasted Platform Engineer",
    })
    // contracts 9.6: "the posting row is unavailable", so `findPosting` finds no Candidate-Posting row.
    await database.db.deleteFrom("candidate_posting").where("candidate_id", "=", database.operatorId).where("job_posting_id", "=", PASTED_POSTING_ID).execute()

    scriptRun(USUAL_REFERRAL)
    await candidate.post(writePath(PASTED_APPLICATION_ID, "referral_request")).expect(202)
    const pasted = await settle("referral_request", PASTED_APPLICATION_ID)
    expect(pasted.lastFailure).toBeNull()
    expect(pasted.text).toBe(`Hello,\n\n${referralBodyFor("Pasted Platform Engineer", "Pasteboard Ltd")}`)
    const sent = anthropic.requests.map((request) => JSON.stringify(request.body)).join("\n")
    expect(sent).toContain("Pasted Platform Engineer")
    expect(sent).toContain("Pasteboard Ltd")
    expect(sent).not.toContain("private pasted description")
  })
})

describe("outreach-write-again.feature: the stale line's version", () => {
  it("reports the newer approved version beside a text written from an older one", async () => {
    await readyToWrite({ approveProfile: false })
    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_REFERRAL, profileVersion: 1 })
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 2, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(V1), created_at: NOW, approved_at: NOW })
      .execute()
    const body = await readOutreach()
    expect(body.approvedProfileVersion).toBe(2)
    expect(itemOf(body.items, "referral_request").profileVersion).toBe(1)
  })

  it("does not treat an unapproved draft as newer", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_REFERRAL, profileVersion: 1 })
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 2, status: "draft", source: "edit", resume_upload_id: null, sections: JSON.stringify(V1), created_at: NOW, approved_at: null })
      .execute()
    const body = await readOutreach()
    expect(body.approvedProfileVersion).toBe(1)
    expect(itemOf(body.items, "referral_request").profileVersion).toBe(1)
  })
})

describe("outreach-retention-and-ownership.feature: deletion and expiry", () => {
  it("answers 404 on all three routes after the details are deleted by hand, and stores nothing of the rows", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL, lastFailure: "blocked", firstFailedSentence: "I led the Zorvex billing migration." })
    await seedOutreach(APPLICATION_ID, "introduction", { readerName: "Dana Whitfield" })
    await seedOutreach(APPLICATION_ID, "application_note", { body: BODY_NOTE, lastFailure: "blocked", firstFailedSentence: "I led the Zorvex billing migration." })
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [APPLICATION_ID] }).expect(200)
    expect((await candidate.get(outreachPath(APPLICATION_ID)).expect(404)).body).toEqual(NOT_FOUND)
    expect((await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(404)).body).toEqual(NOT_FOUND)
    expect((await candidate.put(namePath(APPLICATION_ID, "introduction")).send({ readerName: "Amara" }).expect(404)).body).toEqual(NOT_FOUND)
    const stored = await sql<{ n: string }>`select count(*)::text as n from outreach_message where application_id = ${APPLICATION_ID}`.execute(database.db)
    expect(Number(stored.rows[0]?.n)).toBe(0)
    const distinctive = await sql<{ n: string }>`
      select count(*)::text as n from outreach_message
      where reader_name = 'Dana Whitfield' or first_failed_sentence = 'I led the Zorvex billing migration.'
    `.execute(database.db)
    expect(Number(distinctive.rows[0]?.n)).toBe(0)
  })

  it("deletes the outreach records in the same expiry pass as the rest of the details (AC 12.2)", async () => {
    await readyToWrite()
    await database.db.updateTable("application").set({ created_at: new Date("2025-11-10T08:00:00.000Z") }).where("id", "=", APPLICATION_ID).execute()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Amara Okafor", body: BODY_REFERRAL })
    await seedOutreach(APPLICATION_ID, "application_note", { lastFailure: "blocked", firstFailedSentence: "I led the Zorvex billing migration." })
    // retention.daily's first run was more than 30 days ago, and runs at 03:00 WAT on the anniversary.
    await database.db
      .insertInto("retention_run")
      .values({ id: randomUUID(), candidate_id: database.operatorId, wat_date: "2026-06-01", started_at: new Date("2026-06-01T02:00:00Z"), finished_at: new Date("2026-06-01T02:00:01Z"), outcome: "completed" })
      .execute()
    clock.set("2026-11-10T02:00:00.000Z")
    await new RetentionRunner(new TenantDatabase(workerDb), clock).run()
    const row = await database.db.selectFrom("application").select("details_deleted_at").where("id", "=", APPLICATION_ID).executeTakeFirstOrThrow()
    expect(row.details_deleted_at).not.toBeNull()
    const stored = await sql<{ n: string }>`
      select count(*)::text as n from outreach_message
      where application_id = ${APPLICATION_ID} or first_failed_sentence = 'I led the Zorvex billing migration.'
    `.execute(database.db)
    expect(Number(stored.rows[0]?.n)).toBe(0)
  })

  it("refuses manual deletion with the existing busy conflict while a Run is in flight (AC 12.3)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { running: true })
    const response = await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [APPLICATION_ID] }).expect(409)
    expect(response.body.error.code).toBe("application_state_conflict")
    const stored = await sql<{ n: string }>`select count(*)::text as n from outreach_message where application_id = ${APPLICATION_ID}`.execute(database.db)
    expect(Number(stored.rows[0]?.n)).toBe(1)
  })

  // outreach-retention-and-ownership.feature, "A Run that finishes after the details were deleted writes nothing".
  // Deletion cannot reach a live Run (the 409 above), so the row is moved past the ten-minute window the busy
  // check reads: the deletion goes through, and the held Run then finishes against a deleted Application.
  it("writes nothing when a Run finishes after the details were deleted (AC 12.3)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "introduction", { body: BODY_INTRODUCTION })
    await database.db
      .insertInto("tailored_document")
      .values({ id: randomUUID(), candidate_id: database.operatorId, application_id: APPLICATION_ID, kind: "resume", career_profile_version: 1, content: JSON.stringify({ text: "A stored resume." }), pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: NOW })
      .execute()

    anthropic.replyWithObjectWhenReleased(USUAL_REFERRAL)
    anthropic.replyWithObject(SUPPORTS_ALL)
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    await anthropic.waitForHeld(1)
    await database.db
      .updateTable("outreach_message")
      .set({ run_started_at: new Date(NOW.getTime() - 11 * 60_000) })
      .where("application_id", "=", APPLICATION_ID)
      .where("kind", "=", "referral_request")
      .execute()

    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [APPLICATION_ID] }).expect(200)
    // The Run's reply arrives after the deletion: it may not write a text, a cause or a sentence.
    anthropic.releaseHeld()
    await app.get(OutreachService).settled()

    // The Run reached the model before the deletion; its finisher then found the details gone.
    expect(anthropic.requests.length).toBeGreaterThan(0)
    const stored = await sql<{ n: string }>`select count(*)::text as n from outreach_message where application_id = ${APPLICATION_ID}`.execute(database.db)
    expect(Number(stored.rows[0]?.n)).toBe(0)
    const documents = await sql<{ n: string }>`select count(*)::text as n from tailored_document where application_id = ${APPLICATION_ID}`.execute(database.db)
    expect(Number(documents.rows[0]?.n)).toBe(0)
    expect((await candidate.get(outreachPath(APPLICATION_ID)).expect(404)).body).toEqual(NOT_FOUND)
    expect((await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(404)).body).toEqual(NOT_FOUND)
    expect((await candidate.put(namePath(APPLICATION_ID, "introduction")).send({ readerName: "Amara Okafor" }).expect(404)).body).toEqual(NOT_FOUND)
  })

  it("carries the owning Candidate's id on every outreach row (AC 12.4)", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_REFERRAL })
    await seedOutreach(APPLICATION_ID, "introduction", { body: BODY_INTRODUCTION })
    const rows = await sql<{ candidate_id: string }>`select candidate_id from outreach_message where application_id = ${APPLICATION_ID}`.execute(database.db)
    expect(rows.rows).toHaveLength(2)
    for (const row of rows.rows) expect(row.candidate_id).toBe(database.operatorId)
  })
})

describe("outreach-retention-and-ownership.feature: logs carry counts and enums only (AC 12.5)", () => {
  // AC 12.5 and AC 11.6, the log half: an Outreach text, a Reader name and a stored first failed
  // sentence never reach a log line. One Run drops a sentence and writes, one blocks and stores its
  // sentence, one writes with no drop, so every logged ending is covered.
  it("logs no model text, Reader name or fact text for a Run that drops, one that blocks and one that succeeds", async () => {
    const logged: string[] = []
    const capture = (message: unknown) => void logged.push(String(message))
    vi.spyOn(Logger.prototype, "log").mockImplementation(capture)
    vi.spyOn(Logger.prototype, "error").mockImplementation(capture)

    await readyToWrite({ approveProfile: false })
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(V1_WITH_F5), created_at: NOW, approved_at: NOW })
      .execute()
    await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: "Zephyrine Quillfeather" }).expect(200)

    scriptRun({ sentences: [...USUAL_REFERRAL.sentences, { kind: "statement", text: "I mentored 12 junior developers.", factIds: ["F3"] }] })
    await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(202)
    expect((await settle("referral_request")).lastFailure).toBeNull()

    scriptRun(BLOCKED_REFERRAL)
    await candidate.post(writePath(APPLICATION_ID, "introduction")).expect(202)
    expect(await settle("introduction")).toMatchObject({ lastFailure: "blocked", firstFailedSentence: BLOCKED_SENTENCE })

    scriptRun(USUAL_NOTE)
    await candidate.post(writePath(APPLICATION_ID, "application_note")).expect(202)
    expect((await settle("application_note")).lastFailure).toBeNull()

    const lines = logged.filter((line) => line.includes('"event":"outreach.')).map((line) => JSON.parse(line) as Record<string, unknown>)
    const finished = lines.filter((line) => line["event"] === "outreach.run_finished")
    expect(finished.map((line) => line["outcome"])).toEqual(expect.arrayContaining(["ready", "blocked"]))
    expect(finished).toContainEqual(expect.objectContaining({ outcome: "blocked", quote: "stored" }))
    expect(lines.some((line) => line["event"] === "outreach.sentences_dropped")).toBe(true)

    // A number, a flag or a closed enum; never a free string.
    for (const line of lines) {
      for (const value of Object.values(line)) {
        if (typeof value === "number" || typeof value === "boolean") continue
        expect(value).toMatch(CLOSED_LOG_VALUE)
      }
    }

    // And in the whole captured output: the stored sentence, the dropped sentence, the name, fact text and the posting.
    const captured = logged.join("\n")
    for (const secret of ["Zorvex", "Angular", "12 junior", "Zephyrine", "Quillfeather", "Brightwave", "merchant dashboard", "Build design systems"]) {
      expect(captured).not.toContain(secret)
    }
  })
})

describe("outreach-retention-and-ownership.feature: RLS between two Candidates", () => {
  it("shows another Candidate's session none of the rows, and refuses an insert carrying that Candidate's id", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Zephyrine Quillfeather", body: BODY_REFERRAL, lastFailure: "blocked", firstFailedSentence: "I led the Zorvex billing migration." })

    const seenByOther = await CandidateScope.run(otherCandidateId, () =>
      app.get(TenantDatabase).run((tx) => sql<{ n: string }>`select count(*)::text as n from outreach_message`.execute(tx))
    )
    expect(Number(seenByOther.rows[0]?.n)).toBe(0)

    const refused = await CandidateScope.run(otherCandidateId, () =>
      app
        .get(TenantDatabase)
        .run((tx) =>
          sql`insert into outreach_message (id, candidate_id, application_id, kind, created_at, updated_at)
              values (${randomUUID()}, ${database.operatorId}, ${APPLICATION_ID}, 'introduction', ${NOW}, ${NOW})`.execute(tx)
        )
        .then(() => "inserted" as const)
        .catch(() => "refused" as const)
    )
    expect(refused).toBe("refused")
  })

  it("answers the same not-found when another Candidate asks for the Application's texts or starts a Run for it", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { readerName: "Zephyrine Quillfeather", body: BODY_REFERRAL })
    // Move the Application to the other Candidate: from this session it is now foreign.
    await database.db.updateTable("application").set({ candidate_id: otherCandidateId }).where("id", "=", APPLICATION_ID).execute()
    expect((await candidate.get(outreachPath(APPLICATION_ID)).expect(404)).body).toEqual(NOT_FOUND)
    expect((await candidate.post(writePath(APPLICATION_ID, "referral_request")).expect(404)).body).toEqual(NOT_FOUND)
    expect((await candidate.put(namePath(APPLICATION_ID, "introduction")).send({ readerName: "Amara Okafor" }).expect(404)).body).toEqual(NOT_FOUND)
    expect(anthropic.requests).toHaveLength(0)
  })
})

async function seedSpend(micros: number): Promise<void> {
  const month = "2026-11-01"
  // The month header first, as SpendLedger does in production (controls.int-spec).
  await app.get(SpendLedger).month()
  await database.db
    .insertInto("spend_entry")
    .values({ id: randomUUID(), month, category: "ai", sub_budget: null, purpose: "seed", status: "settled", reserved_micros: micros, actual_micros: micros, application_id: null, attempt_id: null, created_at: clock.now(), settled_at: clock.now() })
    .execute()
}
