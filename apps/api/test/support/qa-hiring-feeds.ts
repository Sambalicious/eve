import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import { type Kysely, sql } from "kysely"

import { SESSION_COOKIE } from "../../src/auth/cookies.js"
import type { Database } from "../../src/db/schema.js"
import type { AlertFeedGetOptions, AlertFeedHttp } from "../../src/stack-posts/alert-feed-http.js"
import { Browser } from "./browser.js"
import type { FakeGoogle } from "./fake-google.js"
import { SignedInCandidate, signInCandidate } from "./signed-in.js"

/**
 * QA-authored support for the EPIC-0007 Phase 3 integration tests
 * (qa-hiring-*.int-spec.ts, run epic-0007-p3, test authoring).
 *
 * Paths and the problem set are retyped from api-contract.r1.md, not imported
 * from @eve/contracts, so a wrong product constant fails the tests instead of
 * passing with them. The Phase 3 tables are not in the Kysely `Database` type at
 * authoring time, so fixtures and assertions use raw SQL through the bootstrap
 * superuser (`database.db`), which RLS does not bind.
 */
export const HIRING_FEEDS_PATH = "/v1/stack-posts/hiring-feeds"
export const HIRING_VERIFICATION_PATH = "/v1/stack-posts/hiring-feeds/verification"
export const HIRING_POSTS_PATH = "/v1/stack-posts/hiring-posts"
export const ALERT_FEEDS_PATH = "/v1/stack-posts/alert-feeds"
export const ALERT_FEED_VERIFICATION_PATH = "/v1/stack-posts/alert-feeds/verification"

export const NOT_VERIFIED_MESSAGE = "Record the permitted-use verification for Google Alerts feeds before registering a feed."
export const BAD_REQUEST_MESSAGE = "The request is not valid."

/** hiring-alert-feeds.feature header (synthetic; never fetched from Google). */
export const HFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555123456"
export const HFEED_A_DIGITS = "01234567890123456789/5555555555555123456"
export const HFEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555777888"
export const SFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
export const hiringFeedUrl = (n: number) => `https://www.google.com/alerts/feeds/02222222222222222222/${700000000 + n}`
export const stackFeedUrl = (n: number) => `https://www.google.com/alerts/feeds/03333333333333333333/${800000000 + n}`

export const PHASE3_TABLES = ["hiring_post", "hiring_post_run", "hiring_alert_feed", "hiring_feed_verification"] as const
/** EPIC-0008: the legacy shared `alert_feed_verification` is cleared too, so no test leaves it behind. */
export const EPIC5_TABLES = ["stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification", "alert_feed_verification"] as const

export type ApiError = { error: { code: string; message: string; fieldErrors?: { field: string; position: number | null; problem: string }[] } }
export type HiringFeedsBody = {
  verification: { verifiedOn: string; verificationBasis: string; updatedAt: string } | null
  feeds: { id: string; label: string | null; maskedUrl: string; createdAt: string; lastReadAt: string | null; failure: { reason: string; at: string } | null }[]
  limit: number
}
export type HiringPostsBody = { items: { id: string; canonicalUrl: string; title: string; source: { label: string | null; maskedUrl: string } | null }[]; page: number; pageSize: number; totalCount: number; totalPages: number }

/** Signs in the Operator (template owner) and an invited Candidate "Bola", each over HTTP. */
export async function signInBoth(app: INestApplication, google: FakeGoogle, db: Kysely<Database>, bolaEmail = "bola.p3@example.test"): Promise<{ ada: SignedInCandidate; bola: SignedInCandidate; bolaId: string }> {
  const ada = await signInCandidate(new Browser(app, google))
  const sub = `3000000000000${Math.floor(Math.random() * 1e8)}`.slice(0, 21)
  const bolaId = (await db.insertInto("candidate").values({ email: bolaEmail, google_sub: sub, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  await db.insertInto("job_criteria").values({ candidate_id: bolaId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub, email: bolaEmail, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  const bola = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, bolaEmail)
  return { ada, bola, bolaId }
}

export async function clearPhase3(db: Kysely<Database>): Promise<void> {
  for (const table of [...PHASE3_TABLES, ...EPIC5_TABLES, "ai_call", "spend_entry"]) await sql`delete from ${sql.table(table)}`.execute(db)
  await db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
}

export async function setHiringVerification(db: Kysely<Database>, candidateId: string, verifiedOn = "2026-10-21", basis = "Read Google's terms for Alerts RSS on 21 Oct."): Promise<void> {
  await sql`insert into hiring_feed_verification (candidate_id, verified_on, verification_basis, updated_at) values (${candidateId}::uuid, ${verifiedOn}::date, ${basis}, now())
    on conflict (candidate_id) do update set verified_on = excluded.verified_on, verification_basis = excluded.verification_basis, updated_at = now()`.execute(db)
}

export type VerificationRow = { candidate_id: string; verified_on: string; verification_basis: string; updated_at: Date }

export async function hiringVerifications(db: Kysely<Database>): Promise<VerificationRow[]> {
  return (await sql<VerificationRow>`select candidate_id::text, verified_on::text, verification_basis, updated_at from hiring_feed_verification order by candidate_id`.execute(db)).rows
}

/**
 * EPIC-0008: the Candidate's own Stack posts record (replaces the shared-row setter that used to gate Stack posts).
 * `recorded: false` removes her row only.
 */
export async function setOwnStackVerification(db: Kysely<Database>, candidateId: string, recorded: boolean): Promise<void> {
  await sql`delete from alert_feed_candidate_verification where candidate_id = ${candidateId}::uuid`.execute(db)
  if (recorded) {
    await sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at)
      values (${candidateId}::uuid, '2026-09-30', 'Own Stack posts basis.', now())`.execute(db)
  }
}

export async function ownStackVerificationRows(db: Kysely<Database>): Promise<VerificationRow[]> {
  return (await sql<VerificationRow>`select candidate_id::text, verified_on::text, verification_basis, updated_at from alert_feed_candidate_verification order by candidate_id`.execute(db)).rows
}

/** The legacy shared EPIC-0005 row, unread since EPIC-0008: kept only for "legacy row unchanged" assertions. */
export async function setLegacySharedVerification(db: Kysely<Database>, recorded: boolean): Promise<void> {
  await sql`delete from alert_feed_verification`.execute(db)
  if (recorded) await sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-09-30', 'Operator shared basis.', now())`.execute(db)
}

export async function sharedVerificationRows(db: Kysely<Database>): Promise<{ verified_on: string; verification_basis: string }[]> {
  return (await sql<{ verified_on: string; verification_basis: string }>`select verified_on::text, verification_basis from alert_feed_verification`.execute(db)).rows
}

export async function insertHiringFeed(db: Kysely<Database>, candidateId: string, url: string, options: { label?: string | null; failing?: string | null; id?: string } = {}): Promise<string> {
  const id = options.id ?? randomUUID()
  const failing = options.failing ?? null
  await sql`insert into hiring_alert_feed (candidate_id, id, url, label, created_at, last_read_at, last_failure_reason, last_failed_at)
    values (${candidateId}::uuid, ${id}::uuid, ${url}, ${options.label ?? null}, now(), now(), ${failing}, ${failing === null ? null : new Date()})`.execute(db)
  return id
}

export async function insertStackFeed(db: Kysely<Database>, candidateId: string, url: string, label: string | null = null): Promise<string> {
  const id = randomUUID()
  await db.insertInto("alert_feed").values({ candidate_id: candidateId, id, url, label, created_at: new Date(), last_read_at: new Date(), last_failure_reason: null, last_failed_at: null }).execute()
  return id
}

export async function hiringFeedUrls(db: Kysely<Database>, candidateId: string): Promise<string[]> {
  return (await sql<{ url: string }>`select url from hiring_alert_feed where candidate_id = ${candidateId}::uuid order by created_at, id`.execute(db)).rows.map((r) => r.url)
}

export async function stackFeedUrls(db: Kysely<Database>, candidateId: string): Promise<string[]> {
  return (await db.selectFrom("alert_feed").select("url").where("candidate_id", "=", candidateId).orderBy("created_at").execute()).map((r) => r.url)
}

export async function insertHiringPosts(db: Kysely<Database>, candidateId: string, count: number, options: { prefix?: string; firstSeen?: (i: number) => Date; sourceFeedId?: string | null; title?: (i: number) => string } = {}): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await sql`insert into hiring_post (candidate_id, id, canonical_url, kind, title, snippet, published_at, matched_technologies, source_feed_id, first_seen_at)
      values (${candidateId}::uuid, ${randomUUID()}::uuid, ${`https://www.linkedin.com/posts/${options.prefix ?? "qa"}-${i}-${randomUUID().slice(0, 8)}`}, 'post',
              ${options.title ? options.title(i) : `${options.prefix ?? "qa"} hiring ${i}`}, 's', null, '{}', ${options.sourceFeedId ?? null}::uuid,
              ${options.firstSeen ? options.firstSeen(i) : new Date(Date.UTC(2026, 9, 1) + i * 60_000)})`.execute(db)
  }
}

export async function countRows(db: Kysely<Database>, table: string, candidateId?: string): Promise<number> {
  const where = candidateId === undefined ? sql`` : sql` where candidate_id = ${candidateId}::uuid`
  return (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}${where}`.execute(db)).rows[0]?.n ?? 0
}

export async function hiringRuns(db: Kysely<Database>, candidateId: string): Promise<string[]> {
  return (await sql<{ outcome: string }>`select outcome from hiring_post_run where candidate_id = ${candidateId}::uuid order by started_at`.execute(db)).rows.map((r) => r.outcome)
}

/**
 * Makes `table`'s insert raise for one Candidate (a fixture-only fault, applied
 * as the bootstrap superuser): the scheduled read's first step for that
 * Candidate is its run-row insert (api-contract.r1 "Scheduled read" step 1),
 * so this is "an internal error before its first request". Returns the undo.
 */
export async function failInsertsFor(db: Kysely<Database>, table: "hiring_post_run" | "stack_post_run", candidateId: string): Promise<() => Promise<void>> {
  const name = `qa_fail_${table}_${randomUUID().replaceAll("-", "").slice(0, 8)}`
  await sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin
      if new.candidate_id = '${candidateId}'::uuid then raise exception 'qa injected fault'; end if; return new; end $$`).execute(db)
  await sql.raw(`create trigger ${name} before insert on ${table} for each row execute function ${name}()`).execute(db)
  return async () => {
    await sql.raw(`drop trigger if exists ${name} on ${table}`).execute(db)
    await sql.raw(`drop function if exists ${name}()`).execute(db)
  }
}

/** A deferred promise. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Polls `predicate` every 10 ms; only observes state, never orders work. */
export async function until(predicate: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not reached")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * The production Alert feed client behind a gate: `hold(url)` parks every
 * later fetch of that URL until `release(url)`. Used to get two registrations
 * past their pre-checks before either reaches the locked insert.
 */
export class GatedFeedHttp implements AlertFeedHttp {
  constructor(private readonly inner: AlertFeedHttp) {}
  private readonly gates = new Map<string, { waiting: number; open: ReturnType<typeof deferred> }>()
  readonly fetched: string[] = []

  hold(url: string): void {
    this.gates.set(url, { waiting: 0, open: deferred() })
  }

  waiting(url: string): number {
    return this.gates.get(url)?.waiting ?? 0
  }

  release(url: string): void {
    this.gates.get(url)?.open.resolve()
    this.gates.delete(url)
  }

  reset(): void {
    for (const url of [...this.gates.keys()]) this.release(url)
    this.fetched.length = 0
  }

  async get(url: string, options: AlertFeedGetOptions): Promise<string | null> {
    this.fetched.push(url)
    const gate = this.gates.get(url)
    if (gate) {
      gate.waiting += 1
      await gate.open.promise
    }
    return this.inner.get(url, options)
  }
}

/** Reads a named export that the Phase 3 build adds, without a compile-time dependency on it. */
export async function exportOf<T>(modulePath: string, name: string): Promise<T> {
  const module = (await import(modulePath)) as Record<string, unknown>
  if (!(name in module)) throw new Error(`${modulePath} has no export ${name} (api-contract.r1)`)
  return module[name] as T
}
