import { randomUUID } from "node:crypto"

import { type INestApplication, Logger } from "@nestjs/common"
import { type JobPostingsResponse, jobPostingSummarySchema, jobPostingsResponseSchema, keywordFoldsToEmpty } from "@eve/contracts"
import { roleFamilySchema as ROLE_FAMILIES_V18 } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { reclassifyOtherPostings } from "../src/db/migrations/0011-postings-paging-filter.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DiscoveryRepository } from "../src/discovery/discovery.repository.js"
import { PostingCursorCodec, TIER_HASH } from "../src/discovery/posting-cursor.js"
import { type RoleFamily, rankPostings } from "../src/discovery/rules/ranking.js"
import { foldForKeywords } from "../src/discovery/rules/rule-result.js"
import { EMPTY_STRUCTURED } from "../src/discovery/sources/discovered-posting.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { holdAllPostings, insertPostingFor, postingsOf, setStateWhere, targetEveryFamily, everyFamilyContext, visibleFilter } from "./support/candidate-posting.js"

/**
 * Slice 8: GET /v1/job-postings paging, the Posting filter, global ranks and
 * the stored-posting reclassification (postings-paging-and-filter.feature,
 * role-family-classification.feature). Real api on Fastify, real Postgres.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
const clock = new TestClock("2026-10-21T09:00:00.000Z")

type Status = "checking" | "waiting_to_be_checked" | "ranked" | "excluded" | "skipped" | "evaluation_failed"
type Seed = Partial<{
  id: string
  title: string | null
  company: string
  status: Status
  family: RoleFamily | null
  covered: number
  total: number
  origin: "employer_board" | "remote_board" | "pasted_link"
  discoveredAt: Date
  postingText: string
  skipReason: string | null
}>

const BASE = Date.parse("2026-10-01T08:00:00.000Z")
let sequence = 0

async function seed(input: Seed = {}): Promise<string> {
  sequence += 1
  const id = input.id ?? randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${id}`
  const status = input.status ?? "ranked"
  const title = input.title === undefined ? `Senior Frontend Engineer ${sequence}` : input.title
  await insertPostingFor(database.db, database.operatorId, {
      id,
      application_url: url,
      requisition_id: id,
      apply_url: url,
      application_system: "Greenhouse",
      apply_mode: "automatic",
      origin: input.origin ?? "employer_board",
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      title,
      title_folded: title === null || title.trim() === "" ? null : foldForKeywords(title),
      company: input.company ?? "Acme",
      posting_text: input.postingText ?? "Remote.",
      status,
      skip_reason: input.skipReason ?? (status === "skipped" ? "weak_core_match" : status === "excluded" ? "violated_rule" : null),
      skip_detail: null,
      evaluation_failure: status === "evaluation_failed" ? "provider_error" : null,
      // EPIC-0006 (AC-1.8): a titled posting has its store-time family whatever its status, so an unevaluated row is
      // no longer family-null (that would be off-target, AC-1.7). Untitled rows stay null; a test's explicit family wins.
      role_family: input.family === undefined ? (title === null || title.trim() === "" ? null : "senior_frontend") : input.family,
      discovered_at: input.discoveredAt ?? new Date(BASE + sequence * 60_000),
      evaluated_at: null,
    },
    // The slice 8 family tests name every family, null included (0011 reclassification inputs).
    { keepFamily: true })
  if (input.total !== undefined || status === "ranked") {
    const total = input.total ?? 10
    await database.db
      .insertInto("match_evidence")
      .values({ candidate_id: database.operatorId, job_posting_id: id, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: input.covered ?? total, total_count: total, threshold: "0.700", items: "[]", evaluated_at: new Date(BASE), criteria_version: 1 })
      .execute()
  }
  return id
}

async function list(query: string, status = 200): Promise<JobPostingsResponse> {
  const response = await candidate.get(`/v1/job-postings${query === "" ? "" : `?${query}`}`).expect(status)
  return status === 200 ? jobPostingsResponseSchema.parse(response.body) : response.body
}

/** Follows nextCursor to the end; returns every page. */
async function follow(base: string): Promise<JobPostingsResponse[]> {
  const pages = [await list(base)]
  for (let guard = 0; pages.at(-1)?.nextCursor && guard < 10_000; guard++) {
    pages.push(await list(`${base}&cursor=${encodeURIComponent(pages.at(-1)!.nextCursor!)}`))
  }
  return pages
}
const ids = (pages: JobPostingsResponse[]) => pages.flatMap((page) => page.postings.map((posting) => posting.id))

/** The rankPostings order over the stored ranked rows: the reference for every SQL order test. */
async function referenceRankedOrder(): Promise<string[]> {
  const rows = await postingsOf(database.db, database.operatorId)
    .leftJoin("match_evidence", "match_evidence.job_posting_id", "job_posting.id")
    .select(["job_posting.id", "job_posting.role_family", "job_posting.discovered_at", "job_posting.origin", "match_evidence.covered_count", "match_evidence.total_count", "job_posting.title_folded", "job_posting.prefilter_skip", "job_posting.seniority_marker", "job_posting.posted_at"])
    .where("job_posting.status", "=", "ranked")
    .execute()
  // EPIC-0006: the list holds visible rows only.
  return rankPostings(
    rows.filter(visibleFilter(everyFamilyContext(clock.now()))).map((row) => ({
      id: row.id,
      family: (row.role_family ?? "other") as RoleFamily,
      coverage: row.total_count ? (row.covered_count ?? 0) / row.total_count : 0,
      discoveredAt: row.discovered_at,
      fromEmployerBoard: row.origin === "employer_board",
    }))
  )
}

async function referenceNewestOrder(statuses: Status[] | null): Promise<string[]> {
  let query = postingsOf(database.db, database.operatorId).select(["id", sql<string>`(extract(epoch from discovered_at) * 1000000)::bigint::text`.as("us"), "title_folded", "prefilter_skip", "role_family", "seniority_marker", "posted_at"])
  if (statuses) query = query.where("status", "in", statuses)
  const rows = (await query.execute()).filter(visibleFilter(everyFamilyContext(clock.now())))
  return rows.sort((a, b) => (BigInt(b.us) > BigInt(a.us) ? 1 : BigInt(b.us) < BigInt(a.us) ? -1 : a.id.localeCompare(b.id))).map((row) => row.id)
}

/** Deterministic pseudo-random numbers. */
function rng(seedValue: number) {
  let state = seedValue
  return (n: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state % n
  }
}

const FAMILIES: RoleFamily[] = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "backend", "mobile", "devops_platform", "people_management", "other"]
const STATUSES: Status[] = ["checking", "waiting_to_be_checked", "ranked", "excluded", "skipped", "evaluation_failed"]
const TITLES = ["Senior React Engineer", "Backend Engineer", "Cloud Engineer", "Flutter Developer", "Lead Engineer, React Platform", "Développeur Frontend", "100% Remote Engineer", null, ""]

/** A mixed data set with ties on every sort column, zero totals, null families and microsecond timestamps. */
async function seedMixed(count: number, seedValue = 1): Promise<void> {
  const next = rng(seedValue)
  for (let index = 0; index < count; index++) {
    const status = STATUSES[next(STATUSES.length)]!
    const total = next(4) === 0 ? 0 : 1 + next(5)
    await seed({
      status,
      title: TITLES[next(TITLES.length)]!,
      family: next(6) === 0 ? null : FAMILIES[next(FAMILIES.length)]!,
      covered: total === 0 ? 0 : next(total + 1),
      total,
      origin: (["employer_board", "remote_board", "pasted_link"] as const)[next(3)],
      // Few distinct instants (ties), some sub-millisecond apart.
      discoveredAt: new Date(BASE + next(6) * 60_000 + next(3)),
    })
    if (next(5) === 0) await sql`update job_posting set discovered_at = discovered_at + interval '1 microsecond' * ${1 + next(900)} where id = (select id from job_posting order by random() limit 1)`.execute(database.db)
  }
}

/** Direct pipeline, evaluator and repository calls run in the owner's (Operator's) scope, as the worker and the session give it. */
const asOwner = <T>(work: () => Promise<T>) => app.get(TenantDatabase).asOperator(work)

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
  sequence = 0
  // EPIC-0006: this spec is about order and tenancy, not visibility; every family is a target (support/candidate-posting.ts).
  await targetEveryFamily(database.db, database.operatorId)
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("paging (8P.1 to 8P.6)", () => {
  it("PF-01, PF-02, PF-05: 60 postings page as 25, 25, 10 with an exact, stable total", async () => {
    for (let index = 0; index < 60; index++) await seed({ status: STATUSES[index % STATUSES.length] })
    const first = await list("tab=all")
    expect(first.postings).toHaveLength(25)
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(first.totalCount).toBe(60)
    const pages = await follow("tab=all&limit=25")
    expect(pages.map((page) => page.postings.length)).toEqual([25, 25, 10])
    expect(pages.map((page) => page.totalCount)).toEqual([60, 60, 60])
    expect(pages[2]!.nextCursor).toBeNull()
  })

  it("PF-03, PF-04: one page or exactly one full page has a null cursor", async () => {
    for (let index = 0; index < 7; index++) await seed()
    expect(await list("tab=ranked&limit=25")).toMatchObject({ nextCursor: null, totalCount: 7 })
    for (let index = 0; index < 18; index++) await seed()
    const full = await list("tab=ranked&limit=25")
    expect(full.postings).toHaveLength(25)
    expect(full.nextCursor).toBeNull()
  })

  it("PF-06: totalCount is exact and uncapped (1,204)", async () => {
    // EPIC-0006: untitled and dated, so every row is visible.
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, structured, status, discovered_at, posted_at, posted_date_kind)
      select gen_random_uuid(), 'https://x.test/' || g, g::text, 'https://x.test/' || g, 'Greenhouse', 'automatic', 'employer_board', null, 'Co', '{}', 'skipped', now() - g * interval '1 second', ${clock.now()}::timestamptz, 'published'
      from generate_series(1, 1204) g`.execute(database.db)
    await holdAllPostings(database.db, database.operatorId)
    expect((await list("tab=all")).totalCount).toBe(1204)
  })

  it("PF-08, PF-09, PF-10: 600 postings; the oldest is rank 1; All reaches each once in 6 pages; Ranked ranks read 1 to 600", async () => {
    await seed({ title: "Frontend Tech Lead at Globex", family: "technical_lead", covered: 10, total: 10, discoveredAt: new Date(BASE - 3_600_000) })
    for (let index = 1; index < 600; index++) await seed({ family: index % 2 ? "fullstack" : "other", covered: 5, total: 10 })
    const ranked = await list("tab=ranked&limit=25")
    expect(ranked.postings[0]).toMatchObject({ title: "Frontend Tech Lead at Globex", rank: 1 })
    const all = await follow("tab=all&limit=100")
    expect(all).toHaveLength(6)
    expect(new Set(ids(all)).size).toBe(600)
    expect(ids(all)).toHaveLength(600)
    const rankedPages = await follow("tab=ranked&limit=25")
    expect(rankedPages.flatMap((page) => page.postings.map((posting) => posting.rank))).toEqual(Array.from({ length: 600 }, (_, index) => index + 1))
  })

  it("PF-11: the Ranked tab follows the Role Preference order across pages", async () => {
    const row = (label: string, family: RoleFamily, covered: number, origin: "employer_board" | "remote_board", day: number, id: string) =>
      seed({ title: label, family, covered, total: 10, origin, discoveredAt: new Date(`2026-10-0${day}T08:00:00Z`), id })
    await row("A", "fullstack", 10, "employer_board", 1, "00000000-0000-4000-8000-00000000000a")
    await row("B", "senior_frontend", 8, "remote_board", 2, "00000000-0000-4000-8000-00000000000b")
    await row("C", "technical_lead", 8, "employer_board", 3, "00000000-0000-4000-8000-00000000000c")
    await row("D", "senior_frontend", 9, "remote_board", 4, "00000000-0000-4000-8000-00000000000d")
    await row("E", "technical_lead", 8, "employer_board", 1, "00000000-0000-4000-8000-00000000000e")
    await row("F", "backend", 10, "employer_board", 1, "00000000-0000-4000-8000-00000000000f")
    await row("G", "technical_lead", 8, "employer_board", 1, "00000000-0000-4000-8000-000000000001")
    const pages = await follow("tab=ranked&limit=2")
    const postings = pages.flatMap((page) => page.postings)
    expect(postings.map((posting) => posting.title)).toEqual(["D", "G", "E", "C", "B", "A", "F"])
    expect(postings.map((posting) => posting.rank)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it.each([
    ["skipped", ["S3", "S2", "S1", "S4"]],
    ["all", ["R1", "S3", "S2", "S1", "S4"]],
  ])("PF-12: tab %s lists newest first, then id ascending", async (tab, order) => {
    await seed({ title: "S1", status: "skipped", discoveredAt: new Date("2026-10-20T08:00:00Z"), id: "00000000-0000-4000-8000-000000000002" })
    await seed({ title: "S2", status: "excluded", discoveredAt: new Date("2026-10-21T08:00:00Z"), id: "00000000-0000-4000-8000-000000000005" })
    await seed({ title: "S3", status: "skipped", discoveredAt: new Date("2026-10-21T08:00:00Z"), id: "00000000-0000-4000-8000-000000000003" })
    await seed({ title: "S4", status: "skipped", discoveredAt: new Date("2026-10-19T08:00:00Z"), id: "00000000-0000-4000-8000-000000000004" })
    await seed({ title: "R1", status: "ranked", discoveredAt: new Date("2026-10-22T08:00:00Z"), id: "00000000-0000-4000-8000-000000000001" })
    const pages = await follow(`tab=${tab}&limit=1`)
    expect(pages.flatMap((page) => page.postings.map((posting) => posting.title))).toEqual(order)
  })

  it("SQL Ranked order equals rankPostings on randomised data (ties, zero totals, null family, sub-millisecond times), and global ranks match", async () => {
    for (const seedValue of [3, 11, 29]) {
      await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
      await seedMixed(150, seedValue)
      const reference = await referenceRankedOrder()
      const pages = await follow("tab=ranked&limit=7")
      expect(ids(pages)).toEqual(reference)
      expect(pages.flatMap((page) => page.postings.map((posting) => posting.rank))).toEqual(reference.map((_, index) => index + 1))
      // Ranks on the All tab are the same global numbers.
      const all = (await follow("tab=all&limit=100")).flatMap((page) => page.postings)
      for (const posting of all) expect(posting.rank).toBe(posting.status === "ranked" ? reference.indexOf(posting.id) + 1 : null)
      // The submission readers use rankPostings directly; the Ranked tab equals it, so the list and submission agree.
    }
  })

  it.each([
    ["ranked", 1],
    ["ranked", 7],
    ["ranked", 100],
    ["skipped", 1],
    ["skipped", 25],
    ["all", 1],
    ["all", 26],
    ["all", 100],
  ] as const)("PF-13: tab %s with limit %i equals the one unpaged order", async (tab, limit) => {
    await seedMixed(230, 5)
    const expected = tab === "ranked" ? await referenceRankedOrder() : await referenceNewestOrder(tab === "skipped" ? ["excluded", "skipped"] : null)
    expect(ids(await follow(`tab=${tab}&limit=${limit}`))).toEqual(expected)
  })

  it("PF-14: stable data pages with no duplicate and no gap, for every limit 1 to 100 and each filter", async () => {
    await seedMixed(230, 9)
    const views = [
      "tab=ranked",
      "tab=skipped",
      "tab=all",
      "tab=ranked&families=technical_lead,fullstack&keyword=react",
      "tab=all&families=backend,mobile",
      "tab=skipped&keyword=engineer",
      "tab=all&families=devops_platform&keyword=cloud",
    ]
    for (const view of views) {
      const reference = ids(await follow(`${view}&limit=100`))
      const total = (await list(view)).totalCount
      expect(reference).toHaveLength(total)
      for (let limit = 1; limit <= 100; limit++) {
        const pages = await follow(`${view}&limit=${limit}`)
        expect(ids(pages), `${view} limit ${limit}`).toEqual(reference)
      }
    }
  }, 600_000)
})

describe("changing data between pages (8P.7, 8P.8)", () => {
  const ranked30 = async () => {
    const labels: string[] = []
    for (let index = 1; index <= 30; index++) {
      const label = `R${String(index).padStart(2, "0")}`
      // Descending coverage then discovery: R01 first.
      await seed({ title: label, family: "senior_frontend", covered: 100 - index * 2, total: 100, discoveredAt: new Date(BASE + index * 60_000) })
      labels.push(label)
    }
    return labels
  }
  const titles = (page: JobPostingsResponse) => page.postings.map((posting) => posting.title)

  it("PF-15, PF-16: a posting discovered after page 1 is not on later pages, the total grows, and a reload shows it first", async () => {
    for (let index = 0; index < 60; index++) await seed({ status: STATUSES[index % STATUSES.length] })
    const first = await list("tab=all&limit=25")
    await seed({ title: "Staff Frontend Engineer at Initech", status: "checking", discoveredAt: new Date(BASE + 10_000_000) })
    const second = await list(`tab=all&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    const third = await list(`tab=all&limit=25&cursor=${encodeURIComponent(second.nextCursor!)}`)
    const later = [...second.postings, ...third.postings].map((posting) => posting.title)
    expect(later).not.toContain("Staff Frontend Engineer at Initech")
    expect(new Set([...first.postings, ...second.postings, ...third.postings].map((posting) => posting.id)).size).toBe(60)
    expect(second.totalCount).toBe(61)
    expect((await list("tab=all&limit=25")).postings[0]?.title).toBe("Staff Frontend Engineer at Initech")
  })

  it("PF-17: on Skipped a newly skipped posting is not on page 2", async () => {
    for (let index = 0; index < 40; index++) await seed({ status: "skipped" })
    const first = await list("tab=skipped&limit=25")
    await seed({ title: "Sales Engineer at Acme", status: "skipped", skipReason: "not_software_role", family: null, discoveredAt: new Date(BASE + 10_000_000) })
    const second = await list(`tab=skipped&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.postings).toHaveLength(15)
    expect(titles(second)).not.toContain("Sales Engineer at Acme")
  })

  it("PF-18: a status change without a sort-key change appears once and is not skipped", async () => {
    const created: string[] = []
    for (let index = 0; index < 30; index++) created.push(await seed({ status: "skipped" }))
    // The 27th newest is index 3 (30 - 27).
    const target = created[3]!
    await database.db.updateTable("job_posting").set({ title: "Frontend Engineer at Umbrella", title_folded: foldForKeywords("Frontend Engineer at Umbrella") }).where("id", "=", target).execute()
    await setStateWhere(database.db, database.operatorId, { column: "id", value: target }, { status: "checking" })
    const first = await list("tab=all&limit=25")
    await database.db.updateTable("job_posting").set({ role_family: "senior_frontend" }).where("id", "=", target).execute()
    await setStateWhere(database.db, database.operatorId, { column: "id", value: target }, { status: "ranked" })
    const second = await list(`tab=all&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.postings).toHaveLength(5)
    expect(second.postings[1]?.id).toBe(target)
    expect(first.postings.map((posting) => posting.id)).not.toContain(target)
  })

  it("PF-19: a newly ranked posting sorting after the cursor appears in its place with its global rank", async () => {
    await ranked30()
    const first = await list("tab=ranked&limit=25")
    expect(titles(first)).toEqual(Array.from({ length: 25 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`))
    // Between R27 (coverage 46) and R28 (coverage 44).
    await seed({ title: "N", family: "senior_frontend", covered: 45, total: 100 })
    const second = await list(`tab=ranked&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(titles(second)).toEqual(["R26", "R27", "N", "R28", "R29", "R30"])
    expect(second.postings[2]?.rank).toBe(28)
  })

  it("PF-20: a posting leaving the tab is not returned by later pages", async () => {
    await ranked30()
    const first = await list("tab=ranked&limit=25")
    await setStateWhere(database.db, database.operatorId, { column: "title", value: "R28" }, { status: "skipped" })
    const second = await list(`tab=ranked&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(titles(second)).toEqual(["R26", "R27", "R29", "R30"])
  })

  it("PF-21: a posting starting to match the filter before the cursor is not on later pages", async () => {
    for (let index = 1; index <= 30; index++) {
      await seed({ title: `B${String(index).padStart(2, "0")}`, family: "backend", covered: 100 - index * 2, total: 100 })
    }
    const first = await list("tab=ranked&families=backend&limit=25")
    await seed({ title: "N", family: "backend", covered: 95, total: 100 })
    const second = await list(`tab=ranked&families=backend&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(titles(second)).toEqual(["B26", "B27", "B28", "B29", "B30"])
  })

  it("PF-22: a ranked posting arriving before the cursor shifts later ranks up by one, with no repeat", async () => {
    await ranked30()
    const first = await list("tab=ranked&limit=25")
    expect(first.postings.map((posting) => posting.rank)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1))
    await seed({ title: "N", family: "senior_frontend", covered: 95, total: 100 })
    const second = await list(`tab=ranked&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(titles(second)).toEqual(["R26", "R27", "R28", "R29", "R30"])
    expect(second.postings.map((posting) => posting.rank)).toEqual([27, 28, 29, 30, 31])
  })

  it("PF-23: a ranked posting leaving before the cursor shifts later ranks down by one", async () => {
    await ranked30()
    const first = await list("tab=ranked&limit=25")
    await setStateWhere(database.db, database.operatorId, { column: "title", value: "R02" }, { status: "skipped" })
    const second = await list(`tab=ranked&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(titles(second)).toEqual(["R26", "R27", "R28", "R29", "R30"])
    expect(second.postings.map((posting) => posting.rank)).toEqual([25, 26, 27, 28, 29])
  })

  it("PF-65 (automated form of the @manual race): pages served while postings are inserted concurrently never repeat or fail", async () => {
    for (let index = 0; index < 300; index++) await seed({ status: STATUSES[index % STATUSES.length] })
    const before = new Set((await database.db.selectFrom("job_posting").select("id").execute()).map((row) => row.id))
    const pages = [await list("tab=all&limit=25")]
    const inserted: string[] = []
    const writer = (async () => {
      for (let index = 0; index < 40; index++) inserted.push(await seed({ status: "checking", discoveredAt: new Date(BASE + 50_000_000 + index) }))
    })()
    while (pages.at(-1)!.nextCursor) pages.push(await list(`tab=all&limit=25&cursor=${encodeURIComponent(pages.at(-1)!.nextCursor!)}`))
    await writer
    const seen = ids(pages)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.filter((id) => before.has(id))).toHaveLength(300)
    expect(pages.slice(1).flatMap((page) => page.postings).some((posting) => inserted.includes(posting.id))).toBe(false)
  })
})

describe("cursor binding and tampering (8P.9, 8P.10)", () => {
  it.each([
    ["tab=ranked", "tab=all"],
    ["tab=all", "tab=skipped"],
    ["tab=ranked&families=senior_frontend", "tab=ranked&families=senior_frontend,mobile"],
    ["tab=ranked&families=senior_frontend", "tab=ranked"],
    ["tab=ranked", "tab=ranked&families=senior_frontend"],
    ["tab=all&keyword=react", "tab=all&keyword=vue"],
    ["tab=all&keyword=react", "tab=all"],
    ["tab=all", "tab=all&keyword=react"],
    ["tab=all&keyword=react", "tab=all&keyword=reac"],
  ])("PF-24: a cursor issued for %s is refused for %s", async (issued, used) => {
    for (let index = 0; index < 30; index++) {
      await seed({ title: "Senior React Engineer", status: "ranked" })
      await seed({ title: "Senior React Engineer", status: "skipped" })
    }
    const page = await list(`${issued}&limit=10`)
    const body = await list(`${used}&limit=10&cursor=${encodeURIComponent(page.nextCursor!)}`, 400)
    expect(body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
  })

  it.each(["families=backend,mobile", "families=mobile,backend", "families=backend,mobile,backend"])(
    "PF-25: a cursor is accepted with the same family set written another way (%s)",
    async (families) => {
      for (let index = 0; index < 30; index++) {
        await seed({ family: "backend", status: "skipped" })
        await seed({ family: "mobile", status: "skipped" })
      }
      const page = await list("tab=all&families=backend,mobile&limit=10")
      const next = await list(`tab=all&${families}&limit=10&cursor=${encodeURIComponent(page.nextCursor!)}`)
      expect(next.postings.every((posting) => posting.roleFamily === "backend" || posting.roleFamily === "mobile")).toBe(true)
      expect(next.postings).toHaveLength(10)
    }
  )

  it("PF-26: a cursor is accepted with the same keyword trimmed, in another case, or with accents (folded binding)", async () => {
    for (let index = 0; index < 60; index++) await seed({ title: "Senior React Engineer", status: "skipped" })
    const page = await list("tab=all&keyword=react")
    for (const keyword of ["%20%20react%20%20", "REACT", "R%C3%A9act"]) {
      await list(`tab=all&keyword=${keyword}&cursor=${encodeURIComponent(page.nextCursor!)}`)
    }
  })

  it("PF-27: the limit may change between pages", async () => {
    for (let index = 0; index < 60; index++) await seed({ status: "skipped" })
    const reference = ids(await follow("tab=all&limit=100"))
    const first = await list("tab=all&limit=10")
    const second = await list(`tab=all&limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.postings.map((posting) => posting.id)).toEqual(reference.slice(10, 35))
    expect(second.nextCursor).toEqual(expect.any(String))
  })

  it("PF-28, PF-29: any cursor the server did not issue is a 400 with no postings, never a 500", async () => {
    for (let index = 0; index < 40; index++) await seed({ status: "ranked" })
    for (let index = 0; index < 40; index++) await seed({ status: "skipped" })
    const issued = (await list("tab=ranked&limit=25")).nextCursor!
    const [payload] = issued.split(".") as [string, string]
    const forged = (k: unknown[]) => `${Buffer.from(JSON.stringify({ v: 2, b: JSON.parse(Buffer.from(payload, "base64url").toString()).b, k })).toString("base64url")}.${"A".repeat(43)}`
    const flip = (text: string, index: number) => text.slice(0, index) + (text[index] === "A" ? "B" : "A") + text.slice(index + 1)
    const bad = [
      "not-a-cursor",
      issued.slice(0, -4),
      flip(issued, Math.floor(issued.length / 2)),
      flip(issued, 0),
      "",
      "a".repeat(1025),
      issued + "x".repeat(1000),
      forged(["n", "1", randomUUID()]),
      forged(["r", 0, 1, 1, 1, "1", randomUUID()]),
      `${payload}.`,
      `.${issued.split(".")[1]}`,
      `${issued}.x`,
      "%%%%",
    ]
    // 50 single-character edits spread over the cursor.
    for (let edit = 0; edit < 50; edit++) bad.push(flip(issued, Math.floor((edit * issued.length) / 50)))
    for (const cursor of bad) {
      const response = await candidate.get(`/v1/job-postings?tab=ranked&cursor=${encodeURIComponent(cursor)}`)
      expect(response.status, cursor.slice(0, 40)).toBe(400)
      expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
    }
  })

  it("PF-63: without a session, a cursor gets 401 and no posting", async () => {
    for (let index = 0; index < 30; index++) await seed({ status: "skipped" })
    const cursor = (await list("tab=all&limit=10")).nextCursor!
    const response = await browser.http().get(`/v1/job-postings?tab=all&cursor=${encodeURIComponent(cursor)}`).expect(401)
    expect(response.body).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } })
  })

  it("PF-62: unauthenticated and expired sessions get 401 with no data", async () => {
    await seed()
    const query = "/v1/job-postings?tab=ranked&families=backend&keyword=react&limit=25"
    expect((await browser.http().get(query).expect(401)).body.error.code).toBe("unauthenticated")
    expect((await browser.http().get(query).set("cookie", "__Host-ja_session=gone").expect(401)).body.error.code).toBe("session_expired")
  })
})

describe("validation (8P.1, 8P.12, 8F.2, 8F.4)", () => {
  it.each(["0", "101", "-1", "-25", "2.5", "25.0", "ten", "1e2", "1000"])("PF-30: limit %s is a 400", async (limit) => {
    await list(`tab=all&limit=${limit}`, 400)
  })

  it.each([1, 2, 25, 99, 100])("PF-31: limit %i returns that many postings", async (limit) => {
    if (limit === 1) for (let index = 0; index < 150; index++) await seed({ status: "skipped" })
    else for (let index = 0; index < 150; index++) await seed({ status: "skipped" })
    const page = await list(`tab=all&limit=${limit}`)
    expect(page.postings).toHaveLength(limit)
    expect(page.nextCursor).toEqual(expect.any(String))
  })

  it.each(["page=2", "offset=25", "sort=rank", "family=backend", "q=react"])("PF-32: unknown parameter %s is a 400", async (parameter) => {
    await list(`tab=all&${parameter}`, 400)
  })

  it.each(["Ranked", "excluded", "ALL"])("PF-33: tab %s is a 400", async (tab) => {
    await list(`tab=${tab}`, 400)
  })

  it("PF-34: no tab lists All", async () => {
    for (let index = 0; index < 3; index++) await seed()
    for (let index = 0; index < 2; index++) await seed({ status: "skipped" })
    const page = await list("")
    expect(page.postings).toHaveLength(5)
    expect(page.totalCount).toBe(5)
  })

  it("a repeated parameter is a 400 (each parameter is sent once)", async () => {
    await list("tab=all&families=backend&families=mobile", 400)
    await list("tab=all&limit=1&limit=2", 400)
  })

  it.each(["robotics", "Backend", "BACKEND", "frontend", "devops", "backend,", ",backend", "backend,,mobile", "backend,%20mobile", "senior-frontend", "null"])(
    "PF-40: families %s is a 400",
    async (families) => {
      await list(`tab=all&families=${families}`, 400)
    }
  )

  it("F-QA8-01: a NUL or other non-whitespace control character in any parameter is a 400, never a 500", async () => {
    for (let index = 0; index < 30; index++) await seed({ title: "Senior React Engineer", status: "skipped" })
    const cursor = (await list("tab=all&keyword=react&limit=10")).nextCursor!
    const refused = [
      "tab=all&keyword=%00",
      "tab=all&keyword=re%00act",
      "tab=all&keyword=%20%00%20",
      "tab=all&keyword=%01",
      "tab=all&keyword=a%1Fb",
      "tab=all&keyword=a%7Fb",
      `tab=all&keyword=react%00&cursor=${encodeURIComponent(cursor)}`,
      "tab=all&families=backend%00",
      "tab=all&families=%00",
      "tab=all%00",
      "tab=all&limit=1%00",
      "tab=all&cursor=%00",
      `tab=all&keyword=react&cursor=${encodeURIComponent(cursor)}%00`,
      `tab=all&keyword=react&cursor=%00${encodeURIComponent(cursor)}`,
    ]
    for (const query of refused) {
      const response = await candidate.get(`/v1/job-postings?${query}`)
      expect({ query, status: response.status, body: response.body }).toEqual({
        query,
        status: 400,
        body: { error: { code: "bad_request", message: "The request is not valid." } },
      })
    }
    // Whitespace controls stay ordinary whitespace: trimmed at the ends, one space inside.
    expect((await list("tab=all&keyword=%09react%0A")).totalCount).toBe(30)
    expect((await list("tab=all&keyword=senior%09react")).totalCount).toBe(30)
    expect((await list("tab=all&keyword=%0D%0A%0B%0C")).totalCount).toBe(30)
  })

  it("PF-45, PF-46: keyword trimmed, 100 characters accepted, 101 refused", async () => {
    await seed({ title: "Senior React Engineer", status: "skipped" })
    await seed({ title: "Kotlin Developer", status: "skipped" })
    await seed({ title: `${"a".repeat(100)} Engineer`, status: "skipped" })
    const titlesFor = async (keyword: string) => (await list(`tab=all&keyword=${encodeURIComponent(keyword)}`)).postings.map((posting) => posting.title)
    expect(await titlesFor("")).toHaveLength(3)
    expect(await titlesFor(" ")).toHaveLength(3)
    expect(await titlesFor("   \t  ")).toHaveLength(3)
    expect(await titlesFor("k")).toEqual(["Kotlin Developer"])
    expect(await titlesFor(" k ")).toEqual(["Kotlin Developer"])
    expect(await titlesFor("  react  ")).toEqual(["Senior React Engineer"])
    expect(await titlesFor("a".repeat(100))).toEqual([`${"a".repeat(100)} Engineer`])
    expect(await titlesFor(` ${"a".repeat(100)} `)).toHaveLength(1)
    expect(await titlesFor(`${" ".repeat(10)}${"a".repeat(100)}${" ".repeat(10)}`)).toHaveLength(1)
    await list(`tab=all&keyword=${"a".repeat(101)}`, 400)
    await list(`tab=all&keyword=%20${"a".repeat(101)}%20`, 400)
  })
})

describe("waitingToBeCheckedCount and summary shape (8P.11, 8P.13)", () => {
  it.each([
    ["tab=ranked", 1],
    ["tab=ranked", 2],
    ["tab=skipped", 1],
    ["tab=all&families=mobile", 1],
    ["tab=ranked&families=backend&keyword=zzz", 1],
    ["tab=all&families=backend&keyword=backend", 2],
  ] as const)("PF-35: waitingToBeCheckedCount is 2 for %s page %i", async (view, page) => {
    for (let index = 0; index < 40; index++) await seed({ title: "Senior Backend Engineer", family: "backend" })
    await seed({ title: "Frontend Engineer at Acme", status: "waiting_to_be_checked" })
    await seed({ title: null, status: "waiting_to_be_checked", origin: "pasted_link" })
    let response = await list(`${view}&limit=25`)
    if (page === 2) response = await list(`${view}&limit=25&cursor=${encodeURIComponent(response.nextCursor!)}`)
    expect(response.waitingToBeCheckedCount).toBe(2)
  })

  it("PF-36: each posting carries exactly the pre-slice-8 summary fields", async () => {
    await seed({ title: "Senior Backend Engineer at Initech", family: "backend" })
    const [posting] = (await candidate.get("/v1/job-postings?tab=ranked").expect(200)).body.postings
    expect(Object.keys(posting).sort()).toEqual(Object.keys(jobPostingSummarySchema.shape).sort())
    expect(jobPostingSummarySchema.parse(posting).roleFamily).toBe("backend")
  })

  it.each(["ranked", "skipped", "all"])("PF-64: tab %s with no postings is an empty last page", async (tab) => {
    // v1.18.0 adds hiddenCounts, recheckableCount, targetRoleFamilies and waitingReason.
    expect(await list(`tab=${tab}`)).toEqual({
      postings: [],
      nextCursor: null,
      totalCount: 0,
      waitingToBeCheckedCount: 0,
      criteriaEmptyState: false,
      hiddenCounts: { offTarget: 0, belowSeniorityFloor: 0, undated: 0, olderThan60Days: 0, total: 0 },
      recheckableCount: 0,
      targetRoleFamilies: [...ROLE_FAMILIES_V18.options],
      waitingReason: null,
    })
  })
})

describe("Posting filter (8F)", () => {
  it("PF-07, PF-37: families any-of, combined with the tab, exact total", async () => {
    await seed({ title: "P1", family: "backend" })
    await seed({ title: "P2", family: "backend", status: "skipped" })
    await seed({ title: "P3", family: "mobile" })
    await seed({ title: "P4", family: "senior_frontend" })
    const page = await list("tab=ranked&families=backend,mobile")
    expect(page.totalCount).toBe(2)
    expect(page.postings.map((posting) => posting.title).sort()).toEqual(["P1", "P3"])
    expect((await list("tab=all&families=backend,mobile")).postings.map((posting) => posting.title).sort()).toEqual(["P1", "P2", "P3"])
  })

  it("PF-38, PF-44: without a family filter null-family postings are listed; with one they never match", async () => {
    await seed({ title: "P1", family: "backend" })
    await seed({ title: "Sales Engineer", status: "skipped", skipReason: "not_software_role", family: null })
    await seed({ title: null, status: "waiting_to_be_checked" })
    for (const status of ["checking", "evaluation_failed"] as const) await seed({ title: "Frontend Engineer at Acme", status, family: null })
    // EPIC-0006 (AC-1.7): a titled row with no family (here the pre-filtered Sales Engineer and two family-null
    // fixtures) is off-target and hidden. The untitled row is the null-family posting the list still shows.
    const all = await list("tab=all")
    expect(all.totalCount).toBe(2)
    expect(all.hiddenCounts.offTarget).toBe(3)
    expect(await list("tab=all&families=other")).toMatchObject({ postings: [], totalCount: 0 })
  })

  it("PF-39, PF-43: each of the nine families filters to its one posting; all nine together match every classified posting", async () => {
    for (const family of FAMILIES) await seed({ title: `${family} role`, family })
    // EPIC-0006: untitled, so a family-null row is not off-target (AC-1.7) and still matches no family filter.
    await seed({ title: null, status: "checking", family: null })
    for (const family of FAMILIES) {
      const page = await list(`tab=all&families=${family}`)
      expect(page.postings.map((posting) => posting.roleFamily)).toEqual([family])
    }
    const all = await list(`tab=all&families=${FAMILIES.join(",")}`)
    expect(all.totalCount).toBe(9)
    expect(all.postings.map((posting) => posting.title)).not.toContain(null)
  })

  it("PF-41, PF-42: a repeated family counts once; an empty families value is no filter", async () => {
    for (let index = 0; index < 3; index++) await seed({ family: "backend" })
    for (let index = 0; index < 2; index++) await seed({ family: "mobile" })
    const repeated = await list("tab=all&families=backend,backend")
    expect(repeated.totalCount).toBe(3)
    expect(new Set(repeated.postings.map((posting) => posting.id)).size).toBe(3)
    expect((await list("tab=all&families=")).totalCount).toBe(5)
  })

  it.each([
    ["react", "Senior React Engineer", true],
    ["react", "REACT NATIVE DEVELOPER", true],
    ["REACT", "Senior React Engineer", true],
    ["developpeur", "Développeur Frontend Senior", true],
    ["Développeur", "Développeur Frontend Senior", true],
    ["DÉVELOPPEUR", "Développeur Frontend Senior", true],
    ["front", "Frontend Engineer", true],
    ["front", "Senior Front-End Engineer", true],
    ["lead   engineer", "Lead Engineer", true],
    ["lead engineer", "Lead Engineer", true],
    ["gineer", "Lead Engineer", true],
    ["vue", "Senior React Engineer", false],
    ["react engineer", "Senior React Native Engineer", false],
  ])("PF-47: keyword %j against %j", async (keyword, title, listed) => {
    await seed({ title })
    const page = await list(`tab=all&keyword=${encodeURIComponent(keyword)}`)
    expect(page.postings.length).toBe(listed ? 1 : 0)
  })

  it("PF-48, PF-49: the keyword never matches the description or the company", async () => {
    await seed({ title: "Frontend Engineer", postingText: "You will build React and TypeScript features", company: "Reactive Labs" })
    expect(await list("tab=all&keyword=react")).toMatchObject({ postings: [], totalCount: 0 })
    expect(await list("tab=all&keyword=reactive")).toMatchObject({ postings: [], totalCount: 0 })
  })

  it("PF-50, PF-51: untitled postings never match a keyword, and are listed without one", async () => {
    await seed({ title: null, status: "checking", origin: "pasted_link" })
    await seed({ title: "", status: "checking", origin: "pasted_link" })
    for (const keyword of ["a", "e"]) expect((await list(`tab=all&keyword=${keyword}`)).postings).toEqual([])
    expect((await list("tab=all&keyword=%20%20%20")).postings).toHaveLength(2)
  })

  it.each([
    ["100%", ["P1"]],
    ["%", ["P1"]],
    ["front_end", ["P4"]],
    ["_", ["P4"]],
    ["\\", ["P5"]],
    ["backend\\p", ["P5"]],
  ])("PF-52: keyword %j matches only literally", async (keyword, expected) => {
    const titles: Record<string, string> = {
      P1: "100% Remote Frontend Engineer",
      P2: "100 Remote Engineers",
      P3: "Senior Front-End Engineer",
      P4: "Front_End Engineer",
      P5: "Backend\\Platform Engineer",
      P6: "Backend Platform Engineer",
    }
    const byTitle = new Map(Object.entries(titles).map(([label, title]) => [title, label]))
    for (const title of Object.values(titles)) await seed({ title })
    const page = await list(`tab=all&keyword=${encodeURIComponent(keyword)}`)
    expect(page.postings.map((posting) => byTitle.get(posting.title!))).toEqual(expected)
  })

  it("PF-53: wildcard-only keywords over 2,000 postings return no rows and take at most twice the plain-keyword time", async () => {
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, status, discovered_at)
      select gen_random_uuid(), 'https://x.test/' || g, g::text, 'https://x.test/' || g, 'Greenhouse', 'automatic', 'employer_board',
        'Senior Engineer ' || g, 'senior engineer ' || g, 'Co', '{}', 'skipped', now() - g * interval '1 second'
      from generate_series(1, 2000) g`.execute(database.db)
    await holdAllPostings(database.db, database.operatorId)
    const timed = async (keyword: string) => {
      const samples: number[] = []
      for (let run = 0; run < 5; run++) {
        const started = performance.now()
        const page = await list(`tab=all&keyword=${encodeURIComponent(keyword)}`)
        samples.push(performance.now() - started)
        expect(page).toMatchObject({ postings: [], totalCount: 0 })
      }
      return samples.sort((a, b) => a - b)[2]!
    }
    const baseline = await timed("zzzz")
    for (const keyword of ["%%%%", "\\\\", "_", "%_%_\\%", "____"]) {
      // Median of 5; a 25 ms floor absorbs scheduler noise on a loaded machine.
      expect(await timed(keyword)).toBeLessThanOrEqual(Math.max(baseline * 2, baseline + 25))
    }
  })

  it("PF-54, PF-55: family AND keyword AND tab; a filter that matches nothing is an empty last page", async () => {
    await seed({ title: "React Tech Lead", family: "technical_lead" })
    await seed({ title: "Fullstack Engineer (React)", family: "fullstack" })
    await seed({ title: "Fullstack Engineer (Vue)", family: "fullstack" })
    await seed({ title: "Senior React Engineer", family: "senior_frontend" })
    await seed({ title: "Lead Engineer, React Platform", family: "technical_lead", status: "skipped" })
    const page = await list("tab=ranked&families=technical_lead,fullstack&keyword=react")
    expect(page.postings.map((posting) => posting.title)).toEqual(["React Tech Lead", "Fullstack Engineer (React)"])
    expect(page.totalCount).toBe(2)
    for (let index = 0; index < 30; index++) await seed({ family: "senior_frontend" })
    expect(await list("tab=ranked&families=mobile&keyword=flutter")).toMatchObject({ postings: [], nextCursor: null, totalCount: 0 })
  })

  it("PF-56: filtered list requests change no posting's status, reason, Match, family or rank", async () => {
    await seedMixed(50, 13)
    const snapshot = async () => ({
      rows: await sql`select p.*, m.covered_count, m.total_count from job_posting p left join match_evidence m on m.job_posting_id = p.id order by p.id`.execute(database.db).then((result) => result.rows),
      ranks: await referenceRankedOrder(),
    })
    const before = await snapshot()
    const views = ["tab=ranked", "tab=all&families=backend", "tab=skipped&keyword=engineer", "tab=all&keyword=react&limit=3", "tab=ranked&families=other,mobile&limit=2"]
    for (let index = 0; index < 20; index++) {
      const view = views[index % views.length]!
      const first = await list(view)
      if (first.nextCursor) await list(`${view}&cursor=${encodeURIComponent(first.nextCursor)}`)
    }
    expect(await snapshot()).toEqual(before)
  })
})

describe("global ranks under the filter (8K)", () => {
  const TEN = [
    "Senior React Engineer",
    "Frontend Tech Lead",
    "Senior Frontend Engineer",
    "Fullstack Engineer (React)",
    "Product Engineer",
    "Fullstack Engineer (Vue)",
    "Senior Backend Engineer",
    "iOS Engineer",
    "Reactive Systems Engineer",
    "DevOps Engineer",
  ]
  const seedTen = async () => {
    for (const [index, title] of TEN.entries()) await seed({ title, family: "senior_frontend", covered: 100 - index, total: 100 })
  }

  it("PF-58: a filtered Ranked list keeps global ranks, with gaps", async () => {
    await seedTen()
    expect((await list("tab=ranked&keyword=react")).postings.map((posting) => posting.rank)).toEqual([1, 4, 9])
  })

  it("PF-59: a filtered Ranked list across pages is the unfiltered order with other families removed; ranks strictly increase", async () => {
    const next = rng(17)
    for (let index = 0; index < 60; index++) await seed({ family: FAMILIES[index % FAMILIES.length]!, covered: next(10), total: 10 })
    const unfiltered = (await follow("tab=ranked&limit=100")).flatMap((page) => page.postings)
    const filtered = (await follow("tab=ranked&families=backend,mobile,devops_platform&limit=3")).flatMap((page) => page.postings)
    expect(filtered.map((posting) => posting.id)).toEqual(
      unfiltered.filter((posting) => ["backend", "mobile", "devops_platform"].includes(posting.roleFamily!)).map((posting) => posting.id)
    )
    const ranks = filtered.map((posting) => posting.rank!)
    expect(ranks.every((rank, index) => index === 0 || rank > ranks[index - 1]!)).toBe(true)
  })

  it("PF-60: the All tab shows global ranks under a filter and null for unranked", async () => {
    await seed({ title: "Senior React Engineer", covered: 10, total: 10 })
    await seed({ title: "Frontend Tech Lead", covered: 9, total: 10 })
    await seed({ title: "React Native Engineer", covered: 8, total: 10 })
    await seed({ title: "React Developer", status: "skipped" })
    await seed({ title: "React Engineer", status: "evaluation_failed" })
    const byTitle = new Map((await list("tab=all&keyword=react")).postings.map((posting) => [posting.title, posting.rank]))
    expect(byTitle.get("Senior React Engineer")).toBe(1)
    expect(byTitle.get("React Native Engineer")).toBe(3)
    expect(byTitle.get("React Developer")).toBeNull()
    expect(byTitle.get("React Engineer")).toBeNull()
  })

  it("PF-61: the same posting has the same rank in every view, and in the detail", async () => {
    for (let index = 0; index < 40; index++) {
      await seed({ title: index === 6 ? "Senior Backend Engineer" : `Frontend ${index}`, company: index === 6 ? "Initech" : "Acme", family: index === 6 ? "backend" : "senior_frontend", covered: 100 - index, total: 100 })
    }
    // Backend is in the last tier, so it ranks 40th whatever its coverage; that is still one number everywhere.
    const rankIn = async (view: string) => (await follow(`${view}&limit=100`)).flatMap((page) => page.postings).find((posting) => posting.company === "Initech")!.rank
    const ranks = [await rankIn("tab=ranked"), await rankIn("tab=all"), await rankIn("tab=ranked&families=backend"), await rankIn("tab=all&keyword=backend")]
    expect(new Set(ranks)).toEqual(new Set([40]))
    const id = (await list("tab=ranked&families=backend")).postings[0]!.id
    expect((await candidate.get(`/v1/job-postings/${id}`).expect(200)).body.rank).toBe(40)
  })
})

describe("reclassification of stored postings (8M) and new postings (8R)", () => {
  const snapshotAll = () => sql`select p.*, m.covered_count from job_posting p left join match_evidence m on m.job_posting_id = p.id order by p.id`.execute(database.db).then((result) => result.rows)

  it("RF-14, RF-17, RF-19: other rows move to the new families; other families and null are untouched", async () => {
    const id = async (title: string | null, family: RoleFamily | null, status: Status = "ranked") => seed({ title, family, status })
    const p = {
      backend: await id("Senior Backend Engineer", "other"),
      ios: await id("iOS Engineer", "other"),
      sre: await id("Site Reliability Engineer", "other"),
      software: await id("Software Engineer", "other"),
      data: await id("Data Engineer", "other"),
      reactNode: await id("Backend Engineer (React, Node)", "senior_frontend"),
      lead: await id("Backend Tech Lead", "technical_lead"),
      rn: await id("React Native Engineer", "senior_frontend"),
      manager: await id("Engineering Manager, Backend", "people_management"),
      skipped: await id("Senior Backend Engineer", null, "skipped"),
      checking: await id("DevOps Engineer", null, "checking"),
      waiting: await id("iOS Engineer", null, "waiting_to_be_checked"),
      sales: await id("Sales Engineer", "other"),
      untitled: await id(null, "other"),
      mobileBackend: await id("Mobile Backend Engineer", "other"),
    }
    expect(await reclassifyOtherPostings(database.db as never)).toBe(4)
    const family = async (key: keyof typeof p) =>
      (await database.db.selectFrom("job_posting").select("role_family").where("id", "=", p[key]).executeTakeFirstOrThrow()).role_family
    expect([await family("backend"), await family("ios"), await family("sre"), await family("software"), await family("data")]).toEqual(["backend", "mobile", "devops_platform", "other", "other"])
    expect([await family("reactNode"), await family("lead"), await family("rn"), await family("manager")]).toEqual(["senior_frontend", "technical_lead", "senior_frontend", "people_management"])
    expect([await family("skipped"), await family("checking"), await family("waiting")]).toEqual([null, null, null])
    expect([await family("sales"), await family("untitled"), await family("mobileBackend")]).toEqual(["other", "other", "mobile"])
  })

  it("RF-15, RF-16, RF-20, RF-21, RF-23, RF-24: no other field changes, every rank is kept, a second run changes nothing, empty is fine", async () => {
    expect(await reclassifyOtherPostings(database.db as never)).toBe(0)
    const next = rng(23)
    const otherTitles = ["Senior Backend Engineer", "Flutter Developer", "DevOps Engineer", "Software Engineer", "Cloud Engineer", "Android Engineer"]
    for (let index = 0; index < 200; index++) {
      const isOther = index < 40
      await seed({
        title: isOther ? otherTitles[index % otherTitles.length]! : TITLES[next(TITLES.length)]!,
        family: isOther ? "other" : (["senior_frontend", "technical_lead", "fullstack", "product_engineering", "people_management", null] as const)[next(6)],
        status: isOther ? "ranked" : STATUSES[next(STATUSES.length)]!,
        covered: next(10),
        total: 10,
      })
    }
    const before = await snapshotAll()
    const ranksBefore = await referenceRankedOrder()
    const listedBefore = ids(await follow("tab=ranked&limit=100"))
    expect(await reclassifyOtherPostings(database.db as never)).toBeGreaterThan(0)
    const after = await snapshotAll()
    const strip = (rows: Record<string, unknown>[]) => rows.map((row) => ({ ...row, role_family: undefined }))
    expect(strip(after as Record<string, unknown>[])).toEqual(strip(before as Record<string, unknown>[]))
    for (const [index, row] of (after as Record<string, unknown>[]).entries()) {
      const was = (before as Record<string, unknown>[])[index]!.role_family
      if (was !== row.role_family) {
        expect(was).toBe("other")
        expect(["backend", "mobile", "devops_platform"]).toContain(row.role_family)
      }
    }
    expect(await referenceRankedOrder()).toEqual(ranksBefore)
    expect(ids(await follow("tab=ranked&limit=100"))).toEqual(listedBefore)
    const once = await snapshotAll()
    expect(await reclassifyOtherPostings(database.db as never)).toBe(0)
    expect(await snapshotAll()).toEqual(once)
  })

  it("RF-25: after reclassification a family filter finds the relabelled posting with the same rank", async () => {
    for (let index = 0; index < 5; index++) await seed({ family: "senior_frontend" })
    const id = await seed({ title: "Senior Backend Engineer", company: "Acme", family: "other" })
    const rankBefore = (await candidate.get(`/v1/job-postings/${id}`).expect(200)).body.rank
    await reclassifyOtherPostings(database.db as never)
    const page = await list("tab=ranked&families=backend")
    expect(page.postings.map((posting) => posting.id)).toEqual([id])
    expect(page.postings[0]!.rank).toBe(rankBefore)
  })

  it("stored postings get title_folded at ingestion", async () => {
    const stored = await asOwner(() => app.get(DiscoveryRepository).storeOnce({
      applicationUrl: "https://jobs.lever.co/globex/x1",
      requisitionId: "x1",
      applyUrl: "https://jobs.lever.co/globex/x1",
      applicationSystem: "Lever",
      applyMode: "automatic",
      origin: "pasted_link",
      employerBoardId: null,
      remoteBoardKey: null,
      attribution: null,
      title: "Développeur   FRONTEND",
      company: "Globex",
      postingText: "",
      structured: EMPTY_STRUCTURED,
      discoveredAt: new Date(),
      postedAt: null,
      postedDateKind: null,
    }, () => ({ pass: true })))
    const row = await database.db.selectFrom("job_posting").select("title_folded").where("id", "=", stored.id).executeTakeFirstOrThrow()
    expect(row.title_folded).toBe("developpeur frontend")
  })
})

/**
 * Slice 8d over HTTP (postings-paging-and-filter.feature PF-66 to PF-74). The
 * test builds MAC-valid cursors with the api's own key: DiscoveryService keys
 * the codec with the Google client secret, which the test app sets to
 * TEST_CLIENT_SECRET.
 */
describe("slice 8d: out-of-range cursor timestamps (8d.7, 8d.8)", () => {
  const codec = new PostingCursorCodec(TEST_CLIENT_SECRET)
  const cursorFor = (tab: "ranked" | "all" | "skipped", micros: string) =>
    codec.encode(
      { tab, families: [], foldedKeyword: null, candidateId: database.operatorId, tierHash: TIER_HASH },
      tab === "ranked"
        ? { kind: "ranked", tier: 0, atsFit: -1, covered: 0, total: 0, fromEmployerBoard: false, discoveredUs: micros, id: "00000000-0000-4000-8000-000000000000" }
        : { kind: "newest", discoveredUs: micros, id: "00000000-0000-4000-8000-000000000000" }
    )
  const seedForty = async () => {
    for (let index = 0; index < 40; index++) await seed({ status: "ranked" })
    for (let index = 0; index < 20; index++) await seed({ status: "skipped" })
  }

  it.each([
    ["ranked", "9223372036854775807"],
    ["ranked", "9999999999999999999"],
    ["ranked", "-9223372036854775808"],
    ["ranked", "253402300800000000"],
    ["ranked", "-62135596800000001"],
    ["ranked", "-1"],
    ["ranked", "7258118400000001"],
    ["all", "9223372036854775807"],
    ["all", "9999999999999999999"],
    ["skipped", "-9223372036854775808"],
    ["all", "253402300800000000"],
    ["skipped", "-62135596800000001"],
    ["all", "-1"],
    ["skipped", "7258118400000001"],
  ] as const)("PF-66: tab %s with micros %s is 400, never 500, and runs no page query", async (tab, micros) => {
    await seedForty()
    const repository = app.get(DiscoveryRepository)
    const readPage = vi.spyOn(repository, "listPage")
    try {
      const response = await candidate.get(`/v1/job-postings?tab=${tab}&cursor=${encodeURIComponent(cursorFor(tab, micros))}`)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
      expect(readPage).not.toHaveBeenCalled()
    } finally {
      readPage.mockRestore()
    }
  })

  it.each([
    ["ranked", "abc"],
    ["ranked", "1.5"],
    ["ranked", "1e5"],
    ["ranked", "-"],
    ["ranked", "--1"],
    ["ranked", "12 34"],
    ["all", "abc"],
    ["all", "1.5"],
    ["skipped", "1e5"],
    ["all", "-"],
    ["skipped", "--1"],
    ["all", "12 34"],
  ] as const)("PF-66 r2 (CR8D-01): tab %s with non-numeric micros %j is 400, runs no page query, and logs nothing about it", async (tab, micros) => {
    await seedForty()
    const repository = app.get(DiscoveryRepository)
    const readPage = vi.spyOn(repository, "listPage")
    const logged: string[] = []
    const capture = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "))
    }
    const spies = (["log", "error", "warn", "debug", "verbose"] as const).map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(capture))
    try {
      const response = await candidate.get(`/v1/job-postings?tab=${tab}&cursor=${encodeURIComponent(cursorFor(tab, micros))}`)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: { code: "bad_request", message: "The request is not valid." } })
      expect(readPage).not.toHaveBeenCalled()
      // The only line a 400 logs is the debug "Client error 400: bad_request"; nothing quotes the value or a BigInt failure.
      expect(logged.filter((line) => line !== "Client error 400: bad_request")).toEqual([])
    } finally {
      readPage.mockRestore()
      for (const spy of spies) spy.mockRestore()
    }
  })

  it.each([
    ["ranked", "7258118400000000", 40],
    ["ranked", "7258118399999999", 40],
    ["ranked", "0", 40],
    ["ranked", "1", 40],
    ["all", "7258118400000000", 60],
    ["all", "7258118399999999", 60],
    ["skipped", "0", 20],
    ["skipped", "1", 20],
  ] as const)("PF-67: tab %s with micros %s succeeds with totalCount %i", async (tab, micros, total) => {
    await seedForty()
    const page = await list(`tab=${tab}&cursor=${encodeURIComponent(cursorFor(tab, micros))}`)
    expect(page.totalCount).toBe(total)
  })

  it("PF-68: one out-of-range cursor over HTTP gets 400 and the api keeps serving", async () => {
    for (let index = 0; index < 30; index++) await seed({ status: "ranked" })
    await list(`tab=ranked&cursor=${encodeURIComponent(cursorFor("ranked", "9223372036854775807"))}`, 400)
    expect((await list("tab=ranked")).postings).toHaveLength(25)
  })
})

describe("slice 8d: a keyword of only invisible characters is no keyword (8d.13, 8d.14)", () => {
  const seedFour = async () => {
    await seed({ title: "Senior React Engineer", status: "ranked" })
    await seed({ title: "Kotlin Developer", status: "ranked" })
    await seed({ title: null, status: "ranked" })
    await seed({ title: "Sales Engineer", status: "skipped" })
  }

  it.each([
    ["ranked", "%E2%80%8B"],
    ["ranked", "%C2%AD"],
    ["ranked", "%E2%81%A0%E2%80%8B"],
    ["ranked", "%CC%81"],
    ["all", "%E2%80%8B"],
    ["all", "%CC%81"],
  ])("PF-69: tab %s keyword=%s equals the list without a keyword, untitled included", async (tab, encoded) => {
    await seedFour()
    const without = await list(`tab=${tab}`)
    const withKeyword = await list(`tab=${tab}&keyword=${encoded}`)
    expect(withKeyword).toEqual(without)
    expect(withKeyword.postings.some((posting) => posting.title === null)).toBe(true)
  })

  it.each([
    "%C2%AD", "%CD%8F", "%E1%A0%8E", "%E2%80%8B%E2%80%8C%E2%80%8D%E2%80%8E%E2%80%8F", "%E2%80%AA%E2%80%AB%E2%80%AC%E2%80%AD%E2%80%AE",
    "%E2%81%A0%E2%81%A1%E2%81%A2%E2%81%A3%E2%81%A4", "%EF%BB%BF", "%EF%B8%8F", "%CC%81", "%20%20%E2%80%8B%20%20",
  ])("PF-70: keyword=%s returns all 4 postings", async (encoded) => {
    await seed({ title: "Senior React Engineer" })
    await seed({ title: "Kotlin Developer" })
    await seed({ title: "Flutter Developer" })
    await seed({ title: null })
    const page = await list(`tab=ranked&keyword=${encoded}`)
    expect(page.postings).toHaveLength(4)
    expect(page.totalCount).toBe(4)
  })

  it.each(["%E2%80%8B%00", "%01%C2%AD", "%7F%CC%81"])("PF-71: keyword=%s with a control character is 400", async (encoded) => {
    await list(`tab=ranked&keyword=${encoded}`, 400)
  })

  it("PF-72: a visible letter among invisible characters is still a keyword", async () => {
    await seed({ title: "Senior React Engineer" })
    await seed({ title: "Kotlin Developer" })
    const page = await list("tab=ranked&keyword=%E2%80%8Bk%C2%AD")
    expect(page.postings.map((posting) => posting.title)).toEqual(["Kotlin Developer"])
    expect(page.totalCount).toBe(1)
  })

  it.each([
    ["", "&keyword=%E2%80%8B"],
    ["&keyword=%E2%80%8B", ""],
    ["&keyword=%C2%AD", "&keyword=%CC%81"],
  ])("PF-73: a cursor issued with %j is accepted with %j", async (first, second) => {
    for (let index = 0; index < 40; index++) await seed({ status: "ranked", covered: 100 - index, total: 100 })
    const reference = ids(await follow("tab=ranked&limit=100"))
    const page = await list(`tab=ranked&limit=25${first}`)
    const next = await list(`tab=ranked&limit=25${second}&cursor=${encodeURIComponent(page.nextCursor!)}`)
    expect(next.postings.map((posting) => posting.id)).toEqual(reference.slice(25, 40))
  })

  it("PF-74: the API schema uses the shared contracts rule (keywordFoldsToEmpty)", async () => {
    await seedFour()
    for (const keyword of ["\u200b", "\u00ad", "\u2060\u200b", "\u0301", "\ufeff", "\ufe0f", "  \u200b  "]) {
      expect(keywordFoldsToEmpty(keyword)).toBe(true)
      expect((await list(`tab=all&keyword=${encodeURIComponent(keyword)}`)).totalCount).toBe(4)
    }
  })
})
