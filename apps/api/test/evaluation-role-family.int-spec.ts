import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { RoleFamilyValue } from "@eve/contracts"

import { WORKER_STATEMENT_TIMEOUT_MS } from "../src/db/create-database.js"
import { PostingEvaluator } from "../src/discovery/posting-evaluator.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0006 AC-1.8 (prd.r3; architecture.r1 "Reconciling at evaluation";
 * role-family-catalog.feature:337-362), repair CR-1: recording an evaluation
 * changes the shared `job_posting.role_family` only between technical_lead and
 * people_management. Any other evaluated family leaves the store-time family;
 * an untitled posting (stored null) takes the evaluated family. Runs through
 * PostingEvaluator with real Postgres and the fake Anthropic endpoint.
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
const clock = new TestClock("2026-10-21T09:00:00.000Z")

const BASE_TEXT = "Remote, open to candidates in Nigeria. Salary USD 60,000–80,000 per year. Core hours 10:00–18:00 WAT. Globex builds payment APIs for merchants."
const MANAGEMENT_DUTIES = ["Hiring for the payments group", "Performance reviews for 8 engineers", "Line management of the platform group"]
const HANDS_ON_DUTIES = ["Write React and TypeScript code daily", "Ship features hands-on"]
const SECTIONS = [{ id: "s1", kind: "experience", title: "Engineering Manager", organization: "Brightwave Ltd", period: "2021-2024", sourceQuote: null, facts: [{ id: "F1", text: "Managed and hired a team of 8", sourceQuote: null }] }]

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock, config: { statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS } })
  const candidate = await signInCandidate(new Browser(app, google))
  await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(SECTIONS), created_at: new Date(), approved_at: new Date() })
    .execute()
})

beforeEach(async () => {
  anthropic.install()
  anthropic.reset()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

function extraction(core: readonly string[]) {
  return {
    workArrangement: "remote",
    locationQuote: "Remote, open to candidates in Nigeria",
    relocationCountry: null,
    relocationQuote: null,
    sponsorshipQuote: null,
    payQuote: "Salary USD 60,000–80,000 per year",
    hoursQuote: "Core hours 10:00–18:00 WAT",
    employerBusiness: "payment APIs for merchants",
    businessQuote: "Globex builds payment APIs for merchants",
    employmentType: null,
    coreResponsibilities: core.map((text) => ({ text, quote: text, factId: "F1" })),
    mandatoryPrerequisites: [],
    niceToHave: [],
  }
}

/** A stored, visible posting waiting in `checking`, with the family discovery stored for it (null for untitled). */
async function stored(title: string | null, family: RoleFamilyValue | null, core: readonly string[]): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/globex/jobs/${id}`
  await insertPostingFor(
    database.db,
    database.operatorId,
    { id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title, company: "Globex", posting_text: `${BASE_TEXT} ${core.join(". ")}.`, status: "checking", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: family, discovered_at: clock.now(), evaluated_at: null },
    { keepFamily: true }
  )
  return id
}

async function evaluatedFamily(title: string | null, family: RoleFamilyValue | null, core: readonly string[]): Promise<string | null> {
  const id = await stored(title, family, core)
  anthropic.replyWithObject(extraction(core))
  expect(await asOperator(app, app.get(PostingEvaluator)).evaluate(id)).toBe("evaluated")
  expect(anthropic.requests).toHaveLength(1)
  return (await database.db.selectFrom("job_posting").select("role_family").where("id", "=", id).executeTakeFirstOrThrow()).role_family
}

describe("AC-1.8 the evaluation keeps the store-time family except technical_lead <-> people_management (CR-1)", () => {
  it.each([
    ["Senior Frontend Engineer", "senior_frontend"],
    ["Senior Backend Engineer", "backend"],
    ["Senior Software Engineer", "software_engineering"],
  ] as const)("%s (%s) with management-only duties keeps its family", async (title, family) => {
    expect(await evaluatedFamily(title, family, MANAGEMENT_DUTIES)).toBe(family)
  })

  it("Engineering Lead (technical_lead) with management-only duties becomes people_management", async () => {
    expect(await evaluatedFamily("Engineering Lead", "technical_lead", MANAGEMENT_DUTIES)).toBe("people_management")
  })

  it("Engineering Lead stored as people_management with hands-on duties becomes technical_lead", async () => {
    expect(await evaluatedFamily("Engineering Lead", "people_management", HANDS_ON_DUTIES)).toBe("technical_lead")
  })

  it("an untitled posting (stored null) takes the evaluated family", async () => {
    expect(await evaluatedFamily(null, null, MANAGEMENT_DUTIES)).toBe("people_management")
  })
})
