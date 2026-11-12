import type { INestApplication } from "@nestjs/common"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DiscoveryPipeline } from "../src/discovery/discovery-pipeline.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { preFilter } from "../src/discovery/pre-filters.js"
import { insertCandidatePosting } from "./support/candidate-posting.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { FIXTURE_POSTED_MS } from "./support/posted-date-fixture.js"

/**
 * EPIC-0002 A1, AC 5.17 (architecture r4 "Shared pre-filter", "Migration of
 * the owner" step 5; job-postings-per-candidate.feature :297, :306, :312).
 * The pre-filter runs once, when the shared `job_posting` is first stored, and
 * its skip is kept on `job_posting.prefilter_skip`. A Candidate who first sees
 * a stored posting later gets that skip copied into their `candidate_posting`:
 * the pre-filter does not run again, and no AI call or spend reservation is made.
 *
 * The spy wraps the real classifier, so the results are unchanged; it only counts calls.
 */
vi.mock("../src/discovery/pre-filters.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/discovery/pre-filters.js")>()
  return { ...actual, preFilter: vi.fn(actual.preFilter) }
})
const preFilterSpy = vi.mocked(preFilter)

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let kofiId: string
let wanjiruId: string
const clock = new TestClock("2026-11-05T09:00:00.000Z")

const SALES_URL = "https://jobs.lever.co/globex/sales-emea"
const CSE_URL = "https://jobs.lever.co/globex/cse-1"
const FIELD_URL = "https://jobs.lever.co/globex/field-1"
const FRONTEND_URL = "https://jobs.lever.co/globex/frontend-1"

function leverPosting(slug: string, url: string, title: string) {
  return http.get(`https://api.lever.co/v0/postings/globex/${slug}`, () => HttpResponse.json({ id: slug, text: title, hostedUrl: url, createdAt: FIXTURE_POSTED_MS, descriptionPlain: "Remote." }))
}

/** A stored shared posting, as an earlier discovery left it, held by Kofi. */
async function storedPosting(url: string, slug: string, title: string, prefilterSkip: "not_software_role" | null): Promise<string> {
  const id = crypto.randomUUID()
  const at = new Date("2026-11-02T08:00:00.000Z")
  await database.db
    .insertInto("job_posting")
    .values({ id, application_url: url, requisition_id: slug, apply_url: url, application_system: "lever", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title, company: "Globex", posting_text: "Remote.", role_family: null, discovered_at: at, prefilter_skip: prefilterSkip })
    .execute()
  await insertCandidatePosting(database.db, kofiId, id, prefilterSkip === null ? { status: "checking", evaluatedAt: null } : { status: "skipped", skipReason: prefilterSkip })
  return id
}

const asCandidate = <T>(candidateId: string, work: () => Promise<T>) => CandidateScope.run(candidateId, work)

async function pasteAs(candidateId: string, url: string) {
  const response = await asCandidate(candidateId, () => app.get(DiscoveryService).pasteLink(url))
  await app.get(DiscoveryService).settled()
  return response
}

async function stateOf(candidateId: string, jobPostingId: string) {
  return database.db.selectFrom("candidate_posting").select(["status", "skip_reason", "skip_detail"]).where("candidate_id", "=", candidateId).where("job_posting_id", "=", jobPostingId).executeTakeFirst()
}

async function expectNoAiOrSpend(): Promise<void> {
  expect(anthropic.requests).toHaveLength(0)
  expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
  expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  kofiId = database.operatorId
  wanjiruId = await insertSecondCandidate(database.db, "wanjiru.invitee@example.test")
  await database.db.insertInto("job_criteria").values({ candidate_id: wanjiruId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
})

beforeEach(async () => {
  await app.get(DiscoveryService).settled()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  outbound.reset()
  for (const table of ["ai_call", "spend_entry", "match_evidence", "eligibility_result", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  preFilterSpy.mockClear()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("the shared pre-filter skip (AC 5.17)", () => {
  it(":297 the pre-filter runs exactly once for a posting both Candidates see, and both get its skip", async () => {
    google.server.use(leverPosting("sales-emea", SALES_URL, "Senior Sales Engineer, EMEA"))
    const kofi = await pasteAs(kofiId, SALES_URL)
    expect(preFilterSpy).toHaveBeenCalledTimes(1)
    const wanjiru = await pasteAs(wanjiruId, SALES_URL)
    expect(wanjiru.posting.id).toBe(kofi.posting.id)
    expect(preFilterSpy).toHaveBeenCalledTimes(1)

    const shared = await database.db.selectFrom("job_posting").select(["prefilter_skip"]).where("id", "=", kofi.posting.id).executeTakeFirstOrThrow()
    expect(shared.prefilter_skip).toBe("not_software_role")
    for (const id of [kofiId, wanjiruId]) expect(await stateOf(id, kofi.posting.id)).toEqual({ status: "skipped", skip_reason: "not_software_role", skip_detail: null })
    expect(wanjiru.posting).toMatchObject({ status: "skipped", skipReason: "not_software_role" })
    await expectNoAiOrSpend()
  })

  it(":306 a Candidate who first sees a pre-filtered posting later gets the stored skip, with no pre-filter, AI call or spend", async () => {
    const id = await storedPosting(CSE_URL, "cse-1", "Customer Success Engineer", "not_software_role")
    google.server.use(leverPosting("cse-1", CSE_URL, "Customer Success Engineer"))
    const wanjiru = await pasteAs(wanjiruId, CSE_URL)
    expect(wanjiru.posting.id).toBe(id)
    expect(await stateOf(wanjiruId, id)).toEqual({ status: "skipped", skip_reason: "not_software_role", skip_detail: null })
    expect(preFilterSpy).not.toHaveBeenCalled()
    await expectNoAiOrSpend()
  })

  it(":306 the stored skip is copied, not recomputed: a title today's classifier would pass stays skipped", async () => {
    // The stored fact is authoritative (CR8-03): a classifier change after the first store does not split the Candidates.
    const id = await storedPosting(FRONTEND_URL, "frontend-1", "Senior Frontend Engineer", "not_software_role")
    expect(preFilter({ title: "Senior Frontend Engineer" })).toEqual({ pass: true })
    preFilterSpy.mockClear()
    google.server.use(leverPosting("frontend-1", FRONTEND_URL, "Senior Frontend Engineer"))
    await pasteAs(wanjiruId, FRONTEND_URL)
    expect(await stateOf(wanjiruId, id)).toEqual({ status: "skipped", skip_reason: "not_software_role", skip_detail: null })
    expect(preFilterSpy).not.toHaveBeenCalled()
    await expectNoAiOrSpend()
  })

  it("a stored posting the pre-filter passed is not pre-filtered again for a later Candidate, and waits for evaluation (EPIC-0002 D13: not skipped)", async () => {
    const id = await storedPosting(SALES_URL, "sales-emea", "Senior Sales Engineer, EMEA", null)
    google.server.use(leverPosting("sales-emea", SALES_URL, "Senior Sales Engineer, EMEA"))
    const stored = await asCandidate(wanjiruId, () => app.get(DiscoveryPipeline).ingestPastedLink(SALES_URL))
    // Wanjiru is an invitee: before EPIC-0002 slice D her row waits instead of being evaluated (EPIC-0007 P1-B-01).
    expect(stored).toEqual({ id, created: true, evaluate: false })
    expect(await stateOf(wanjiruId, id)).toEqual({ status: "waiting_to_be_checked", skip_reason: null, skip_detail: null })
    expect(preFilterSpy).not.toHaveBeenCalled()
  })

  it("a posting not yet stored is pre-filtered once and its skip is kept on the shared row", async () => {
    google.server.use(leverPosting("sales-emea", SALES_URL, "Senior Sales Engineer, EMEA"))
    const stored = await asCandidate(kofiId, () => app.get(DiscoveryPipeline).ingestPastedLink(SALES_URL))
    expect(stored).toMatchObject({ created: true, evaluate: false })
    expect(preFilterSpy).toHaveBeenCalledTimes(1)
    expect(preFilterSpy).toHaveBeenCalledWith({ title: "Senior Sales Engineer, EMEA" })
    const shared = await database.db.selectFrom("job_posting").select(["prefilter_skip"]).where("id", "=", stored.id).executeTakeFirstOrThrow()
    expect(shared.prefilter_skip).toBe("not_software_role")
  })

  it(":312 a pasted pre-filtered title is skipped for the Candidate who pasted it, and no other Candidate holds it", async () => {
    google.server.use(leverPosting("field-1", FIELD_URL, "Field Engineer"))
    const kofi = await pasteAs(kofiId, FIELD_URL)
    expect(await stateOf(kofiId, kofi.posting.id)).toEqual({ status: "skipped", skip_reason: "not_software_role", skip_detail: null })
    expect(await stateOf(wanjiruId, kofi.posting.id)).toBeUndefined()
    expect(preFilterSpy).toHaveBeenCalledTimes(1)
    await expectNoAiOrSpend()
  })

  it("the Operator's scope still reaches the pipeline as before (owner is the first Candidate)", async () => {
    google.server.use(leverPosting("field-1", FIELD_URL, "Field Engineer"))
    const stored = await app.get(TenantDatabase).asOperator(() => app.get(DiscoveryPipeline).ingestPastedLink(FIELD_URL))
    expect(stored).toMatchObject({ created: true, evaluate: false })
    expect(await stateOf(kofiId, stored.id)).toEqual({ status: "skipped", skip_reason: "not_software_role", skip_detail: null })
  })
})
