import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * v1.28.1 (migration 0036, owner decision 2026-11-10): a check that failed for a transient reason is
 * retried once by the worker, without the Candidate pressing "Check again". These are the rows the
 * worker's spend tick picks up (`releaseWaiting`), and the failure kinds it must leave alone.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidateId: string
let repository: DiscoveryRepository
const clock = new TestClock("2026-11-10T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  await signInCandidate(new Browser(app, google))
  candidateId = database.operatorId
  repository = app.get(DiscoveryRepository)
})

afterAll(async () => {
  await app.close()
  google.close()
  await database.stop()
})

/** A failed posting `ageMinutes` old, with the stored failure and attempt count. */
async function seedFailed(failure: string, attempts: number, ageMinutes: number): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${id.slice(0, 8)}`
  const evaluatedAt = new Date(clock.now().getTime() - ageMinutes * 60_000)
  await insertPostingFor(database.db, candidateId, {
    id,
    application_url: url,
    requisition_id: id.slice(0, 8),
    apply_url: url,
    application_system: "greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: "Senior Frontend Engineer",
    company: "Acme",
    status: "evaluation_failed",
    skip_reason: null,
    skip_detail: null,
    evaluation_failure: failure,
    role_family: "senior_frontend",
    discovered_at: clock.now(),
    evaluated_at: evaluatedAt,
  })
  await database.db
    .updateTable("candidate_posting")
    .set({ evaluation_attempts: attempts })
    .where("candidate_id", "=", candidateId)
    .where("job_posting_id", "=", id)
    .execute()
  return id
}

const retryIds = () => CandidateScope.run(candidateId, () => repository.retryFailedIds(50, clock.now()))

describe("automatic retry of a transient check failure (migration 0036)", () => {
  it("re-queues a provider_error that failed once and is past the backoff", async () => {
    const id = await seedFailed("provider_error", 1, 30)
    expect(await retryIds()).toContain(id)
  })

  it("re-queues a not_configured row: the provider outage of 21-28 Oct", async () => {
    const id = await seedFailed("not_configured", 1, 24 * 60)
    expect(await retryIds()).toContain(id)
  })

  it("never picks up a row that was already retried", async () => {
    const id = await seedFailed("provider_error", 2, 30)
    expect(await retryIds()).not.toContain(id)
  })

  it("leaves a failure the Candidate must fix to the Check again panel", async () => {
    const noProfile = await seedFailed("no_career_profile", 1, 30)
    const notApproved = await seedFailed("not_approved", 1, 30)
    const ids = await retryIds()
    expect(ids).not.toContain(noProfile)
    expect(ids).not.toContain(notApproved)
  })

  it("waits for the backoff so a provider outage is not hammered", async () => {
    const id = await seedFailed("provider_error", 1, 2)
    expect(await retryIds()).not.toContain(id)
  })
})

describe("markFailed counts the attempt", () => {
  it("increments evaluation_attempts and records the failure", async () => {
    const id = await seedFailed("provider_error", 1, 30)
    await CandidateScope.run(candidateId, () => repository.markFailed(id, "provider_error", clock.now()))
    const row = await database.db
      .selectFrom("candidate_posting")
      .select(["status", "evaluation_failure", "evaluation_attempts"])
      .where("candidate_id", "=", candidateId)
      .where("job_posting_id", "=", id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ status: "evaluation_failed", evaluation_failure: "provider_error", evaluation_attempts: 2 })
  })
})
