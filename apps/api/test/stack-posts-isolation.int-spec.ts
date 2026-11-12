import type { INestApplication } from "@nestjs/common"
import { ALERT_FEEDS_PATH, STACK_POSTS_PATH, alertFeedsResponseSchema, stackPostsResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateScope } from "../src/db/candidate-scope.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { StackPostsController } from "../src/stack-posts/stack-posts.controller.js"
import { StackPostsService } from "../src/stack-posts/stack-posts.service.js"
import { StackPostsSummaryReader } from "../src/stack-posts/stack-posts-summary.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 A1 merge of EPIC-0005: the four Stack posts tables are Candidate
 * data (migration 0016, RLS in 0017). The signed-in owner never sees, counts or
 * removes another Candidate's Alert feed, verification or Stack posts, and the
 * owner's daily summary section reads only the owner's rows. No feed is
 * fetched: every row is a fixture.
 */
const OTHER_FEED = "00000000-0000-4000-8000-0000000000f1"
const OTHER_POST = "00000000-0000-4000-8000-0000000000f2"
const OTHER_URL = "https://www.google.com/alerts/feeds/99999999999999999999/1111111111111111111"
const OTHER_POST_URL = "https://www.linkedin.com/posts/other-candidate-secret-post"

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let otherId: string
const clock = new TestClock("2026-10-21T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
})

beforeEach(async () => {
  for (const table of ["stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification"] as const) await database.db.deleteFrom(table).execute()
  const at = new Date("2026-10-21T07:00:00.000Z")
  await database.db
    .insertInto("alert_feed")
    .values({ candidate_id: otherId, id: OTHER_FEED, url: OTHER_URL, label: "OTHER-SECRET-LABEL", created_at: at, last_read_at: at, last_failure_reason: "redirected", last_failed_at: at })
    .execute()
  await database.db
    .insertInto("stack_post")
    .values({ candidate_id: otherId, id: OTHER_POST, canonical_url: OTHER_POST_URL, kind: "post", title: "OTHER-SECRET-TITLE", snippet: "s", published_at: null, matched_technologies: ["React"], source_feed_id: OTHER_FEED, first_seen_at: at })
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("Stack posts belong to one Candidate (EPIC-0002 A1, EPIC-0005 tables)", () => {
  it("the owner's posts list and feeds page show none of the other Candidate's rows", async () => {
    const posts = stackPostsResponseSchema.parse((await owner.get(STACK_POSTS_PATH).expect(200)).body)
    expect(posts).toMatchObject({ totalCount: 0, items: [] })
    const feeds = alertFeedsResponseSchema.parse((await owner.get(ALERT_FEEDS_PATH).expect(200)).body)
    expect(feeds.feeds).toEqual([])
    const body = JSON.stringify([posts, feeds])
    expect(body).not.toContain("OTHER-SECRET")
  })

  it("removing the other Candidate's feed by its id changes nothing", async () => {
    await owner.delete(`${ALERT_FEEDS_PATH}/${OTHER_FEED}`).expect(204)
    expect(await database.db.selectFrom("alert_feed").select("id").where("candidate_id", "=", otherId).execute()).toEqual([{ id: OTHER_FEED }])
  })

  // EPIC-0008 (AC 6.4, D12/D15) rewrites the r5 K6 pair: each Candidate has their own Stack posts record.
  it("EPIC-0008: the Operator's verification is her own record; another Candidate still reads null and keeps her feeds", async () => {
    await owner.put(`${ALERT_FEEDS_PATH}/verification`).send({ verifiedOn: "2026-10-20", verificationBasis: "Operator basis." }).expect(200)
    expect(await database.db.selectFrom("alert_feed_candidate_verification").select(["candidate_id", "verification_basis"]).execute()).toEqual([{ candidate_id: database.operatorId, verification_basis: "Operator basis." }])
    const seenByOther = await CandidateScope.run(otherId, () => app.get(StackPostsService).feeds())
    expect(seenByOther.verification).toBeNull()
    expect(seenByOther.feeds.map((feed) => feed.id)).toEqual([OTHER_FEED])
  })

  it("EPIC-0008: another Candidate's verification write saves her own record only; an invalid body is a 400, never not_found", async () => {
    const service = app.get(StackPostsService)
    const saved = await CandidateScope.run(otherId, () => service.saveVerification({ verifiedOn: "2026-10-20", verificationBasis: "Invitee basis." }))
    expect(saved.verification).toMatchObject({ verifiedOn: "2026-10-20", verificationBasis: "Invitee basis." })
    expect(saved.feeds.map((feed) => feed.id)).toEqual([OTHER_FEED])
    const controller = app.get(StackPostsController)
    await expect(CandidateScope.run(otherId, () => controller.saveVerification({ verifiedOn: "not-a-date" }, "application/json"))).rejects.toMatchObject({ code: "bad_request" })
    expect(await database.db.selectFrom("alert_feed_candidate_verification").select(["candidate_id", "verification_basis"]).execute()).toEqual([{ candidate_id: otherId, verification_basis: "Invitee basis." }])
    expect(alertFeedsResponseSchema.parse((await owner.get(ALERT_FEEDS_PATH).expect(200)).body).verification).toBeNull()
  })

  it("the same post URL can be stored for two Candidates", async () => {
    await database.db
      .insertInto("stack_post")
      .values({ candidate_id: database.operatorId, id: crypto.randomUUID(), canonical_url: OTHER_POST_URL, kind: "post", title: "Own", snippet: "s", published_at: null, matched_technologies: [], source_feed_id: null, first_seen_at: clock.now() })
      .execute()
    const posts = stackPostsResponseSchema.parse((await owner.get(STACK_POSTS_PATH).expect(200)).body)
    expect(posts.items.map((item) => item.title)).toEqual(["Own"])
  })

  it("the owner's daily summary section reads only the owner's rows", async () => {
    const tenant = app.get(TenantDatabase)
    await database.db.insertInto("alert_feed_candidate_verification").values({ candidate_id: database.operatorId, verified_on: "2026-10-20", verification_basis: "Owner.", updated_at: clock.now() }).execute()
    const summary = await tenant.asOperator(() => new StackPostsSummaryReader(tenant).summary(crypto.randomUUID(), new Date("2026-10-21T20:00:00.000Z")))
    expect(summary).toMatchObject({ verified: true, newCount: 0, newPosts: [], failingFeeds: [] })
  })
})

/**
 * r5-addendum K8: `stack_post (candidate_id, source_feed_id)` references
 * `alert_feed (candidate_id, id)`. A foreign key check ignores RLS, so with the
 * one-column key a post of one Candidate could name another Candidate's feed.
 */
describe("a Stack post can name only its own Candidate's feed (r5 K8)", () => {
  it("the database refuses an owner post whose source is the other Candidate's feed", async () => {
    await expect(
      database.db
        .insertInto("stack_post")
        .values({ candidate_id: database.operatorId, id: crypto.randomUUID(), canonical_url: "https://www.linkedin.com/posts/owner-k8", kind: "post", title: "t", snippet: "s", published_at: null, matched_technologies: [], source_feed_id: OTHER_FEED, first_seen_at: new Date() })
        .execute()
    ).rejects.toThrow(/foreign key/)
  })

  it("removing a feed nulls only the post's source, keeping its Candidate", async () => {
    await database.db.deleteFrom("alert_feed").where("id", "=", OTHER_FEED).execute()
    const post = await database.db.selectFrom("stack_post").select(["candidate_id", "source_feed_id"]).where("id", "=", OTHER_POST).executeTakeFirstOrThrow()
    expect(post).toEqual({ candidate_id: otherId, source_feed_id: null })
  })
})
