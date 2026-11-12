import { randomUUID } from "node:crypto"

import { Logger, type INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { TenantDatabase } from "../src/db/tenant-database.js"
import { OutreachRepository } from "../src/outreach/outreach.repository.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0014 architecture r1 D10: a Run lives in the api process, so a row left
 * `running` at startup was cut off by a restart. Boot recovery resets each
 * Candidate's rows in that Candidate's own scope to `idle` with
 * `last_failure = 'interrupted'`, keeping the earlier text (AC 7.9, D11). The
 * repository writer is covered directly and once through a real boot, so the
 * `onApplicationBootstrap` wiring is proved too.
 */
type Kind = "referral_request" | "introduction" | "application_note"

const NOW = new Date("2026-11-10T09:00:00.000Z")
const CREATED_AT = new Date("2026-11-09T08:00:00.000Z")
const RUN_STARTED_AT = new Date("2026-11-10T08:55:00.000Z")
const WRITTEN_AT = new Date("2026-11-08T12:30:00.000Z")
const POSTING_ID = "00000000-0000-4000-8000-000000000114"
const APPLICATION_ID = "00000000-0000-4000-8000-000000000214"
const BODY = "I built the merchant dashboard and mentored six developers."

let database: TestDatabase
let app: INestApplication
const clock = new TestClock(NOW.toISOString())

beforeAll(async () => {
  database = await startMigratedDatabase()
  app = await createTestApp({ databaseUrl: database.url, clock })
})

beforeEach(async () => {
  clock.set(NOW.toISOString())
  await database.db.deleteFrom("outreach_message").execute()
  await database.db.deleteFrom("application").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
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
    posting_text: "Build design systems with React and TypeScript.",
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: NOW,
    evaluated_at: NOW,
  })
  await database.db
    .insertInto("application")
    .values({
      id: APPLICATION_ID,
      candidate_id: database.operatorId,
      job_posting_id: POSTING_ID,
      application_url: "https://boards.greenhouse.io/northwind/jobs/14",
      requisition_id: "R-OM-14",
      company: "Northwind Labs",
      role_title: "Senior Frontend Engineer",
      state: "documents_ready",
      career_profile_version: null,
      blocked_document: null,
      blocked_claim: null,
      failure: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    })
    .execute()
})

afterAll(async () => {
  await app?.close()
  await database?.stop()
})

/** One row with the table's all-or-none text columns; `running` rows carry a run token. */
async function seed(kind: Kind, input: Readonly<{ running?: boolean; body?: string }> = {}): Promise<void> {
  const body = input.body ?? null
  await database.db
    .insertInto("outreach_message")
    .values({
      id: randomUUID(),
      candidate_id: database.operatorId,
      application_id: APPLICATION_ID,
      kind,
      reader_name: kind === "introduction" ? "Amara Okafor" : null,
      body,
      sentences: body === null ? null : JSON.stringify([{ kind: "statement", text: body, factIds: ["F1"] }]),
      profile_version: body === null ? null : 2,
      written_at: body === null ? null : WRITTEN_AT,
      last_failure: kind === "application_note" ? "provider_error" : null,
      first_failed_sentence: null,
      run_status: input.running === true ? "running" : "idle",
      run_id: input.running === true ? randomUUID() : null,
      run_started_at: input.running === true ? RUN_STARTED_AT : null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    })
    .execute()
}

const rows = () => database.db.selectFrom("outreach_message").selectAll().where("candidate_id", "=", database.operatorId).orderBy("kind").execute()
const rowFor = async (kind: Kind) => (await rows()).find((row) => row.kind === kind)

describe("outreach boot recovery (D10)", () => {
  it("turns each running row idle with interrupted, keeps an earlier text, leaves an idle row alone, and returns the count", async () => {
    await seed("referral_request", { running: true })
    await seed("introduction", { running: true, body: BODY })
    await seed("application_note")
    const idleBefore = await rowFor("application_note")

    const counts = await app.get(TenantDatabase).eachCandidate(() => app.get(OutreachRepository).resetInterrupted(NOW))
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(2)

    const referral = await rowFor("referral_request")
    expect(referral).toMatchObject({
      run_status: "idle",
      run_id: null,
      run_started_at: null,
      last_failure: "interrupted",
      first_failed_sentence: null,
      body: null,
      sentences: null,
      profile_version: null,
      written_at: null,
      updated_at: NOW,
    })

    const introduction = await rowFor("introduction")
    expect(introduction).toMatchObject({
      run_status: "idle",
      run_id: null,
      run_started_at: null,
      last_failure: "interrupted",
      first_failed_sentence: null,
      body: BODY,
      sentences: [{ kind: "statement", text: BODY, factIds: ["F1"] }],
      profile_version: 2,
      written_at: WRITTEN_AT,
      reader_name: "Amara Okafor",
      updated_at: NOW,
    })

    // A row that is already idle is untouched, cause and timestamp included.
    expect(await rowFor("application_note")).toEqual(idleBefore)
  })

  it("resets an interrupted Run when a new api process starts and logs one count-only event", async () => {
    await seed("referral_request", { running: true, body: BODY })
    const logs: string[] = []
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)))
    let restarted: INestApplication | undefined
    try {
      restarted = await createTestApp({ databaseUrl: database.url, clock })
    } finally {
      log.mockRestore()
    }
    try {
      expect(await rowFor("referral_request")).toMatchObject({
        run_status: "idle",
        run_id: null,
        run_started_at: null,
        last_failure: "interrupted",
        body: BODY,
      })
      const events = logs.filter((line) => line.includes('"event":"outreach.runs_interrupted"'))
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0] ?? "")).toEqual({ event: "outreach.runs_interrupted", count: 1 })
      // Count only: the event carries no application id, kind, text or Reader name.
      expect(events[0]).not.toContain(APPLICATION_ID)
      expect(events[0]).not.toContain(BODY)
    } finally {
      await restarted?.close()
    }
  })
})
