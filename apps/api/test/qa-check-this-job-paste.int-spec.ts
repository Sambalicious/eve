import type { INestApplication } from "@nestjs/common"
import { jobPostingDetailSchema, pasteJobLinkResponseSchema } from "@eve/contracts"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { DiscoveryService } from "../src/discovery/discovery.service.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA-owned gap test (EPIC-0007 Phase 2 gate, run epic-0007-p2; repair wave 1 of
 * run epic-0007-p1 aligns it to check-this-job.feature r3, owner decisions D10
 * and D11). Phase 2 adds no API change: "Check this job" sends the existing
 * POST /v1/job-postings/links request. Covered here:
 *
 *   - :245 the API treats a linkedin.com URL as today: pasted_link, skipped as
 *     unsupported_application_system, no outbound request, no AI call; r3: it is
 *     hidden as undated (hiddenReason "undated").
 *   - :92 (Outline, api part) a hidden new link is stored not_checked with the
 *     first hidden reason and no AI call; :112 a known hidden link answers
 *     created false with no ATS request.
 *   - :260 the same URL pasted twice by the same Candidate (both forms send this
 *     request) gives the same stored result after the first is removed.
 *   - :269 (D11) before EPIC-0002 slice D the Operator's row is evaluated and the
 *     invitee's waits, each in their own row, with no model call for the invitee.
 *   - :284 (D11) the invitee's waiting row does not change when the Operator's
 *     row for the same URL is evaluated.
 *   - outbound-and-separation.feature :85 during the cost pause a visible paste
 *     is saved and waits, with no ai_call row and no spend entry.
 *
 * QA-P1-T-07: every "visible posting" stub carries a posted date inside the
 * 60-day window of the test clock (2026-10-24), a Frontend title and no
 * entry-level marker; both Candidates target Frontend with the default
 * seniority setting (the r3 Background).
 */
let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let ada: SignedInCandidate
let bola: SignedInCandidate
let bolaId: string
const clock = new TestClock("2026-10-24T09:00:00.000Z")
const BOLA_SUB = "200000000000000000707"
const BOLA_EMAIL = "bola.qa@example.test"

const GREENHOUSE_URL = "https://boards.greenhouse.io/acme/jobs/4012345"
const LINKEDIN_URL = "https://www.linkedin.com/jobs/view/3999999999"
const POSTING_TEXT =
  "Remote, open to candidates in Nigeria. Salary USD 60,000–80,000 per year. Core hours 10:00–18:00 WAT. Acme builds payment APIs for merchants. Build React features. Mentor engineers."

const SECTIONS = [
  {
    id: "s1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021-2024",
    sourceQuote: null,
    facts: [
      { id: "F1", text: "Built a React and TypeScript merchant dashboard from scratch to production", sourceQuote: null },
      { id: "F3", text: "Mentored 6 junior developers", sourceQuote: null },
    ],
  },
]

const STRONG_EXTRACTION = {
  workArrangement: "remote",
  locationQuote: "Remote, open to candidates in Nigeria",
  relocationCountry: null,
  relocationQuote: null,
  sponsorshipQuote: null,
  payQuote: "Salary USD 60,000–80,000 per year",
  hoursQuote: "Core hours 10:00–18:00 WAT",
  employerBusiness: "payment APIs for merchants",
  businessQuote: "Acme builds payment APIs for merchants",
  employmentType: null,
  coreResponsibilities: [
    { text: "Build React features", quote: "Build React features", factId: "F1" },
    { text: "Mentor engineers", quote: "Mentor engineers", factId: "F3" },
  ],
  mandatoryPrerequisites: [],
  niceToHave: [],
}

/** r3 "visible posting": dated 2026-10-20 (4 days before the test clock), Frontend, mid-or-higher. */
const greenhousePosting = () =>
  http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345", () =>
    HttpResponse.json({ id: 4012345, title: "Senior Frontend Engineer", absolute_url: GREENHOUSE_URL, requisition_id: "4012345", company_name: "Acme", location: { name: "Remote" }, content: POSTING_TEXT, first_published: "2026-10-20T10:00:00Z" })
  )

/** check-this-job.feature r3 CTJ:92 rows: link, ATS API URL, stub body, expected first hidden reason. */
const HIDDEN_ROWS = [
  { link: "https://jobs.lever.co/acme/fe-undated-1", api: "https://api.lever.co/v0/postings/acme/fe-undated-1", body: { id: "fe-undated-1", text: "Senior Frontend Engineer", hostedUrl: "https://jobs.lever.co/acme/fe-undated-1", descriptionPlain: "Remote." }, reason: "undated" },
  { link: "https://boards.greenhouse.io/acme/jobs/4019001", api: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4019001", body: { id: 4019001, title: "Senior Data Engineer", absolute_url: "https://boards.greenhouse.io/acme/jobs/4019001", requisition_id: "4019001", company_name: "Acme", content: "Remote.", first_published: "2026-10-20T10:00:00Z" }, reason: "off_target" },
  { link: "https://jobs.ashbyhq.com/beta/0a1b2c3d-0000-1111-2222-333344440001", api: "https://api.ashbyhq.com/posting-api/job-board/beta", body: { jobs: [{ id: "0a1b2c3d-0000-1111-2222-333344440001", title: "Junior Frontend Developer", jobUrl: "https://jobs.ashbyhq.com/beta/0a1b2c3d-0000-1111-2222-333344440001", isListed: true, descriptionPlain: "Remote.", publishedAt: "2026-10-20T10:00:00Z" }] }, reason: "below_seniority_floor" },
  { link: "https://jobs.lever.co/acme/fe-old-1", api: "https://api.lever.co/v0/postings/acme/fe-old-1", body: { id: "fe-old-1", text: "Senior Frontend Engineer", hostedUrl: "https://jobs.lever.co/acme/fe-old-1", descriptionPlain: "Remote.", createdAt: Date.parse("2026-08-01T10:00:00Z") }, reason: "older_than_60_days" },
  { link: "https://jobs.lever.co/acme/data-undated-1", api: "https://api.lever.co/v0/postings/acme/data-undated-1", body: { id: "data-undated-1", text: "Senior Data Engineer", hostedUrl: "https://jobs.lever.co/acme/data-undated-1", descriptionPlain: "Remote." }, reason: "off_target" },
] as const

async function paste(who: SignedInCandidate, url: string) {
  const response = await who.post("/v1/job-postings/links").send({ url })
  await app.get(DiscoveryService).settled()
  return response
}

/** The outcome fields check-this-job.feature r3 :260 compares. Ids and timestamps are per paste by design. */
function outcome(detail: ReturnType<typeof jobPostingDetailSchema.parse>) {
  return {
    origin: detail.origin,
    status: detail.status,
    skipReason: detail.skipReason,
    skipDetail: detail.skipDetail,
    evaluationFailure: detail.evaluationFailure,
    roleFamily: detail.roleFamily,
    rank: detail.rank,
    applyMode: detail.applyMode,
    unverifiedLabels: detail.unverifiedLabels,
    technologies: detail.technologies,
    technologiesNotChecked: detail.technologiesNotChecked,
    hiddenReason: detail.hiddenReason,
    eligibility: detail.eligibility && { arrangement: detail.eligibility.arrangement, rules: detail.eligibility.rules, normalizedMonthlyMaxUsd: detail.eligibility.normalizedMonthlyMaxUsd },
    match: detail.match && { verdict: detail.match.verdict, coveredCount: detail.match.coveredCount, totalCount: detail.match.totalCount, thresholdPercent: detail.match.thresholdPercent, careerProfileVersion: detail.match.careerProfileVersion },
  }
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))

  bolaId = (await database.db.insertInto("candidate").values({ email: BOLA_EMAIL, google_sub: BOLA_SUB, role: "candidate", onboarded_at: new Date() } as never).returning("id").executeTakeFirstOrThrow()).id
  await database.db.insertInto("job_criteria").values({ candidate_id: bolaId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: BOLA_SUB, email: BOLA_EMAIL, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  bola = new (ada.constructor as typeof SignedInCandidate)(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, BOLA_EMAIL)

  // Identical settings and Career Profiles for both Candidates.
  await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  for (const candidateId of [database.operatorId, bolaId]) {
    // r3 Background: target Frontend with the default seniority setting (hide entry-level).
    await database.db.updateTable("job_criteria").set({ min_core_match_percent: 70, frameworks: [], technologies: [], target_role_families: ["senior_frontend"], seniority_floor: "hide_entry_level" }).where("candidate_id", "=", candidateId).execute()
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: candidateId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(SECTIONS), created_at: new Date(), approved_at: new Date() })
      .execute()
  }
})

beforeEach(async () => {
  await app.get(DiscoveryService).settled()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  outbound.reset()
  for (const table of ["ai_call", "match_evidence", "eligibility_result", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("check-this-job.feature :245 a direct API paste of a linkedin.com URL is handled as today", () => {
  it("stores one pasted_link posting skipped as unsupported_application_system and hidden as undated, with no outbound request and no AI call", async () => {
    const response = await paste(ada, LINKEDIN_URL)
    expect(response.status).toBe(201)
    const pasted = pasteJobLinkResponseSchema.parse(response.body)
    expect(pasted).toMatchObject({ created: true, posting: { origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system", applyMode: "manual", postedAt: null, hiddenReason: "undated" } })
    expect(outbound.urls).toEqual([])
    expect(anthropic.requests).toHaveLength(0)

    const rows = await database.db.selectFrom("candidate_posting").select(["candidate_id", "origin", "status", "skip_reason"]).execute()
    expect(rows).toEqual([{ candidate_id: database.operatorId, origin: "pasted_link", status: "skipped", skip_reason: "unsupported_application_system" }])

    // CTJ:217 (api part): the same request again is created false, same posting, still hidden as undated, nothing new.
    const again = await paste(ada, LINKEDIN_URL)
    expect(again.status).toBe(200)
    expect(pasteJobLinkResponseSchema.parse(again.body)).toMatchObject({ created: false, posting: { id: pasted.posting.id, hiddenReason: "undated" } })
    expect(await database.db.selectFrom("candidate_posting").select("job_posting_id").execute()).toHaveLength(1)
    expect(outbound.urls).toEqual([])
  })
})

describe("check-this-job.feature :92 (api part) a new link hidden for her is stored not_checked with the first hidden reason", () => {
  it.each(HIDDEN_ROWS)("$link → not_checked, hiddenReason $reason, no AI call", async ({ link, api, body, reason }) => {
    google.server.use(http.get(api, () => HttpResponse.json(body)))
    const response = await paste(ada, link)
    expect(response.status).toBe(201)
    const pasted = pasteJobLinkResponseSchema.parse(response.body)
    expect(pasted).toMatchObject({ created: true, posting: { origin: "pasted_link", status: "not_checked", hiddenReason: reason } })
    expect(anthropic.requests).toHaveLength(0)
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    const rows = await database.db.selectFrom("candidate_posting").select(["candidate_id", "origin", "status"]).execute()
    expect(rows).toEqual([{ candidate_id: database.operatorId, origin: "pasted_link", status: "not_checked" }])
  })

  it(":112 a known hidden link answers created false with hiddenReason undated and makes no request to the Lever API", async () => {
    const [row] = HIDDEN_ROWS
    google.server.use(http.get(row.api, () => HttpResponse.json(row.body)))
    const first = pasteJobLinkResponseSchema.parse((await paste(ada, row.link)).body)
    outbound.reset()
    const again = await paste(ada, row.link)
    expect(again.status).toBe(200)
    expect(pasteJobLinkResponseSchema.parse(again.body)).toMatchObject({ created: false, posting: { id: first.posting.id, hiddenReason: "undated" } })
    expect(outbound.urls).toEqual([])
    expect(await database.db.selectFrom("candidate_posting").select("job_posting_id").execute()).toHaveLength(1)
  })
})

describe("outbound-and-separation.feature :85 Phase 2 spends only what the existing pasted-link evaluation spends, under the existing ceilings", () => {
  it("during the cost pause a pasted visible Greenhouse link is saved and waits, with no model call, no ai_call row and no spend entry", async () => {
    await database.db.deleteFrom("spend_entry").execute()
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    google.server.use(greenhousePosting())
    const pasted = pasteJobLinkResponseSchema.parse((await paste(ada, GREENHOUSE_URL)).body)
    expect(pasted).toMatchObject({ created: true, posting: { origin: "pasted_link", hiddenReason: null } })
    // The POST answers before evaluation; after it settles the posting is saved and waiting (as discovery.int-spec "during the cost pause").
    const detail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${pasted.posting.id}`).expect(200)).body)
    expect(detail.status).toBe("waiting_to_be_checked")
    expect(anthropic.requests).toHaveLength(0)
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })
})

describe("check-this-job.feature :260 the same URL pasted twice by the same Candidate gives the same stored result", () => {
  it("Ada's second paste, after the first posting and its records are removed, equals the first in every outcome field", async () => {
    google.server.use(greenhousePosting())
    anthropic.replyWithObject(STRONG_EXTRACTION)
    anthropic.replyWithObject(STRONG_EXTRACTION)

    const first = pasteJobLinkResponseSchema.parse((await paste(ada, GREENHOUSE_URL)).body)
    expect(first).toMatchObject({ created: true, posting: { hiddenReason: null } })
    const recorded = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${first.posting.id}`).expect(200)).body)
    expect(recorded.status).toBe("ranked")

    for (const table of ["ai_call", "match_evidence", "eligibility_result", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()

    const second = pasteJobLinkResponseSchema.parse((await paste(ada, GREENHOUSE_URL)).body)
    expect(second.created).toBe(true)
    const repeated = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${second.posting.id}`).expect(200)).body)
    expect(outcome(repeated)).toEqual(outcome(recorded))
    expect(anthropic.requests).toHaveLength(2)
  })
})

describe("check-this-job.feature :269 and :284 (D11): before EPIC-0002 slice D the Operator's row is evaluated and an invitee's waits", () => {
  it(":269 each Candidate has their own row; equal Role family, technology checks, skip reason and hidden state; Ada evaluated, Bola waiting with no model call", async () => {
    google.server.use(greenhousePosting())
    anthropic.replyWithObject(STRONG_EXTRACTION)

    const first = pasteJobLinkResponseSchema.parse((await paste(ada, GREENHOUSE_URL)).body)
    const requestsAfterAda = anthropic.requests.length
    const second = pasteJobLinkResponseSchema.parse((await paste(bola, GREENHOUSE_URL)).body)
    expect(first.created).toBe(true)
    // Bola has no row of her own yet, so for her the posting is new (tenancy: Ada's row is not revealed).
    expect(second.created).toBe(true)
    expect(second.posting).toMatchObject({ origin: "pasted_link", hiddenReason: null })
    expect(anthropic.requests).toHaveLength(requestsAfterAda)

    const adaDetail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${first.posting.id}`).expect(200)).body)
    const bolaDetail = jobPostingDetailSchema.parse((await bola.get(`/v1/job-postings/${second.posting.id}`).expect(200)).body)
    expect({ roleFamily: bolaDetail.roleFamily, skipReason: bolaDetail.skipReason, hiddenReason: bolaDetail.hiddenReason, technologiesNotChecked: bolaDetail.technologiesNotChecked }).toEqual({
      roleFamily: adaDetail.roleFamily,
      skipReason: adaDetail.skipReason,
      hiddenReason: adaDetail.hiddenReason,
      technologiesNotChecked: adaDetail.technologiesNotChecked,
    })
    expect(adaDetail.status).toBe("ranked")
    expect(adaDetail.eligibility).not.toBeNull()
    expect(adaDetail.match).not.toBeNull()
    expect(bolaDetail.status).toBe("waiting_to_be_checked")
    expect(bolaDetail.eligibility).toBeNull()
    expect(bolaDetail.match).toBeNull()
    expect(await database.db.selectFrom("ai_call").select("id").where("candidate_id", "=", bolaId).execute()).toEqual([])

    const holders = await database.db.selectFrom("candidate_posting").select(["candidate_id", "origin"]).orderBy("candidate_id").execute()
    expect(holders.map((row) => row.origin)).toEqual(["pasted_link", "pasted_link"])
    expect(new Set(holders.map((row) => row.candidate_id))).toEqual(new Set([database.operatorId, bolaId]))
    // Nothing of Ada's status or results reaches Bola's response or detail, and the reverse.
    expect(JSON.stringify(second)).not.toContain('"ranked"')
    expect(JSON.stringify(bolaDetail)).not.toContain('"ranked"')
    expect(JSON.stringify(adaDetail)).not.toContain("waiting_to_be_checked")
    // Only the Greenhouse public API and the model were contacted.
    expect(new Set(outbound.urls.map((url) => new URL(url.split(" ")[1]!).hostname))).toEqual(new Set(["boards-api.greenhouse.io", "api.anthropic.com"]))
  })

  it(":284 Bola's waiting row is unchanged when Ada's row for the same URL is evaluated, and Ada's result does not report Bola", async () => {
    google.server.use(greenhousePosting())
    anthropic.replyWithObject(STRONG_EXTRACTION)

    const bolaPasted = pasteJobLinkResponseSchema.parse((await paste(bola, GREENHOUSE_URL)).body)
    const bolaRow = () => database.db.selectFrom("candidate_posting").selectAll().where("candidate_id", "=", bolaId).executeTakeFirstOrThrow()
    const before = await bolaRow()
    expect(before.status).toBe("waiting_to_be_checked")

    const adaResponse = await paste(ada, GREENHOUSE_URL)
    const adaPasted = pasteJobLinkResponseSchema.parse(adaResponse.body)
    // For Ada the posting is new: the response does not reveal that Bola already holds it.
    expect(adaResponse.status).toBe(201)
    expect(adaPasted.created).toBe(true)
    const adaDetail = jobPostingDetailSchema.parse((await ada.get(`/v1/job-postings/${adaPasted.posting.id}`).expect(200)).body)
    expect(adaDetail.status).toBe("ranked")

    expect(await bolaRow()).toEqual(before)
    const bolaDetail = jobPostingDetailSchema.parse((await bola.get(`/v1/job-postings/${bolaPasted.posting.id}`).expect(200)).body)
    expect(bolaDetail).toMatchObject({ status: "waiting_to_be_checked", eligibility: null, match: null })
    expect(await database.db.selectFrom("eligibility_result").select("job_posting_id").where("candidate_id", "=", bolaId).execute()).toEqual([])
    expect(JSON.stringify(adaResponse.body)).not.toContain(BOLA_EMAIL)
    expect(JSON.stringify(adaResponse.body)).not.toContain(bolaId)
  })
})

/**
 * SEC-P2-03 (security-review.md, threat model P2-2(b) and P2-1(d)): committed form
 * of the Phase 2 Security scratch probes. A pasted loopback, cloud-metadata,
 * redirecting or LinkedIn URL is stored as an unsupported pasted link and makes
 * no request to that host (nor to any non-loopback host); a paste without the
 * CSRF header is refused before anything is stored.
 */
describe("SEC-P2-03: pasted internal, redirecting and LinkedIn hosts make no outbound request", () => {
  const SSRF_URLS = [
    "http://127.0.0.1:5432/",
    "http://localhost:5432/x",
    "http://169.254.169.254/latest/meta-data/",
    "https://redirect.example/job/1",
    "https://www.linkedin.com/posts/x",
    "https://uk.linkedin.com/jobs/view/1",
  ] as const
  const SUSPICIOUS = /^(127\.0\.0\.1:5432|localhost:5432|169\.254\.169\.254|redirect\.example|([a-z0-9-]+\.)*linkedin\.com)$/

  it.each(SSRF_URLS)("%s → 201 pasted_link skipped as unsupported_application_system, no request to it", async (url) => {
    const seen: string[] = []
    const record = ({ request }: { request: Request }) => void seen.push(new URL(request.url).host)
    google.server.events.on("request:start", record)
    // Tripwires: if the api ever fetched these hosts, the handler would answer (and be recorded).
    google.server.use(
      http.all("http://127.0.0.1:5432/*", () => HttpResponse.text("postgres")),
      http.all("http://localhost:5432/*", () => HttpResponse.text("postgres")),
      http.all("http://169.254.169.254/*", () => HttpResponse.text("ami-id")),
      http.all("https://redirect.example/*", () => HttpResponse.redirect(GREENHOUSE_URL, 302)),
      http.all("https://*.linkedin.com/*", () => HttpResponse.text("linkedin")),
      greenhousePosting(),
    )
    try {
      const response = await paste(ada, url)
      expect(response.status).toBe(201)
      expect(pasteJobLinkResponseSchema.parse(response.body)).toMatchObject({ created: true, posting: { origin: "pasted_link", status: "skipped", skipReason: "unsupported_application_system" } })
    } finally {
      google.server.events.removeListener("request:start", record)
    }
    expect(seen.filter((host) => SUSPICIOUS.test(host))).toEqual([])
    expect(outbound.urls).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
  })

  it("a paste with the session but no CSRF header → 403 csrf_invalid, nothing stored, no outbound request", async () => {
    google.server.use(greenhousePosting())
    const response = await new Browser(app, google).http().post("/v1/job-postings/links").set("cookie", ada.cookie).send({ url: GREENHOUSE_URL })
    await app.get(DiscoveryService).settled()
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ error: { code: "csrf_invalid" } })
    expect(await database.db.selectFrom("job_posting").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("candidate_posting").select("job_posting_id").execute()).toEqual([])
    expect(outbound.urls).toEqual([])
  })
})
