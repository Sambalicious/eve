import pg from "pg"

import { stackState } from "./db.ts"
import type { Family, HintPrefs } from "./hiring-oracle.ts"

/**
 * EPIC-0007 Phase 1 fixtures: per-Candidate Job criteria (frameworks,
 * technologies, EPIC-0006 target_role_families) and Job Preferences (the three
 * booleans AC 2.5 reads, architecture r1 SA-4). Written as the bootstrap
 * superuser (RLS does not bind it), exactly as the api's own int-spec fixtures do.
 */
async function withDb<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

export type HiringInputs = Readonly<{
  families: readonly Family[]
  frameworks?: readonly string[]
  technologies?: readonly string[]
  /** `null` deletes the Job Preferences row (a Candidate before Onboarding, AC 2.5). Omitted leaves it as it is. */
  prefs?: HintPrefs | null
}>

/** Sets one Candidate's Job criteria and, when given, Job Preferences. */
export async function setHiringInputs(email: string, inputs: HiringInputs): Promise<void> {
  await withDb(async (client) => {
    const result = await client.query(
      `update job_criteria set target_role_families = $2, frameworks = $3, technologies = $4
        where candidate_id = (select id from candidate where email = $1)`,
      [email, inputs.families, inputs.frameworks ?? [], inputs.technologies ?? []]
    )
    if (result.rowCount !== 1) throw new Error(`No job_criteria row for ${email}`)
    if (inputs.prefs === undefined) return
    if (inputs.prefs === null) {
      await client.query("delete from job_preferences where candidate_id = (select id from candidate where email = $1)", [email])
      return
    }
    await setPreferenceValues(client, email, inputs.prefs)
  })
}

/**
 * A complete v1.25.0 Job Preferences value (EPIC-0002 B1, strict schema). A new row starts from it,
 * so a row this fixture creates (after `prefs: null` deleted one) parses: since B1 the Job criteria
 * save reads the preferences FOR SHARE and fails closed (500) on a value that does not parse.
 */
const FULL_PREFERENCES: Record<string, unknown> = {
  homeCountry: "NG",
  timeZone: "Africa/Lagos",
  latestWorkHour: "23:00",
  workAuthorizedCountries: ["NG"],
  remoteAccepted: true,
  relocationAccepted: false,
  sponsorshipNeededForRelocation: true,
  excludedRelocationCountries: [],
  excludedIndustries: [],
  payFloor: { amount: "5000.00", currency: "USD", period: "month", basis: "gross" },
  preferredPay: { amount: "6000.00", currency: "USD", period: "month", basis: "net" },
  roleFamilyTiers: {
    senior_frontend: 1, technical_lead: 1, fullstack: 1, product_engineering: 1, software_engineering: 1, backend: 1, mobile: 1,
    platform_engineering: 1, devops_platform: 1, people_management: 1, data_ml: 1, solutions_customer: 1, other: 1,
  },
  titleKeyword: null,
  seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
  employmentTypes: ["direct", "employer_of_record", "contract"],
  dailyCap: 5,
  emphasisThemes: [],
}

/** Writes raw `job_preferences.values` (also used for a malformed row). Keeps other keys already stored; a new row starts from FULL_PREFERENCES. */
async function setPreferenceValues(client: pg.Client, email: string, values: Record<string, unknown>): Promise<void> {
  await client.query(
    `insert into job_preferences (candidate_id, version, values)
       select id, 1, $3::jsonb || $2::jsonb from candidate where email = $1
     on conflict (candidate_id) do update set values = job_preferences.values || $2::jsonb, updated_at = now()`,
    [email, JSON.stringify(values), JSON.stringify(FULL_PREFERENCES)]
  )
}

type Saved = { criteria: pg.QueryResultRow[]; prefs: pg.QueryResultRow[] }

/** Captures every Candidate's criteria and preferences, so a file can put them back for the files after it. */
export async function snapshotHiringInputs(): Promise<Saved> {
  return withDb(async (client) => ({
    criteria: (await client.query("select candidate_id, frameworks, technologies, target_role_families from job_criteria")).rows,
    prefs: (await client.query("select candidate_id, version, values from job_preferences")).rows,
  }))
}

export async function restoreHiringInputs(saved: Saved): Promise<void> {
  await withDb(async (client) => {
    for (const row of saved.criteria) {
      await client.query("update job_criteria set frameworks = $2, technologies = $3, target_role_families = $4 where candidate_id = $1", [
        row.candidate_id,
        row.frameworks,
        row.technologies,
        row.target_role_families,
      ])
    }
    await client.query("delete from job_preferences")
    for (const row of saved.prefs) {
      await client.query("insert into job_preferences (candidate_id, version, values) values ($1, $2, $3)", [row.candidate_id, row.version, row.values])
    }
  })
}

/** Global pause and cost-ceiling pause (control_state singleton). */
export async function setPauses(pauses: { global: boolean; cost: boolean }): Promise<void> {
  await withDb((client) => client.query("update control_state set global_paused = $1, cost_paused = $2", [pauses.global, pauses.cost]))
}

export async function clearAlertFeedVerification(): Promise<void> {
  await withDb((client) => client.query("delete from alert_feed_verification"))
}

/** Tables whose rows a page load may legitimately touch (session idle stamp, sign-in). */
const VOLATILE = new Set(["dashboard_session", "sign_in_attempt"])

/**
 * A content fingerprint of every table in `public` (md5 of the ordered rows),
 * so "no database row is created, changed or deleted" is checked on the data
 * itself rather than on lagging statistics counters.
 */
export async function databaseFingerprint(): Promise<Record<string, string>> {
  return withDb(async (client) => {
    const tables = (await client.query<{ name: string }>("select tablename as name from pg_tables where schemaname = 'public' order by tablename")).rows
    const out: Record<string, string> = {}
    for (const { name } of tables) {
      if (VOLATILE.has(name)) continue
      const row = (await client.query<{ h: string | null }>(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from public.${pg.escapeIdentifier(name)} t`)).rows[0]
      out[name] = row?.h ?? ""
    }
    return out
  })
}

export async function aiCallAndSpendCounts(): Promise<{ aiCalls: number; spendEntries: number }> {
  return withDb(async (client) => ({
    aiCalls: Number((await client.query<{ n: string }>("select count(*) as n from ai_call")).rows[0]?.n ?? 0),
    spendEntries: Number((await client.query<{ n: string }>("select count(*) as n from spend_entry")).rows[0]?.n ?? 0),
  }))
}
