import type { INestApplication } from "@nestjs/common"
import { JOB_CRITERIA_PATH } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { JobCriteriaSaveLimiter } from "../src/job-criteria/job-criteria-save-limit.guard.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { ALL_FAMILIES, DEFAULT_TARGETS, TODAY, list, signInSecondCandidate } from "./support/epic-0006.js"

/**
 * EPIC-0006 QA test authoring (step [5e]): AC-9.1 on a local Testcontainers
 * Postgres (migration-and-performance.feature:286-305). The production-VPS
 * p95 stays @manual for the QA gate.
 *
 * Budget: no numeric "slice 8 p95" exists in the epics (searched EPIC-0001
 * slice 8 docs). This uses 300 ms p95 per list request locally, an assumption
 * stated in qa-tests.md; the architecture expects single-digit ms for the
 * predicate at 5,000 rows. The save budget is EPIC-0004 AC 5.5's 5 s.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
const clock = new TestClock(TODAY)
const LIST_P95_MS = 300
const SAVE_P95_MS = 5_000

const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  ada = await signInCandidate(new Browser(app, google))
  const { id: kofiId } = await signInSecondCandidate(app, google, database.db)
  // 5,000 Operator postings: 3,000 visible; 2,000 hidden across the four reasons (500 each). Plus 5,000 of Kofi's.
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at, posted_at, posted_date_kind, seniority_marker)
    select gen_random_uuid(), 'https://x.test/a/' || g, g::text, 'https://x.test/a/' || g, 'greenhouse', 'automatic', 'employer_board',
      'Senior Frontend Engineer ' || g, 'senior frontend engineer ' || g, 'Co', '{}',
      case when g between 3001 and 3500 then 'data_ml' else 'senior_frontend' end,
      now() - g * interval '1 second',
      case when g between 4001 and 4500 then null when g between 4501 and 5000 then timestamptz '2026-07-01T00:00:00Z' else timestamptz '2026-10-20T00:00:00Z' end,
      case when g between 4001 and 4500 then null else 'published' end,
      case when g between 3501 and 4000 then 'entry' else 'mid_plus' end
    from generate_series(1, 5000) g`.execute(database.db)
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, discovered_at, evaluated_at)
    select ${database.operatorId}::uuid, id, origin, case when random() < 0.6 then 'ranked' else 'skipped' end, null, discovered_at, now() from job_posting`.execute(database.db)
  await sql`update candidate_posting set skip_reason = 'weak_core_match' where status = 'skipped'`.execute(database.db)
  await sql`insert into match_evidence (candidate_id, job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
    select candidate_id, job_posting_id, 1, case when status = 'ranked' then 'strong' else 'weak' end, case when status = 'ranked' then null else 'coverage_below_threshold' end, case when status = 'ranked' then 8 else 5 end, 10, '0.700', '[]', now(), 1 from candidate_posting`.execute(database.db)
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at, posted_at, posted_date_kind, seniority_marker)
    select gen_random_uuid(), 'https://x.test/k/' || g, g::text, 'https://x.test/k/' || g, 'greenhouse', 'automatic', 'employer_board',
      'Backend Engineer ' || g, 'backend engineer ' || g, 'Co', '{}', 'backend', now(), timestamptz '2026-10-20T00:00:00Z', 'published', 'mid_plus'
    from generate_series(1, 5000) g`.execute(database.db)
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at, evaluated_at)
    select ${kofiId}::uuid, id, origin, 'ranked', discovered_at, now() from job_posting where application_url like 'https://x.test/k/%'`.execute(database.db)
  await sql`analyze`.execute(database.db)
}, 120_000)

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

describe("AC-9.1 @AC-9.1 performance at 5,000 postings (migration-and-performance:286-305)", () => {
  it("the fixture holds 2,000 hidden postings across all four reasons", async () => {
    const page = await list(ada, "tab=all")
    expect(page.hiddenCounts).toEqual({ offTarget: 500, belowSeniorityFloor: 500, undated: 500, olderThan60Days: 500, total: 2000 })
  })

  it.each([["tab=ranked"], ["tab=skipped"], ["tab=all"], ["tab=all&families=senior_frontend"]])(
    "migration:286 100 requests of %s stay within the list p95 budget, hidden counts included",
    async (query) => {
      const samples: number[] = []
      for (let i = 0; i < 100; i++) {
        const started = performance.now()
        await ada.get(`/v1/job-postings?${query}`).expect(200)
        samples.push(performance.now() - started)
      }
      expect(p95(samples)).toBeLessThanOrEqual(LIST_P95_MS)
    },
    120_000
  )

  it("migration:300 20 family/floor saves, alternating, finish under 5 s at p95", async () => {
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      app.get(JobCriteriaSaveLimiter).reset()
      const on = i % 2 === 0
      const started = performance.now()
      await ada
        .put(JOB_CRITERIA_PATH)
        .send({ minCoreMatchPercent: 70, frameworks: [], technologies: [], targetRoleFamilies: on ? [...DEFAULT_TARGETS, "data_ml"] : [...DEFAULT_TARGETS], seniorityFloor: on ? "all_levels" : "hide_entry_level" })
        .expect(200)
      samples.push(performance.now() - started)
    }
    expect(p95(samples)).toBeLessThan(SAVE_P95_MS)
    expect(ALL_FAMILIES).toHaveLength(13)
  }, 180_000)
})
