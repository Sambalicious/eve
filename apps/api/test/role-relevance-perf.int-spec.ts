import type { INestApplication } from "@nestjs/common"
import { DEFAULT_TARGET_ROLE_FAMILIES, JOB_CRITERIA_PATH, jobPostingsResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { JobCriteriaSaveLimiter } from "../src/job-criteria/job-criteria-save-limit.guard.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { ROLE_RELEVANCE_DEFAULTS } from "./support/job-criteria-body.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0006 AC-9.1 (migration-and-performance.feature): at 5,000 held postings,
 * a list request stays within the slice 8 budget (p95 300 ms here, on a local
 * Testcontainers Postgres; the VPS figure is QA's), and a families-only save
 * finishes within 5 s. Data mixes every family, status and hidden reason.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
const clock = new TestClock("2026-10-24T08:00:00.000Z")
const ROWS = 5000
const P95_BUDGET_MS = 300

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  const families = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering", "backend", "mobile", "platform_engineering", "devops_platform", "people_management", "data_ml", "solutions_customer", "other"]
  const statuses = ["ranked", "ranked", "ranked", "skipped", "excluded", "evaluation_failed", "not_checked", "waiting_to_be_checked", "checking"]
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at, seniority_marker, posted_at, posted_date_kind)
    select gen_random_uuid(), 'https://boards.greenhouse.io/perf/jobs/' || g, g::text, 'https://boards.greenhouse.io/perf/jobs/' || g, 'Greenhouse', 'automatic', 'employer_board',
      'Engineer ' || g, 'engineer ' || g, 'Co ' || (g % 97), '{}', (${families}::text[])[1 + g % 13], ${clock.now()}::timestamptz - g * interval '17 minutes',
      case when g % 11 = 0 then 'entry' else 'none' end,
      case when g % 7 = 0 then null else ${clock.now()}::timestamptz - (g % 90) * interval '1 day' end,
      case when g % 7 = 0 then null else 'published' end
    from generate_series(1, ${ROWS}) g`.execute(database.db)
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, evaluation_failure, discovered_at)
    select ${database.operatorId}::uuid, p.id, p.origin, (${statuses}::text[])[1 + (p.requisition_id::int % 9)],
      case when (${statuses}::text[])[1 + (p.requisition_id::int % 9)] = 'evaluation_failed' then 'provider_error' end, p.discovered_at
    from job_posting p`.execute(database.db)
  await sql`insert into match_evidence (candidate_id, job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
    select cp.candidate_id, cp.job_posting_id, 1, 'strong', null, 7, 10, 0.700, '[]', now(), 1 from candidate_posting cp where cp.status in ('ranked', 'skipped')`.execute(database.db)
  await sql`analyze`.execute(database.db)
}, 120_000)

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!
}

describe("AC-9.1 at 5,000 held postings", () => {
  it(`list requests on every tab stay within p95 ${P95_BUDGET_MS} ms, and the hidden counts add up`, async () => {
    const queries = ["tab=ranked", "tab=skipped", "tab=all", "tab=all&families=backend,mobile", "tab=ranked&keyword=engineer"]
    for (const query of queries) await ada.get(`/v1/job-postings?${query}`).expect(200) // warm-up
    const samples: number[] = []
    let last = null
    for (let round = 0; round < 4; round++) {
      for (const query of queries) {
        const started = performance.now()
        const response = await ada.get(`/v1/job-postings?${query}`).expect(200)
        samples.push(performance.now() - started)
        if (query === "tab=all") last = jobPostingsResponseSchema.parse(response.body)
      }
    }
    expect(p95(samples)).toBeLessThan(P95_BUDGET_MS)
    const counts = last!.hiddenCounts
    expect(counts.total).toBe(counts.offTarget + counts.belowSeniorityFloor + counts.undated + counts.olderThan60Days)
    expect(last!.totalCount + counts.total).toBe(ROWS)
  })

  it("a families-only save finishes within 5 s and writes no posting rows", async () => {
    app.get(JobCriteriaSaveLimiter).reset()
    const before = await sql<{ n: number }>`select count(*)::int as n from candidate_posting where status = 'ranked'`.execute(database.db)
    const started = performance.now()
    await ada
      .put(JOB_CRITERIA_PATH)
      .send({ ...ROLE_RELEVANCE_DEFAULTS, minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES, "data_ml"], seniorityFloor: "all_levels" })
      .expect(200)
    expect(performance.now() - started).toBeLessThan(5_000)
    expect((await sql<{ n: number }>`select count(*)::int as n from candidate_posting where status = 'ranked'`.execute(database.db)).rows).toEqual(before.rows)
  })
})
