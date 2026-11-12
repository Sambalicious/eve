import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { ANTHROPIC_TERMS, APPLICATIONS_PATH, DELETE_DETAILS_PATH, applicationPath } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { WORKER_STATEMENT_TIMEOUT_MS, createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { RetentionRunner } from "../src/records/retention-runner.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA gate, EPIC-0014. Gherkin behaviours that no other suite exercises, through the published routes
 * and the database: the Application is unchanged by a Run in every state, the Application summary and
 * detail carry no outreach field, bulk deletion and the expiry boundary and skip, and no other table
 * holds a Reader name or a first failed sentence. Harness copied from outreach.int-spec.ts.
 */

type Kind = "referral_request" | "introduction" | "application_note"
const KINDS: readonly Kind[] = ["referral_request", "introduction", "application_note"]
const SLUGS: Record<Kind, string> = { referral_request: "referral-request", introduction: "introduction", application_note: "application-note" }

const outreachPath = (applicationId: string) => `/v1/applications/${applicationId}/outreach`
const writePath = (applicationId: string, kind: Kind) => `${outreachPath(applicationId)}/${SLUGS[kind]}/write`
const namePath = (applicationId: string, kind: Kind) => `${outreachPath(applicationId)}/${SLUGS[kind]}/reader-name`

const F1 = { id: "6f1c0e8a-1111-4a6b-9a01-000000000001", text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", sourceQuote: null }
const F3 = { id: "6f1c0e8a-3333-4a6b-9a01-000000000003", text: "Mentored 6 junior developers", sourceQuote: null }
const F4 = { id: "6f1c0e8a-4444-4a6b-9a01-000000000004", text: "Cut release cycle from 2 weeks to 3 days", sourceQuote: null }
const F2 = { id: "6f1c0e8a-2222-4a6b-9a01-000000000002", text: "Senior Frontend Engineer at Brightwave Ltd, 2021–2024", sourceQuote: null }
const V1 = [{ id: "s1", kind: "experience", title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021–2024", sourceQuote: null, facts: [F1, F2, F3, F4] }]

const REPLIES: Record<Kind, unknown> = {
  referral_request: {
    sentences: [
      { kind: "statement", text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
      { kind: "statement", text: "I mentored 6 junior developers.", factIds: ["F3"] },
      { kind: "ask", text: "Would you be open to referring me for {role_phrase} at {company_phrase}, with no pressure at all if the answer is no?", factIds: [] },
    ],
  },
  introduction: {
    sentences: [
      { kind: "statement", text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
      { kind: "statement", text: "I cut our release cycle from 2 weeks to 3 days.", factIds: ["F4"] },
      { kind: "ask", text: "Could we have a short conversation, or could you point me to the right person?", factIds: [] },
    ],
  },
  application_note: {
    sentences: [
      { kind: "statement", text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
      { kind: "statement", text: "I mentored 6 junior developers.", factIds: ["F3"] },
    ],
  },
}
const SUPPORTS_ALL = { results: Array.from({ length: 200 }, (_, id) => ({ id, supported: true })) }
const BODY_NOTE = "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I mentored 6 junior developers."
const DISTINCTIVE_SENTENCE = "I led the Zorvex billing migration."
const DISTINCTIVE_NAME = "Zephyrine Quillfeather"

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let storage: string
let workerDb: Kysely<Database>
const clock = new TestClock("2026-11-10T09:00:00.000Z")

const NOW = new Date("2026-11-10T09:00:00.000Z")
const POSTING_ID = "00000000-0000-4000-8000-000000000e15"
const APPLICATION_ID = "00000000-0000-4000-8000-000000000a15"
const SECOND_ID = "00000000-0000-4000-8000-000000000b15"
const THIRD_ID = "00000000-0000-4000-8000-000000000c15"

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-outreach-gate-"))
  markStorageMigratedSync(join(storage, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({
    databaseUrl: database.url,
    clock,
    config: { candidateStorageDir: join(storage, "candidates"), anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5") },
  })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
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
    .set({ global_paused: false, global_paused_at: null, cost_paused: false, cost_paused_at: null, cost_paused_month: null, cost_pause_action: null, cost_pause_estimate_micros: null, cost_pause_cleared_at: null })
    .execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "", lines: "[]" }).where("candidate_id", "=", database.operatorId).execute()
  await insertPostingFor(database.db, database.operatorId, {
    id: POSTING_ID,
    application_url: "https://boards.greenhouse.io/northwind/jobs/15",
    requisition_id: "R-OM-15",
    apply_url: "https://boards.greenhouse.io/northwind/jobs/15",
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
  await insertApplication(APPLICATION_ID)
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await workerDb?.destroy()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

async function insertApplication(id: string): Promise<void> {
  await database.db
    .insertInto("application")
    .values({
      id,
      candidate_id: database.operatorId,
      job_posting_id: POSTING_ID,
      application_url: `https://boards.greenhouse.io/northwind/jobs/15?${id.slice(-4)}`,
      requisition_id: id.slice(-4),
      company: "Northwind Labs",
      role_title: "Senior Frontend Engineer",
      state: "documents_ready",
      career_profile_version: 1,
      blocked_document: null,
      blocked_claim: null,
      failure: null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute()
}

async function readyToWrite(): Promise<void> {
  await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: ANTHROPIC_TERMS.checkedOn }).expect(200)
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(V1), created_at: NOW, approved_at: NOW })
    .execute()
  await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] }).expect(200)
}

type SeedRow = Readonly<{ readerName?: string | null; body?: string | null; lastFailure?: string | null; firstFailedSentence?: string | null; running?: boolean }>

async function seedOutreach(applicationId: string, kind: Kind, row: SeedRow = {}): Promise<void> {
  const body = row.body ?? null
  const sentences = body === null ? null : JSON.stringify([{ kind: "statement", text: body, factIds: ["F1"] }])
  await sql`
    insert into outreach_message
      (id, candidate_id, application_id, kind, reader_name, body, sentences, profile_version, written_at,
       last_failure, first_failed_sentence, run_status, run_id, run_started_at, created_at, updated_at)
    values
      (${randomUUID()}, ${database.operatorId}, ${applicationId}, ${kind}, ${row.readerName ?? null}, ${body},
       ${sentences}::jsonb, ${body === null ? null : 1}, ${body === null ? null : NOW}, ${row.lastFailure ?? null},
       ${row.firstFailedSentence ?? null}, ${row.running === true ? "running" : "idle"},
       ${row.running === true ? randomUUID() : null}, ${row.running === true ? NOW : null}, ${NOW}, ${NOW})
  `.execute(database.db)
}

type Item = Readonly<{ kind: Kind; status: "idle" | "running"; text: string | null; lastFailure: string | null; firstFailedSentence: string | null }>

async function settle(kind: Kind, applicationId = APPLICATION_ID, timeoutMs = 25_000): Promise<Item> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { items } = (await candidate.get(outreachPath(applicationId)).expect(200)).body as { items: Item[] }
    const item = items.find((entry) => entry.kind === kind)
    if (item?.status === "idle") return item
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`the ${kind} Run did not settle within ${timeoutMs} ms`)
}

async function writeAndSettle(kind: Kind, reply: unknown = REPLIES[kind]): Promise<Item> {
  anthropic.replyWithObject(reply)
  anthropic.replyWithObject(SUPPORTS_ALL)
  await candidate.post(writePath(APPLICATION_ID, kind)).expect(202)
  return settle(kind)
}

const applicationRow = async (id = APPLICATION_ID) => JSON.parse(JSON.stringify(await database.db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow())) as unknown
const outreachRowCount = async (id: string) => Number((await sql<{ n: string }>`select count(*)::text as n from outreach_message where application_id = ${id}`.execute(database.db)).rows[0]?.n)

describe("outreach-section.feature, AC 13.2: the Application summary and detail carry no outreach field", () => {
  it("returns the same summary and detail with three texts and a stored first failed sentence as with none", async () => {
    await readyToWrite()
    const listBefore = (await candidate.get(APPLICATIONS_PATH).expect(200)).body as unknown
    const detailBefore = (await candidate.get(applicationPath(APPLICATION_ID)).expect(200)).body as unknown

    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_NOTE, readerName: DISTINCTIVE_NAME })
    await seedOutreach(APPLICATION_ID, "introduction", { lastFailure: "blocked", firstFailedSentence: "I built the merchant dashboard in Angular." })
    await seedOutreach(APPLICATION_ID, "application_note", { body: BODY_NOTE })

    const listAfter = (await candidate.get(APPLICATIONS_PATH).expect(200)).body as unknown
    const detailAfter = (await candidate.get(applicationPath(APPLICATION_ID)).expect(200)).body as unknown
    expect(listAfter).toEqual(listBefore)
    expect(detailAfter).toEqual(detailBefore)
    for (const body of [JSON.stringify(listAfter), JSON.stringify(detailAfter)]) {
      expect(body).not.toContain("Angular")
      expect(body).not.toContain(DISTINCTIVE_NAME)
      expect(body.toLowerCase()).not.toContain("outreach")
    }
  })
})

describe("outreach-availability.feature: every Application state, and a Run changes nothing about the Application", () => {
  const STATES: readonly [string, Record<string, unknown>][] = [
    ["prepared", {}],
    ["generating", {}],
    ["documents_ready", {}],
    ["documents_blocked", { blocked_document: "cover_letter", blocked_claim: "I admire Northwind Labs." }],
    ["documents_failed", { failure: "provider_error" }],
  ]

  it.each(STATES)("writes all three Kinds in state %s, and leaves the Application row and detail as they were", async (state, columns) => {
    await readyToWrite()
    await database.db.updateTable("application").set({ state: state as never, ...columns }).where("id", "=", APPLICATION_ID).execute()
    const rowBefore = await applicationRow()
    const detailBefore = (await candidate.get(applicationPath(APPLICATION_ID)).expect(200)).body as unknown
    const listBefore = (await candidate.get(APPLICATIONS_PATH).expect(200)).body as unknown

    for (const kind of KINDS) {
      const item = await writeAndSettle(kind)
      expect(item.lastFailure).toBeNull()
      expect(item.text).not.toBeNull()
    }

    expect(await applicationRow()).toEqual(rowBefore)
    expect((await candidate.get(applicationPath(APPLICATION_ID)).expect(200)).body).toEqual(detailBefore)
    expect((await candidate.get(APPLICATIONS_PATH).expect(200)).body).toEqual(listBefore)
  })

  const SUBMISSIONS: readonly [string, Record<string, unknown>][] = [
    ["queued", {}],
    ["confirmed", { confirmed_at: NOW }],
    ["uncertain", {}],
    ["blocked", { blocked_reason: "captcha" }],
    ["manual", {}],
    ["declined", {}],
  ]

  it.each(SUBMISSIONS)("writes a Kind in submission state %s, says nothing about it, and leaves the Application as it was", async (submission, columns) => {
    await readyToWrite()
    await database.db.updateTable("application").set({ submission_state: submission as never, ...columns }).where("id", "=", APPLICATION_ID).execute()
    const rowBefore = await applicationRow()
    const item = await writeAndSettle("introduction")
    expect(item.lastFailure).toBeNull()
    expect(item.text).not.toMatch(/applied|submitted|submission|confirmed/i)
    expect(await applicationRow()).toEqual(rowBefore)
  })
})

describe("outreach-retention-and-ownership.feature: bulk deletion, the expiry boundary and the skip", () => {
  it("bulk deletion removes the outreach rows of every selected Application and of no other", async () => {
    await readyToWrite()
    await insertApplication(SECOND_ID)
    await insertApplication(THIRD_ID)
    for (const id of [APPLICATION_ID, SECOND_ID, THIRD_ID]) {
      await seedOutreach(id, "referral_request", { body: BODY_NOTE, readerName: DISTINCTIVE_NAME })
      await seedOutreach(id, "introduction", { lastFailure: "blocked", firstFailedSentence: DISTINCTIVE_SENTENCE })
    }
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [APPLICATION_ID, SECOND_ID] }).expect(200)

    expect(await outreachRowCount(APPLICATION_ID)).toBe(0)
    expect(await outreachRowCount(SECOND_ID)).toBe(0)
    expect(await outreachRowCount(THIRD_ID)).toBe(2)
    await candidate.get(outreachPath(APPLICATION_ID)).expect(404)
    await candidate.get(outreachPath(SECOND_ID)).expect(404)
    const kept = (await candidate.get(outreachPath(THIRD_ID)).expect(200)).body as { items: Item[] }
    expect(kept.items.find((item) => item.kind === "introduction")?.firstFailedSentence).toBe(DISTINCTIVE_SENTENCE)
  })

  async function startExpiry(day: string): Promise<void> {
    await database.db.updateTable("application").set({ created_at: new Date("2025-11-10T08:00:00.000Z") }).where("id", "=", APPLICATION_ID).execute()
    await database.db
      .insertInto("retention_run")
      .values({ id: randomUUID(), candidate_id: database.operatorId, wat_date: "2026-06-01", started_at: new Date("2026-06-01T02:00:00Z"), finished_at: new Date("2026-06-01T02:00:01Z"), outcome: "completed" })
      .execute()
    clock.set(day)
    await new RetentionRunner(new TenantDatabase(workerDb), clock).run()
  }

  it("deletes nothing the day before the 12-month anniversary", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_NOTE, readerName: "Amara Okafor" })
    await seedOutreach(APPLICATION_ID, "introduction", { lastFailure: "blocked", firstFailedSentence: DISTINCTIVE_SENTENCE })
    await startExpiry("2026-11-09T02:00:00.000Z")
    const row = await database.db.selectFrom("application").select("details_deleted_at").where("id", "=", APPLICATION_ID).executeTakeFirstOrThrow()
    expect(row.details_deleted_at).toBeNull()
    expect(await outreachRowCount(APPLICATION_ID)).toBe(2)
  })

  it("expiry skips an Application with a Run in flight and keeps its rows; manual deletion then works once the Run has ended", async () => {
    await readyToWrite()
    await seedOutreach(APPLICATION_ID, "referral_request", { body: BODY_NOTE })
    await seedOutreach(APPLICATION_ID, "introduction", { running: true })
    await startExpiry("2026-11-10T02:00:00.000Z")
    const skipped = await database.db.selectFrom("application").select("details_deleted_at").where("id", "=", APPLICATION_ID).executeTakeFirstOrThrow()
    expect(skipped.details_deleted_at).toBeNull()
    expect(await outreachRowCount(APPLICATION_ID)).toBe(2)

    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [APPLICATION_ID] }).expect(409)
    await sql`update outreach_message set run_status = 'idle', run_id = null, run_started_at = null, last_failure = 'provider_error' where application_id = ${APPLICATION_ID} and kind = 'introduction'`.execute(database.db)
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [APPLICATION_ID] }).expect(200)
    expect(await outreachRowCount(APPLICATION_ID)).toBe(0)
  })
})

describe("outreach-blocked-quote.feature and outreach-reader-name.feature: the sentence and the name are kept in the Outreach row and nowhere else", () => {
  async function tablesHolding(needle: string): Promise<string[]> {
    const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`.execute(database.db)
    const holding: string[] = []
    for (const { table_name } of tables.rows) {
      const found = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table_name)} t where t::text ilike ${`%${needle}%`}`.execute(database.db)
      if (Number(found.rows[0]?.n) > 0) holding.push(table_name)
    }
    return holding
  }

  it("leaves a blocked Run's sentence and a saved Reader name in no other table, and in no request to Anthropic", async () => {
    await readyToWrite()
    await candidate.put(namePath(APPLICATION_ID, "referral_request")).send({ readerName: DISTINCTIVE_NAME }).expect(200)
    const blocked = {
      sentences: [
        { kind: "statement", text: DISTINCTIVE_SENTENCE, factIds: ["F1"] },
        { kind: "ask", text: "Would you be open to referring me for {role_phrase} at {company_phrase}, with no pressure at all if the answer is no?", factIds: [] },
      ],
    }
    const item = await writeAndSettle("referral_request", blocked)
    expect(item.lastFailure).toBe("blocked")
    expect(item.firstFailedSentence).toBe(DISTINCTIVE_SENTENCE)

    expect(await tablesHolding("Zorvex")).toEqual(["outreach_message"])
    expect(await tablesHolding("Zephyrine")).toEqual(["outreach_message"])
    expect(JSON.stringify(anthropic.requests)).not.toContain("Zephyrine")
    expect(JSON.stringify(anthropic.requests)).not.toContain("Zorvex")
  })
})
