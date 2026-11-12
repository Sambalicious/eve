import { randomUUID } from "node:crypto"

import type { Page } from "@playwright/test"
import pg from "pg"

import { CSRF_HEADER, stackState } from "./db.ts"

/**
 * EPIC-0002 B1 E2E fixtures (qa-author, qa-tests-1). Job Preferences are set
 * through the real `PUT /v1/me/preferences` from the signed-in page; only
 * postings and each Candidate's state for them are seeded in SQL (the e2e stack
 * runs no worker, so nothing is evaluated). Reads of `job_preferences` are for
 * "nothing changed" checks only.
 */
export const PREFS_PATH = "/v1/me/preferences"

async function withDb<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

export type Values = Record<string, unknown>

/** Bola's starting record: home Kenya, daily cap 3 (job-preferences.feature personas, synthetic). */
export function kenyaValues(over: Values = {}): Values {
  return {
    homeCountry: "KE",
    timeZone: "Africa/Nairobi",
    latestWorkHour: "23:00",
    workAuthorizedCountries: ["KE"],
    remoteAccepted: true,
    relocationAccepted: true,
    sponsorshipNeededForRelocation: true,
    excludedRelocationCountries: [],
    excludedIndustries: [],
    payFloor: { amount: "4000.00", currency: "EUR", period: "month", basis: "gross" },
    preferredPay: { amount: "5500.00", currency: "EUR", period: "month", basis: "net" },
    roleFamilyTiers: {
      senior_frontend: 1, technical_lead: 1, fullstack: 2, product_engineering: 2, software_engineering: 3, backend: 3, mobile: 3,
      platform_engineering: 3, devops_platform: 3, people_management: 3, data_ml: 3, solutions_customer: 3, other: 3,
    },
    titleKeyword: null,
    seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
    employmentTypes: ["direct", "employer_of_record", "contract"],
    dailyCap: 3,
    emphasisThemes: [],
    ...over,
  }
}

/** Removes a Candidate's Job Preferences record and history (so the next save is a first save). */
export async function clearPreferences(email: string): Promise<void> {
  await withDb(async (client) => {
    await client.query("delete from job_preferences where candidate_id = (select id from candidate where email = $1)", [email])
    await client.query("delete from job_preferences_version where candidate_id = (select id from candidate where email = $1)", [email])
  })
}

/** Current version and values from the database. */
export async function storedPreferences(email: string): Promise<{ version: number; values: Values } | null> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ version: number; values: Values }>(
      "select version, values from job_preferences where candidate_id = (select id from candidate where email = $1)",
      [email]
    )
    return rows[0] ?? null
  })
}

export async function versionCount(email: string): Promise<number> {
  return withDb(async (client) =>
    Number((await client.query<{ n: string }>("select count(*) as n from job_preferences_version where candidate_id = (select id from candidate where email = $1)", [email])).rows[0]?.n ?? 0)
  )
}

async function csrf(page: Page): Promise<string> {
  return ((await (await page.request.get("/v1/session")).json()) as { csrfToken: string }).csrfToken
}

/** `PUT /v1/me/preferences` from the signed-in page (same session cookie, real CSRF). */
export async function putPreferences(page: Page, baseVersion: number | null, values: Values): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await page.request.put(PREFS_PATH, { data: { baseVersion, values }, headers: { [CSRF_HEADER]: await csrf(page) } })
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> }
}

/** Gives the signed-in page's Candidate a fresh record (version 1) with `values`. */
export async function freshRecord(page: Page, email: string, values: Values = kenyaValues()): Promise<void> {
  await clearPreferences(email)
  const response = await putPreferences(page, null, values)
  if (response.status !== 200) throw new Error(`first save failed: ${response.status} ${JSON.stringify(response.body)}`)
}

/** Saves `change` on top of the stored version from the signed-in page. */
export async function changePreferences(page: Page, email: string, change: Values): Promise<number> {
  const stored = await storedPreferences(email)
  if (!stored) throw new Error(`no record for ${email}`)
  const response = await putPreferences(page, stored.version, { ...stored.values, ...change })
  if (response.status !== 200) throw new Error(`save failed: ${response.status} ${JSON.stringify(response.body)}`)
  return (response.body as { version: number }).version
}

export type Seed = Readonly<{
  title: string | null
  family?: string | null
  status: "ranked" | "skipped" | "excluded" | "waiting_to_be_checked"
  skipReason?: string | null
  minutesAgo?: number
}>

/** One shared posting held by `email`, with strong Match evidence when ranked. Returns its id. */
export async function seedPosting(email: string, seed: Seed): Promise<string> {
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/qab1e2e/jobs/${id}`
  const title = seed.title
  const family = seed.family === undefined ? "senior_frontend" : seed.family
  const discovered = new Date(Date.now() - (seed.minutesAgo ?? 60) * 60_000)
  await withDb(async (client) => {
    await client.query(
      `insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, posting_text,
                                discovered_at, role_family, seniority_marker, posted_at, posted_date_kind)
       values ($1, $2, $3, $2, 'greenhouse', 'automatic', 'employer_board', $4, lower($4), 'QAB1', 'Remote, open to candidates in Kenya.', $5, $6, $7, $5, 'published')`,
      [id, url, id.slice(0, 13), title, discovered, family, title === null ? null : "mid_plus"]
    )
    await client.query(
      `insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, discovered_at, evaluated_at)
       select id, $2, 'employer_board', $3, $4, $5::timestamptz, case when $3 = 'waiting_to_be_checked' then null else $5::timestamptz end from candidate where email = $1`,
      [email, id, seed.status, seed.skipReason ?? null, discovered]
    )
    if (seed.status === "ranked") {
      await client.query(
        `insert into match_evidence (candidate_id, job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at, criteria_version)
         select id, $2, 1, 'strong', null, 8, 10, 0.700, '[]', $3, 1 from candidate where email = $1`,
        [email, id, discovered]
      )
    }
  })
  return id
}

/** Every family a target and all levels for `email`, so EPIC-0006 visibility hides nothing these journeys seed. */
export async function targetEveryFamily(email: string): Promise<void> {
  await withDb((client) =>
    client.query(
      `update job_criteria set target_role_families = array['senior_frontend','technical_lead','fullstack','product_engineering','software_engineering','backend','mobile',
         'platform_engineering','devops_platform','people_management','data_ml','solutions_customer','other'], seniority_floor = 'all_levels'
       where candidate_id = (select id from candidate where email = $1)`,
      [email]
    )
  )
}

export async function postingState(email: string, postingId: string): Promise<{ status: string; skipReason: string | null }> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ status: string; skipReason: string | null }>(
      `select status, skip_reason as "skipReason" from candidate_posting where job_posting_id = $2 and candidate_id = (select id from candidate where email = $1)`,
      [email, postingId]
    )
    if (!rows[0]) throw new Error("no candidate_posting")
    return rows[0]
  })
}
