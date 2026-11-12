import type { INestApplication } from "@nestjs/common"
import { DEFAULT_SENIORITY_FLOOR, DEFAULT_TARGET_ROLE_FAMILIES } from "@eve/contracts"
import { CompiledQuery, sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { createDatabase } from "../src/db/create-database.js"
import { API_STATEMENT_TIMEOUT_MS } from "../src/db/statement-timeouts.js"
import { ranksOf } from "../src/discovery/job-postings-query.js"
import { TIER } from "../src/discovery/rules/ranking.js"
import { buildVisibilityContext } from "../src/discovery/visibility.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * job-postings-per-candidate.feature:289 (@slice-A2, AC 5.16, F-QA-03): Kofi
 * and Wanjiru each hold 24,000 ranked postings. Kofi follows nextCursor at
 * limit 100 to the last page of his Ranked tab on the real api, whose pool has
 * the 5 s statement_timeout; every page returns inside 5 s, the ranks run
 * 1..24,000, and the rank query's plan reads only Kofi's candidate_posting rows.
 * After the EPIC-0006 merge every posting is dated inside 60 days and on a
 * default target family, so all 24,000 stay visible (an undated one is hidden).
 */
const PER_CANDIDATE = 24_000
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let kofi: SignedInCandidate
let kofiId: string
let wanjiruId: string
const clock = new TestClock("2026-10-21T09:00:00.000Z")
const KOFI_SUB = "200000000000000000289"

async function seedRanked(candidateId: string, prefix: string): Promise<void> {
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, status, role_family, discovered_at, posted_at, posted_date_kind)
    select gen_random_uuid(), 'https://boards.greenhouse.io/' || ${prefix} || '/jobs/' || g, g::text, 'https://boards.greenhouse.io/' || ${prefix} || '/jobs/' || g, 'greenhouse', 'automatic', 'employer_board',
      ${prefix} || ' Engineer ' || g, ${prefix} || ' engineer ' || g, 'Co', '{}', 'ranked', case g % 3 when 0 then 'senior_frontend' when 1 then 'fullstack' else 'backend' end,
      timestamptz '2026-10-01 08:00:00Z' + g * interval '1 second', timestamptz '2026-10-01 08:00:00Z' + g * interval '1 second', 'published'
    from generate_series(1, ${PER_CANDIDATE}) g`.execute(database.db)
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at, evaluated_at)
    select ${candidateId}::uuid, p.id, p.origin, 'ranked', p.discovered_at, p.discovered_at from job_posting p where p.application_url like ${`https://boards.greenhouse.io/${prefix}/%`}`.execute(database.db)
  await sql`insert into match_evidence (candidate_id, job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
    select ${candidateId}::uuid, cp.job_posting_id, 1, 'strong', null, 5 + (abs(hashtext(cp.job_posting_id::text)) % 6), 10, 0.700, '[]', now(), 1
    from candidate_posting cp where cp.candidate_id = ${candidateId}::uuid`.execute(database.db)
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  const operator = await signInCandidate(new Browser(app, google))
  kofiId = (await database.db.insertInto("candidate").values({ email: "kofi.rank@example.test", google_sub: KOFI_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  wanjiruId = (await database.db.insertInto("candidate").values({ email: "wanjiru.rank@example.test", google_sub: "synthetic-wanjiru-rank", role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  for (const id of [kofiId, wanjiruId]) await database.db.insertInto("job_criteria").values({ candidate_id: id, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  await seedRanked(kofiId, "kofi")
  await seedRanked(wanjiruId, "wanjiru")
  await sql`analyze`.execute(database.db)
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: KOFI_SUB, email: "kofi.rank@example.test", email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  kofi = new (operator.constructor as typeof SignedInCandidate)(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, "kofi.rank@example.test")
}, 300_000)

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

type Page = { postings: { id: string; rank?: number | null; title: string | null }[]; totalCount: number; nextCursor: string | null }

describe("ranking a 24,000-posting Candidate stays inside the timeout (:289)", () => {
  it("every page to Kofi's last Ranked page returns within 5 seconds, with ranks 1..24,000 and none of Wanjiru's postings", { timeout: 600_000 }, async () => {
    expect(API_STATEMENT_TIMEOUT_MS).toBe(5_000)
    const ranks: number[] = []
    let slowest = 0
    let cursor: string | null = null
    let pages = 0
    do {
      const started = performance.now()
      const response = await kofi.get(`/v1/job-postings?tab=ranked&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      slowest = Math.max(slowest, performance.now() - started)
      expect(response.status).toBe(200)
      const page = response.body as Page
      expect(page.totalCount).toBe(PER_CANDIDATE)
      expect(page.postings.some((posting) => posting.title?.startsWith("wanjiru"))).toBe(false)
      ranks.push(...page.postings.map((posting) => posting.rank ?? -1))
      cursor = page.nextCursor
      pages++
    } while (cursor !== null && pages < 1_000)
    expect(pages).toBe(PER_CANDIDATE / 100)
    expect(ranks).toEqual(Array.from({ length: PER_CANDIDATE }, (_, index) => index + 1))
    expect(slowest).toBeLessThan(5_000)
  })

  it("the rank computation reads only Kofi's ranked rows", async () => {
    // Capture the exact SQL ranksOf sends, then EXPLAIN ANALYZE it in Kofi's scope.
    const sent: CompiledQuery[] = []
    const runtime = createDatabase(database.url, { statementTimeoutMs: API_STATEMENT_TIMEOUT_MS })
    try {
      // A raw runtime-role transaction scoped as TenantDatabase.forCandidate scopes it: its guarded handle hides the executor this test records.
      const plan = await runtime.transaction().execute(async (tx) => {
        await sql`select set_config('eve.candidate_id', ${kofiId}, true), public.bind_candidate(${kofiId}::uuid)`.execute(tx)
        const ids = (await tx.selectFrom("candidate_posting").select("job_posting_id").where("candidate_id", "=", kofiId).limit(3).execute()).map((row) => row.job_posting_id)
        const recording = tx.withoutPlugins()
        const executor = recording.getExecutor()
        const original = executor.executeQuery.bind(executor)
        Object.assign(executor, { executeQuery: (query: CompiledQuery, ...rest: unknown[]) => (sent.push(query), (original as (q: CompiledQuery, ...r: unknown[]) => unknown)(query, ...rest)) })
        expect([...(await ranksOf(recording as never, kofiId, buildVisibilityContext({ targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: DEFAULT_SENIORITY_FLOOR }, clock.now()), TIER, ids)).values()].every((rank) => rank >= 1 && rank <= PER_CANDIDATE)).toBe(true)
        const rankQuery = sent.find((query) => /row_number\(\)/.test(query.sql))!
        // With two equal-sized Candidates a sequential scan is cheaper, so the planner's choice
        // says nothing about the access path; disable it to show the bounded path the query takes.
        await sql`set local enable_seqscan = off`.execute(tx)
        const explained = await tx.executeQuery<{ "QUERY PLAN": unknown }>(CompiledQuery.raw(`explain (analyze, format json) ${rankQuery.sql}`, [...rankQuery.parameters]))
        return explained.rows[0]!["QUERY PLAN"]
      })
      const nodes: Record<string, unknown>[] = []
      const walk = (node: Record<string, unknown>) => {
        nodes.push(node)
        for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child)
      }
      walk((plan as { Plan: Record<string, unknown> }[])[0]!.Plan)
      const scans = nodes.filter((node) => node["Relation Name"] === "candidate_posting")
      // One read of candidate_posting, keyed by Kofi's ID through an index, returning exactly his 24,000 rows.
      expect(scans).toHaveLength(1)
      const [scan] = scans
      expect(String(scan!["Node Type"])).toMatch(/Index|Bitmap Heap/)
      const keyed = nodes.filter((node) => /Index/.test(String(node["Node Type"])) && String(node["Index Cond"]).includes("candidate_id"))
      expect(keyed.length).toBeGreaterThan(0)
      expect(scan!["Actual Rows"]).toBe(PER_CANDIDATE)
      expect(scan!["Rows Removed by Filter"] ?? 0).toBe(0)
      expect(scan!["Rows Removed by Index Recheck"] ?? 0).toBe(0)
    } finally {
      await runtime.destroy()
    }
  })
})
