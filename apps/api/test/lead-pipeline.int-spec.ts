import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { leadSchema, leadsResponseSchema } from "@eve/contracts"

import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * v1.29.0 lead pipeline: GET/PUT/DELETE /v1/leads. A lead is the Candidate's own
 * stage for a posting they hold — Saved, Applied, Interviewing, Offer or
 * Rejected — and exists whether or not Eve has an Application for it.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate
const clock = new TestClock("2026-11-10T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  candidate = await signInCandidate(new Browser(app, google))
})

afterAll(async () => {
  await app.close()
  google.close()
  await database.stop()
})

async function posting(title = "Senior Frontend Engineer"): Promise<string> {
  const id = randomUUID()
  await insertPostingFor(database.db, database.operatorId, {
    id,
    application_url: `https://boards.greenhouse.io/acme/jobs/${id.slice(0, 8)}`,
    requisition_id: id.slice(0, 8),
    apply_url: `https://boards.greenhouse.io/acme/jobs/${id.slice(0, 8)}`,
    application_system: "greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title,
    company: "Acme",
    status: "ranked",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: clock.now(),
    evaluated_at: clock.now(),
  })
  return id
}

const list = async () => leadsResponseSchema.parse((await candidate.get("/v1/leads").expect(200)).body)
const setStage = (id: string, stage: string) => candidate.put(`/v1/leads/${id}`).send({ stage })

describe("lead pipeline", () => {
  it("starts empty", async () => {
    expect(await list()).toEqual({ leads: [] })
  })

  it("saves a posting as a lead and lists it with the posting facts", async () => {
    const id = await posting()
    const created = leadSchema.parse((await setStage(id, "saved").expect(200)).body)
    expect(created).toMatchObject({ jobPostingId: id, stage: "saved", roleTitle: "Senior Frontend Engineer", company: "Acme", applicationId: null })
    const leads = await list()
    expect(leads.leads.map((lead) => lead.jobPostingId)).toContain(id)
  })

  it("moves the same lead forward without duplicating it", async () => {
    const id = await posting()
    await setStage(id, "saved").expect(200)
    const applied = leadSchema.parse((await setStage(id, "applied").expect(200)).body)
    expect(applied.stage).toBe("applied")
    const mine = (await list()).leads.filter((lead) => lead.jobPostingId === id)
    expect(mine).toHaveLength(1)
  })

  it("removes a lead", async () => {
    const id = await posting()
    await setStage(id, "saved").expect(200)
    await candidate.delete(`/v1/leads/${id}`).expect(204)
    expect((await list()).leads.some((lead) => lead.jobPostingId === id)).toBe(false)
  })

  it("refuses a posting the Candidate does not hold with 404", async () => {
    expect((await setStage(randomUUID(), "saved").expect(404)).body).toMatchObject({ error: { code: "not_found" } })
  })

  it("refuses a stage outside the five with 400", async () => {
    const id = await posting()
    expect((await setStage(id, "shortlisted").expect(400)).body).toMatchObject({ error: { code: "bad_request" } })
    expect((await candidate.put("/v1/leads/not-a-uuid").send({ stage: "saved" }).expect(400)).body).toMatchObject({ error: { code: "bad_request" } })
  })

  it("requires the session", async () => {
    await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/leads" }).then((response: { statusCode: number }) => {
      expect(response.statusCode).toBe(401)
    })
  })
})
