import type { INestApplication } from "@nestjs/common"
import { pasteJobLinkResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { HttpResponse, type JsonBodyType, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { DiscoveryPipeline } from "../src/discovery/discovery-pipeline.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { PostingEvaluator } from "../src/discovery/posting-evaluator.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import {
  DEFAULT_TARGETS,
  clearPostings,
  factsOf,
  hold,
  insertPosting,
  list,
  queuedEvaluations,
  resetCriteria,
  setCriteria,
  signInSecondCandidate,
  snapshotPosting,
  statusOf,
  wat,
} from "./support/epic-0006.js"
import {
  REMOTE_OK_LEGAL,
  ashbyJob,
  greenhouseJob,
  himalayasJob,
  leverJob,
  remoteOkJob,
  remotiveJob,
  wwrFeed,
  wwrItem,
} from "./fixtures/epic-0006-sources.js"

/**
 * EPIC-0006 QA test authoring (step [5e]): posted-date parsing per source,
 * validity bounds, backfill, the starting status of hidden postings, the
 * evaluator's visibility gate, and pasted links. Recorded fixtures follow the
 * Architect's observed fields (fixtures/epic-0006-sources.ts). Source:
 * posted-date.feature, evaluation-of-hidden-postings.feature,
 * per-candidate-tenancy.feature (backfill and gate per Candidate),
 * check-again-and-worker-key.feature (worker scenarios). Expected to fail
 * until the EPIC-0006 backend lands.
 *
 * Read moment: 2026-10-24T08:00:00Z (09:00 WAT), the Gherkin's "today".
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let ada: SignedInCandidate
let adaId: string
let kofiId: string
const READ_AT = "2026-10-24T08:00:00.000Z"
const clock = new TestClock(READ_AT)

const SECTIONS = [
  {
    id: "s1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021-2024",
    sourceQuote: null,
    facts: [{ id: "F1", text: "Built a React and TypeScript merchant dashboard", sourceQuote: null }],
  },
]
const STRONG = {
  workArrangement: "remote",
  locationQuote: "Remote, open to candidates in Nigeria",
  relocationCountry: null,
  relocationQuote: null,
  sponsorshipQuote: null,
  payQuote: null,
  hoursQuote: null,
  employerBusiness: null,
  businessQuote: null,
  employmentType: null,
  coreResponsibilities: [{ text: "Build React features", quote: "Build React features", factId: "F1" }],
  mandatoryPrerequisites: [],
  niceToHave: [],
}

const ALL_TARGETS = [...DEFAULT_TARGETS, "devops_platform", "data_ml", "solutions_customer", "other"]
const asOwner = <T>(work: () => Promise<T>) => app.get(TenantDatabase).asOperator(work)
const runDaily = () => asOwner(() => app.get(DiscoveryPipeline).runDaily({ ignoreApproval: true }))
const evaluateAs = (candidateId: string, postingId: string) => CandidateScope.run(candidateId, () => app.get(PostingEvaluator).evaluate(postingId))
/** Evaluation spend only (Q-3): a discovery run settles its own `discovery`/`discovery_run` row, which is not evaluation spend. */
const spendRows = async () => Number((await sql<{ n: string }>`select count(*) as n from spend_entry where category <> 'discovery'`.execute(database.db)).rows[0]!.n)

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  adaId = database.operatorId
  ;({ id: kofiId } = await signInSecondCandidate(app, google, database.db))
  await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: adaId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(SECTIONS), created_at: new Date(), approved_at: new Date() })
    .execute()
})

beforeEach(async () => {
  clock.set(READ_AT)
  await app.get(DiscoveryService).settled()
  google.server.resetHandlers()
  // Q-3: every employer board answers empty unless a test overrides it. Registered here, before any test's own
  // handlers, so a test's ATS lookup (for example Ashby "globex") is never shadowed (msw: the last `use` wins).
  google.server.use(
    http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", () => HttpResponse.json({ jobs: [] })),
    http.get("https://api.lever.co/v0/postings/:token", () => HttpResponse.json([])),
    http.get("https://api.ashbyhq.com/posting-api/job-board/:token", () => HttpResponse.json({ jobs: [] }))
  )
  anthropic.install()
  anthropic.reset()
  anthropic.onRequest = null
  outbound.reset()
  await clearPostings(database.db)
  await resetCriteria(database.db)
  await database.db.deleteFrom("spend_entry").execute()
  await database.db.updateTable("employer_board").set({ last_read_at: null }).execute()
  await database.db.updateTable("remote_board").set({ enabled: false, last_read_at: null }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false, cost_paused_month: null }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

type Source = "greenhouse" | "lever" | "ashby" | "himalayas" | "remoteok" | "remotive" | "weworkremotely"

/** Every employer board answers empty except the one source under test. */
function serve(source: Source, raw: unknown) {
  const payload = raw as JsonBodyType
  const handlers = {
    greenhouse: http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", ({ params }) => HttpResponse.json(params.token === "canonical" ? payload : { jobs: [] })),
    lever: http.get("https://api.lever.co/v0/postings/:token", ({ params }) => HttpResponse.json(params.token === "metabase" ? payload : [])),
    ashby: http.get("https://api.ashbyhq.com/posting-api/job-board/:token", ({ params }) => HttpResponse.json(params.token === "railway" ? payload : { jobs: [] })),
    himalayas: http.get("https://himalayas.app/jobs/api", () => HttpResponse.json(payload)),
    remoteok: http.get("https://remoteok.com/api", () => HttpResponse.json(payload)),
    remotive: http.get("https://remotive.com/api/remote-jobs", () => HttpResponse.json(payload)),
    weworkremotely: http.get("https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss", () => HttpResponse.text(raw as string, { headers: { "content-type": "application/rss+xml" } })),
  }
  google.server.use(handlers[source])
}

async function enableRemote(key: "himalayas" | "remoteok" | "remotive" | "weworkremotely") {
  // Remotive is unavailable in the seed; a test database may turn it on to exercise the reader.
  await database.db.updateTable("remote_board").set({ available: true, unavailable_reason: null, verified_on: "2026-10-19", verification_basis: "test", enabled: true }).where("key", "=", key).execute()
}

function payloadFor(source: Source, job: Record<string, unknown> | string) {
  switch (source) {
    case "greenhouse":
    case "ashby":
      return { jobs: [job] }
    case "lever":
      return [job]
    case "himalayas":
      return { jobs: [job], totalCount: 1 }
    case "remoteok":
      return [REMOTE_OK_LEGAL, job]
    case "remotive":
      return { "job-count": 1, jobs: [job] }
    case "weworkremotely":
      return wwrFeed([job as string])
  }
}

async function discover(source: Source, job: Record<string, unknown> | string) {
  if (source === "himalayas" || source === "remoteok" || source === "remotive" || source === "weworkremotely") await enableRemote(source)
  serve(source, payloadFor(source, job))
  await runDaily()
}

/** The one shared posting of a run, or by requisition. */
async function stored(requisition?: string) {
  const { rows } = await sql<{ id: string; posted_at: Date | null; posted_date_kind: string | null; requisition_id: string }>`
    select id, posted_at, posted_date_kind, requisition_id from job_posting ${requisition ? sql`where requisition_id = ${requisition}` : sql``}`.execute(database.db)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString())

describe("AC-5.2 @AC-5.2 each source's published field becomes the posted date (posted-date:57-74)", () => {
  it.each([
    ["greenhouse", greenhouseJob(4001, "Senior Frontend Engineer", { first_published: "2026-10-20T14:30:00-04:00" }), "2026-10-20T18:30:00.000Z"],
    ["lever", leverJob("lv-1", "Senior Frontend Engineer", 1792497600000), "2026-10-20T12:00:00.000Z"],
    ["ashby", ashbyJob("as-1", "Senior Frontend Engineer", "2026-10-20T12:00:00.000+00:00"), "2026-10-20T12:00:00.000Z"],
    ["himalayas", himalayasJob("hm-1", "Senior Frontend Engineer", { pubDate: 1792497600 }), "2026-10-20T12:00:00.000Z"],
    ["remoteok", remoteOkJob("ro-1", "Senior Frontend Engineer", { date: "2026-10-20T12:00:00+00:00" }), "2026-10-20T12:00:00.000Z"],
    ["remoteok", remoteOkJob("ro-2", "Senior Frontend Engineer", { epoch: 1792497600 }), "2026-10-20T12:00:00.000Z"],
    ["remotive", remotiveJob(901, "Senior Frontend Engineer", "2026-10-20T12:00:00"), "2026-10-20T12:00:00.000Z"],
    ["weworkremotely", wwrItem("acme-sfe", "Senior Frontend Engineer", "Tue, 20 Oct 2026 12:00:00 +0000"), "2026-10-20T12:00:00.000Z"],
  ] as const)("%s → %s, basis published", async (source, job, instant) => {
    await discover(source, job)
    const row = await stored()
    expect(iso(row.posted_at)).toBe(instant)
    expect(row.posted_date_kind).toBe("published")
  })
})

describe("AC-5.2 @AC-5.2 epoch units and field precedence (posted-date:76-124)", () => {
  it.each([
    ["himalayas", himalayasJob("hm-s", "Senior Frontend Engineer", { pubDate: 1792497600 }), "2026-10-20T12:00:00.000Z"],
    ["himalayas", himalayasJob("hm-ms", "Senior Frontend Engineer", { pubDate: 1792497600000 }), null],
    ["remoteok", remoteOkJob("ro-s", "Senior Frontend Engineer", { epoch: 1792497600 }), "2026-10-20T12:00:00.000Z"],
    ["remoteok", remoteOkJob("ro-ms", "Senior Frontend Engineer", { epoch: 1792497600000 }), null],
    ["lever", leverJob("lv-ms", "Senior Frontend Engineer", 1792497600000), "2026-10-20T12:00:00.000Z"],
    ["lever", leverJob("lv-s", "Senior Frontend Engineer", 1792497600), null],
  ] as const)("posted-date:76 %s epoch %j gives %s", async (source, job, instant) => {
    await discover(source, job)
    expect(iso((await stored()).posted_at)).toBe(instant)
  })

  it("posted-date:91 the published field wins over the updated field", async () => {
    await discover("greenhouse", greenhouseJob(4002, "Senior Frontend Engineer", { first_published: "2026-09-01T10:00:00Z", updated_at: "2026-10-22T10:00:00Z" }))
    expect(await stored()).toMatchObject({ posted_date_kind: "published" })
    expect(iso((await stored()).posted_at)).toBe("2026-09-01T10:00:00.000Z")
  })

  it("posted-date:98 Remote OK uses date before epoch", async () => {
    await discover("remoteok", remoteOkJob("ro-3", "Senior Frontend Engineer", { date: "2026-10-20T12:00:00+00:00", epoch: 1792584000 }))
    expect(iso((await stored()).posted_at)).toBe("2026-10-20T12:00:00.000Z")
  })

  it("posted-date:104 Remote OK falls back to epoch when date is invalid", async () => {
    await discover("remoteok", remoteOkJob("ro-4", "Senior Frontend Engineer", { date: "not a date", epoch: 1792497600 }))
    expect(await stored()).toMatchObject({ posted_date_kind: "published" })
    expect(iso((await stored()).posted_at)).toBe("2026-10-20T12:00:00.000Z")
  })

  it("posted-date:111 Himalayas expiryDate is ignored", async () => {
    await discover("himalayas", himalayasJob("hm-2", "Senior Frontend Engineer", { pubDate: 1792497600, expiryDate: 1795089600 }))
    expect(iso((await stored()).posted_at)).toBe("2026-10-20T12:00:00.000Z")
  })

  it("posted-date:118 a Himalayas posting with only expiryDate is undated and hidden", async () => {
    await discover("himalayas", himalayasJob("hm-3", "Senior Frontend Engineer", { expiryDate: 1795089600 }))
    const row = await stored()
    expect(row.posted_at).toBeNull()
    expect((await list(ada, "tab=all")).hiddenCounts.undated).toBe(1)
  })
})

describe("AC-5.4 @AC-5.4 @AC-5.2 offset-less date-times are UTC (posted-date:128-152)", () => {
  it.each([
    ["remotive", remotiveJob(902, "Senior Frontend Engineer", "2026-10-17T16:04:29"), "2026-10-17T16:04:29.000Z"],
    ["remotive", remotiveJob(903, "Senior Frontend Engineer", "2026-08-24T23:30:00"), "2026-08-24T23:30:00.000Z"],
    ["remotive", remotiveJob(904, "Senior Frontend Engineer", "2026-08-24T22:59:59"), "2026-08-24T22:59:59.000Z"],
    ["greenhouse", greenhouseJob(4003, "Senior Frontend Engineer", { first_published: "2026-10-20T12:00:00" }), "2026-10-20T12:00:00.000Z"],
  ] as const)("posted-date:128 %s value gives %s", async (source, job, instant) => {
    await discover(source, job)
    expect(iso((await stored()).posted_at)).toBe(instant)
  })

  it.each([
    ["2026-08-24T23:30:00", true],
    ["2026-08-24T22:59:59", false],
  ])("posted-date:142 Remotive %s near the 60-day boundary: visible %s", async (value, visible) => {
    await discover("remotive", remotiveJob(905, "Senior Frontend Engineer", value))
    const page = await list(ada, "tab=all")
    if (visible) expect(page.postings).toHaveLength(1)
    else expect(page.hiddenCounts.olderThan60Days).toBe(1)
  })
})

describe("AC-5.3 @AC-5.3 updated-only dates and no-fallback sources (posted-date:156-202)", () => {
  it("posted-date:156 Greenhouse with only updated_at stores basis updated", async () => {
    await discover("greenhouse", greenhouseJob(4004, "Senior Frontend Engineer", { updated_at: "2026-10-22T10:00:00Z" }))
    expect(await stored()).toMatchObject({ posted_date_kind: "updated" })
    expect(iso((await stored()).posted_at)).toBe("2026-10-22T10:00:00.000Z")
  })

  it("posted-date:163 an invalid published field falls back to a valid updated field", async () => {
    await discover("greenhouse", greenhouseJob(4005, "Senior Frontend Engineer", { first_published: "1999-12-31T22:00:00Z", updated_at: "2026-10-22T10:00:00Z" }))
    expect(await stored()).toMatchObject({ posted_date_kind: "updated" })
  })

  it.each([
    ["lever", leverJob("lv-x", "Senior Frontend Engineer", "garbage")],
    ["ashby", ashbyJob("as-x", "Senior Frontend Engineer", "garbage")],
  ] as const)("posted-date:170 ATS source %s with no valid published field: undated, hidden, not_checked, no model call", async (source, job) => {
    await discover(source, job)
    const row = await stored()
    expect(row.posted_at).toBeNull()
    expect(row.posted_date_kind).toBeNull()
    expect((await statusOf(database.db, adaId, row.id)).status).toBe("not_checked")
    expect((await list(ada, "tab=all")).hiddenCounts.undated).toBe(1)
    expect(anthropic.requests).toHaveLength(0)
  })

  it.each([
    ["himalayas", himalayasJob("hm-x", "Senior Frontend Engineer", { pubDate: "garbage" })],
    ["remoteok", remoteOkJob("ro-x", "Senior Frontend Engineer", { date: "garbage", epoch: "garbage" })],
    ["remotive", remotiveJob(906, "Senior Frontend Engineer", "garbage")],
    ["weworkremotely", wwrItem("acme-x", "Senior Frontend Engineer", "garbage")],
  ] as const)("posted-date r5 (P16) remote board %s, undated and not ATS-resolved: skipped unsupported_application_system, hidden, no model call", async (source, job) => {
    await discover(source, job)
    const row = await stored()
    expect(row.posted_at).toBeNull()
    expect(row.posted_date_kind).toBeNull()
    expect(await statusOf(database.db, adaId, row.id)).toMatchObject({ status: "skipped", skip_reason: "unsupported_application_system" })
    const page = await list(ada, "tab=all")
    expect(page.hiddenCounts.undated).toBe(1)
    expect(page.recheckableCount).toBe(0)
    expect(anthropic.requests).toHaveLength(0)
  })

  it("posted-date:186 an Ashby response with no updatedAt key and publishedAt garbage is undated with no basis", async () => {
    await discover("ashby", ashbyJob("as-y", "Senior Frontend Engineer", "garbage"))
    expect(await stored()).toMatchObject({ posted_at: null, posted_date_kind: null })
  })

  it("posted-date:193 Greenhouse with neither field valid is undated", async () => {
    await discover("greenhouse", greenhouseJob(4006, "Senior Frontend Engineer", { updated_at: "garbage" }))
    expect((await stored()).posted_at).toBeNull()
  })
})

describe("AC-5.2 @AC-5.2 remote boards resolved through an ATS, and pasted links (posted-date:200-236)", () => {
  it("posted-date:201 the board's date wins when present", async () => {
    google.server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/globex/jobs/4012345", () =>
        HttpResponse.json(greenhouseJob(4012345, "Senior Frontend Engineer", { first_published: "2026-10-10T09:00:00Z" }, "globex"))
      )
    )
    await discover("remoteok", remoteOkJob("ro-ats", "Senior Frontend Engineer", { epoch: 1792314000 }, "Apply: https://boards.greenhouse.io/globex/jobs/4012345"))
    const row = await stored()
    expect(iso(row.posted_at)).toBe("2026-10-18T09:00:00.000Z")
    expect(row.posted_date_kind).toBe("published")
  })

  it("posted-date:208 the ATS fields are used when the board has no date", async () => {
    google.server.use(
      http.get("https://api.ashbyhq.com/posting-api/job-board/globex", () => HttpResponse.json({ jobs: [ashbyJob("7f3e", "Senior Frontend Engineer", "2026-10-10T09:00:00.000+00:00", "globex")] }))
    )
    await discover("remotive", remotiveJob(907, "Senior Frontend Engineer", undefined, "Apply at https://jobs.ashbyhq.com/globex/7f3e"))
    const row = await stored()
    expect(iso(row.posted_at)).toBe("2026-10-10T09:00:00.000Z")
    expect(row.posted_date_kind).toBe("published")
  })

  it("posted-date:215 an ATS posting with only updated_at gives basis updated", async () => {
    google.server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/globex/jobs/4012399", () =>
        HttpResponse.json(greenhouseJob(4012399, "Senior Frontend Engineer", { updated_at: "2026-10-21T09:00:00Z" }, "globex"))
      )
    )
    await discover("weworkremotely", wwrItem("acme-ats", "Senior Frontend Engineer", "garbage", "Apply: https://boards.greenhouse.io/globex/jobs/4012399"))
    const row = await stored()
    expect(iso(row.posted_at)).toBe("2026-10-21T09:00:00.000Z")
    expect(row.posted_date_kind).toBe("updated")
  })

  it.each([
    ["https://boards.greenhouse.io/globex/jobs/4012345", "https://boards-api.greenhouse.io/v1/boards/globex/jobs/4012345", greenhouseJob(4012345, "Senior Frontend Engineer", { first_published: "2026-10-20T10:00:00Z" }, "globex"), "2026-10-20T10:00:00.000Z", "published"],
    ["https://boards.greenhouse.io/globex/jobs/4012346", "https://boards-api.greenhouse.io/v1/boards/globex/jobs/4012346", greenhouseJob(4012346, "Senior Frontend Engineer", { updated_at: "2026-10-21T10:00:00Z" }, "globex"), "2026-10-21T10:00:00.000Z", "updated"],
    ["https://jobs.lever.co/globex/abc-123", "https://api.lever.co/v0/postings/globex/abc-123", leverJob("abc-123", "Senior Frontend Engineer", 1792497600000, "globex"), "2026-10-20T12:00:00.000Z", "published"],
    ["https://jobs.ashbyhq.com/globex/7f3e", "https://api.ashbyhq.com/posting-api/job-board/globex", { jobs: [ashbyJob("7f3e", "Senior Frontend Engineer", "2026-10-20T12:00:00.000+00:00", "globex")] }, "2026-10-20T12:00:00.000Z", "published"],
  ] as const)("posted-date:222 a pasted link %s takes the lookup's date", async (link, api, body, instant, basis) => {
    google.server.use(http.get(api, () => HttpResponse.json(body)))
    const pasted = pasteJobLinkResponseSchema.parse((await ada.post("/v1/job-postings/links").send({ url: link }).expect(201)).body)
    await app.get(DiscoveryService).settled()
    expect(pasted.posting).toMatchObject({ postedAt: instant, postedDateKind: basis })
    const facts = await factsOf(database.db, pasted.posting.id)
    expect(iso(facts.posted_at)).toBe(instant)
  })
})

describe("AC-5.4 @AC-5.4 invalid values and validity edges (posted-date:238-330)", () => {
  it.each(["not a date", "", null, "2026-02-30", "2026-13-01T00:00:00Z", "1999-12-31T22:59:59Z", "1970-01-01T00:00:00Z", "2026-10-25T08:00:01Z", "2027-01-01T00:00:00Z", true, {}])(
    "posted-date:238 Greenhouse first_published %j (no updated_at) is undated",
    async (value) => {
      await discover("greenhouse", greenhouseJob(4010, "Senior Frontend Engineer", { first_published: value }))
      expect((await stored()).posted_at).toBeNull()
    }
  )

  it.each([-1, 0, 946681199, 1792915201, "soon", null])("posted-date:258 Himalayas pubDate %j is undated", async (value) => {
    await discover("himalayas", himalayasJob("hm-inv", "Senior Frontend Engineer", { pubDate: value }))
    expect((await stored()).posted_at).toBeNull()
  })

  it.each([-1, 0, 946681199999, 1792915200001, "soon"])("posted-date:273 Lever createdAt %j is undated", async (value) => {
    await discover("lever", leverJob("lv-inv", "Senior Frontend Engineer", value))
    expect((await stored()).posted_at).toBeNull()
  })

  it("posted-date:273 Lever createdAt 1.5e400 (JSON overflow to Infinity) is undated", async () => {
    google.server.use(
      http.get("https://api.lever.co/v0/postings/:token", ({ params }) =>
        params.token === "metabase"
          ? new HttpResponse(`[{"id":"lv-inf","text":"Senior Frontend Engineer","hostedUrl":"https://jobs.lever.co/metabase/lv-inf","descriptionPlain":"Build React features.","createdAt":1.5e400}]`, { headers: { "content-type": "application/json" } })
          : HttpResponse.json([])
      ),
      http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", () => HttpResponse.json({ jobs: [] })),
      http.get("https://api.ashbyhq.com/posting-api/job-board/:token", () => HttpResponse.json({ jobs: [] }))
    )
    await runDaily()
    expect((await stored()).posted_at).toBeNull()
  })

  it.each([
    ["1999-12-31T22:59:59Z", null],
    ["1999-12-31T23:00:00Z", "1999-12-31T23:00:00.000Z"],
    ["1999-12-31T23:30:00", "1999-12-31T23:30:00.000Z"],
    ["2000-01-01T00:00:00Z", "2000-01-01T00:00:00.000Z"],
    ["1999-12-31", null],
    ["2000-01-01", "1999-12-31T23:00:00.000Z"],
  ])("posted-date:289 lower bound: first_published %s gives %s", async (value, instant) => {
    await discover("greenhouse", greenhouseJob(4011, "Senior Frontend Engineer", { first_published: value }))
    expect(iso((await stored()).posted_at)).toBe(instant)
  })

  it.each([
    ["himalayas", himalayasJob("hm-lb1", "Senior Frontend Engineer", { pubDate: 946681199 }), null],
    ["himalayas", himalayasJob("hm-lb2", "Senior Frontend Engineer", { pubDate: 946681200 }), "1999-12-31T23:00:00.000Z"],
    ["lever", leverJob("lv-lb1", "Senior Frontend Engineer", 946681199999), null],
    ["lever", leverJob("lv-lb2", "Senior Frontend Engineer", 946681200000), "1999-12-31T23:00:00.000Z"],
  ] as const)("posted-date:303 epoch lower bound %s gives %s", async (source, job, instant) => {
    await discover(source, job)
    expect(iso((await stored()).posted_at)).toBe(instant)
  })

  it.each([
    [1792828800, READ_AT],
    [1792828801, READ_AT],
    [1792872000, READ_AT],
    [1792915200, READ_AT],
    [1792915201, null],
  ])("posted-date:316 Himalayas pubDate %i up to 24h ahead is stored as the read moment", async (value, instant) => {
    await discover("himalayas", himalayasJob("hm-fut", "Senior Frontend Engineer", { pubDate: value }))
    expect(iso((await stored()).posted_at)).toBe(instant)
  })

  it.each([
    ["2026-10-20", "2026-10-19T23:00:00.000Z"],
    ["2026-08-24", "2026-08-23T23:00:00.000Z"],
    ["2026-10-24", "2026-10-23T23:00:00.000Z"],
    ["2026-10-25", READ_AT],
    ["2026-10-26", null],
  ])("posted-date:330 date-only %s means 00:00 WAT: %s", async (value, instant) => {
    await discover("greenhouse", greenhouseJob(4012, "Senior Frontend Engineer", { first_published: value }))
    expect(iso((await stored()).posted_at)).toBe(instant)
  })

  it("posted-date:525 three new postings store bases published, updated and none", async () => {
    serve("greenhouse", {
      jobs: [
        greenhouseJob(5001, "Senior Frontend Engineer", { first_published: "2026-10-20T10:00:00Z" }),
        greenhouseJob(5002, "Senior Frontend Engineer", { updated_at: "2026-10-21T10:00:00Z" }),
        greenhouseJob(5003, "Senior Frontend Engineer"),
      ],
    })
    await runDaily()
    expect((await stored("GH-5001")).posted_date_kind).toBe("published")
    expect((await stored("GH-5002")).posted_date_kind).toBe("updated")
    expect((await stored("GH-5003")).posted_date_kind).toBeNull()
  })
})

describe("AC-5.5 @AC-5.5 @AC-5.7 @AC-7.1 pasted links: hidden reason, not_checked, no AI (posted-date:352-398, evaluation-of-hidden:52)", () => {
  async function pasteLever(id: string, title: string, createdAt?: unknown) {
    google.server.use(http.get(`https://api.lever.co/v0/postings/globex/${id}`, () => HttpResponse.json(leverJob(id, title, createdAt, "globex"))))
    const response = await ada.post("/v1/job-postings/links").send({ url: `https://jobs.lever.co/globex/${id}` })
    await app.get(DiscoveryService).settled()
    return { status: response.status, body: pasteJobLinkResponseSchema.parse(response.body) }
  }

  it("posted-date:363 an undated pasted link is created, hidden as undated, not_checked, no AI call", async () => {
    const { status, body } = await pasteLever("abc-999", "Senior Frontend Engineer")
    expect(status).toBe(201)
    expect(body).toMatchObject({ created: true, posting: { hiddenReason: "undated", status: "not_checked", postedAt: null, rank: null } })
    expect(anthropic.requests).toHaveLength(0)
    expect(await spendRows()).toBe(0)
  })

  it.each([
    ["data-1", "Senior Data Engineer", 1792497600000, "off_target"],
    ["junior-1", "Junior Frontend Developer", 1792497600000, "below_seniority_floor"],
    ["old-1", "Senior Frontend Engineer", Date.parse("2026-08-01T10:00:00Z"), "older_than_60_days"],
    ["junior-data-undated", "Junior Data Engineer", undefined, "off_target"],
  ])("posted-date:372 a new pasted %s is hidden with reason %s and no AI call", async (id, title, createdAt, reason) => {
    const { body } = await pasteLever(id, title, createdAt)
    expect(body.posting.hiddenReason).toBe(reason)
    expect(anthropic.requests).toHaveLength(0)
  })

  it("posted-date:385 re-pasting a known hidden link: created false, hiddenReason undated, one posting, no fetch", async () => {
    await pasteLever("abc-999", "Senior Frontend Engineer")
    outbound.reset()
    const again = await ada.post("/v1/job-postings/links").send({ url: "https://jobs.lever.co/globex/abc-999" }).expect(200)
    expect(pasteJobLinkResponseSchema.parse(again.body)).toMatchObject({ created: false, posting: { hiddenReason: "undated" } })
    expect(outbound.urls).toEqual([])
    expect((await sql<{ n: string }>`select count(*) as n from job_posting`.execute(database.db)).rows[0]!.n).toBe("1")
  })

  it("posted-date:393 a visible pasted link has no hidden reason and is evaluated", async () => {
    anthropic.replyWithObject(STRONG)
    const { body } = await pasteLever("fe-1", "Senior Frontend Engineer", 1792497600000)
    expect(body.posting.hiddenReason).toBeNull()
    expect(anthropic.requests).toHaveLength(1)
  })

  it("evaluation-of-hidden:52 a hidden pasted Solutions Architect makes no model call and is not_checked", async () => {
    const { body } = await pasteLever("sa-1", "Solutions Architect", 1792497600000)
    expect(body.posting).toMatchObject({ status: "not_checked", roleFamily: "solutions_customer", hiddenReason: "off_target" })
    expect(anthropic.requests).toHaveLength(0)
  })
})

describe("AC-5.6 @AC-5.6 @AC-5.8 backfill (posted-date:402-523, per-candidate:205-245)", () => {
  async function storedUndated(requisitionNum: number, state: Parameters<typeof hold>[3], over: Parameters<typeof insertPosting>[1] = {}) {
    const id = await insertPosting(database.db, { postedAt: null, title: "Senior Frontend Engineer", company: "Globex", requisitionId: `GH-${requisitionNum}`, ...over })
    // Shared row must match the Greenhouse requisition key (application_url, requisition_id).
    await sql`update job_posting set application_url = ${`https://boards.greenhouse.io/canonical/jobs/${requisitionNum}`}, apply_url = ${`https://boards.greenhouse.io/canonical/jobs/${requisitionNum}`} where id = ${id}`.execute(database.db)
    await hold(database.db, adaId, id, state)
    return id
  }

  it("posted-date:405 a discovery read backfills the date and changes nothing else", async () => {
    const id = await storedUndated(4012345, { status: "evaluation_failed", evaluationFailure: "not_configured" })
    const before = JSON.parse(await snapshotPosting(database.db, id)) as Record<string, unknown>[][]
    serve("greenhouse", { jobs: [greenhouseJob(4012345, "Senior Frontend Engineer", { first_published: "2026-10-10T09:00:00Z" })] })
    await runDaily()
    const after = JSON.parse(await snapshotPosting(database.db, id)) as Record<string, unknown>[][]
    expect(after[0]![0]).toMatchObject({ posted_at: "2026-10-10T09:00:00.000Z", posted_date_kind: "published" })
    const { posted_at: _a, posted_date_kind: _b, ...restAfter } = after[0]![0]!
    const { posted_at: _c, posted_date_kind: _d, ...restBefore } = before[0]![0]!
    void [_a, _b, _c, _d]
    expect(restAfter).toEqual(restBefore)
    expect(after[1]).toEqual(before[1])
    expect(anthropic.requests).toHaveLength(0)
  })

  it("posted-date:414 a backfill with only updated_at writes basis updated", async () => {
    const id = await storedUndated(77, { status: "not_checked" })
    serve("greenhouse", { jobs: [greenhouseJob(77, "Senior Frontend Engineer", { updated_at: "2026-10-15T09:00:00Z" })] })
    await runDaily()
    expect(await factsOf(database.db, id)).toMatchObject({ posted_date_kind: "updated" })
  })

  it("posted-date:421 a Himalayas backfill reads pubDate as epoch seconds", async () => {
    const id = await insertPosting(database.db, { postedAt: null, requisitionId: "HM-54", origin: "remote_board", applyMode: "manual" })
    const link = "https://himalayas.app/companies/acme/jobs/HM-54"
    await sql`update job_posting set application_url = ${link}, apply_url = ${link} where id = ${id}`.execute(database.db)
    await hold(database.db, adaId, id, { status: "skipped", skipReason: "unsupported_application_system" })
    await discover("himalayas", himalayasJob("HM-54", "Senior Frontend Engineer", { pubDate: 1792497600 }, link))
    expect(iso((await factsOf(database.db, id)).posted_at)).toBe("2026-10-20T12:00:00.000Z")
  })

  it("posted-date:428 a stored posted date is never overwritten", async () => {
    const id = await storedUndated(4012345, { status: "ranked" }, { postedAt: new Date("2026-10-10T09:00:00Z"), kind: "updated" })
    serve("greenhouse", { jobs: [greenhouseJob(4012345, "Senior Frontend Engineer", { first_published: "2026-09-01T09:00:00Z" })] })
    await runDaily()
    expect(await factsOf(database.db, id)).toMatchObject({ posted_date_kind: "updated" })
    expect(iso((await factsOf(database.db, id)).posted_at)).toBe("2026-10-10T09:00:00.000Z")
  })

  it("posted-date:442 a source that no longer lists the posting leaves it undated and hidden", async () => {
    const id = await storedUndated(999, { status: "ranked" })
    serve("greenhouse", { jobs: [] })
    await runDaily()
    expect((await factsOf(database.db, id)).posted_at).toBeNull()
    expect((await list(ada, "tab=all")).hiddenCounts.undated).toBe(1)
  })

  it("posted-date:450 re-pasting a known undated link makes no fetch and backfills nothing", async () => {
    const id = await insertPosting(database.db, { postedAt: null, requisitionId: "abc-999", origin: "pasted_link" })
    await sql`update job_posting set application_url = 'https://jobs.lever.co/globex/abc-999', apply_url = 'https://jobs.lever.co/globex/abc-999', application_system = 'lever' where id = ${id}`.execute(database.db)
    await hold(database.db, adaId, id, { status: "not_checked" })
    // Q-3: fail every OUTBOUND request only; the supertest call to the app on loopback must pass.
    google.server.use(
      http.all(/^https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/, () => HttpResponse.error())
    )
    await ada.post("/v1/job-postings/links").send({ url: "https://jobs.lever.co/globex/abc-999" }).expect(200)
    expect(outbound.urls).toEqual([])
    expect((await factsOf(database.db, id)).posted_at).toBeNull()
  })

  it("posted-date:459 a not_checked posting a backfill makes visible is claimed and queued by that run", async () => {
    const id = await storedUndated(4012345, { status: "not_checked" })
    serve("greenhouse", { jobs: [greenhouseJob(4012345, "Senior Frontend Engineer", { first_published: "2026-10-10T09:00:00Z" })] })
    const summary = await runDaily()
    expect(summary.postingIdsToEvaluate).toEqual([id])
    expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
  })

  it.each([
    ["skipped weak_core_match", { status: "skipped", skipReason: "weak_core_match", covered: 5 }, "skipped"],
    ["evaluation_failed not_configured", { status: "evaluation_failed", evaluationFailure: "not_configured" }, "evaluation_failed"],
  ] as const)("posted-date:468 / :476 a backfilled %s posting is not queued by the run", async (_label, state, status) => {
    const id = await storedUndated(4012345, state)
    serve("greenhouse", { jobs: [greenhouseJob(4012345, "Senior Frontend Engineer", { first_published: "2026-10-10T09:00:00Z" })] })
    const summary = await runDaily()
    expect(summary.postingIdsToEvaluate).toEqual([])
    expect((await statusOf(database.db, adaId, id)).status).toBe(status)
    expect(anthropic.requests).toHaveLength(0)
    if (status === "evaluation_failed") expect((await list(ada, "tab=all")).recheckableCount).toBe(1)
  })

  it("posted-date:485 a backfill that dates a posting still hidden as off-target queues nothing", async () => {
    const id = await storedUndated(55, { status: "not_checked" }, { title: "Senior Data Engineer", family: "data_ml" })
    serve("greenhouse", { jobs: [greenhouseJob(55, "Senior Data Engineer", { first_published: "2026-10-10T09:00:00Z" })] })
    const summary = await runDaily()
    expect(iso((await factsOf(database.db, id)).posted_at)).toBe("2026-10-10T09:00:00.000Z")
    expect(summary.postingIdsToEvaluate).toEqual([])
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
  })

  it("posted-date:494 a backfill dating a posting older than 60 days queues nothing", async () => {
    const id = await storedUndated(56, { status: "not_checked" })
    serve("greenhouse", { jobs: [greenhouseJob(56, "Senior Frontend Engineer", { first_published: "2026-07-01T09:00:00Z" })] })
    const summary = await runDaily()
    expect(summary.postingIdsToEvaluate).toEqual([])
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    expect((await list(ada, "tab=all")).hiddenCounts.olderThan60Days).toBe(1)
  })

  it("posted-date:524 (r6 Q3-1) @AC-5.8 @AC-7.10 a posting a backfill queued waits when the cost pause starts before it is evaluated: no model call, no spend, waiting_to_be_checked", async () => {
    // Gherkin r6 order: the run backfills and queues the posting, then paid automation is paused for the cost
    // ceiling, then evaluation reaches the queued posting. (A run does not start during the cost pause.)
    const id = await storedUndated(57, { status: "not_checked" })
    serve("greenhouse", { jobs: [greenhouseJob(57, "Senior Frontend Engineer", { first_published: "2026-10-10T09:00:00Z" })] })
    const summary = await runDaily()
    expect(summary.postingIdsToEvaluate).toEqual([id])
    await database.db.updateTable("control_state").set({ cost_paused: true, cost_paused_month: "2026-10-01" }).execute()
    for (const queued of summary.postingIdsToEvaluate) await evaluateAs(adaId, queued)
    expect(anthropic.requests).toHaveLength(0)
    expect(await spendRows()).toBe(0)
    expect((await statusOf(database.db, adaId, id)).status).toBe("waiting_to_be_checked")
  })

  it("posted-date:516 two discovery reads write the date once and queue at most once", async () => {
    const id = await storedUndated(4012345, { status: "not_checked" })
    serve("greenhouse", { jobs: [greenhouseJob(4012345, "Senior Frontend Engineer", { first_published: "2026-10-10T09:00:00Z" })] })
    const first = await runDaily()
    await database.db.updateTable("employer_board").set({ last_read_at: null }).execute()
    const second = await runDaily()
    expect([...first.postingIdsToEvaluate, ...second.postingIdsToEvaluate]).toEqual([id])
  })

  it("per-candidate:205 / :213 a backfill from Ada's run dates the posting for Kofi too, and queues only Ada's row", async () => {
    const id = await storedUndated(4012345, { status: "not_checked" })
    await hold(database.db, kofiId, id, { status: "not_checked" })
    serve("greenhouse", { jobs: [greenhouseJob(4012345, "Senior Frontend Engineer", { first_published: "2026-10-10T09:00:00Z" })] })
    const summary = await runDaily()
    expect(summary.postingIdsToEvaluate).toEqual([id])
    expect((await statusOf(database.db, adaId, id)).status).toBe("checking")
    expect((await statusOf(database.db, kofiId, id)).status).toBe("not_checked")
    expect(await queuedEvaluations(database.db)).toEqual([])
  })

  it("per-candidate:236 a backfill that makes a posting visible only for Kofi queues nothing", async () => {
    const id = await storedUndated(55, { status: "not_checked" }, { title: "Senior Data Engineer", family: "data_ml" })
    await hold(database.db, kofiId, id, { status: "not_checked" })
    await setCriteria(database.db, kofiId, { targets: [...DEFAULT_TARGETS, "data_ml"] })
    serve("greenhouse", { jobs: [greenhouseJob(55, "Senior Data Engineer", { first_published: "2026-10-10T09:00:00Z" })] })
    const summary = await runDaily()
    expect(summary.postingIdsToEvaluate).toEqual([])
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    expect((await statusOf(database.db, kofiId, id)).status).toBe("not_checked")
  })
})

describe("AC-7.1 @AC-7.1 @AC-7.10 hidden postings start not_checked and the evaluator gate spends nothing (evaluation-of-hidden-postings.feature)", () => {
  it.each([
    ["Solutions Architect", 1792497600000],
    ["Senior Data Engineer", 1792497600000],
    ["Junior Frontend Developer", 1792497600000],
    ["Senior Frontend Engineer", undefined],
    ["Senior Frontend Engineer", Date.parse("2026-08-01T10:00:00Z")],
  ])("evaluation-of-hidden:30 a new hidden %s (createdAt %j) is not_checked, not queued, no call, no spend", async (title, createdAt) => {
    await discover("lever", leverJob("hid-1", title, createdAt))
    const row = await stored()
    expect((await statusOf(database.db, adaId, row.id)).status).toBe("not_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await spendRows()).toBe(0)
  })

  it("evaluation-of-hidden:45 a visible new posting is evaluated once with one reservation", async () => {
    serve("lever", [leverJob("vis-1", "Senior Frontend Engineer", 1792497600000)])
    const summary = await runDaily()
    expect(summary.postingIdsToEvaluate).toHaveLength(1)
    anthropic.replyWithObject(STRONG)
    expect(await evaluateAs(adaId, summary.postingIdsToEvaluate[0]!)).toBe("evaluated")
    expect(anthropic.requests).toHaveLength(1)
    expect(await spendRows()).toBeGreaterThan(0)
  })

  it.each([
    ["checking (new)", { status: "checking" }, "not_checked", null],
    ["not_checked via Check again", { status: "checking" }, "not_checked", null],
    ["evaluation_failed provider_error via Check again", { status: "checking", evaluationFailure: "provider_error" }, "evaluation_failed", "provider_error"],
    ["evaluation_failed not_configured via Check again", { status: "checking", evaluationFailure: "not_configured" }, "evaluation_failed", "not_configured"],
  ] as const)("evaluation-of-hidden:84 a %s posting hidden before the worker reaches it returns to %s with no call", async (_label, state, after, kind) => {
    const id = await insertPosting(database.db, { title: "Senior Data Engineer at Initech", family: "data_ml" })
    await hold(database.db, adaId, id, state)
    const before = await snapshotPosting(database.db, id)
    const result = await evaluateAs(adaId, id)
    expect(result).toBe("hidden")
    expect(anthropic.requests).toHaveLength(0)
    expect(await spendRows()).toBe(0)
    expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: after, evaluation_failure: kind })
    const now = JSON.parse(await snapshotPosting(database.db, id)) as unknown[][]
    expect(now[0]).toEqual((JSON.parse(before) as unknown[][])[0])
  })

  it.each([
    ["off-target", { title: "Senior Platform Engineer", family: "platform_engineering" as const }, () => setCriteria(database.db, adaId, { targets: DEFAULT_TARGETS.filter((f) => f !== "platform_engineering") })],
    ["aged past 60 days", { postedAt: wat("2026-08-25") }, async () => clock.set("2026-10-25T09:00:00+01:00")],
  ])("evaluation-of-hidden:62 / :70 / :109 a waiting posting found hidden (%s) at a cost-pause release stays waiting", async (_label, over, hide) => {
    const id = await insertPosting(database.db, over)
    await hold(database.db, adaId, id, { status: "waiting_to_be_checked" })
    await hide()
    expect(await evaluateAs(adaId, id)).toBe("hidden")
    expect(anthropic.requests).toHaveLength(0)
    expect((await statusOf(database.db, adaId, id)).status).toBe("waiting_to_be_checked")
    expect((await list(ada, "tab=all")).waitingToBeCheckedCount).toBe(0)
  })

  it.each([
    ["evaluation_failed timed_out", { status: "checking", evaluationFailure: "timed_out" }, "evaluation_failed", "timed_out"],
    ["not_checked", { status: "checking" }, "not_checked", null],
  ] as const)("evaluation-of-hidden:118 / :126 a %s posting queued at 23:58 that ages past 60 at 00:01 returns with no call", async (_l, state, after, kind) => {
    const id = await insertPosting(database.db, { postedAt: wat("2026-08-25") })
    await hold(database.db, adaId, id, state)
    clock.set("2026-10-25T00:01:00+01:00")
    expect(await evaluateAs(adaId, id)).toBe("hidden")
    expect(anthropic.requests).toHaveLength(0)
    expect(await statusOf(database.db, adaId, id)).toMatchObject({ status: after, evaluation_failure: kind })
  })

  it("evaluation-of-hidden:134 a posting returned to not_checked counts toward Check again once visible again", async () => {
    const id = await insertPosting(database.db, { title: "Senior Data Engineer at Initech", family: "data_ml" })
    await hold(database.db, adaId, id, { status: "checking" })
    await evaluateAs(adaId, id)
    await setCriteria(database.db, adaId, { targets: [...DEFAULT_TARGETS, "data_ml"] })
    const page = await list(ada, "tab=all")
    expect(page.postings.find((p) => p.id === id)?.status).toBe("not_checked")
    expect(page.recheckableCount).toBe(1)
  })

  it("evaluation-of-hidden:154 a model call in flight when its posting becomes hidden finishes and records ranked", async () => {
    const id = await insertPosting(database.db, { title: "Senior Data Engineer at Initech", family: "data_ml" })
    await setCriteria(database.db, adaId, { targets: [...DEFAULT_TARGETS, "data_ml"] })
    await hold(database.db, adaId, id, { status: "checking" })
    anthropic.onRequest = () => setCriteria(database.db, adaId, { targets: DEFAULT_TARGETS })
    anthropic.replyWithObject(STRONG)
    expect(await evaluateAs(adaId, id)).toBe("evaluated")
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
    expect(await spendRows()).toBeGreaterThan(0)
    expect((await list(ada, "tab=all")).hiddenCounts.offTarget).toBe(1)
  })

  it("evaluation-of-hidden:163 a call that starts before midnight and returns after records its verdict", async () => {
    const id = await insertPosting(database.db, { postedAt: wat("2026-08-25") })
    await hold(database.db, adaId, id, { status: "checking" })
    clock.set("2026-10-24T23:59:50+01:00")
    anthropic.onRequest = async () => clock.set("2026-10-25T00:00:05+01:00")
    anthropic.replyWithObject(STRONG)
    expect(await evaluateAs(adaId, id)).toBe("evaluated")
    expect((await statusOf(database.db, adaId, id)).status).toBe("ranked")
    expect((await list(ada, "tab=all")).hiddenCounts.olderThan60Days).toBe(1)
  })

  it("per-candidate:247 the gate reads the evaluating Candidate's criteria: Ada hidden, Kofi would be visible", async () => {
    const id = await insertPosting(database.db, { title: "Senior Data Engineer at Initech", family: "data_ml" })
    await hold(database.db, adaId, id, { status: "checking" })
    await hold(database.db, kofiId, id, { status: "not_checked" })
    await setCriteria(database.db, kofiId, { targets: [...DEFAULT_TARGETS, "data_ml"] })
    expect(await evaluateAs(adaId, id)).toBe("hidden")
    expect((await statusOf(database.db, adaId, id)).status).toBe("not_checked")
    expect((await statusOf(database.db, kofiId, id)).status).toBe("not_checked")
    expect(anthropic.requests).toHaveLength(0)
  })

  it("evaluation-of-hidden:172 @AC-7.8 every model call goes to the fake with a test key, never a real one", async () => {
    serve("lever", [leverJob("vis-2", "Senior Frontend Engineer", 1792497600000)])
    const summary = await runDaily()
    anthropic.replyWithObject(STRONG)
    await evaluateAs(adaId, summary.postingIdsToEvaluate[0]!)
    expect(anthropic.requests).toHaveLength(1)
    for (const request of anthropic.requests) expect(request.apiKey).not.toMatch(/^sk-ant-api\d\d-[A-Za-z0-9_-]{20,}/)
  })
})

describe("CHK-19 / CHK-21 @AC-5.4 untrusted source dates (threat-model CHK-19, CHK-21, SEC-603)", () => {
  /** Serves a raw JSON body for the canonical Greenhouse board, so keys like __proto__ reach JSON.parse as written. */
  function serveRawGreenhouse(body: string) {
    google.server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/:token/jobs", ({ params }) =>
        params.token === "canonical" ? new HttpResponse(body, { headers: { "content-type": "application/json" } }) : HttpResponse.json({ jobs: [] })
      )
    )
  }

  async function storedByRequisition() {
    const { rows } = await sql<{ requisition_id: string; posted_at: Date | null; posted_date_kind: string | null }>`
      select requisition_id, posted_at, posted_date_kind from job_posting order by requisition_id`.execute(database.db)
    return new Map(rows.map((r) => [r.requisition_id, r]))
  }

  it("CHK-19 one invalid date in a 100-posting source: 99 dated, 1 undated, the source read does not fail", async () => {
    const jobs: Record<string, unknown>[] = Array.from({ length: 100 }, (_, i) =>
      i === 42
        ? // A value a naive parser would throw on or mis-read: an object with toString/valueOf as first_published.
          greenhouseJob(8000 + i, `Senior Frontend Engineer ${i}`, { first_published: { toString: "2026-10-20", valueOf: 1792497600000 }, updated_at: "UPDATED_AT" })
        : greenhouseJob(8000 + i, `Senior Frontend Engineer ${i}`, { first_published: "2026-10-20T10:00:00Z" })
    )
    // ...and an updated_at of 1.5e400, which JSON.parse turns into Infinity.
    const patched = JSON.stringify({ jobs }).replace(`"updated_at":"UPDATED_AT"`, `"updated_at":1.5e400`)
    expect(patched).toContain(`"updated_at":1.5e400`)
    serveRawGreenhouse(patched)
    const summary = await runDaily()
    expect(summary.sourcesFailed).toBe(0)
    expect(summary.stored).toBe(100)
    const rows = await storedByRequisition()
    expect(rows.size).toBe(100)
    const undated = [...rows.values()].filter((r) => r.posted_at === null)
    expect(undated.map((r) => r.requisition_id)).toEqual(["GH-8042"])
    expect([...rows.values()].filter((r) => r.posted_at !== null && r.posted_date_kind === "published")).toHaveLength(99)
  })

  it("CHK-21 __proto__, constructor and prototype keys carrying date fields leave the posting undated and pollute nothing", async () => {
    const job = greenhouseJob(8100, "Senior Frontend Engineer")
    const raw = JSON.stringify({ jobs: [job] }).replace(
      `"id":8100,`,
      `"id":8100,"__proto__":{"first_published":"2026-10-20T10:00:00Z","updated_at":"2026-10-20T10:00:00Z","date":"2026-10-20"},"constructor":{"prototype":{"first_published":"2026-10-20T10:00:00Z","date":"2026-10-20"}},"prototype":{"first_published":"2026-10-20T10:00:00Z"},`
    )
    expect(raw).toContain(`"__proto__":{`)
    serveRawGreenhouse(raw)
    const summary = await runDaily()
    expect(summary.sourcesFailed).toBe(0)
    const row = (await storedByRequisition()).get("GH-8100")!
    expect(row).toMatchObject({ posted_at: null, posted_date_kind: null })
    const probe: Record<string, unknown> = {}
    expect(probe.date).toBeUndefined()
    expect(probe.first_published).toBeUndefined()
    expect(probe.updated_at).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).first_published).toBeUndefined()
  })

  it("CHK-21 a Remote OK item with a __proto__ date is undated and Object.prototype stays clean", async () => {
    await enableRemote("remoteok")
    const item = remoteOkJob("ro-proto", "Senior Frontend Engineer")
    const raw = JSON.stringify([REMOTE_OK_LEGAL, item]).replace(`"id":"ro-proto",`, `"id":"ro-proto","__proto__":{"date":"2026-10-20T12:00:00+00:00","epoch":1792497600},`)
    expect(raw).toContain(`"__proto__":{"date"`)
    google.server.use(http.get("https://remoteok.com/api", () => new HttpResponse(raw, { headers: { "content-type": "application/json" } })))
    const summary = await runDaily()
    expect(summary.sourcesFailed).toBe(0)
    const { rows } = await sql<{ posted_at: Date | null }>`select posted_at from job_posting`.execute(database.db)
    expect(rows).toEqual([{ posted_at: null }])
    expect(({} as Record<string, unknown>).date).toBeUndefined()
    expect(({} as Record<string, unknown>).epoch).toBeUndefined()
  })
})

describe("AC-1.8 @AC-1.8 evaluation changes a stored family only between technical_lead and people_management (role-family-catalog:338-362, CR-2)", () => {
  /** The fake model's job answer with `duties` as the one core responsibility, quoted from the posting text. */
  function replyWithDuties(duties: string) {
    anthropic.replyWithObject({ ...STRONG, coreResponsibilities: [{ text: duties, quote: duties, factId: "F1" }] })
  }

  /** Stores a visible, dated posting with `family` (the store-time family), held `checking` by Ada, and evaluates it. */
  async function evaluateStored(title: string | null, family: NonNullable<Parameters<typeof insertPosting>[1]>["family"], duties: string) {
    await setCriteria(database.db, adaId, { targets: ALL_TARGETS })
    const id = await insertPosting(database.db, { title, family, postingText: `Remote, open to candidates in Nigeria. ${duties}.`, origin: title === null ? "pasted_link" : "employer_board" })
    await hold(database.db, adaId, id, { status: "checking" })
    replyWithDuties(duties)
    expect(await evaluateAs(adaId, id)).toBe("evaluated")
    expect(anthropic.requests).toHaveLength(1)
    return id
  }

  const MANAGEMENT = "Hiring, performance reviews and line management of 12 engineers"
  const HANDS_ON = "Write React and TypeScript code daily and ship features hands-on"

  it("role-family-catalog:338 Engineering Lead (technical_lead) with management duties is stored people_management", async () => {
    const id = await evaluateStored("Engineering Lead", "technical_lead", MANAGEMENT)
    expect((await factsOf(database.db, id)).role_family).toBe("people_management")
  })

  it("role-family-catalog:345 Head of Engineering (people_management) with hands-on duties gets classifyRoleFamily's family for that title and those duties", async () => {
    // "Head of Engineering" is a management title: classifyRoleFamily gives people_management whatever the duties.
    const id = await evaluateStored("Head of Engineering", "people_management", HANDS_ON)
    expect((await factsOf(database.db, id)).role_family).toBe("people_management")
  })

  it("role-family-catalog:338/:345 a lead title moves to people_management on management duties and back to technical_lead on hands-on duties", async () => {
    const id = await evaluateStored("Lead Engineer", "technical_lead", MANAGEMENT)
    expect((await factsOf(database.db, id)).role_family).toBe("people_management")
    // Re-evaluated with hands-on duties (Check again path: back to checking).
    await sql`update candidate_posting set status = 'checking' where candidate_id = ${adaId} and job_posting_id = ${id}`.execute(database.db)
    await sql`update job_posting set posting_text = ${`Remote, open to candidates in Nigeria. ${HANDS_ON}.`} where id = ${id}`.execute(database.db)
    anthropic.reset()
    replyWithDuties(HANDS_ON)
    expect(await evaluateAs(adaId, id)).toBe("evaluated")
    expect((await factsOf(database.db, id)).role_family).toBe("technical_lead")
  })

  it.each([
    ["Senior Software Engineer", "software_engineering", "Build React frontends and lead the team hands-on"],
    ["Senior Data Engineer", "data_ml", "Hiring, performance reviews and line management of 6 engineers"],
    ["Solutions Architect", "solutions_customer", "Write TypeScript services and ship features"],
    ["Senior Platform Engineer", "platform_engineering", "Run SRE on-call and DevOps pipelines"],
    // CR-1 trigger: a non-lead IC title whose evaluated duties are management-only.
    ["Senior Frontend Engineer", "senior_frontend", "Hiring, performance reviews and line management of 6 engineers"],
    ["Senior Backend Engineer", "backend", "Hiring, performance reviews and line management of 6 engineers"],
    // Expected red until Backend's CR-1 fix (wire reconcileRoleFamily into the evaluation write) merges:
    // the Senior Frontend Engineer and Senior Backend Engineer rows are stored people_management today.
  ] as const)("role-family-catalog:351 %s stored %s keeps its family after evaluation returns %j (management-only rows expected red pending CR-1)", async (title, family, duties) => {
    const id = await evaluateStored(title, family, duties)
    expect((await factsOf(database.db, id)).role_family).toBe(family)
  })

  it("role-family-catalog:262 an untitled posting (stored with a null family, as the store path writes) takes the evaluated family", async () => {
    // Untitled: the store path writes role_family null (discovery.repository storePosting); the duty rule alone
    // decides at evaluation (management duties → people_management).
    const id = await evaluateStored(null, null, MANAGEMENT)
    expect((await factsOf(database.db, id)).role_family).toBe("people_management")
  })
})
