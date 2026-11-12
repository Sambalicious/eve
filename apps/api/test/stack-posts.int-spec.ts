import { randomUUID } from "node:crypto"
import { createServer } from "node:net"

import { type INestApplication, type INestApplicationContext, Logger, type LoggerService } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import {
  ALERT_FEEDS_PATH,
  ALERT_FEED_VERIFICATION_PATH,
  STACK_POSTS_PATH,
  alertFeedsResponseSchema,
  apiErrorResponseSchema,
  registerAlertFeedResponseSchema,
  stackPostsResponseSchema,
} from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { createDatabase } from "../src/db/create-database.js"
import type { Database } from "../src/db/schema.js"
import { CLOCK } from "../src/shared/clock.js"
import { ALERT_FEED_HTTP } from "../src/stack-posts/alert-feed-http.provider.js"
import { ALERT_FEED_MAX_BYTES, AlertFeedError, type AlertFeedHttp, createAlertFeedHttp } from "../src/stack-posts/alert-feed-http.js"
import type { MatchCriteria } from "../src/stack-posts/stack-post-builder.js"
import { StackPostsReader } from "../src/stack-posts/stack-posts-reader.js"
import { RETENTION_MAX_POSTS, StackPostsRepository } from "../src/stack-posts/stack-posts.repository.js"
import { STACK_POSTS_READ_CRON, STACK_POSTS_READ_QUEUE, StackPostsJobs } from "../src/worker/stack-posts-jobs.js"
import { WorkerHeartbeat } from "../src/worker/worker-heartbeat.js"
import { WorkerModule } from "../src/worker/worker.module.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { asOperatorWith } from "./support/operator-scope.js"
import { FEED_A, FEED_A_DIGITS, FEED_B, atomFeed, atomFeedOfBytes, fixture, googleRedirect } from "./support/alert-feed-fixtures.js"
import { Browser } from "./support/browser.js"
import { OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeFeedServer } from "./support/fake-feed-server.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, migratedStorageRoot } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0005 against the real api, real Postgres (runtime role) and a local
 * feed server standing in for Google Alerts. The production Alert feed client
 * is used with its `testOrigin` seam, a 300 ms timeout and a recorded sleep.
 * No request leaves 127.0.0.1 (OutboundRecorder); no email, no AI.
 */
const FEED_URL = (n: number) => `https://www.google.com/alerts/feeds/${String(n).padStart(20, "0")}/${100000 + n}`
const TIMEOUT_MS = 300

let database: TestDatabase
let runtime: Kysely<Database>
let tenant: TenantDatabase
let google: FakeGoogle
let outbound: OutboundRecorder
let feeds: FakeFeedServer
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let reader: StackPostsReader
const sleeps: number[] = []
let onSleep: (ms: number) => Promise<void> = async () => undefined
const clock = new TestClock("2026-10-21T09:00:00.000Z")
const logs: string[] = []
const line = (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" "))
const capture: LoggerService = { log: line, warn: line, error: line, debug: line, verbose: line }

function feedClient(origin: string): AlertFeedHttp {
  return createAlertFeedHttp({
    testOrigin: origin,
    timeoutMs: TIMEOUT_MS,
    sleep: async (ms) => {
      sleeps.push(ms)
      await onSleep(ms)
    },
  })
}

beforeAll(async () => {
  Logger.overrideLogger(capture)
  database = await startMigratedDatabase()
  runtime = createDatabase(database.url)
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  outbound = new OutboundRecorder(google.server)
  feeds = await FakeFeedServer.start()
  const http = feedClient(feeds.origin)
  app = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: http })
  // TestingModuleBuilder.compile() installs its own TestingLogger; put the capture back so the log checks see real lines.
  Logger.overrideLogger(capture)
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
  tenant = new TenantDatabase(runtime)
  reader = asOperatorWith(tenant, new StackPostsReader(new StackPostsRepository(tenant), http, clock))
})

beforeEach(async () => {
  clock.set("2026-10-21T09:00:00.000Z")
  feeds.reset()
  outbound.reset()
  sleeps.length = 0
  onSleep = async () => undefined
  logs.length = 0
  // Compiling a Nest testing module (here or in a test) installs its own TestingLogger. Re-install the capture
  // so the afterEach URL-privacy check sees every line (found while adding CR-E5-03).
  Logger.overrideLogger(capture)
  for (const table of ["stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification", "ai_call", "spend_entry"] as const) {
    await database.db.deleteFrom(table).execute()
  }
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("job_criteria").set({ frameworks: ["React", "NestJS"], technologies: ["TypeScript"] }).execute()
})

afterEach(() => {
  // AC 7.4: no full feed URL in any log line, and nothing left 127.0.0.1 (AC 6.4, 6.7).
  expect(logs.join("\n")).not.toContain(FEED_A_DIGITS)
  expect(outbound.urls).toEqual([])
})

afterAll(async () => {
  await app?.close()
  await feeds?.close()
  google?.close()
  await runtime?.destroy()
  await database?.stop()
  Logger.overrideLogger(false)
})

const verify = () => candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-20", verificationBasis: "Reviewed Google Alerts terms." })
const register = (url: string, label: string | null = "React posts") => candidate.post(ALERT_FEEDS_PATH).send({ url, label })
const feedRows = () => database.db.selectFrom("alert_feed").selectAll().orderBy("created_at").execute()
const postRows = () => database.db.selectFrom("stack_post").selectAll().orderBy("first_seen_at").orderBy("canonical_url").execute()
const fieldErrors = (body: unknown) => apiErrorResponseSchema.parse(body).error.fieldErrors

const REACT_POST = "https://www.linkedin.com/posts/ada-obi_react-activity-7254-abcd"
const validFeed = () => fixture("google-alerts.atom.xml")

async function seedPosts(count: number, options: { firstSeen?: (i: number) => Date; published?: (i: number) => Date | null; feedId?: string | null } = {}): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    canonical_url: `https://www.linkedin.com/posts/seed-${i}-${randomUUID().slice(0, 8)}`,
    kind: "post" as const,
    title: `Seed ${i}`,
    snippet: `Snippet ${i}`,
    published_at: options.published ? options.published(i) : null,
    matched_technologies: ["React"],
    candidate_id: database.operatorId,
    source_feed_id: options.feedId ?? null,
    first_seen_at: options.firstSeen ? options.firstSeen(i) : new Date(Date.UTC(2026, 9, 1) + i * 60_000),
  }))
  for (let i = 0; i < rows.length; i += 500) await database.db.insertInto("stack_post").values(rows.slice(i, i + 500)).execute()
}

describe("session and CSRF (stack-posts-page.feature @ac-7.x)", () => {
  it.each([STACK_POSTS_PATH, ALERT_FEEDS_PATH])("GET %s without a session is 401", async (path) => {
    const response = await browser.http().get(path).expect(401)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("unauthenticated")
  })

  it("a write without the CSRF token is 403 and changes nothing", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    const response = await browser.http().post(ALERT_FEEDS_PATH).set("cookie", candidate.cookie).send({ url: FEED_A }).expect(403)
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe("csrf_invalid")
    expect(await feedRows()).toEqual([])
    expect(feeds.requestsTo(FEED_A)).toBe(0)
  })
})

describe("Alert feed verification (alert-feed-verification.feature)", () => {
  it("records, returns trimmed and upserts the caller's own row (EPIC-0008)", async () => {
    const first = await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-20", verificationBasis: "  Reviewed terms.  " }).expect(200)
    expect(first.headers["cache-control"]).toBe("no-store")
    expect(alertFeedsResponseSchema.parse(first.body)).toMatchObject({ verification: { verifiedOn: "2026-10-20", verificationBasis: "Reviewed terms." }, feeds: [], limit: 10, globalPaused: false })
    await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2024-02-29", verificationBasis: "Updated." }).expect(200)
    const rows = await sql<{ verified_on: string; verification_basis: string }>`select verified_on::text, verification_basis from alert_feed_candidate_verification where candidate_id = ${database.operatorId}`.execute(database.db)
    expect(rows.rows).toEqual([{ verified_on: "2024-02-29", verification_basis: "Updated." }])
  })

  it("accepts today in WAT and refuses tomorrow in WAT", async () => {
    clock.set("2026-10-21T23:30:00.000Z") // 00:30 WAT on the 22nd
    await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-22", verificationBasis: "x" }).expect(200)
    const response = await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-23", verificationBasis: "x" }).expect(400)
    expect(fieldErrors(response.body)).toEqual([{ field: "verifiedOn", position: null, problem: "future_date" }])
  })

  it.each([
    [{ verifiedOn: "2026-02-30", verificationBasis: "x" }, [{ field: "verifiedOn", position: null, problem: "invalid" }]],
    [{ verifiedOn: "", verificationBasis: "x" }, [{ field: "verifiedOn", position: null, problem: "missing" }]],
    [{ verifiedOn: "2026-10-20", verificationBasis: "   " }, [{ field: "verificationBasis", position: null, problem: "missing" }]],
    [{ verifiedOn: "2026-10-20", verificationBasis: "x".repeat(501) }, [{ field: "verificationBasis", position: null, problem: "too_long" }]],
    [{ verifiedOn: null, verificationBasis: null }, [{ field: "verifiedOn", position: null, problem: "missing" }, { field: "verificationBasis", position: null, problem: "missing" }]],
  ])("refuses %j with field errors and keeps the recorded verification", async (body, expected) => {
    await verify().expect(200)
    const response = await candidate.put(ALERT_FEED_VERIFICATION_PATH).send(body).expect(400)
    expect(fieldErrors(response.body)).toEqual(expected)
    expect((await candidate.get(ALERT_FEEDS_PATH).expect(200)).body.verification.verifiedOn).toBe("2026-10-20")
  })

  // alert-feed-verification.feature @concurrent @ac-3.4 "Two tabs updating the verification leave the last successful save stored" (F-QA-E5-01)
  it("two tabs: both saves succeed and the last one is stored", async () => {
    await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-15", verificationBasis: "Basis A" }).expect(200)
    const tabA = await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-15", verificationBasis: "Basis B" }).expect(200)
    const tabB = await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-15", verificationBasis: "Basis C" }).expect(200)
    expect(alertFeedsResponseSchema.parse(tabA.body).verification?.verificationBasis).toBe("Basis B")
    expect(alertFeedsResponseSchema.parse(tabB.body).verification?.verificationBasis).toBe("Basis C")
    const rows = await database.db.selectFrom("alert_feed_candidate_verification").select("verification_basis").where("candidate_id", "=", database.operatorId).execute()
    expect(rows).toEqual([{ verification_basis: "Basis C" }])
    expect((await candidate.get(ALERT_FEEDS_PATH).expect(200)).body.verification.verificationBasis).toBe("Basis C")
  })

  it("two tabs saving at the same moment: both succeed and exactly one of the two is stored", async () => {
    const [b, c] = await Promise.all([
      candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-15", verificationBasis: "Basis B" }),
      candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-16", verificationBasis: "Basis C" }),
    ])
    expect([b.status, c.status]).toEqual([200, 200])
    const rows = await sql<{ verified_on: string; verification_basis: string }>`select verified_on::text, verification_basis from alert_feed_candidate_verification where candidate_id = ${database.operatorId}`.execute(database.db)
    expect(rows.rows).toHaveLength(1)
    expect([[{ verified_on: "2026-10-15", verification_basis: "Basis B" }], [{ verified_on: "2026-10-16", verification_basis: "Basis C" }]]).toContainEqual(rows.rows)
  })

  // alert-feed-verification.feature r3 (CR-E5-01): "The API returns every field error of a verification save together"
  it.each([
    [{ verifiedOn: "2026-10-22", verificationBasis: "   " }, [["verifiedOn", "future_date"], ["verificationBasis", "missing"]]],
    [{ verifiedOn: "2026-02-30", verificationBasis: "b".repeat(501) }, [["verifiedOn", "invalid"], ["verificationBasis", "too_long"]]],
    [{ verifiedOn: "2099-01-01", verificationBasis: "basis\u0000x" }, [["verifiedOn", "future_date"], ["verificationBasis", "invalid_characters"]]],
    [{}, [["verifiedOn", "missing"], ["verificationBasis", "missing"]]],
  ])("returns every field error together for %j (CR-E5-01)", async (body, expected) => {
    clock.set("2026-10-21T12:00:00.000Z")
    const response = await candidate.put(ALERT_FEED_VERIFICATION_PATH).send(body).expect(400)
    expect(fieldErrors(response.body)).toEqual(expected.map(([field, problem]) => ({ field, position: null, problem })))
    expect(await database.db.selectFrom("alert_feed_candidate_verification").select("verified_on").execute()).toEqual([])
  })

  // alert-feed-verification.feature r3 (SEC-E5-06): control characters give a 400 field error, never a 500
  it.each([
    ["basis\u0000x", "invalid_characters"],
    ["\u0000", "invalid_characters"],
    ["Reviewed\u0001 terms", "invalid_characters"],
    ["Reviewed\u001b[31m terms", "invalid_characters"],
    ["Reviewed\u001f terms", "invalid_characters"],
    ["Reviewed\u007f terms", "invalid_characters"],
    ["Reviewed\u000b terms", "invalid_characters"],
    ["Reviewed\u000c terms", "invalid_characters"],
    // alert-feed-verification.feature r4 (SEC-E5F-02, v1.15.2)
    ["Reviewed\u0085 terms", "invalid_characters"],
    ["Reviewed\u009f terms", "invalid_characters"],
    ["Reviewed\u061c terms", "invalid_characters"],
    ["Reviewed\u202e terms", "invalid_characters"],
    ["Reviewed\u2068 terms", "invalid_characters"],
    ["Reviewed\u200b terms", "invalid_characters"],
    ["Reviewed\u2060 terms", "invalid_characters"],
    ["Reviewed\ufeff terms", "invalid_characters"],
    ["   ", "missing"],
    [`${"a".repeat(500)}\u0000`, "invalid_characters"],
    [`${"a".repeat(501)}\u0000`, "invalid_characters"],
  ])("refuses the raw JSON basis %j with %s and stores nothing (SEC-E5-06)", async (verificationBasis, problem) => {
    const response = await candidate.put(ALERT_FEED_VERIFICATION_PATH).set("content-type", "application/json").send(JSON.stringify({ verifiedOn: "2026-10-20", verificationBasis })).expect(400)
    expect(fieldErrors(response.body)).toEqual([{ field: "verificationBasis", position: null, problem }])
    expect(await database.db.selectFrom("alert_feed_candidate_verification").select("verified_on").execute()).toEqual([])
  })

  it.each([
    ["Reviewed Google Alerts terms.\nSee notes.", "Reviewed Google Alerts terms.\nSee notes."],
    ["Reviewed\r\nGoogle Alerts terms.", "Reviewed\r\nGoogle Alerts terms."],
    ["Reviewed\tGoogle Alerts terms.", "Reviewed\tGoogle Alerts terms."],
    ["\n\tReviewed terms.\r\n", "Reviewed terms."],
  ])("saves a basis with tabs and line breaks %j as %j", async (verificationBasis, stored) => {
    await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-20", verificationBasis }).expect(200)
    expect(await database.db.selectFrom("alert_feed_candidate_verification").select("verification_basis").where("candidate_id", "=", database.operatorId).execute()).toEqual([{ verification_basis: stored }])
  })

  // alert-feed-verification.feature r3 (CR-E5-04): code points, the same in the API and the database
  it.each([
    ["😀".repeat(500), 200],
    [`     ${"😀".repeat(500)}     `, 200],
    [`${"a".repeat(499)}😀`, 200],
    ["😀".repeat(501), 400],
    [`${"a".repeat(499)}🇳🇬`, 400],
    [`${"a".repeat(498)}\r\nb`, 400],
  ])("basis %#: %d (code points after trimming)", async (verificationBasis, status) => {
    const response = await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-20", verificationBasis }).expect(status)
    if (status === 400) expect(fieldErrors(response.body)).toEqual([{ field: "verificationBasis", position: null, problem: "too_long" }])
    else {
      const rows = await sql<{ length: number }>`select char_length(verification_basis) as length from alert_feed_candidate_verification where candidate_id = ${database.operatorId}`.execute(database.db)
      expect(rows.rows).toEqual([{ length: 500 }])
    }
  })

  it("accepts a basis of exactly 500 characters after trimming", async () => {
    await candidate.put(ALERT_FEED_VERIFICATION_PATH).send({ verifiedOn: "2026-10-20", verificationBasis: ` ${"b".repeat(500)} ` }).expect(200)
  })
})

describe("registration (alert-feeds.feature)", () => {
  it("before verification: 409 alert_feeds_not_verified and no request", async () => {
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    const response = await register(FEED_A).expect(409)
    expect(apiErrorResponseSchema.parse(response.body).error).toEqual({
      code: "alert_feeds_not_verified",
      message: "Record the permitted-use verification for Google Alerts feeds before registering a feed.",
    })
    expect(feeds.requestsTo(FEED_A)).toBe(0)
    expect(await feedRows()).toEqual([])
  })

  it("201 carries the full URL once; later reads show only the mask; posts from the one fetch are stored", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    const response = await register(`  ${FEED_A} `, "  React posts  ").expect(201)
    expect(response.headers["cache-control"]).toBe("no-store")
    const body = registerAlertFeedResponseSchema.parse(response.body)
    expect(body.feed).toMatchObject({ url: FEED_A, label: "React posts", maskedUrl: "…654321", lastReadAt: "2026-10-21T09:00:00.000Z", failure: null })
    // Fixture: one LinkedIn post, one article, one job link (ignored).
    expect(body.storedPosts).toBe(2)
    expect(feeds.requestsTo(FEED_A)).toBe(1)

    const list = await candidate.get(ALERT_FEEDS_PATH).expect(200)
    expect(JSON.stringify(list.body)).not.toContain(FEED_A_DIGITS)
    const masked = Object.fromEntries(Object.entries(body.feed).filter(([key]) => key !== "url"))
    expect(alertFeedsResponseSchema.parse(list.body).feeds).toEqual([masked])
    const posts = stackPostsResponseSchema.parse((await candidate.get(STACK_POSTS_PATH).expect(200)).body)
    expect(JSON.stringify(posts)).not.toContain(FEED_A_DIGITS)
    expect(posts.items.map((item) => [item.canonicalUrl, item.kind, item.matchedTechnologies, item.source])).toEqual([
      [REACT_POST, "post", ["React", "NestJS"], { label: "React posts", maskedUrl: "…654321" }],
      ["https://www.linkedin.com/pulse/typescript-at-scale-chidi-eze", "article", ["TypeScript"], { label: "React posts", maskedUrl: "…654321" }],
    ])
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })

  it("an entry with &#0; registers (201) and is stored without NUL (SEC-E5-03)", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: atomFeed([{ title: "React&#0; hooks", content: "a&#x0;b", link: REACT_POST }]) })
    expect((await register(FEED_A).expect(201)).body.storedPosts).toBe(1)
    expect((await postRows()).map((row) => [row.title, row.snippet])).toEqual([["React hooks", "ab"]])
  })

  it("a label blank after trimming is stored as none; an RSS 2.0 feed and an empty feed register", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: fixture("google-alerts.rss2.xml") })
    feeds.on(FEED_B, { kind: "body", body: atomFeed([]) })
    expect((await register(FEED_A, "   ").expect(201)).body.feed.label).toBeNull()
    const empty = await register(FEED_B, null).expect(201)
    expect(empty.body).toMatchObject({ storedPosts: 0, feed: { maskedUrl: "…222333" } })
  })

  it("registration still runs during the global pause (AC 6.6)", async () => {
    await verify().expect(200)
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    await register(FEED_A).expect(201)
  })

  it.each([
    ["http://www.google.com/alerts/feeds/1/2"],
    ["https://google.com/alerts/feeds/1/2"],
    ["https://www.google.com/alerts/feeds/1/2?x=1"],
    ["https://www.google.com/alerts/feeds/1/2/"],
    ["https://user:pw@www.google.com/alerts/feeds/1/2"],
    ["https://www.google.com:443/alerts/feeds/1/2"],
    [`https://www.google.com/alerts/feeds/1/${"9".repeat(500)}`],
  ])("refuses %s as url/invalid_format before any request", async (url) => {
    await verify().expect(200)
    const response = await register(url).expect(400)
    expect(fieldErrors(response.body)).toEqual([{ field: "url", position: null, problem: "invalid_format" }])
    expect(feeds.requests).toEqual([])
  })

  it("a label over 60 after trimming is refused; 60 is accepted", async () => {
    await verify().expect(200)
    expect(fieldErrors((await register(FEED_A, "l".repeat(61)).expect(400)).body)).toEqual([{ field: "label", position: null, problem: "too_long" }])
    expect(feeds.requests).toEqual([])
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    await register(FEED_A, ` ${"l".repeat(60)} `).expect(201)
  })

  // alert-feeds.feature r3 (SEC-E5-06): "The API refuses a label that contains a control character"
  // r4 (SEC-E5F-02, v1.15.2): C1 controls, bidi controls, U+200B, U+2060 and U+FEFF
  it.each([
    "lab\u0000el",
    "React\tposts",
    "React\nposts",
    "React\rposts",
    "React\u001b[2Jposts",
    "React\u007fposts",
    "React\u0085posts",
    "React\u0080posts",
    "React\u009fposts",
    "React\u061cposts",
    "React\u200eposts",
    "React\u200fposts",
    "React\u202aposts",
    "React\u202eposts",
    "React\u2066posts",
    "React\u2069posts",
    "React\u200bposts",
    "React\u2060posts",
    "React\ufeffposts",
  ])(
    "refuses the raw JSON label %j with invalid_characters, stores nothing and requests nothing (SEC-E5-06, SEC-E5F-02)",
    async (label) => {
      await verify().expect(200)
      feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
      const response = await candidate.post(ALERT_FEEDS_PATH).set("content-type", "application/json").send(JSON.stringify({ url: FEED_A, label })).expect(400)
      expect(fieldErrors(response.body)).toEqual([{ field: "label", position: null, problem: "invalid_characters" }])
      expect(await feedRows()).toEqual([])
      expect(feeds.requests).toEqual([])
    }
  )

  // r4 (SEC-E5F-02): printable characters, joiners and the no-break space stay allowed
  it.each(["React\u00a0posts", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 posts", "👨\u200d👩\u200d👧 posts", "Réact 🚀 posts", "React posts 😀"])("accepts and stores the label %j", async (label) => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    await register(FEED_A, label).expect(201)
    expect((await feedRows()).map((row) => row.label)).toEqual([label])
  })

  // alert-feeds.feature r3 (CR-E5-01): "The API returns the URL and label errors of a registration together"
  it("returns the URL and label errors of a registration together, with no outbound request", async () => {
    await verify().expect(200)
    const response = await candidate
      .post(ALERT_FEEDS_PATH)
      .set("content-type", "application/json")
      .send(JSON.stringify({ url: "https://www.google.com/search?q=react", label: "lab\u0000el" }))
      .expect(400)
    expect(fieldErrors(response.body)).toEqual([
      { field: "url", position: null, problem: "invalid_format" },
      { field: "label", position: null, problem: "invalid_characters" },
    ])
    expect(feeds.requests).toEqual([])
  })

  // alert-feeds.feature r3 (CR-E5-04): "Label length is counted in code points, the same in the form, the API and the database"
  it.each([
    ["😀".repeat(60), 201],
    [`    ${"😀".repeat(60)}    `, 201],
    [`${"a".repeat(59)}😀`, 201],
    ["😀".repeat(61), 400],
    [`${"a".repeat(59)}🇳🇬`, 400],
  ])("label %#: %d (code points after trimming)", async (label, status) => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    const response = await register(FEED_A, label).expect(status)
    if (status === 400) {
      expect(fieldErrors(response.body)).toEqual([{ field: "label", position: null, problem: "too_long" }])
      expect(feeds.requests).toEqual([])
    } else {
      const rows = await sql<{ length: number }>`select char_length(label) as length from alert_feed`.execute(database.db)
      expect(rows.rows).toEqual([{ length: 60 }])
    }
  })

  describe("the six fetch failure reasons (D-E5-1), each storing nothing", () => {
    const cases: [string, Parameters<FakeFeedServer["on"]>[1], string][] = [
      ["404", { kind: "status", status: 404 }, "unexpected_response"],
      ["500 (no retry at registration)", { kind: "status", status: 500 }, "unexpected_response"],
      ["403", { kind: "status", status: 403 }, "unexpected_response"],
      ["204 empty", { kind: "status", status: 204 }, "unexpected_response"],
      ["301", { kind: "redirect", status: 301, location: "https://evil.test/feed" }, "redirected"],
      ["302", { kind: "redirect", status: 302, location: FEED_B }, "redirected"],
      ["200 HTML", { kind: "body", body: fixture("html-page.html"), headers: { "content-type": "text/html" } }, "not_a_feed"],
      ["200 malformed XML", { kind: "body", body: fixture("malformed.xml") }, "not_a_feed"],
      ["200 XML not a feed", { kind: "body", body: fixture("not-a-feed.xml") }, "not_a_feed"],
      ["200 DOCTYPE entity", { kind: "body", body: fixture("doctype-entity.xml") }, "not_a_feed"],
      ["200 empty", { kind: "body", body: "" }, "not_a_feed"],
      ["200 one byte over the cap", { kind: "body", body: atomFeedOfBytes(ALERT_FEED_MAX_BYTES + 1) }, "too_large"],
      ["hang", { kind: "hang" }, "timed_out"],
      ["socket reset", { kind: "reset" }, "not_reachable"],
    ]
    it.each(cases)("%s -> url/%s", async (_name, reply, problem) => {
      await verify().expect(200)
      feeds.on(FEED_A, reply)
      const response = await register(FEED_A).expect(400)
      expect(apiErrorResponseSchema.parse(response.body).error).toMatchObject({ code: "bad_request", fieldErrors: [{ field: "url", position: null, problem }] })
      expect(feeds.requestsTo(FEED_A)).toBe(1)
      expect(await feedRows()).toEqual([])
      expect(await postRows()).toEqual([])
      expect(sleeps).toEqual([])
    })

    it("a refused connection -> url/not_reachable", async () => {
      await verify().expect(200)
      const closedPort = await new Promise<number>((resolve) => {
        const server = createServer().listen(0, "127.0.0.1", () => {
          const { port } = server.address() as { port: number }
          server.close(() => resolve(port))
        })
      })
      const refusing = await createTestApp({ databaseUrl: database.url, clock, alertFeedHttp: feedClient(`http://127.0.0.1:${closedPort}`) })
      try {
        const other = await signInCandidate(new Browser(refusing, google))
        // Sign-in talks to the MSW fake Google (intercepted, never sent); only the feed calls are audited here.
        outbound.reset()
        const response = await other.post(ALERT_FEEDS_PATH).send({ url: FEED_A }).expect(400)
        expect(fieldErrors(response.body)).toEqual([{ field: "url", position: null, problem: "not_reachable" }])
      } finally {
        await refusing.close()
      }
    })

    it("a response exactly at the cap is accepted", async () => {
      await verify().expect(200)
      feeds.on(FEED_A, { kind: "body", body: atomFeedOfBytes(ALERT_FEED_MAX_BYTES) })
      await register(FEED_A).expect(201)
    })
  })

  it("duplicate: refused with no request, also when it differs only by surrounding spaces", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    await register(FEED_A).expect(201)
    for (const url of [FEED_A, `  ${FEED_A} `]) {
      const response = await register(url, "React again").expect(400)
      expect(fieldErrors(response.body)).toEqual([{ field: "url", position: null, problem: "duplicate" }])
    }
    expect(feeds.requestsTo(FEED_A)).toBe(1)
    expect(await feedRows()).toHaveLength(1)
  })

  it("the 10th feed is accepted, an 11th is refused as limit_reached (also when it is a duplicate), and removing one frees a slot", async () => {
    await verify().expect(200)
    for (let n = 1; n <= 10; n += 1) {
      feeds.on(FEED_URL(n), { kind: "body", body: atomFeed([]) })
      await register(FEED_URL(n), null).expect(201)
    }
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    expect(fieldErrors((await register(FEED_A).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    expect(fieldErrors((await register(FEED_URL(3)).expect(400)).body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    expect(feeds.requestsTo(FEED_A)).toBe(0)
    const [first] = alertFeedsResponseSchema.parse((await candidate.get(ALERT_FEEDS_PATH).expect(200)).body).feeds
    await candidate.delete(`${ALERT_FEEDS_PATH}/${first!.id}`).expect(204)
    await register(FEED_A).expect(201)
    expect(await feedRows()).toHaveLength(10)
  })

  it("concurrent: two identical registrations store one feed; two for the 10th slot leave 10", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    const statuses = (await Promise.all([register(FEED_A), register(FEED_A)])).map((response) => response.status).sort()
    expect(statuses).toEqual([201, 400])
    expect(await feedRows()).toHaveLength(1)
    expect(await postRows()).toHaveLength(2)

    for (let n = 1; n <= 8; n += 1) {
      feeds.on(FEED_URL(n), { kind: "body", body: atomFeed([]) })
      await register(FEED_URL(n), null).expect(201)
    }
    feeds.on(FEED_URL(9), { kind: "body", body: atomFeed([]) })
    feeds.on(FEED_URL(10), { kind: "body", body: atomFeed([]) })
    const race = await Promise.all([register(FEED_URL(9), null), register(FEED_URL(10), null)])
    expect(race.map((response) => response.status).sort()).toEqual([201, 400])
    expect(fieldErrors(race.find((response) => response.status === 400)!.body)).toEqual([{ field: "url", position: null, problem: "limit_reached" }])
    expect(await feedRows()).toHaveLength(10)
  })

  it("removal is idempotent, keeps the posts as 'Removed feed', and the URL can be registered again; a non-UUID id is 400", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    const { id } = (await register(FEED_A).expect(201)).body.feed as { id: string }
    await candidate.delete(`${ALERT_FEEDS_PATH}/${id}`).expect(204)
    await candidate.delete(`${ALERT_FEEDS_PATH}/${id}`).expect(204)
    await candidate.delete(`${ALERT_FEEDS_PATH}/not-a-uuid`).expect(400)
    const posts = stackPostsResponseSchema.parse((await candidate.get(STACK_POSTS_PATH).expect(200)).body)
    expect(posts.items.map((item) => item.source)).toEqual([null, null])
    expect((await register(FEED_A, "React posts v2").expect(201)).body.storedPosts).toBe(0)
  })
})

describe("scheduled read (StackPostsReader against Postgres)", () => {
  async function registered(url: string, body = atomFeed([])): Promise<string> {
    feeds.on(url, { kind: "body", body })
    const response = await register(url, null).expect(201)
    feeds.reset()
    return (response.body.feed as { id: string }).id
  }

  it("skips during the global pause: no request, a run row, feeds untouched", async () => {
    await verify().expect(200)
    await registered(FEED_A)
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    expect(await reader.runRead()).toMatchObject({ outcome: "skipped_global_pause", feedsRead: 0 })
    expect(feeds.requests).toEqual([])
    expect(await database.db.selectFrom("stack_post_run").select("outcome").execute()).toEqual([{ outcome: "skipped_global_pause" }])
  })

  it("skips without a verification and requests nothing", async () => {
    await database.db.insertInto("alert_feed").values({ candidate_id: database.operatorId, id: randomUUID(), url: FEED_A, label: null, created_at: clock.now(), last_read_at: null, last_failure_reason: null, last_failed_at: null }).execute()
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    expect((await reader.runRead()).outcome).toBe("skipped_unverified")
    expect(feeds.requests).toEqual([])
  })

  it("a cost pause does not stop reads (AC 6.5); no AI call or spend", async () => {
    await verify().expect(200)
    await registered(FEED_A)
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    expect(await reader.runRead()).toMatchObject({ outcome: "completed", feedsRead: 1, postsStored: 2 })
    expect(await database.db.selectFrom("ai_call").select("id").execute()).toEqual([])
    expect(await database.db.selectFrom("spend_entry").select("id").execute()).toEqual([])
  })

  it("dedupes by canonical URL: a repeat read stores nothing; another feed keeps the first source and matches", async () => {
    await verify().expect(200)
    const a = await registered(FEED_A)
    const b = await registered(FEED_B)
    const dup = atomFeed([
      { title: "React hooks", link: googleRedirect(`${REACT_POST}/?utm=1#x`) },
      { title: "React hooks again", link: REACT_POST },
    ])
    feeds.on(FEED_A, { kind: "body", body: dup })
    feeds.on(FEED_B, { kind: "status", status: 404 })
    clock.set("2026-10-21T13:00:00.000Z")
    expect(await reader.runRead()).toMatchObject({ feedsRead: 1, feedsFailed: 1, postsStored: 1 })

    await database.db.updateTable("job_criteria").set({ frameworks: ["Vue"], technologies: [] }).execute()
    feeds.on(FEED_A, { kind: "body", body: dup })
    feeds.on(FEED_B, { kind: "body", body: dup })
    clock.set("2026-10-21T19:00:00.000Z")
    expect(await reader.runRead()).toMatchObject({ feedsRead: 2, feedsFailed: 0, postsStored: 0 })
    const rows = await postRows()
    expect(rows.map((row) => [row.canonical_url, row.source_feed_id, row.matched_technologies, row.first_seen_at.toISOString()])).toEqual([
      [REACT_POST, a, ["React"], "2026-10-21T13:00:00.000Z"],
    ])
    const feedB = (await feedRows()).find((row) => row.id === b)!
    expect(feedB).toMatchObject({ last_failure_reason: null, last_failed_at: null, last_read_at: new Date("2026-10-21T19:00:00.000Z") })
  })

  it("a scheduled read of an entry with &#0; stores every entry and records no failure (SEC-E5-03)", async () => {
    await verify().expect(200)
    await registered(FEED_A)
    feeds.on(FEED_A, { kind: "body", body: atomFeed([{ title: "NUL&#0; here", link: REACT_POST }, { title: "clean", link: "https://www.linkedin.com/posts/ada-obi_clean-1" }]) })
    expect(await reader.runRead()).toMatchObject({ feedsRead: 1, feedsFailed: 0, postsStored: 2 })
    expect((await feedRows())[0]).toMatchObject({ last_failure_reason: null })
    expect((await postRows()).map((row) => row.title).sort()).toEqual(["NUL here", "clean"])
  })

  it("one feed failing never stops the others; the failing feed keeps its last read and shows reason and time", async () => {
    await verify().expect(200)
    await registered(FEED_A)
    clock.set("2026-10-21T09:00:01.000Z")
    await registered(FEED_B)
    feeds.on(FEED_A, { kind: "body", body: fixture("malformed.xml") })
    feeds.on(FEED_B, { kind: "body", body: validFeed() })
    clock.set("2026-10-21T13:00:00.000Z")
    expect(await reader.runRead()).toMatchObject({ outcome: "completed", feedsRead: 1, feedsFailed: 1, postsStored: 2 })
    const list = alertFeedsResponseSchema.parse((await candidate.get(ALERT_FEEDS_PATH).expect(200)).body).feeds
    expect(list.map((feed) => [feed.maskedUrl, feed.lastReadAt, feed.failure])).toEqual([
      ["…654321", "2026-10-21T09:00:00.000Z", { reason: "not_a_feed", at: "2026-10-21T13:00:00.000Z" }],
      ["…222333", "2026-10-21T13:00:00.000Z", null],
    ])
    expect(list.map((feed) => feed.createdAt)).toEqual(["2026-10-21T09:00:00.000Z", "2026-10-21T09:00:01.000Z"])
  })

  it.each([
    ["timed_out", { kind: "hang" } as const],
    ["redirected", { kind: "redirect", status: 302, location: "https://www.linkedin.com/" } as const],
    ["too_large", { kind: "stream", chunkBytes: 64 * 1024 } as const],
  ])("records %s", async (reason, reply) => {
    await verify().expect(200)
    await registered(FEED_A)
    feeds.on(FEED_A, reply)
    await reader.runRead()
    expect((await feedRows())[0]).toMatchObject({ last_failure_reason: reason })
  })

  it("retries 5xx with the board delays, then records unexpected_response; a success on retry is not a failure", async () => {
    await verify().expect(200)
    await registered(FEED_A)
    feeds.on(FEED_A, { kind: "status", status: 503 })
    await reader.runRead()
    expect(feeds.requestsTo(FEED_A)).toBe(3)
    expect(sleeps).toEqual([1_000, 4_000])
    expect((await feedRows())[0]).toMatchObject({ last_failure_reason: "unexpected_response" })

    feeds.reset()
    sleeps.length = 0
    feeds.on(FEED_A, (attempt) => (attempt === 1 ? { kind: "status", status: 429 } : { kind: "body", body: validFeed() }))
    expect(await reader.runRead()).toMatchObject({ feedsRead: 1, feedsFailed: 0, postsStored: 2 })
    expect(sleeps).toEqual([1_000])
    expect((await feedRows())[0]).toMatchObject({ last_failure_reason: null })
  })

  // alert-feeds.feature r3 (CR-E5-03): "An internal error during a scheduled read leaves the feed's stored state unchanged and is counted on the run"
  describe("internal errors leave the feed's stored state unchanged (CR-E5-03)", () => {
    const SECRET_MESSAGE = `boom ${FEED_A_DIGITS}`
    type FeedState = Pick<Awaited<ReturnType<typeof feedRows>>[number], "last_read_at" | "last_failure_reason" | "last_failed_at">
    const stateOf = async (id: string): Promise<FeedState> => {
      const row = (await feedRows()).find((feed) => feed.id === id)!
      return { last_read_at: row.last_read_at, last_failure_reason: row.last_failure_reason, last_failed_at: row.last_failed_at }
    }

    /** A reader whose entry-to-post step throws for one feed. */
    class FaultyBuildReader extends StackPostsReader {
      constructor(
        private readonly faultyFeedId: string,
        private readonly makeError: () => Error = () => new TypeError(SECRET_MESSAGE)
      ) {
        super(new StackPostsRepository(tenant), feedClient(feeds.origin), clock)
      }
      protected override buildPosts(feedId: string, body: string, criteria: MatchCriteria) {
        if (feedId === this.faultyFeedId) throw this.makeError()
        return super.buildPosts(feedId, body, criteria)
      }
    }

    async function setUp(before: "healthy" | "failing"): Promise<{ a: string; b: string }> {
      await verify().expect(200)
      clock.set("2026-10-21T07:00:00.000Z")
      const a = await registered(FEED_A)
      clock.set("2026-10-21T07:00:01.000Z")
      const b = await registered(FEED_B)
      if (before === "failing") {
        await database.db.updateTable("alert_feed").set({ last_failure_reason: "timed_out", last_failed_at: new Date("2026-10-21T01:00:00Z") }).where("id", "=", a).execute()
      }
      feeds.on(FEED_A, { kind: "body", body: atomFeed([{ title: "React A", link: "https://www.linkedin.com/posts/ada-obi_a-1" }]) })
      feeds.on(FEED_B, { kind: "body", body: atomFeed([{ title: "TypeScript B", link: "https://www.linkedin.com/posts/ada-obi_b-1" }]) })
      clock.set("2026-10-21T13:00:00.000Z")
      return { a, b }
    }

    async function expectInternalErrorOutcome(run: () => Promise<unknown>, a: string, b: string): Promise<void> {
      const before = await stateOf(a)
      expect(await run()).toMatchObject({ outcome: "completed", feedsRead: 1, feedsFailed: 1, postsStored: 1 })
      expect(await stateOf(a)).toEqual(before)
      const posts = await postRows()
      expect(posts.map((post) => [post.title, post.source_feed_id])).toEqual([["TypeScript B", b]])
      const [run1] = await database.db.selectFrom("stack_post_run").selectAll().execute()
      expect(run1).toMatchObject({ outcome: "completed", feeds_read: 1, feeds_failed: 1 })
      const errorLines = logs.filter((entry) => entry.includes("internal error"))
      expect(errorLines).toHaveLength(1)
      expect(errorLines[0]).toMatch(new RegExp(`^Alert feed ${a} \\(…654321\\) read failed: internal error [A-Z]\\w+ at [\\w.-]+\\.[jt]s:\\d+`))
      expect(logs.join("\n")).not.toContain("boom")
    }

    it("the database refuses the write that records the read: no failure mark, last read kept", async () => {
      const { a, b } = await setUp("healthy")
      await sql
        .raw(
          `create function e5f_refuse() returns trigger language plpgsql as $$ begin raise exception 'boom ${FEED_A_DIGITS}'; end $$;
           create trigger e5f_refuse before update on alert_feed for each row when (new.id = '${a}') execute function e5f_refuse();`
        )
        .execute(database.db)
      try {
        await expectInternalErrorOutcome(() => reader.runRead(), a, b)
        expect(await stateOf(a)).toEqual({ last_read_at: new Date("2026-10-21T07:00:00Z"), last_failure_reason: null, last_failed_at: null })
      } finally {
        await sql.raw("drop trigger e5f_refuse on alert_feed; drop function e5f_refuse();").execute(database.db)
      }
    })

    it("the entry-to-post step throws: a healthy feed stays healthy", async () => {
      const { a, b } = await setUp("healthy")
      await expectInternalErrorOutcome(() => asOperatorWith(tenant, new FaultyBuildReader(a)).runRead(), a, b)
      const list = alertFeedsResponseSchema.parse((await candidate.get(ALERT_FEEDS_PATH).expect(200)).body).feeds
      expect(list.find((feed) => feed.id === a)).toMatchObject({ lastReadAt: "2026-10-21T07:00:00.000Z", failure: null })
    })

    it("the entry-to-post step throws: a feed failing with timed_out keeps that reason and time", async () => {
      const { a, b } = await setUp("failing")
      await expectInternalErrorOutcome(() => asOperatorWith(tenant, new FaultyBuildReader(a)).runRead(), a, b)
      const list = alertFeedsResponseSchema.parse((await candidate.get(ALERT_FEEDS_PATH).expect(200)).body).feeds
      expect(list.find((feed) => feed.id === a)).toMatchObject({ failure: { reason: "timed_out", at: "2026-10-21T01:00:00.000Z" } })
    })

    it("the stored URL fails the outbound allowlist check: no failure mark", async () => {
      const { a, b } = await setUp("healthy")
      const real = feedClient(feeds.origin)
      const http: AlertFeedHttp = {
        get: (url, options) => (url === FEED_A ? Promise.reject(new AlertFeedError("url_not_allowed")) : real.get(url, options)),
      }
      await expectInternalErrorOutcome(() => asOperatorWith(tenant, new StackPostsReader(new StackPostsRepository(tenant), http, clock)).runRead(), a, b)
    })

    // alert-feeds.feature r4 (SEC-E5F-03): "A multi-line error message cannot choose the file:line in the internal-error log line"
    it.each([
      ["a multi-line message", () => new TypeError(`boom\n    at x (/src/www.google.com.ts:1:1)`)],
      [
        "a multi-line name",
        () => {
          const error = new TypeError("boom")
          error.name = "Error\n    at x (/src/www.google.com.ts:1:1)"
          return error
        },
      ],
    ] as const)("%s cannot choose the logged file:line; the frame comes from Eve's own stack (SEC-E5F-03)", async (_name, makeError) => {
      const { a, b } = await setUp("healthy")
      await expectInternalErrorOutcome(() => asOperatorWith(tenant, new FaultyBuildReader(a, makeError)).runRead(), a, b)
      const line = logs.find((entry) => entry.includes("internal error"))!
      expect(line).toMatch(/internal error TypeError at stack-posts-reader\.ts:\d+\b/)
      expect(logs.join("\n")).not.toContain("www.google.com.ts")
    })

    it("does not hide a real fetch failure in the same run", async () => {
      const { a, b } = await setUp("healthy")
      feeds.on(FEED_A, { kind: "status", status: 404 })
      const before = await stateOf(b)
      expect(await asOperatorWith(tenant, new FaultyBuildReader(b)).runRead()).toMatchObject({ feedsRead: 0, feedsFailed: 2 })
      expect(await stateOf(a)).toMatchObject({ last_failure_reason: "unexpected_response", last_failed_at: new Date("2026-10-21T13:00:00Z") })
      expect(await stateOf(b)).toEqual(before)
      expect(await database.db.selectFrom("stack_post_run").select("feeds_failed").execute()).toEqual([{ feeds_failed: 2 }])
    })
  })

  it("removing a feed during its retry wait makes no further request and records no failure (AC 4.8)", async () => {
    await verify().expect(200)
    const id = await registered(FEED_A)
    feeds.on(FEED_A, { kind: "status", status: 503 })
    onSleep = async () => {
      await candidate.delete(`${ALERT_FEEDS_PATH}/${id}`).expect(204)
    }
    expect(await reader.runRead()).toMatchObject({ feedsRead: 0, feedsFailed: 0 })
    expect(feeds.requestsTo(FEED_A)).toBe(1)
    expect(await feedRows()).toEqual([])
  })

  it("with no feed registered, a run makes no request and still applies retention", async () => {
    await verify().expect(200)
    await seedPosts(1, { firstSeen: () => new Date("2026-01-01T00:00:00Z") })
    expect(await reader.runRead()).toMatchObject({ outcome: "completed", postsDeleted: 1 })
    expect(feeds.requests).toEqual([])
  })

  // stack-post-ingestion.feature @ac-5.8 "A post that retention deleted is stored again as new when seen again" (F-QA-E5-01)
  it("a post deleted by retention is stored again as new on a later read", async () => {
    await verify().expect(200)
    const feedId = await registered(FEED_A)
    const target = "https://www.linkedin.com/posts/ada-obi_x-1"
    await database.db
      .insertInto("stack_post")
      .values({ candidate_id: database.operatorId, id: randomUUID(), canonical_url: target, kind: "post", title: "Old", snippet: "Old", published_at: null, matched_technologies: [], source_feed_id: feedId, first_seen_at: new Date("2026-06-01T00:00:00Z") })
      .execute()
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    clock.set("2026-10-21T08:00:00.000Z")
    expect(await reader.runRead()).toMatchObject({ postsDeleted: 1 })
    expect(await postRows()).toEqual([])

    feeds.on(FEED_A, { kind: "body", body: atomFeed([{ title: "React again", link: googleRedirect(target) }]) })
    clock.set("2026-10-21T13:00:00.000Z")
    expect(await reader.runRead()).toMatchObject({ feedsRead: 1, postsStored: 1, postsDeleted: 0 })
    expect((await postRows()).map((row) => [row.canonical_url, row.title, row.first_seen_at.toISOString(), row.source_feed_id])).toEqual([
      [target, "React again", "2026-10-21T13:00:00.000Z", feedId],
    ])
    const page = stackPostsResponseSchema.parse((await candidate.get(STACK_POSTS_PATH).expect(200)).body)
    expect(page.items.map((item) => item.canonicalUrl)).toEqual([target])
  })

  it("retention: older than 90 days by first-seen is deleted (exactly 90 kept), published date ignored", async () => {
    await verify().expect(200)
    clock.set("2026-10-21T14:00:00.000Z")
    const seen = ["2026-07-23T14:00:01Z", "2026-07-23T14:00:00Z", "2026-07-23T13:59:59Z", "2026-01-01T00:00:00Z"]
    await seedPosts(4, { firstSeen: (i) => new Date(seen[i]!), published: () => new Date("2026-10-20T00:00:00Z") })
    await reader.runRead()
    expect((await postRows()).map((row) => row.first_seen_at.toISOString())).toEqual(["2026-07-23T14:00:00.000Z", "2026-07-23T14:00:01.000Z"])
  })

  it("retention: age first, then only the newest 2,000 by first-seen, also when every feed failed", async () => {
    await verify().expect(200)
    await registered(FEED_A)
    feeds.on(FEED_A, { kind: "status", status: 404 })
    clock.set("2026-10-21T14:00:00.000Z")
    await seedPosts(3, { firstSeen: () => new Date("2026-06-01T00:00:00Z") })
    await seedPosts(RETENTION_MAX_POSTS + 5, { firstSeen: (i) => new Date(Date.UTC(2026, 9, 1) + i * 60_000), published: (i) => new Date(Date.UTC(2030, 0, 1) - i * 60_000) })
    expect(await reader.runRead()).toMatchObject({ feedsFailed: 1, postsDeleted: 8 })
    const remaining = await postRows()
    expect(remaining).toHaveLength(RETENTION_MAX_POSTS)
    expect(remaining[0]!.title).toBe("Seed 5")
  })
})

describe("posts list paging (posts-list.feature)", () => {
  it("empty: totalCount 0, totalPages 0", async () => {
    expect((await candidate.get(STACK_POSTS_PATH).expect(200)).body).toEqual({ items: [], page: 1, pageSize: 50, totalCount: 0, totalPages: 0 })
  })

  it("51 posts: 50 then 1, newest first by coalesce(published, first seen); past the end is empty with real totals", async () => {
    await seedPosts(51, { firstSeen: (i) => new Date(Date.UTC(2026, 9, 1) + i * 60_000) })
    const page1 = stackPostsResponseSchema.parse((await candidate.get(STACK_POSTS_PATH).expect(200)).body)
    expect(page1).toMatchObject({ page: 1, pageSize: 50, totalCount: 51, totalPages: 2 })
    expect(page1.items).toHaveLength(50)
    expect(page1.items[0]).toMatchObject({ title: "Seed 50", dateKind: "found", source: null })
    const page2 = stackPostsResponseSchema.parse((await candidate.get(`${STACK_POSTS_PATH}?page=2`).expect(200)).body)
    expect(page2.items.map((item) => item.title)).toEqual(["Seed 0"])
    expect((await candidate.get(`${STACK_POSTS_PATH}?page=3`).expect(200)).body).toMatchObject({ items: [], page: 3, totalCount: 51, totalPages: 2 })
  })

  it("ties on date are broken by first-seen, newest first; a published date sorts as 'posted'", async () => {
    const same = new Date("2026-10-20T10:00:00Z")
    await seedPosts(2, { firstSeen: (i) => new Date(Date.UTC(2026, 9, 21, i)), published: () => same })
    const items = stackPostsResponseSchema.parse((await candidate.get(STACK_POSTS_PATH).expect(200)).body).items
    expect(items.map((item) => [item.title, item.dateKind, item.date])).toEqual([
      ["Seed 1", "posted", same.toISOString()],
      ["Seed 0", "posted", same.toISOString()],
    ])
  })

  it("the last of 2,000 posts is on page 40", async () => {
    await seedPosts(2000)
    const page = stackPostsResponseSchema.parse((await candidate.get(`${STACK_POSTS_PATH}?page=40`).expect(200)).body)
    expect(page).toMatchObject({ totalCount: 2000, totalPages: 40 })
    expect(page.items.at(-1)!.title).toBe("Seed 0")
  })

  it.each(["0", "-1", "abc", "1.5", "01", "1e3", "1234567890"])("?page=%s is 400 page/invalid", async (value) => {
    const response = await candidate.get(`${STACK_POSTS_PATH}?page=${encodeURIComponent(value)}`).expect(400)
    expect(fieldErrors(response.body)).toEqual([{ field: "page", position: null, problem: "invalid" }])
  })
})

describe("worker wiring (AC 4.5, 4.7)", () => {
  let worker: INestApplicationContext

  beforeAll(async () => {
    worker = await Test.createTestingModule({
      imports: [WorkerModule.forRoot({ databaseUrl: database.url, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), candidateStorageDir: migratedStorageRoot() })],
    })
      .overrideProvider(WorkerHeartbeat)
      .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(ALERT_FEED_HTTP)
      .useValue(feedClient(feeds.origin))
      .compile()
    Logger.overrideLogger(capture)
    await worker.init()
  })

  afterAll(async () => {
    await worker?.close()
  })

  it("schedules stack-posts.read at 02:00, 08:00, 14:00, 20:00 Africa/Lagos, singleton, retries off", async () => {
    const schedule = await sql<{ cron: string; timezone: string }>`select cron, timezone from pgboss.schedule where name = ${STACK_POSTS_READ_QUEUE}`.execute(database.db)
    expect(schedule.rows).toEqual([{ cron: STACK_POSTS_READ_CRON, timezone: "Africa/Lagos" }])
    expect(STACK_POSTS_READ_CRON).toBe("0 2,8,14,20 * * *")
    const queue = await sql<{ policy: string; retry_limit: number }>`select policy, retry_limit from pgboss.queue where name = ${STACK_POSTS_READ_QUEUE}`.execute(database.db)
    expect(queue.rows).toEqual([{ policy: "singleton", retry_limit: 0 }])
  })

  it("the job handler reads through the runtime role and stores posts", async () => {
    await verify().expect(200)
    feeds.on(FEED_A, { kind: "body", body: atomFeed([]) })
    await register(FEED_A).expect(201)
    feeds.on(FEED_A, { kind: "body", body: validFeed() })
    // EPIC-0008 (AR-6): the Stack posts read runs per Candidate; the Operator's entry carries her result.
    const { stack } = await worker.get(StackPostsJobs).runScheduled()
    expect(stack.find((entry) => entry.candidateId === database.operatorId)?.result).toMatchObject({ outcome: "completed", feedsRead: 1, postsStored: 2 })
  })
})
