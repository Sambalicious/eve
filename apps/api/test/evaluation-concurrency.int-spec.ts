import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { pasteJobLinkResponseSchema } from "@eve/contracts"
import { HttpResponse, http } from "msw"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { PostingEvaluator } from "../src/discovery/posting-evaluator.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { FIXTURE_POSTED_MS } from "./support/posted-date-fixture.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0006 repair SEC-601 (security-review.md): many concurrent evaluations
 * in one process must neither starve nor deadlock the 10-connection pool. Before
 * the fix, each evaluation held one pooled connection for the TM-04 advisory
 * lock while its body waited for a second; at 10 overlapping evaluations every
 * connection was a lock holder and the api hung, /v1/health included.
 * Default api config (5 s statement timeout, api pool), as the paste path runs.
 */
const COUNT = 12
/** Generous for 12 tiny evaluations on Testcontainers (about 50 ms when healthy); short enough that a hang fails fast. */
const BOUND_MS = 15_000

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let candidate: SignedInCandidate
const clock = new TestClock("2026-10-21T09:00:00.000Z")

const TEXT = "Remote, open to candidates in Nigeria. Salary USD 60,000–80,000 per year. Core hours 10:00–18:00 WAT. Globex builds payment APIs for merchants. Build React features."
const SECTIONS = [{ id: "s1", kind: "experience", title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021-2024", sourceQuote: null, facts: [{ id: "F1", text: "Built React features", sourceQuote: null }] }]

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  candidate = await signInCandidate(new Browser(app, google))
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
})

afterAll(async () => {
  anthropic?.reset()
  await app?.close()
  google?.close()
  await database?.stop()
})

/** Resolves with `work`'s value, or rejects once `ms` pass (a pool deadlock never settles). */
function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

const health = () => within(request(app.getHttpServer()).get("/v1/health"), BOUND_MS, "GET /v1/health")

function extraction() {
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
    coreResponsibilities: [{ text: "Build React features", quote: "Build React features", factId: "F1" }],
    mandatoryPrerequisites: [],
    niceToHave: [],
  }
}

describe("SEC-601: concurrent evaluations never deadlock the api pool", () => {
  it(`${COUNT} concurrent PostingEvaluator.evaluate calls all finish, and /v1/health still answers`, async () => {
    const ids: string[] = []
    for (let i = 0; i < COUNT; i++) {
      const id = randomUUID()
      const url = `https://boards.greenhouse.io/globex/jobs/${id}`
      // Hidden for the Operator (data_ml is not a default target): the gate returns "hidden" with no model call, as in the probe.
      await insertPostingFor(database.db, database.operatorId, { id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Data Engineer", company: "Globex", posting_text: TEXT, status: "checking", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "data_ml", discovered_at: clock.now(), evaluated_at: null })
      ids.push(id)
    }
    const evaluator = asOperator(app, app.get(PostingEvaluator))
    const results = await within(Promise.all(ids.map((id) => evaluator.evaluate(id))), BOUND_MS, `${COUNT} concurrent evaluations`)
    expect(results).toEqual(ids.map(() => "hidden"))
    expect(anthropic.requests).toHaveLength(0)
    expect((await health()).status).toBe(200)
  })

  it("TM-04 / CHK-11 still holds: a second evaluation of the same posting while one is in flight is not claimed and reserves nothing", async () => {
    const id = randomUUID()
    const url = `https://boards.greenhouse.io/globex/jobs/${id}`
    await insertPostingFor(database.db, database.operatorId, { id, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company: "Globex", posting_text: TEXT, status: "checking", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: clock.now(), evaluated_at: null })
    const reservations = async () => (await database.db.selectFrom("spend_entry").select("id").where("category", "=", "ai").execute()).length
    const before = await reservations()
    const evaluator = asOperator(app, app.get(PostingEvaluator))
    anthropic.replyWithObjectWhenReleased(extraction())
    const first = evaluator.evaluate(id)
    await anthropic.waitForHeld()
    expect(await within(evaluator.evaluate(id), BOUND_MS, "second evaluation")).toBe("not_claimed")
    anthropic.releaseHeld()
    expect(await first).toBe("evaluated")
    expect(anthropic.requests).toHaveLength(1)
    expect((await reservations()) - before).toBe(1)
  })

  it(`${COUNT} parallel POST /v1/job-postings/links all return 201, their evaluations finish, and /v1/health answers meanwhile`, async () => {
    google.server.use(
      http.get("https://api.lever.co/v0/postings/globex/:job", ({ params }) =>
        HttpResponse.json({ id: params.job, text: "Senior Frontend Engineer", hostedUrl: `https://jobs.lever.co/globex/${String(params.job)}`, createdAt: FIXTURE_POSTED_MS, descriptionPlain: TEXT })
      )
    )
    for (let i = 0; i < COUNT; i++) anthropic.replyWithObject(extraction())
    const pastes = Array.from({ length: COUNT }, (_, i) => candidate.post("/v1/job-postings/links").send({ url: `https://jobs.lever.co/globex/sec601-${i}` }))
    const [responses, during] = await within(Promise.all([Promise.all(pastes.map((paste) => paste.then((response) => response))), health()]), BOUND_MS, `${COUNT} parallel pastes`)
    expect(during.status).toBe(200)
    expect(responses.map((response) => response.status)).toEqual(responses.map(() => 201))
    const postingIds = responses.map((response) => pasteJobLinkResponseSchema.parse(response.body).posting.id)
    await within(app.get(DiscoveryService).settled(), BOUND_MS, "background evaluations")
    expect(anthropic.requests).toHaveLength(COUNT)
    const rows = await database.db.selectFrom("candidate_posting").select("status").where("job_posting_id", "in", postingIds).execute()
    expect(rows).toHaveLength(COUNT)
    expect(rows.every((row) => row.status === "ranked")).toBe(true)
    expect((await health()).status).toBe(200)
  })
})
