import { type Kysely, sql } from "kysely"
import type { Migration } from "kysely/migration"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0002 A1 unit 4 (architecture r2 "Migration of the owner" step 6; PRD r4
 * AC 1 "The owner's Job Preferences are created from current values"). Runs
 * after the tenancy and RLS migrations (numbering per D19: nothing reserved).
 *
 * 1. `job_preferences` (current values, one row per Candidate) and the immutable
 *    `job_preferences_version` history (architecture r1 "Preferences versioning").
 *    Version 1 for the owner (the Operator). Time zone and latest work hour come
 *    from `evaluation_setting` (0016's preflight proved the cutoff is not 00:00
 *    and the work-authorization text means Nigeria only); preferred pay from the
 *    owner's saved `preferred_net_pay`, else the PRD's USD 5,000 net per month.
 *    Nothing reads these rows yet: slice B moves the rules onto them, and folds
 *    `job_criteria` (EPIC-0004) in then. The value shape is provisional until B.
 * 2. `ai_terms_record` (shared, immutable versions) and `ai_terms_approval`
 *    (Candidate). Record 1 and the owner's approval come from the slice 2
 *    `ai_provider_approval` row, if there is one. That row stays: the built code
 *    reads it until slice C.
 * 3. RLS, forced, with `<table>_candidate`, as 0017 does for every Candidate
 *    table. FORCE binds this owner role too, so the owner's rows are written
 *    with `eve.candidate_id` set to the Operator for this transaction only.
 */
export const OWNER_PREFERENCE_TABLES: readonly string[] = ["job_preferences", "job_preferences_version", "ai_terms_approval"]

const CURRENT_CANDIDATE = sql.raw("nullif(current_setting('eve.candidate_id', true), '')::uuid")

/** PRD r4 AC 1, in the order the PRD lists them. Time zone, latest work hour and preferred pay are filled from current settings. Exported for its unit test. */
export function ownerValues(timeZone: string, latestWorkHour: string, preferredPay: { amount: string; currency: string }) {
  return {
    homeCountry: "NG",
    timeZone,
    latestWorkHour,
    workAuthorizedCountries: ["NG"],
    remoteAccepted: true,
    relocationAccepted: true,
    sponsorshipNeededForRelocation: true,
    // locations.ts EXCLUDED_RELOCATION_COUNTRIES: Oman, Turkey, Jordan, Lebanon, Thailand.
    excludedRelocationCountries: ["OM", "TR", "JO", "LB", "TH"],
    excludedIndustries: ["adult_content", "video_games_and_gaming_platforms", "gambling", "betting"],
    // pay.ts PAY_FLOOR_MONTHLY_USD_CENTS = 200_000.
    payFloor: { amount: "2000.00", currency: "USD", period: "month", basis: "gross" },
    preferredPay: { ...preferredPay, period: "month", basis: "net" },
    // ranking.ts TIER (0, 1, 2 there; 1, 2, 3 here). Keys are the contracts `roleFamily` enum: the stored key stays `senior_frontend` (architecture r4, D16).
    roleFamilyTiers: { senior_frontend: 1, technical_lead: 1, fullstack: 2, product_engineering: 2, backend: 3, mobile: 3, devops_platform: 3, people_management: 3, other: 3 },
    excludedRoleFamilies: [],
    titleKeyword: null,
    seniorityLevels: "all",
    employmentTypes: ["direct", "employer_of_record", "contract"],
    dailyCap: 5,
    emphasisThemes: ["building projects from scratch to production", "accelerating team delivery", "mentoring developers"],
  }
}

export const up: Migration["up"] = async (db: Kysely<unknown>) => {
  await sql`create table job_preferences (
    candidate_id uuid primary key references candidate (id) on delete cascade,
    version integer not null check (version >= 1),
    values jsonb not null check (jsonb_typeof(values) = 'object'),
    updated_at timestamptz not null default now()
  )`.execute(db)
  await sql`create table job_preferences_version (
    candidate_id uuid not null references candidate (id) on delete cascade,
    version integer not null check (version >= 1),
    values jsonb not null check (jsonb_typeof(values) = 'object'),
    saved_at timestamptz not null default now(),
    primary key (candidate_id, version)
  )`.execute(db)
  await sql`create table ai_terms_record (
    version integer primary key check (version >= 1),
    provider text not null check (provider = 'anthropic'),
    terms_checked_on date not null,
    training_line text not null,
    retention_line text not null,
    whats_sent_line text not null,
    recorded_at timestamptz not null
  )`.execute(db)
  await sql`create table ai_terms_approval (
    candidate_id uuid not null references candidate (id) on delete cascade,
    terms_version integer not null references ai_terms_record (version),
    approved_at timestamptz not null,
    primary key (candidate_id, terms_version)
  )`.execute(db)

  const operator = await sql<{ id: string }>`select id from candidate where role = 'operator'`.execute(db)
  const ownerId = operator.rows[0]?.id
  if (ownerId === undefined) throw new Error("No Operator: migration 0016 must run first")

  for (const table of OWNER_PREFERENCE_TABLES) {
    const t = sql.table(table)
    await sql`alter table ${t} enable row level security`.execute(db)
    await sql`alter table ${t} force row level security`.execute(db)
    await sql`create policy ${sql.id(`${table}_candidate`)} on ${t} for all
      using (candidate_id = ${CURRENT_CANDIDATE}) with check (candidate_id = ${CURRENT_CANDIDATE})`.execute(db)
  }

  await sql`select set_config('eve.candidate_id', ${ownerId}, true)`.execute(db)

  const hours = await sql<{ hours_time_zone: string; hours_cutoff: string }>`select hours_time_zone, hours_cutoff from evaluation_setting`.execute(db)
  const setting = hours.rows[0] ?? { hours_time_zone: "Africa/Lagos", hours_cutoff: "23:00" }
  const pay = await sql<{ amount: string; currency: string }>`select amount::text as amount, currency from preferred_net_pay where candidate_id = ${ownerId}`.execute(db)
  const values = JSON.stringify(ownerValues(setting.hours_time_zone, setting.hours_cutoff, pay.rows[0] ?? { amount: "5000.00", currency: "USD" }))
  await sql`insert into job_preferences (candidate_id, version, values) values (${ownerId}, 1, ${values}::jsonb)`.execute(db)
  await sql`insert into job_preferences_version (candidate_id, version, values) values (${ownerId}, 1, ${values}::jsonb)`.execute(db)

  const approval = await sql`
    insert into ai_terms_record (version, provider, terms_checked_on, training_line, retention_line, whats_sent_line, recorded_at)
    select 1, provider, terms_checked_on, training_line, retention_line, whats_sent_line, approved_at from ai_provider_approval
    returning version`.execute(db)
  if (approval.rows.length > 0) {
    await sql`insert into ai_terms_approval (candidate_id, terms_version, approved_at)
      select ${ownerId}, 1, approved_at from ai_provider_approval`.execute(db)
  }

  await sql`select set_config('eve.candidate_id', '', true)`.execute(db)
  await recordSchemaMarker(db, "0018-owner-preferences")
}
