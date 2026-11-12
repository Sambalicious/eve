import type { INestApplication } from "@nestjs/common"
import {
  ALERT_FEEDS_PATH,
  HIRING_ALERT_FEEDS_PATH,
  HIRING_FEED_VERIFICATION_PATH,
  HIRING_POSTS_PATH,
  HIRING_SEARCH_INPUTS_PATH,
  hiringAlertFeedsResponseSchema,
  hiringPostsResponseSchema,
  JOB_CRITERIA_PATH,
  STACK_POSTS_PATH,
  alertFeedsResponseSchema,
  hiringSearchInputsResponseSchema,
  jobCriteriaResponseSchema,
  stackPostsResponseSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { DiscoveryService as PostingsService } from "../src/discovery/discovery.service.js"
import { JobCriteriaService } from "../src/job-criteria/job-criteria.service.js"
import { HiringPostsController } from "../src/stack-posts/hiring-posts.controller.js"
import { HiringPostsService } from "../src/stack-posts/hiring-posts.service.js"
import { StackPostsController } from "../src/stack-posts/stack-posts.controller.js"
import { StackPostsService } from "../src/stack-posts/stack-posts.service.js"
import { Browser } from "./support/browser.js"
import { insertCandidatePosting } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { CROSS_CANDIDATE_CASES, PUBLIC_ROUTES, SLICE_7_ROUTES } from "./cross-candidate.cases.js"
import { GUARDED_ROUTES } from "./converted-feature.cases.js"
import { routeTable } from "./support/route-table.js"
import { ROLE_RELEVANCE_DEFAULTS } from "./support/job-criteria-body.js"

/**
 * EPIC-0002 cross-Candidate 404 registry (architecture r4; r5-addendum "Routes
 * added to the 404 registry"). Part 1 enumerates the api's routes from Nest's
 * controller metadata and requires a registry entry for every authenticated
 * route (A2), the guard pairing and the public-list complement. The generic
 * cases for every entry run in cross-candidate-registry.int-spec.ts. Part 2 runs each entry's case with two Candidates: the
 * signed-in owner (A, the Operator) and a synthetic invitee (B), whose calls
 * run in B's own scope through the same service and controller code.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let otherId: string
const clock = new TestClock("2026-10-21T09:00:00.000Z")
const OWNER_FEED = "00000000-0000-4000-8000-0000000000e1"
const OWNER_FEED_URL = "https://www.google.com/alerts/feeds/11111111111111111111/2222222222222222222"
const OWNER_POSTING = "00000000-0000-4000-8000-0000000000e2"
const OWNER_HIRING_FEED = "00000000-0000-4000-8000-0000000000e3"
const OWNER_HIRING_FEED_URL = "https://www.google.com/alerts/feeds/33333333333333333333/4444444444444444444"
const asOther = <T>(work: () => Promise<T>) => CandidateScope.run(otherId, work)

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
  for (const table of ["hiring_post", "hiring_post_run", "hiring_alert_feed", "hiring_feed_verification", "stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification", "match_evidence", "eligibility_result", "candidate_posting", "job_posting"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("job_criteria").set({ min_core_match_percent: 70, frameworks: [], technologies: [] }).where("candidate_id", "=", otherId).execute()
  await database.db.updateTable("job_criteria").set({ min_core_match_percent: 85, frameworks: ["React"], technologies: ["TypeScript"] }).where("candidate_id", "=", database.operatorId).execute()
  const at = new Date("2026-10-20T09:00:00.000Z")
  await database.db.insertInto("alert_feed").values({ candidate_id: database.operatorId, id: OWNER_FEED, url: OWNER_FEED_URL, label: "OWNER-LABEL", created_at: at, last_read_at: at, last_failure_reason: null, last_failed_at: null }).execute()
  await database.db
    .insertInto("stack_post")
    .values({ candidate_id: database.operatorId, id: crypto.randomUUID(), canonical_url: "https://www.linkedin.com/posts/owner-registry", kind: "post", title: "OWNER-POST", snippet: "s", published_at: null, matched_technologies: ["React"], source_feed_id: OWNER_FEED, first_seen_at: at })
    .execute()
  const url = "https://boards.greenhouse.io/registry/jobs/1"
  await database.db
    .insertInto("job_posting")
    .values({ id: OWNER_POSTING, application_url: url, requisition_id: "1", apply_url: url, application_system: "Greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "OWNER-POSTING", company: "Acme", posting_text: "Remote.", role_family: "senior_frontend", discovered_at: at })
    .execute()
  await insertCandidatePosting(database.db, database.operatorId, OWNER_POSTING, { status: "ranked", evaluatedAt: at })
  // EPIC-0007 Phase 3: A (the owner) has an own record with a marker basis, a Hiring feed and a Hiring post.
  await database.db.insertInto("hiring_feed_verification").values({ candidate_id: database.operatorId, verified_on: "2026-10-19", verification_basis: "OWNER-BASIS-MARKER", updated_at: at }).execute()
  await database.db.insertInto("hiring_alert_feed").values({ candidate_id: database.operatorId, id: OWNER_HIRING_FEED, url: OWNER_HIRING_FEED_URL, label: "OWNER-HIRING-LABEL", created_at: at, last_read_at: at, last_failure_reason: null, last_failed_at: null }).execute()
  await database.db
    .insertInto("hiring_post")
    .values({ candidate_id: database.operatorId, id: crypto.randomUUID(), canonical_url: "https://www.linkedin.com/posts/owner-hiring-registry", kind: "post", title: "OWNER-HIRING-POST", snippet: "s", published_at: null, matched_technologies: [], source_feed_id: OWNER_HIRING_FEED, first_seen_at: at })
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

const registered = () => CROSS_CANDIDATE_CASES.map((entry) => `${entry.method} ${entry.path}`)

describe("the registry covers every authenticated route (A2; data-isolation.feature:282, :290, :813)", () => {
  it("each authenticated route in Nest's route table has exactly one case, and every case names a mapped route", () => {
    const authenticated = routeTable(app).filter((route) => !route.isPublic).map((route) => route.route)
    expect(new Set(registered()).size).toBe(registered().length)
    expect(authenticated).toEqual([...registered()].sort((a, b) => a.localeCompare(b)))
  })

  it("every route is in the public list or the registry, never both", () => {
    const table = routeTable(app)
    expect(table.filter((route) => route.isPublic).map((route) => route.route)).toEqual([...PUBLIC_ROUTES].sort((a, b) => a.localeCompare(b)))
    for (const route of table) expect([PUBLIC_ROUTES.includes(route.route), registered().includes(route.route)].filter(Boolean)).toHaveLength(1)
  })

  it("names the 9 slice 7 routes (gap G6)", () => {
    for (const route of SLICE_7_ROUTES) expect(registered()).toContain(route)
  })

  it("a route behind ConvertedFeatureGuard is marked guarded and has its 409 case with the same feature (gap G5)", () => {
    const decorated = routeTable(app).filter((route) => route.feature !== undefined).map((route) => `${route.route} ${route.feature}`).sort()
    const second = GUARDED_ROUTES.map((route) => `${route.method} ${route.path} ${route.feature}`).sort()
    const marked = CROSS_CANDIDATE_CASES.filter((entry) => entry.guarded).map((entry) => `${entry.method} ${entry.path}`).sort()
    expect(second).toEqual(decorated)
    expect(marked).toEqual(decorated.map((line) => line.split(" ").slice(0, 2).join(" ")))
  })

  it("a route behind @OperatorOnly() is registered as operator-only", () => {
    const operatorOnly = routeTable(app).filter((route) => route.operatorOnly).map((route) => route.route)
    expect(operatorOnly.length).toBeGreaterThan(0)
    for (const route of operatorOnly) expect(CROSS_CANDIDATE_CASES.find((entry) => `${entry.method} ${entry.path}` === route)?.kind).toBe("operator-only")
  })
})

describe("cross-Candidate cases (B never reads or changes A's rows)", () => {
  it("GET job criteria: B reads B's values, none of A's", async () => {
    const theirs = await asOther(() => app.get(JobCriteriaService).read())
    expect(jobCriteriaResponseSchema.parse(theirs)).toMatchObject({ minCoreMatchPercent: 70, frameworks: [], technologies: [] })
    expect(jobCriteriaResponseSchema.parse((await owner.get(JOB_CRITERIA_PATH).expect(200)).body)).toMatchObject({ minCoreMatchPercent: 85, frameworks: ["React"] })
  })

  it("PUT job criteria: B's save changes B's row only; A's row and version are byte-equal", async () => {
    const before = await database.db.selectFrom("job_criteria").selectAll().where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
    await asOther(() => app.get(JobCriteriaService).save({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 60, frameworks: ["Vue"], technologies: [] }))
    expect(await database.db.selectFrom("job_criteria").selectAll().where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).toEqual(before)
    expect(await database.db.selectFrom("job_criteria").select("min_core_match_percent").where("candidate_id", "=", otherId).executeTakeFirstOrThrow()).toEqual({ min_core_match_percent: 60 })
    expect(await database.db.selectFrom("candidate_posting").select("status").where("candidate_id", "=", database.operatorId).execute()).toEqual([{ status: "ranked" }])
  })

  it("GET stack posts: B's page and totalCount count B's posts only", async () => {
    const theirs = stackPostsResponseSchema.parse(await asOther(() => app.get(StackPostsService).posts(1)))
    expect(theirs).toMatchObject({ totalCount: 0, items: [] })
    expect(stackPostsResponseSchema.parse((await owner.get(STACK_POSTS_PATH).expect(200)).body).totalCount).toBe(1)
  })

  it("GET hiring search inputs: reflects only the caller's own preferences: A has hints, B has none, so B gets []", async () => {
    expect((await owner.get(HIRING_SEARCH_INPUTS_PATH).expect(200)).body).toEqual({ hintTerms: ["remote", "relocation", "visa sponsorship"] })
    expect(hiringSearchInputsResponseSchema.parse(await asOther(() => app.get(StackPostsService).hiringSearchInputs()))).toEqual({ hintTerms: [] })
  })

  it("GET alert feeds: B sees B's feeds only; B's verification is null while A has a record", async () => {
    await database.db.insertInto("alert_feed_candidate_verification").values({ candidate_id: database.operatorId, verified_on: "2026-10-19", verification_basis: "OWNER-STACK-BASIS", updated_at: clock.now() }).execute()
    const theirs = alertFeedsResponseSchema.parse(await asOther(() => app.get(StackPostsService).feeds()))
    expect(theirs).toEqual({ verification: null, feeds: [], limit: 10, globalPaused: false })
    expect(JSON.stringify(theirs)).not.toMatch(/OWNER-LABEL|OWNER-STACK-BASIS/)
    expect(alertFeedsResponseSchema.parse((await owner.get(ALERT_FEEDS_PATH).expect(200)).body).verification).toMatchObject({ verifiedOn: "2026-10-19", verificationBasis: "OWNER-STACK-BASIS" })
  })

  it("PUT alert feed verification: writes only the caller's row; another Candidate's row, their registration gate and their reads are unchanged", async () => {
    await database.db.insertInto("alert_feed_candidate_verification").values({ candidate_id: database.operatorId, verified_on: "2026-10-19", verification_basis: "OWNER-STACK-BASIS", updated_at: clock.now() }).execute()
    const before = await database.db.selectFrom("alert_feed_candidate_verification").selectAll().where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
    const theirs = alertFeedsResponseSchema.parse(await asOther(() => app.get(StackPostsController).saveVerification({ verifiedOn: "2026-10-20", verificationBasis: "Invitee." }, "application/json")))
    expect(theirs.verification).toMatchObject({ verifiedOn: "2026-10-20", verificationBasis: "Invitee." })
    expect(JSON.stringify(theirs)).not.toContain("OWNER-")
    expect(await database.db.selectFrom("alert_feed_candidate_verification").selectAll().where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).toEqual(before)
    expect(await database.db.selectFrom("alert_feed_candidate_verification").select("candidate_id").orderBy("candidate_id").execute()).toHaveLength(2)
    // An unknown key (a candidateId aimed at A) is a plain 400 and writes nothing.
    await expect(asOther(() => app.get(StackPostsController).saveVerification({ verifiedOn: "2026-10-20", verificationBasis: "x", candidateId: database.operatorId }, "application/json"))).rejects.toMatchObject({ code: "bad_request" })
    expect(await database.db.selectFrom("alert_feed_candidate_verification").selectAll().where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).toEqual(before)
    // A's gate is unchanged: with 10 feeds A passes the record check and is refused at the limit, which comes before any fetch.
    const at = new Date("2026-10-20T09:00:00.000Z")
    for (let n = 0; n < 9; n++) {
      await database.db.insertInto("alert_feed").values({ candidate_id: database.operatorId, id: crypto.randomUUID(), url: `https://www.google.com/alerts/feeds/55555555555555555555/${700 + n}`, label: null, created_at: at, last_read_at: at, last_failure_reason: null, last_failed_at: null }).execute()
    }
    const ownerRefusal = await owner.post(ALERT_FEEDS_PATH).send({ url: "https://www.google.com/alerts/feeds/55555555555555555555/6666666666666666666", label: null }).expect(400)
    expect(ownerRefusal.body.error.fieldErrors).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    expect(alertFeedsResponseSchema.parse((await owner.get(ALERT_FEEDS_PATH).expect(200)).body).verification?.verificationBasis).toBe("OWNER-STACK-BASIS")
  })

  it("POST alert feed: A's record never lifts B's 409; the limit and the duplicate check count B's feeds only (A's URL is not a duplicate for B)", async () => {
    await database.db.insertInto("alert_feed_candidate_verification").values({ candidate_id: database.operatorId, verified_on: "2026-10-19", verification_basis: "Operator.", updated_at: clock.now() }).execute()
    await expect(asOther(() => app.get(StackPostsService).register({ url: OWNER_FEED_URL, label: null }))).rejects.toMatchObject({ code: "alert_feeds_not_verified" })
    await database.db.insertInto("alert_feed_candidate_verification").values({ candidate_id: otherId, verified_on: "2026-10-19", verification_basis: "B.", updated_at: clock.now() }).execute()
    // The fetch fails (no feed server in this file), which proves the duplicate check passed: a duplicate is refused before any fetch.
    const refusal = await asOther(() => app.get(StackPostsService).register({ url: OWNER_FEED_URL, label: null })).catch((error: unknown) => error)
    expect(JSON.stringify((refusal as { fieldErrors?: unknown }).fieldErrors ?? [])).not.toContain("duplicate")
    expect(await database.db.selectFrom("alert_feed").select(["candidate_id", "id"]).execute()).toEqual([{ candidate_id: database.operatorId, id: OWNER_FEED }])
  })

  it("DELETE alert feed: A's feed ID sent by B is the same no-op as an unknown ID, and A's feed stays", async () => {
    await asOther(() => app.get(StackPostsService).remove(OWNER_FEED))
    await asOther(() => app.get(StackPostsService).remove(crypto.randomUUID()))
    expect(await database.db.selectFrom("alert_feed").select("id").execute()).toEqual([{ id: OWNER_FEED }])
  })

  it("GET hiring feeds: lists only own feeds and own verification: B gets null and [] while A has both", async () => {
    const theirs = hiringAlertFeedsResponseSchema.parse(await asOther(() => app.get(HiringPostsService).feeds()))
    expect(theirs).toEqual({ verification: null, feeds: [], limit: 10, globalPaused: false })
    const mine = hiringAlertFeedsResponseSchema.parse((await owner.get(HIRING_ALERT_FEEDS_PATH).expect(200)).body)
    expect(mine.verification).toMatchObject({ verifiedOn: "2026-10-19", verificationBasis: "OWNER-BASIS-MARKER" })
    expect(mine.feeds.map((feed) => feed.id)).toEqual([OWNER_HIRING_FEED])
  })

  it("PUT hiring feed verification: writes only the caller's row; another Candidate's row, their registration gate and their reads are unchanged", async () => {
    const before = await database.db.selectFrom("hiring_feed_verification").selectAll().where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()
    const theirs = hiringAlertFeedsResponseSchema.parse(await asOther(() => app.get(HiringPostsController).saveVerification({ verifiedOn: "2026-10-20", verificationBasis: "Invitee basis." }, "application/json")))
    expect(theirs.verification).toMatchObject({ verifiedOn: "2026-10-20", verificationBasis: "Invitee basis." })
    expect(JSON.stringify(theirs)).not.toContain("OWNER-")
    expect(await database.db.selectFrom("hiring_feed_verification").selectAll().where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).toEqual(before)
    expect(await database.db.selectFrom("hiring_feed_verification").select("candidate_id").orderBy("candidate_id").execute()).toHaveLength(2)
    // An unknown key (a candidateId aimed at A) is a plain 400 and writes nothing.
    await expect(asOther(() => app.get(HiringPostsController).saveVerification({ verifiedOn: "2026-10-20", verificationBasis: "x", candidateId: database.operatorId }, "application/json"))).rejects.toMatchObject({ code: "bad_request" })
    expect(await database.db.selectFrom("hiring_feed_verification").selectAll().where("candidate_id", "=", database.operatorId).executeTakeFirstOrThrow()).toEqual(before)
    expect((await owner.get(HIRING_FEED_VERIFICATION_PATH.replace("/verification", "")).expect(200)).body.verification.verificationBasis).toBe("OWNER-BASIS-MARKER")
  })

  it("POST hiring feed: A's record never lifts B's 409; A's URLs in either list never refuse B", async () => {
    await expect(asOther(() => app.get(HiringPostsService).register({ url: OWNER_HIRING_FEED_URL, label: null }))).rejects.toMatchObject({ code: "alert_feeds_not_verified" })
    await database.db.insertInto("hiring_feed_verification").values({ candidate_id: otherId, verified_on: "2026-10-19", verification_basis: "B.", updated_at: clock.now() }).execute()
    // The fetch fails (no feed server here), which proves duplicate and in_other_list passed: both refuse before any fetch.
    for (const url of [OWNER_HIRING_FEED_URL, OWNER_FEED_URL]) {
      const refusal = await asOther(() => app.get(HiringPostsService).register({ url, label: null })).catch((error: unknown) => error)
      expect(JSON.stringify((refusal as { fieldErrors?: unknown }).fieldErrors ?? [])).not.toMatch(/duplicate|in_other_list|limit_reached/)
    }
    expect(await database.db.selectFrom("hiring_alert_feed").select(["candidate_id", "id"]).execute()).toEqual([{ candidate_id: database.operatorId, id: OWNER_HIRING_FEED }])
  })

  it("DELETE hiring feed: A's Hiring feed ID sent by B is the same no-op as an unknown ID, and A's feed stays", async () => {
    await asOther(() => app.get(HiringPostsService).remove(OWNER_HIRING_FEED))
    await asOther(() => app.get(HiringPostsService).remove(crypto.randomUUID()))
    expect(await database.db.selectFrom("hiring_alert_feed").select("id").execute()).toEqual([{ id: OWNER_HIRING_FEED }])
  })

  it("GET hiring posts: B's page and totalCount count B's Hiring posts only", async () => {
    const theirs = hiringPostsResponseSchema.parse(await asOther(() => app.get(HiringPostsService).posts(1)))
    expect(theirs).toMatchObject({ totalCount: 0, totalPages: 0, items: [] })
    expect(hiringPostsResponseSchema.parse((await owner.get(HIRING_POSTS_PATH).expect(200)).body).totalCount).toBe(1)
  })

  it("GET job postings, GET job posting by ID: B sees none of A's postings; A's ID is 404 for B", async () => {
    const service = app.get(PostingsService)
    const theirs = await asOther(() => service.listPostings({ tab: "all", limit: 25, families: [], keyword: null, cursor: null }))
    expect(theirs).toMatchObject({ totalCount: 0, postings: [] })
    await expect(asOther(() => service.posting(OWNER_POSTING))).rejects.toMatchObject({ code: "not_found" })
    await owner.get(`/v1/job-postings/${OWNER_POSTING}`).expect(200)
  })

  it("POST job posting link: a link A holds, pasted by B, gives B their own row; A's row is unchanged", async () => {
    const before = await database.db.selectFrom("candidate_posting").selectAll().where("candidate_id", "=", database.operatorId).execute()
    const service = app.get(PostingsService)
    const pasted = await asOther(() => service.pasteLink("https://boards.greenhouse.io/registry/jobs/1"))
    // B has no AI approval in this file, so the background evaluation stops early; wait for it before asserting.
    await asOther(() => service.settled())
    expect(pasted).toMatchObject({ created: true })
    expect(await database.db.selectFrom("candidate_posting").select("job_posting_id").where("candidate_id", "=", otherId).execute()).toEqual([{ job_posting_id: pasted.posting.id }])
    expect(await database.db.selectFrom("candidate_posting").selectAll().where("candidate_id", "=", database.operatorId).execute()).toEqual(before)
  })

  it("POST check again: B's press claims B's rows only (to waiting, no job); A's rows and A's jobs are unchanged", async () => {
    // A visible failed posting held by both: dated, on target, not entry level.
    await database.db.updateTable("job_posting").set({ posted_at: new Date("2026-10-20T09:00:00.000Z"), posted_date_kind: "published", title_folded: "owner-posting", seniority_marker: "none" }).where("id", "=", OWNER_POSTING).execute()
    await database.db.updateTable("candidate_posting").set({ status: "evaluation_failed", evaluation_failure: "not_configured" }).where("candidate_id", "=", database.operatorId).execute()
    await insertCandidatePosting(database.db, otherId, OWNER_POSTING, { status: "evaluation_failed", evaluationFailure: "provider_error" })
    const ownerBefore = await database.db.selectFrom("candidate_posting").selectAll().where("candidate_id", "=", database.operatorId).execute()
    const jobsBefore = await sql<{ n: number }>`select count(*)::int as n from pgboss.job where name = 'evaluate.posting'`.execute(database.db)
    const theirs = await asOther(() => app.get(PostingsService).checkAgain())
    expect(theirs).toEqual({ queued: 1, movedTo: "waiting_to_be_checked" })
    expect(await database.db.selectFrom("candidate_posting").select(["status", "evaluation_failure"]).where("candidate_id", "=", otherId).execute()).toEqual([{ status: "waiting_to_be_checked", evaluation_failure: "provider_error" }])
    expect(await database.db.selectFrom("candidate_posting").selectAll().where("candidate_id", "=", database.operatorId).execute()).toEqual(ownerBefore)
    expect((await sql<{ n: number }>`select count(*)::int as n from pgboss.job where name = 'evaluate.posting'`.execute(database.db)).rows).toEqual(jobsBefore.rows)
  })
})
