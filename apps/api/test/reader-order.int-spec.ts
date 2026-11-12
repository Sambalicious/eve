import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { type JobPostingsResponse, jobPostingsResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { TenantDatabase } from "../src/db/tenant-database.js"
import { reclassifyOtherPostings } from "../src/db/migrations/0011-postings-paging-filter.js"
import type { RoleFamily } from "../src/discovery/rules/ranking.js"
import { foldForKeywords } from "../src/discovery/rules/rule-result.js"
import { SampleRepository } from "../src/submission/sample.repository.js"
import { SampleService } from "../src/submission/sample.service.js"
import { SubmissionRepository } from "../src/submission/submission.repository.js"
import { SubmissionService, type SubmitOutcome } from "../src/submission/submission.service.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor, targetEveryFamily } from "./support/candidate-posting.js"

/**
 * Slice 8d (8d.16, 8d.17, CR8-02; RF-27 to RF-31): the three readers of the
 * ranking agree. The Ranked tab (`GET /v1/job-postings?tab=ranked`, SQL), the
 * daily submission queue (`SubmissionService.runDaily`, `rankPostings`) and the
 * Activation Gate sample queue (`SampleService.prepare`, `rankPostings` plus
 * one per company) must give one order. Submission is recorded, not executed:
 * `submit` is replaced by a recorder, so no browser and no network is used.
 * Real api app, real Postgres.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
const clock = new TestClock("2026-10-21T09:00:00.000Z")

type Seed = Readonly<{
  title: string
  company: string
  family: RoleFamily
  covered: number
  origin: "employer_board" | "remote_board"
  discoveredAt: Date
  /** Fixed ids for the fully tied pair, so posting-id order and application-id order disagree on every run. */
  postingId?: string
  applicationId?: string
}>

/** Posting id to its Application id, for the postings seeded by the current test. */
const applicationOf = new Map<string, string>()
const postingOf = new Map<string, string>()

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  vi.restoreAllMocks()
  // EPIC-0006: this spec is about order and tenancy, not visibility; every family is a target (support/candidate-posting.ts).
  await targetEveryFamily(database.db, database.operatorId)
  applicationOf.clear()
  postingOf.clear()
  for (const table of ["notification_outbox", "submission_event", "application_form_read", "tailored_document", "application", "candidate_posting", "job_posting", "career_profile_version"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: "[]", created_at: new Date(), approved_at: new Date() })
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

/** An eligible, strong-Match, ranked, automatic posting with a documents-ready Application. */
async function seed(input: Seed): Promise<string> {
  const id = input.postingId ?? randomUUID()
  const url = `https://boards.greenhouse.io/${input.company.toLowerCase().replace(/\W+/g, "")}/jobs/${id}`
  await insertPostingFor(database.db, database.operatorId, {
      id,
      application_url: url,
      requisition_id: id,
      apply_url: url,
      application_system: "greenhouse",
      apply_mode: "automatic",
      origin: input.origin,
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      title: input.title,
      title_folded: foldForKeywords(input.title),
      company: input.company,
      posting_text: "Remote.",
      status: "ranked",
      skip_reason: null,
      skip_detail: null,
      evaluation_failure: null,
      role_family: input.family,
      discovered_at: input.discoveredAt,
      evaluated_at: input.discoveredAt,
    })
  await database.db
    .insertInto("eligibility_result")
    .values({ candidate_id: database.operatorId, job_posting_id: id, arrangement: "remote", relocation_country: null, employment_type: "direct", rules: "[]", eligible: true, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: input.discoveredAt })
    .execute()
  await database.db
    .insertInto("match_evidence")
    .values({ candidate_id: database.operatorId, job_posting_id: id, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: input.covered, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: input.discoveredAt, criteria_version: 1 })
    .execute()
  const applicationId = input.applicationId ?? randomUUID()
  await database.db
    .insertInto("application")
    .values({ candidate_id: database.operatorId, id: applicationId, job_posting_id: id, application_url: url, requisition_id: id, company: input.company, role_title: input.title, state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date() })
    .execute()
  applicationOf.set(id, applicationId)
  postingOf.set(applicationId, id)
  return id
}

const at = (minute: number, ms = 0) => new Date(Date.UTC(2026, 9, 1, 8, minute, 0, ms))

/**
 * 14 postings over six families, both origins, 4 pairs of tied coverage (one
 * pair also tied on origin and discovery time, so the posting id decides) and
 * sub-second discovery times.
 */
const FOURTEEN: readonly Seed[] = [
  { title: "Senior Frontend Engineer", company: "Acme", family: "senior_frontend", covered: 9, origin: "remote_board", discoveredAt: at(1) },
  { title: "Senior React Engineer", company: "Hooli", family: "senior_frontend", covered: 9, origin: "employer_board", discoveredAt: at(2) },
  // Tied on tier, coverage, origin and discovery time: only the id decides. Posting ids sort Initech first, application ids Umbrella first.
  { title: "Fullstack Engineer", company: "Initech", family: "fullstack", covered: 8, origin: "employer_board", discoveredAt: at(3, 250), postingId: "00000000-0000-4000-8000-00000000000a", applicationId: "ffffffff-0000-4000-8000-0000000000ff" },
  { title: "Fullstack Developer", company: "Umbrella", family: "fullstack", covered: 8, origin: "employer_board", discoveredAt: at(3, 250), postingId: "00000000-0000-4000-8000-00000000000b", applicationId: "11111111-0000-4000-8000-000000000001" },
  { title: "Senior Backend Engineer", company: "Stark", family: "backend", covered: 10, origin: "employer_board", discoveredAt: at(4) },
  { title: "Backend Developer", company: "Wayne", family: "backend", covered: 7, origin: "remote_board", discoveredAt: at(5) },
  { title: "iOS Engineer", company: "Wonka", family: "mobile", covered: 7, origin: "employer_board", discoveredAt: at(6) },
  { title: "Flutter Developer", company: "Cyberdyne", family: "mobile", covered: 6, origin: "remote_board", discoveredAt: at(7) },
  { title: "Site Reliability Engineer", company: "Tyrell", family: "devops_platform", covered: 6, origin: "remote_board", discoveredAt: at(8) },
  { title: "DevOps Engineer", company: "Soylent", family: "devops_platform", covered: 9, origin: "employer_board", discoveredAt: at(9) },
  { title: "Software Engineer", company: "Oscorp", family: "other", covered: 10, origin: "employer_board", discoveredAt: at(10) },
  { title: "Data Engineer", company: "Massive", family: "other", covered: 5, origin: "remote_board", discoveredAt: at(11, 999) },
  { title: "Frontend Engineer", company: "Vandelay", family: "senior_frontend", covered: 7, origin: "remote_board", discoveredAt: at(12) },
  { title: "Product Engineer", company: "Pied Piper", family: "fullstack", covered: 9, origin: "remote_board", discoveredAt: at(13) },
]

async function list(query: string): Promise<JobPostingsResponse> {
  return jobPostingsResponseSchema.parse((await candidate.get(`/v1/job-postings?${query}`).expect(200)).body)
}

/** The Ranked tab order: limit 5, following nextCursor to the end. */
async function rankedTabOrder(): Promise<string[]> {
  const order: string[] = []
  let page = await list("tab=ranked&limit=5")
  order.push(...page.postings.map((posting) => posting.id))
  while (page.nextCursor) {
    page = await list(`tab=ranked&limit=5&cursor=${encodeURIComponent(page.nextCursor)}`)
    order.push(...page.postings.map((posting) => posting.id))
  }
  return order
}

/** PF-57: assorted list requests with tabs, families, keywords and cursors. */
async function assortedListRequests(): Promise<void> {
  await list("tab=all&families=backend")
  await list("tab=skipped&keyword=engineer")
  await list("tab=ranked&families=mobile,other&keyword=e")
  const first = await list("tab=ranked&limit=3&keyword=engineer")
  if (first.nextCursor) await list(`tab=ranked&limit=3&keyword=engineer&cursor=${encodeURIComponent(first.nextCursor)}`)
  const all = await list("tab=all&limit=4")
  if (all.nextCursor) await list(`tab=all&limit=4&cursor=${encodeURIComponent(all.nextCursor)}`)
}

/** Posting ids in the order SampleService.prepare picks them (the ids handed to markAwaiting). */
async function sampleQueue(before: () => Promise<void> = async () => undefined): Promise<string[]> {
  await before()
  const repository = app.get(SampleRepository)
  const picked: string[] = []
  const original = repository.markAwaiting.bind(repository)
  const spy = vi.spyOn(repository, "markAwaiting").mockImplementation(async (trx, ids, when) => {
    picked.push(...ids)
    return original(trx, ids, when)
  })
  try {
    await app.get(TenantDatabase).asOperator(() => app.get(SampleService).prepare())
  } finally {
    spy.mockRestore()
  }
  return picked.map((applicationId) => postingOf.get(applicationId)!)
}

/**
 * Posting ids in the order SubmissionService.runDaily attempts them. Each
 * attempt is recorded and refused as not ready, so nothing is executed and the
 * run goes on to the next one. `between` runs before each recorded attempt.
 */
async function submissionQueue(between: () => Promise<void> = async () => undefined): Promise<string[]> {
  await database.db.updateTable("application").set({ sample_state: null, submission_state: "queued", submission_kind: "automatic" }).execute()
  await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true }).execute()
  const service = asOperator(app, app.get(SubmissionService))
  const attempted: string[] = []
  const spy = vi.spyOn(service, "submit").mockImplementation(async (applicationId, kind): Promise<SubmitOutcome> => {
    expect(kind).toBe("automatic")
    await between()
    attempted.push(applicationId)
    return { result: "refused", refusal: "not_ready" }
  })
  try {
    expect(await service.runDaily()).toEqual({ submitted: 0, carriedOver: 0, stoppedBy: null })
  } finally {
    spy.mockRestore()
  }
  return attempted.map((applicationId) => postingOf.get(applicationId)!)
}

/** The Ranked order with each posting whose company already has a sample dropped, first `needed`. */
async function rankedTopUnderOnePerCompany(ranked: readonly string[], needed = 5): Promise<string[]> {
  const rows = await database.db.selectFrom("job_posting").select(["id", "company"]).execute()
  const company = new Map(rows.map((row) => [row.id, (row.company ?? "").trim().toLowerCase()]))
  const seen = new Set<string>()
  const picked: string[] = []
  for (const id of ranked) {
    if (picked.length === needed) break
    const name = company.get(id)!
    if (seen.has(name)) continue
    seen.add(name)
    picked.push(id)
  }
  return picked
}

/** Seeds the fourteen and makes Ranked ranks 2 and 3 the same company, "Globex" (company never changes the rank). */
async function seedFourteen(overrides: Partial<Record<number, Partial<Seed>>> = {}): Promise<void> {
  for (const [index, posting] of FOURTEEN.entries()) await seed({ ...posting, ...overrides[index] })
  const ranked = await rankedTabOrder()
  for (const id of [ranked[1]!, ranked[2]!]) {
    await database.db.updateTable("job_posting").set({ company: "Globex" }).where("id", "=", id).execute()
    await database.db.updateTable("application").set({ company: "Globex" }).where("job_posting_id", "=", id).execute()
  }
}

describe("the three readers of the ranking agree (8d.16, 8d.17)", () => {
  it("RF-27: the daily submission run attempts postings in exactly the Ranked tab order", async () => {
    await seedFourteen()
    const ranked = await rankedTabOrder()
    expect(ranked).toHaveLength(14)
    expect(await submissionQueue()).toEqual(ranked)
  })

  it("RF-28: the sample queue picks the Ranked top 5 under its one-per-company rule, in Ranked order", async () => {
    await seedFourteen()
    const ranked = await rankedTabOrder()
    const expected = await rankedTopUnderOnePerCompany(ranked)
    expect(expected).not.toContain(ranked[2])
    expect(expected).toEqual([ranked[0], ranked[1], ranked[3], ranked[4], ranked[5]])
    expect(await sampleQueue()).toEqual(expected)
  })

  it.each([
    ["no list request between submissions", false],
    ["assorted list requests before each submission (PF-57)", true],
  ] as const)("RF-29: readers agree with %s", async (_label, withRequests) => {
    await seedFourteen()
    const ranked = await rankedTabOrder()
    const between = withRequests ? assortedListRequests : undefined
    expect(await sampleQueue(between)).toEqual(await rankedTopUnderOnePerCompany(ranked))
    expect(await submissionQueue(between)).toEqual(ranked)
    expect(await rankedTabOrder()).toEqual(ranked)
  })

  it("RF-29: readers agree after the reclassification relabels other rows (RF-22)", async () => {
    // Four of the fourteen stored as "other" under these titles.
    await seedFourteen({
      4: { title: "Senior Backend Engineer", family: "other" },
      7: { title: "Flutter Developer", family: "other" },
      9: { title: "DevOps Engineer", family: "other" },
      10: { title: "Software Engineer", family: "other" },
    })
    expect(await reclassifyOtherPostings(database.db as never)).toBe(3)
    const families = await database.db.selectFrom("job_posting").select(["title", "role_family"]).where("title", "in", ["Senior Backend Engineer", "Flutter Developer", "DevOps Engineer", "Software Engineer"]).orderBy("title").execute()
    expect(families).toEqual([
      { title: "DevOps Engineer", role_family: "devops_platform" },
      { title: "Flutter Developer", role_family: "mobile" },
      { title: "Senior Backend Engineer", role_family: "backend" },
      { title: "Software Engineer", role_family: "other" },
    ])
    const ranked = await rankedTabOrder()
    expect(await sampleQueue()).toEqual(await rankedTopUnderOnePerCompany(ranked))
    expect(await submissionQueue()).toEqual(ranked)
  })

  it("RF-30: a backend, a mobile and a DevOps and platform posting hold the same place in all three readers (RF-11)", async () => {
    const hooli = await seed({ title: "Fullstack Engineer", company: "Hooli", family: "fullstack", covered: 7, origin: "employer_board", discoveredAt: at(4) })
    const acme = await seed({ title: "Senior Backend Engineer", company: "Acme", family: "backend", covered: 10, origin: "employer_board", discoveredAt: at(1) })
    const globex = await seed({ title: "iOS Engineer", company: "Globex", family: "mobile", covered: 9, origin: "employer_board", discoveredAt: at(2) })
    const initech = await seed({ title: "SRE", company: "Initech", family: "devops_platform", covered: 8, origin: "employer_board", discoveredAt: at(3) })
    const expected = [hooli, acme, globex, initech]
    expect(await rankedTabOrder()).toEqual(expected)
    expect(await sampleQueue()).toEqual(expected)
    expect(await submissionQueue()).toEqual(expected)
  })

  it("RF-31: changing one reader's tier for backend makes the readers disagree, so these tests catch it", async () => {
    await seedFourteen()
    const ranked = await rankedTabOrder()
    // The submission queue alone sees backend at tier 0 (as senior_frontend): the tier of backend changed for that reader only.
    const repository = app.get(SubmissionRepository)
    const original = repository.queuedForRanking.bind(repository)
    vi.spyOn(repository, "queuedForRanking").mockImplementation(async () => {
      const { rows, tiers } = await original()
      return { tiers, rows: rows.map((row) => (row.role_family === "backend" ? { ...row, role_family: "senior_frontend" } : row)) }
    })
    const broken = await submissionQueue()
    expect(broken).toHaveLength(ranked.length)
    expect(broken).not.toEqual(ranked)
  })
})
