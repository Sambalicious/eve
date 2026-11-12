import type { INestApplication } from "@nestjs/common"
import { JOB_CRITERIA_PATH } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { PostingCursorCodec, TIER_HASH } from "../src/discovery/posting-cursor.js"
import { JobCriteriaService } from "../src/job-criteria/job-criteria.service.js"
import { Browser } from "./support/browser.js"
import { insertCandidatePosting, targetEveryFamily, visibleByDefault } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { ROLE_RELEVANCE_DEFAULTS } from "./support/job-criteria-body.js"

/**
 * EPIC-0002 A1 item 6 (architecture r2 "Shared posting split"; data-isolation
 * feature). Two Candidates hold one shared `job_posting` with opposite
 * outcomes. Before the split the status lived on `job_posting`, so whichever
 * Candidate wrote last decided what both saw. Now each sees only their own
 * `candidate_posting` row, in the list, the tabs, the counts and the detail,
 * and nothing one Candidate does rewrites the other's row.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let otherId: string
const clock = new TestClock("2026-10-16T09:00:00.000Z")
const SHARED = "00000000-0000-4000-8000-0000000000a1"
const OTHERS_ONLY = "00000000-0000-4000-8000-0000000000a2"
const AT = new Date("2026-10-15T09:00:00.000Z")

async function posting(id: string, title: string): Promise<void> {
  const url = `https://boards.greenhouse.io/split/jobs/${id.slice(-2)}`
  await database.db
    .insertInto("job_posting")
    // EPIC-0006: dated and marked like a stored posting (support/candidate-posting.ts visibleByDefault).
    .values(visibleByDefault({ id, application_url: url, requisition_id: id.slice(-2), apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title, company: "Split Co", posting_text: "Remote.", role_family: "senior_frontend", discovered_at: AT }))
    .execute()
}

async function strongMatch(candidateId: string, id: string, covered: number): Promise<void> {
  await database.db
    .insertInto("match_evidence")
    .values({ candidate_id: candidateId, job_posting_id: id, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: covered, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: AT, criteria_version: 1 })
    .execute()
}

/** The other Candidate's own scope, as their session or their worker job would run it. */
function asOther<T>(work: () => Promise<T>): Promise<T> {
  return CandidateScope.run(otherId, work)
}

async function stateOf(candidateId: string, id: string) {
  return database.db.selectFrom("candidate_posting").select(["status", "skip_reason"]).where("candidate_id", "=", candidateId).where("job_posting_id", "=", id).executeTakeFirstOrThrow()
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
  await database.db.insertInto("job_criteria").values({ candidate_id: otherId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
})

beforeEach(async () => {
  for (const table of ["match_evidence", "eligibility_result", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  await database.db.updateTable("job_criteria").set({ min_core_match_percent: 70, frameworks: [], technologies: [] }).execute()
  // EPIC-0006: this spec is about order and tenancy, not visibility; every family is a target (support/candidate-posting.ts).
  await targetEveryFamily(database.db, database.operatorId)
  await targetEveryFamily(database.db, otherId)
  await posting(SHARED, "Shared Frontend Role")
  await posting(OTHERS_ONLY, "Other Candidate's Pasted Role")
  // Owner: ranked with a strong Match. Other: skipped as a weak Match.
  await insertCandidatePosting(database.db, database.operatorId, SHARED, { status: "ranked", evaluatedAt: AT })
  await strongMatch(database.operatorId, SHARED, 9)
  await insertCandidatePosting(database.db, otherId, SHARED, { status: "skipped", skipReason: "weak_core_match", evaluatedAt: AT })
  await insertCandidatePosting(database.db, otherId, OTHERS_ONLY, { status: "waiting_to_be_checked", origin: "pasted_link", evaluatedAt: null })
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("each Candidate sees their own outcome for a shared posting", () => {
  it("the owner's tabs, counts and detail show the owner's ranked row, not the other's skip", async () => {
    const ranked = (await owner.get("/v1/job-postings?tab=ranked").expect(200)).body
    expect(ranked.postings.map((item: { id: string; status: string; rank: number }) => [item.id, item.status, item.rank])).toEqual([[SHARED, "ranked", 1]])
    expect(ranked.totalCount).toBe(1)
    const skipped = (await owner.get("/v1/job-postings?tab=skipped").expect(200)).body
    expect(skipped.postings).toEqual([])
    expect(skipped.totalCount).toBe(0)
    const all = (await owner.get("/v1/job-postings?tab=all").expect(200)).body
    expect(all.postings.map((item: { id: string }) => item.id)).toEqual([SHARED])
    expect(all.waitingToBeCheckedCount).toBe(0)
    const detail = (await owner.get(`/v1/job-postings/${SHARED}`).expect(200)).body
    expect(detail).toMatchObject({ status: "ranked", skipReason: null, rank: 1 })
  })

  it("the other Candidate's list and detail show their skip and their waiting posting", async () => {
    const service = app.get(DiscoveryService)
    const detail = await asOther(() => service.posting(SHARED))
    expect(detail).toMatchObject({ status: "skipped", skipReason: "weak_core_match", rank: null })
    const all = await asOther(() => service.listPostings({ tab: "all", limit: 25, families: [], keyword: null, cursor: null }))
    expect(all.postings.map((item) => [item.id, item.status]).sort()).toEqual([[SHARED, "skipped"], [OTHERS_ONLY, "waiting_to_be_checked"]].sort())
    expect(all.waitingToBeCheckedCount).toBe(1)
    const ranked = await asOther(() => service.listPostings({ tab: "ranked", limit: 25, families: [], keyword: null, cursor: null }))
    expect(ranked.totalCount).toBe(0)
  })

  it("a posting only the other Candidate holds is 404 for the owner, and absent from every owner tab and count", async () => {
    await owner.get(`/v1/job-postings/${OTHERS_ONLY}`).expect(404)
    for (const tab of ["ranked", "skipped", "all"]) {
      const body = (await owner.get(`/v1/job-postings?tab=${tab}`).expect(200)).body
      expect(JSON.stringify(body)).not.toContain(OTHERS_ONLY)
    }
  })
})

describe("last writer no longer wins", () => {
  it("the other Candidate's Job criteria save re-decides only their own rows", async () => {
    await strongMatch(otherId, OTHERS_ONLY, 8)
    await database.db.updateTable("candidate_posting").set({ status: "ranked", evaluated_at: AT }).where("candidate_id", "=", otherId).where("job_posting_id", "=", OTHERS_ONLY).execute()
    await database.db.deleteFrom("candidate_posting").where("candidate_id", "=", otherId).where("job_posting_id", "=", SHARED).execute()
    await insertCandidatePosting(database.db, otherId, SHARED, { status: "ranked", evaluatedAt: AT })
    await strongMatch(otherId, SHARED, 9)

    // 100% makes every one of the other Candidate's ranked postings a weak Match.
    await asOther(() => app.get(JobCriteriaService).save({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 100, frameworks: [], technologies: [] }))

    expect(await stateOf(otherId, SHARED)).toEqual({ status: "skipped", skip_reason: "weak_core_match" })
    expect(await stateOf(otherId, OTHERS_ONLY)).toEqual({ status: "skipped", skip_reason: "weak_core_match" })
    expect(await stateOf(database.operatorId, SHARED)).toEqual({ status: "ranked", skip_reason: null })
    const detail = (await owner.get(`/v1/job-postings/${SHARED}`).expect(200)).body
    expect(detail).toMatchObject({ status: "ranked", rank: 1 })
  })

  it("the owner's Job criteria save leaves the other Candidate's skip in place", async () => {
    await owner.put(JOB_CRITERIA_PATH).send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 50, frameworks: [], technologies: [] }).expect(200)
    expect(await stateOf(otherId, SHARED)).toEqual({ status: "skipped", skip_reason: "weak_core_match" })
    expect(await stateOf(database.operatorId, SHARED)).toEqual({ status: "ranked", skip_reason: null })
  })

  it("an evaluator state change in one Candidate's scope never moves the other's row", async () => {
    const repository = app.get(DiscoveryRepository)
    await asOther(() => repository.markWaiting(SHARED))
    expect(await stateOf(otherId, SHARED)).toEqual({ status: "waiting_to_be_checked", skip_reason: "weak_core_match" })
    expect(await stateOf(database.operatorId, SHARED)).toEqual({ status: "ranked", skip_reason: null })
    expect(await asOther(() => repository.moveToChecking(SHARED, ["waiting_to_be_checked"], new Date()))).toBe(true)
    expect(await stateOf(database.operatorId, SHARED)).toEqual({ status: "ranked", skip_reason: null })
    await asOther(() => repository.markFailed(SHARED, "provider_error", AT))
    expect(await stateOf(database.operatorId, SHARED)).toEqual({ status: "ranked", skip_reason: null })
  })
})

/**
 * EPIC-0002 A1 exit proof (architecture r4 "A1: cursor", C30): a Job Postings
 * cursor is bound to the Candidate it was issued to. Another Candidate's
 * cursor is a 400 like any bad cursor, over HTTP and in the service.
 */
describe("cursor version 2 is bound to the Candidate (C30)", () => {
  const codec = new PostingCursorCodec(TEST_CLIENT_SECRET)
  const key = { kind: "newest", discoveredUs: String(AT.getTime() * 1000), id: SHARED } as const
  const bindingFor = (candidateId: string) => ({ tab: "all", families: [], foldedKeyword: null, candidateId, tierHash: TIER_HASH }) as const

  it("the owner's own cursor is accepted", async () => {
    await owner.get(`/v1/job-postings?tab=all&limit=1&cursor=${encodeURIComponent(codec.encode(bindingFor(database.operatorId), key))}`).expect(200)
  })

  it("another Candidate's cursor presented in the owner's session is 400 bad_request", async () => {
    const response = await owner.get(`/v1/job-postings?tab=all&limit=1&cursor=${encodeURIComponent(codec.encode(bindingFor(otherId), key))}`).expect(400)
    expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
  })

  it("the owner's issued cursor is refused in the other Candidate's scope", async () => {
    await insertCandidatePosting(database.db, database.operatorId, OTHERS_ONLY, { status: "ranked", evaluatedAt: AT })
    const issued = (await owner.get("/v1/job-postings?tab=all&limit=1").expect(200)).body as { nextCursor: string | null }
    expect(issued.nextCursor).toEqual(expect.any(String))
    const service = app.get(DiscoveryService)
    await expect(asOther(() => service.listPostings({ tab: "all", limit: 1, families: [], keyword: null, cursor: issued.nextCursor }))).rejects.toMatchObject({ code: "bad_request" })
  })
})
