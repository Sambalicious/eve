import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertCandidatePosting, insertPostingFor } from "./support/candidate-posting.js"

/**
 * EPIC-0002 A1 unit 2 (discovery group). Both Candidates hold one shared
 * posting; what belongs to a Candidate is their `candidate_posting` state,
 * Eligibility, Match evidence and Career Profile facts (item 6 adds the state;
 * candidate-posting-isolation.int-spec covers it). The other Candidate's evaluation of a shared posting never
 * appears in the owner's list, ranks or detail.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let otherId: string
const clock = new TestClock("2026-10-16T09:00:00.000Z")
const POSTING_ID = "00000000-0000-4000-8000-0000000000f1"
const URL = "https://boards.greenhouse.io/shared/jobs/77"
const FACT_ID = "00000000-0000-4000-8000-0000000000f2"

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
})

beforeEach(async () => {
  for (const table of ["match_evidence", "eligibility_result", "career_profile_version", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  const at = new Date("2026-10-15T09:00:00.000Z")
  await insertPostingFor(database.db, database.operatorId, { id: POSTING_ID, application_url: URL, requisition_id: "77", apply_url: URL, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Shared Frontend Role", company: "Shared Co", posting_text: "Remote.", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: at, evaluated_at: at })
  // The other Candidate holds the same shared posting with their own (ranked) state.
  await insertCandidatePosting(database.db, otherId, POSTING_ID, { status: "ranked", evaluatedAt: at })
  await database.db
    .insertInto("eligibility_result")
    .values({ candidate_id: otherId, job_posting_id: POSTING_ID, arrangement: "remote", relocation_country: null, employment_type: "contract", rules: JSON.stringify([{ rule: "location", result: "unverified", quote: "OTHER-QUOTE" }]), eligible: true, normalized_monthly_max_usd: "9999.00", fx_rate_date: null, evaluated_at: at })
    .execute()
  await database.db
    .insertInto("match_evidence")
    .values({ candidate_id: otherId, job_posting_id: POSTING_ID, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: 7, total_count: 8, threshold: "0.600", items: JSON.stringify([{ group: "core", text: "OTHER-ITEM", factId: FACT_ID }]), evaluated_at: at, criteria_version: 1 })
    .execute()
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: otherId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify([{ id: "s1", kind: "experience", title: "t", organization: null, period: null, sourceQuote: null, facts: [{ id: FACT_ID, text: "OTHER-FACT", sourceQuote: null }] }]), rejected_fact_count: 0, created_at: at, approved_at: at })
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("discovery group shows only the session Candidate's evaluation", () => {
  it("the list carries none of the other Candidate's Match counts or Unverified labels", async () => {
    for (const tab of ["ranked", "all"]) {
      const body = (await owner.get(`/v1/job-postings?tab=${tab}`).expect(200)).body
      const posting = body.postings.find((item: { id: string }) => item.id === POSTING_ID)
      expect(posting).toBeDefined()
      expect(posting.match).toBeNull()
      expect(JSON.stringify(posting)).not.toMatch(/"location"/)
    }
  })

  it("the detail shows none of the other Candidate's Eligibility, Match evidence or facts", async () => {
    const detail = (await owner.get(`/v1/job-postings/${POSTING_ID}`).expect(200)).body
    expect(detail).toMatchObject({ eligibility: null, match: null, employmentType: null })
    expect(JSON.stringify(detail)).not.toMatch(/OTHER-|9999/)
  })

  it("refuses a discovery call outside any Candidate scope", async () => {
    await expect(app.get(DiscoveryService).posting(POSTING_ID)).rejects.toBeInstanceOf(MissingCandidateScopeError)
  })
})
