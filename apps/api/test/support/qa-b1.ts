import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { DEFAULT_ROLE_FAMILY_TIERS, ME_PREFERENCES_PATH, type PreferencesValues, roleFamilySchema } from "@eve/contracts"
import { type Kysely, sql } from "kysely"
import { expect } from "vitest"

import { SESSION_COOKIE } from "../../src/auth/cookies.js"
import type { Database } from "../../src/db/schema.js"
import { Browser } from "./browser.js"
import { FakeGoogle } from "./fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./postgres.js"
import { SignedInCandidate, signInCandidate } from "./signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "./test-app.js"
import { TestClock } from "./test-clock.js"

/**
 * EPIC-0002 B1 QA fixtures (actor qa-author, attempt qa-tests-1, step [5e]).
 * Written from api-contract-b1.md v1.23.0 and the B1 Gherkin, not from the
 * implementation. Everything about Job Preferences goes through HTTP
 * (`GET`/`PUT /v1/me/preferences`); only postings and their per-Candidate state
 * are seeded in SQL, because no non-Operator posting is evaluated before slice D.
 *
 * `PreferencesSaveLimiter` allows 10 saves per session per 60 s, so every test
 * that saves takes a fresh session (`session()`), and a file never shares one
 * session between tests.
 */
export const PREFS = ME_PREFERENCES_PATH
export const VERSIONS = "/v1/me/preferences/versions"
export const FAMILIES = roleFamilySchema.options

export type Who = Readonly<{ sub: string; email: string; id: string }>

export type B1World = Readonly<{
  database: TestDatabase
  db: Kysely<Database>
  google: FakeGoogle
  app: INestApplication
  clock: TestClock
  ada: Who
  kofi: Who
  wanjiru: Who
  /** A new signed-in session (its own save-limit window). */
  session: (who: Who) => Promise<SignedInCandidate>
  stop: () => Promise<void>
}>

const KOFI_SUB = "google-sub-kofi-0101"
const WANJIRU_SUB = "google-sub-wanjiru-0102"

export async function startB1World(start = "2026-10-23T09:00:00.000Z"): Promise<B1World> {
  const database = await startMigratedDatabase()
  const google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  const clock = new TestClock(start)
  const app = await createTestApp({ databaseUrl: database.url, clock })
  const adaSession = await signInCandidate(new Browser(app, google))
  const ada: Who = { sub: "operator", email: adaSession.email, id: database.operatorId }
  await database.db.updateTable("job_criteria").set({ target_role_families: [...FAMILIES], seniority_floor: "all_levels" }).where("candidate_id", "=", database.operatorId).execute()
  const kofi = await insertCandidate(database.db, KOFI_SUB, "kofi.mensah@example.test")
  const wanjiru = await insertCandidate(database.db, WANJIRU_SUB, "wanjiru.kamau@example.test")
  const session = async (who: Who): Promise<SignedInCandidate> => {
    if (who.id === database.operatorId) return signInCandidate(new Browser(app, google))
    const browser = new Browser(app, google)
    const { sessionCookie } = await browser.signIn({ sub: who.sub, email: who.email, email_verified: true })
    const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
    return new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, who.email)
  }
  return {
    database,
    db: database.db,
    google,
    app,
    clock,
    ada,
    kofi,
    wanjiru,
    session,
    stop: async () => {
      await app?.close()
      google?.close()
      await database?.stop()
    },
  }
}

/** An onboarded invited Candidate (a non-Operator) with the built per-Candidate Job criteria row. */
async function insertCandidate(db: Kysely<Database>, sub: string, email: string): Promise<Who> {
  const row = await db
    .insertInto("candidate")
    .values({ email, google_sub: sub, role: "candidate", onboarded_at: new Date("2026-10-20T09:00:00Z") } as never)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db.insertInto("job_criteria").values({ candidate_id: row.id, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  // EPIC-0006 visibility: every family a target and all levels, so only B1 rules decide what a list shows.
  await db.updateTable("job_criteria").set({ target_role_families: [...FAMILIES], seniority_floor: "all_levels" }).where("candidate_id", "=", row.id).execute()
  return { sub, email, id: row.id }
}

/** Kofi's valid preferences (job-preferences.feature personas): home Kenya, daily cap 3, EUR pay. */
export function kenyaValues(over: Partial<PreferencesValues> = {}): PreferencesValues {
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
    roleFamilyTiers: { ...DEFAULT_ROLE_FAMILY_TIERS },
    titleKeyword: null,
    seniorityLevels: ["junior", "mid", "senior", "staff", "principal"],
    employmentTypes: ["direct", "employer_of_record", "contract"],
    dailyCap: 3,
    emphasisThemes: [],
    ...over,
  } as PreferencesValues
}

/** Any values object, including invalid ones, for validation rows. */
export type LooseValues = Record<string, unknown>

export function save(who: SignedInCandidate, baseVersion: number | null, values: LooseValues | PreferencesValues) {
  return who.put(PREFS).send({ baseVersion, values })
}

export type RecordBody = Readonly<{ version: number; savedAt: string; timeZoneLockedUntil: string | null; matchedRegions: string[]; values: PreferencesValues }>

export async function read(who: SignedInCandidate): Promise<RecordBody> {
  return (await who.get(PREFS).expect(200)).body as RecordBody
}

/** First save (`baseVersion: null`), version 1. */
export async function createRecord(who: SignedInCandidate, values: PreferencesValues = kenyaValues()): Promise<RecordBody> {
  const response = await save(who, null, values)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body as RecordBody
}

/** Saves on top of the current version and returns the new record. */
export async function saveOnTop(who: SignedInCandidate, change: Partial<PreferencesValues>): Promise<RecordBody> {
  const current = await read(who)
  const response = await save(who, current.version, { ...current.values, ...change })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body as RecordBody
}

/** Asserts `400 bad_request` with a field error on `field`, and that no field error echoes a value. */
export function expectFieldError(response: { status: number; body: unknown }, field: string, problem?: string): void {
  expect(response.status, JSON.stringify(response.body)).toBe(400)
  const error = (response.body as { error: { code: string; fieldErrors?: { field: string; problem: string; position: number | null }[] } }).error
  expect(error.code).toBe("bad_request")
  expect(error.fieldErrors, "fieldErrors present").toBeDefined()
  const hits = error.fieldErrors!.filter((e) => e.field === field)
  expect(hits.length, `a field error on ${field}: ${JSON.stringify(error.fieldErrors)}`).toBeGreaterThan(0)
  if (problem) expect(hits.map((h) => h.problem)).toContain(problem)
  for (const e of error.fieldErrors!) expect(Object.keys(e).sort()).toEqual(["field", "position", "problem"])
}

/** Asserts a plain `400 bad_request` without `fieldErrors`. */
export function expectPlainBadRequest(response: { status: number; body: unknown }): void {
  expect(response.status, JSON.stringify(response.body)).toBe(400)
  const error = (response.body as { error: Record<string, unknown> }).error
  expect(error.code).toBe("bad_request")
  expect(error.fieldErrors).toBeUndefined()
}

/** Rows in `job_preferences` and `job_preferences_version` for one Candidate, for "nothing changed" checks. */
export async function preferencesRows(db: Kysely<Database>, candidateId: string): Promise<string> {
  const current = await db.selectFrom("job_preferences").selectAll().where("candidate_id", "=", candidateId).execute()
  const history = await db.selectFrom("job_preferences_version").selectAll().where("candidate_id", "=", candidateId).orderBy("version").execute()
  return JSON.stringify([current, history])
}

export async function versionCount(db: Kysely<Database>, candidateId: string): Promise<number> {
  return (await db.selectFrom("job_preferences_version").select("version").where("candidate_id", "=", candidateId).execute()).length
}

// ── Postings ────────────────────────────────────────────────

export type PostingSeed = Readonly<{
  title?: string | null
  family?: string | null
  prefilterSkip?: "not_software_role" | null
  status: "ranked" | "skipped" | "excluded" | "waiting_to_be_checked" | "checking" | "evaluation_failed" | "not_checked"
  skipReason?: string | null
  /** Strong Match coverage for ranked rows (default 8 of 10). */
  covered?: number
  discoveredAt?: Date
  /** Applies to every Candidate in `holders`. */
  holders?: readonly string[]
}>

let minute = 0

/** One shared posting plus one `candidate_posting` row per holder. Returns the posting id. */
export async function seedPosting(db: Kysely<Database>, candidateId: string, seed: PostingSeed): Promise<string> {
  const id = randomUUID()
  const title = seed.title === undefined ? "Senior Frontend Engineer" : seed.title
  const titled = title !== null && title.trim() !== ""
  const family = seed.family === undefined ? (titled ? "senior_frontend" : "other") : seed.family
  minute += 1
  const discovered = seed.discoveredAt ?? new Date(Date.UTC(2026, 9, 20, 8, 0, minute))
  const url = `https://boards.greenhouse.io/qab1/jobs/${id}`
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin,
      employer_board_id, remote_board_key, attribution_name, attribution_url, title, title_folded, company, posting_text,
      role_family, prefilter_skip, discovered_at, posted_at, posted_date_kind, seniority_marker)
    values (${id}, ${url}, ${id.slice(0, 13)}, ${url}, 'greenhouse', 'automatic', 'employer_board',
      null, null, null, null, ${title}, ${titled ? fold(title) : null}, 'QAB1', 'Remote, open to candidates in Kenya.',
      ${family}, ${seed.prefilterSkip ?? null}, ${discovered}, ${new Date("2026-10-20T11:00:00Z")}, 'published', ${titled ? "mid_plus" : null})`.execute(db)
  for (const holder of seed.holders ?? [candidateId]) await hold(db, holder, id, seed)
  return id
}

export async function hold(db: Kysely<Database>, candidateId: string, postingId: string, seed: PostingSeed): Promise<void> {
  const evaluated = ["checking", "waiting_to_be_checked", "not_checked"].includes(seed.status) ? null : new Date("2026-10-20T09:00:00Z")
  await sql`insert into candidate_posting (candidate_id, job_posting_id, origin, status, skip_reason, skip_detail, evaluation_failure, discovered_at, evaluated_at)
    select ${candidateId}::uuid, p.id, p.origin, ${seed.status}, ${seed.skipReason ?? null}, null,
      ${seed.status === "evaluation_failed" ? "provider_error" : null}, p.discovered_at, ${evaluated}
    from job_posting p where p.id = ${postingId}`.execute(db)
  if (seed.status === "ranked") {
    const covered = seed.covered ?? 8
    await db
      .insertInto("match_evidence")
      .values({ candidate_id: candidateId, job_posting_id: postingId, career_profile_version: 1, verdict: "strong", weak_reason: null, covered_count: covered, total_count: 10, threshold: "0.700", items: "[]", evaluated_at: new Date("2026-10-20T09:00:00Z"), criteria_version: 1 })
      .execute()
  }
}

/** Lower-case, accents removed: the test-side reading of the stored folded title (the api stores its own fold). */
function fold(title: string): string {
  return title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
}

export type PostingState = Readonly<{ status: string; skip_reason: string | null; skip_detail: string | null; preferences_version: number }>

/** Status, reason, detail and `preferences_version` (migration 0025) of one Candidate's row. */
export async function stateOf(db: Kysely<Database>, candidateId: string, postingId: string): Promise<PostingState> {
  const { rows } = await sql<PostingState>`select status, skip_reason, skip_detail, preferences_version from candidate_posting
    where candidate_id = ${candidateId} and job_posting_id = ${postingId}`.execute(db)
  if (!rows[0]) throw new Error(`no candidate_posting for ${candidateId} / ${postingId}`)
  return rows[0]
}

/** Every column of one Candidate's postings, Match evidence, Eligibility results and Applications. */
export async function candidateSnapshot(db: Kysely<Database>, candidateId: string): Promise<string> {
  const postings = await sql`select * from candidate_posting where candidate_id = ${candidateId} order by job_posting_id`.execute(db)
  const evidence = await sql`select * from match_evidence where candidate_id = ${candidateId} order by job_posting_id`.execute(db)
  const eligibility = await sql`select * from eligibility_result where candidate_id = ${candidateId} order by job_posting_id`.execute(db)
  const applications = await sql`select * from application where candidate_id = ${candidateId} order by id`.execute(db)
  return JSON.stringify([postings.rows, evidence.rows, eligibility.rows, applications.rows, await preferencesRows(db, candidateId)])
}

/** "The save makes no paid call": model calls, spend entries and queued evaluations, counted. */
export async function paidWork(db: Kysely<Database>): Promise<{ aiCalls: number; spend: number; queued: number }> {
  const ai = await sql<{ n: string }>`select count(*) as n from ai_call`.execute(db)
  const spend = await sql<{ n: string }>`select count(*) as n from spend_entry`.execute(db)
  const queued = await sql<{ n: string }>`select count(*) as n from pgboss.job where name = 'evaluate.posting'`.execute(db)
  return { aiCalls: Number(ai.rows[0]!.n), spend: Number(spend.rows[0]!.n), queued: Number(queued.rows[0]!.n) }
}

/** Deletes every posting row and one Candidate's preferences (Operator rows stay). */
export async function clearPostings(db: Kysely<Database>): Promise<void> {
  await db.deleteFrom("application").execute()
  await db.deleteFrom("match_evidence").execute()
  await db.deleteFrom("eligibility_result").execute()
  await db.deleteFrom("candidate_posting").execute()
  await db.deleteFrom("ai_call").execute()
  await db.deleteFrom("job_posting").execute()
}

export async function clearPreferences(db: Kysely<Database>, candidateId: string): Promise<void> {
  await db.deleteFrom("job_preferences").where("candidate_id", "=", candidateId).execute()
  await db.deleteFrom("job_preferences_version").where("candidate_id", "=", candidateId).execute()
}

/** Makes every `candidate_posting` update for `candidateId` raise (R6-AC11 fault injection). */
export async function failPostingUpdatesFor(db: Kysely<Database>, candidateId: string): Promise<() => Promise<void>> {
  const name = `qab1_fail_${randomUUID().replaceAll("-", "").slice(0, 8)}`
  await sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin
      if new.candidate_id = '${candidateId}'::uuid then raise exception 'qa injected fault'; end if; return new; end $$`).execute(db)
  await sql.raw(`create trigger ${name} before update on candidate_posting for each row execute function ${name}()`).execute(db)
  return async () => {
    await sql.raw(`drop trigger if exists ${name} on candidate_posting`).execute(db)
    await sql.raw(`drop function if exists ${name}()`).execute(db)
  }
}

export type ListPage = Readonly<{
  postings: { id: string; title: string | null; status: string; skipReason: string | null; skipDetail: string | null; roleFamily: string | null; rank: number | null }[]
  totalCount: number
  nextCursor: string | null
}>

export async function listTab(who: SignedInCandidate, query: string): Promise<ListPage> {
  const response = await who.get(`/v1/job-postings?${query}`)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return response.body as ListPage
}
