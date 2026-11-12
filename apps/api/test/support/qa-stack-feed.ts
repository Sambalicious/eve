import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import pg from "pg"

import type { Database } from "../../src/db/schema.js"

/**
 * QA-authored support for the EPIC-0008 integration tests
 * (qa-stack-feed-*.int-spec.ts, run epic-0008, test authoring).
 *
 * Paths, codes, messages and the table name are retyped from
 * epics/active/EPIC-0008-stack-feeds-per-user/api-contract.md (v1.22.0), not
 * imported from @eve/contracts or the app, so a wrong product constant fails
 * the tests instead of passing with them. The new table is not in the Kysely
 * `Database` type at authoring time, and the contract removes the legacy table
 * from it, so both are reached through raw SQL as the bootstrap superuser
 * (`database.db`), which RLS does not bind.
 */
export const ALERT_FEEDS_PATH = "/v1/stack-posts/alert-feeds"
export const ALERT_FEED_VERIFICATION_PATH = "/v1/stack-posts/alert-feeds/verification"
export const STACK_POSTS_PATH = "/v1/stack-posts"
export const HIRING_FEEDS_PATH = "/v1/stack-posts/hiring-feeds"
export const HIRING_VERIFICATION_PATH = "/v1/stack-posts/hiring-feeds/verification"

/** api-contract.md "Migration 0024": the per-Candidate table and its marker. */
export const OWN_TABLE = "alert_feed_candidate_verification"
export const LEGACY_TABLE = "alert_feed_verification"
export const MIGRATION_SUFFIX = "-alert-feed-candidate-verification"

export const NOT_VERIFIED = { code: "alert_feeds_not_verified", message: "Record the permitted-use verification for Google Alerts feeds before registering a feed." } as const
export const BAD_REQUEST_MESSAGE = "The request is not valid."
export const NOT_FOUND = { code: "not_found", message: "Not found." } as const
export const SESSION_EXPIRED = { code: "session_expired", message: "Your session ended. Sign in with Google again to continue where you left off." } as const
export const UNAUTHENTICATED = { code: "unauthenticated", message: "Sign in to continue." } as const
export const CSRF_INVALID = { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } as const

/** stack-feed-registration-gate.feature header (synthetic; never fetched from Google). */
export const SFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
export const SFEED_A_DIGITS = "01234567890123456789/9876543210987654321"
export const SFEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111222333"
export const SFEED_B_DIGITS = "01234567890123456789/1111111111111222333"
export const SFEED_C = "https://www.google.com/alerts/feeds/01234567890123456789/3333333333333444555"
export const HFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555123456"
export const HFEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555777888"
/** A distinct valid Stack posts feed URL per n (n < 10^8). */
export const stackFeedUrl = (n: number) => `https://www.google.com/alerts/feeds/04444444444444444444/${String(800000000 + n)}`

/** Every table EPIC-0008 tests touch, children first. */
export const EPIC8_TABLES = ["stack_post", "stack_post_run", "alert_feed", OWN_TABLE, LEGACY_TABLE, "hiring_post", "hiring_post_run", "hiring_alert_feed", "hiring_feed_verification"] as const

export type ApiError = { error: { code: string; message: string; fieldErrors?: { field: string; position: number | null; problem: string }[] } }
export type AlertFeedsBody = {
  verification: { verifiedOn: string; verificationBasis: string; updatedAt: string } | null
  feeds: { id: string; label: string | null; maskedUrl: string; createdAt: string; lastReadAt: string | null; failure: { reason: string; at: string } | null }[]
  limit: number
}
export type OwnRow = { candidate_id: string; verified_on: string; verification_basis: string; updated_at: Date }

export const fieldErrors = (body: unknown) => ((body as Partial<ApiError>).error?.fieldErrors ?? []).map((e) => `${e.field}/${e.problem}`)

type Db = Kysely<Database>

/** Empties every EPIC-0008 table and the AI and spend ledgers; lifts both pauses. */
export async function clearEpic8(db: Db): Promise<void> {
  for (const table of [...EPIC8_TABLES, "ai_call", "spend_entry"]) await sql`delete from ${sql.table(table)}`.execute(db)
  await db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
}

/** One Candidate's own Stack posts record, as a fixture (upsert). */
export async function setOwnStack(db: Db, candidateId: string, verifiedOn = "2026-10-21", basis = "Read Google's Alerts RSS terms on 21 Oct.", updatedAt = new Date("2026-10-21T09:00:00.000Z")): Promise<void> {
  await sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at)
    values (${candidateId}::uuid, ${verifiedOn}::date, ${basis}, ${updatedAt})
    on conflict (candidate_id) do update set verified_on = excluded.verified_on, verification_basis = excluded.verification_basis, updated_at = excluded.updated_at`.execute(db)
}

export async function ownStackRows(db: Db): Promise<OwnRow[]> {
  return (await sql<OwnRow>`select candidate_id::text, verified_on::text, verification_basis, updated_at from alert_feed_candidate_verification order by candidate_id`.execute(db)).rows
}

export async function ownStackRow(db: Db, candidateId: string): Promise<OwnRow | undefined> {
  return (await ownStackRows(db)).find((row) => row.candidate_id === candidateId)
}

/** The legacy EPIC-0005 shared row (kept, unread after EPIC-0008). */
export async function setLegacy(db: Db, recorded: boolean, basis = "Reviewed Google Alerts terms on 30 Sep."): Promise<void> {
  await sql`delete from alert_feed_verification`.execute(db)
  if (recorded) await sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-09-30', ${basis}, '2026-09-30T10:15:00Z')`.execute(db)
}

export async function legacyRows(db: Db): Promise<{ verified_on: string; verification_basis: string; updated_at: Date }[]> {
  return (await sql<{ verified_on: string; verification_basis: string; updated_at: Date }>`select verified_on::text, verification_basis, updated_at from alert_feed_verification`.execute(db)).rows
}

export async function setHiringRecord(db: Db, candidateId: string, verifiedOn = "2026-10-01", basis = "Hiring basis"): Promise<void> {
  await sql`insert into hiring_feed_verification (candidate_id, verified_on, verification_basis, updated_at) values (${candidateId}::uuid, ${verifiedOn}::date, ${basis}, '2026-10-01T10:00:00Z')
    on conflict (candidate_id) do update set verified_on = excluded.verified_on, verification_basis = excluded.verification_basis`.execute(db)
}

export async function hiringRows(db: Db): Promise<{ candidate_id: string; verified_on: string; verification_basis: string; updated_at: Date }[]> {
  return (await sql<{ candidate_id: string; verified_on: string; verification_basis: string; updated_at: Date }>`select candidate_id::text, verified_on::text, verification_basis, updated_at from hiring_feed_verification order by candidate_id`.execute(db)).rows
}

/** Stores a Stack posts Alert feed by fixture (no fetch), e.g. a feed an invitee registered before EPIC-0008. */
export async function insertStackFeed(db: Db, candidateId: string, url: string, options: { label?: string | null; createdAt?: Date } = {}): Promise<string> {
  const id = randomUUID()
  const at = options.createdAt ?? new Date("2026-10-20T08:00:00Z")
  await sql`insert into alert_feed (candidate_id, id, url, label, created_at, last_read_at, last_failure_reason, last_failed_at)
    values (${candidateId}::uuid, ${id}::uuid, ${url}, ${options.label ?? null}, ${at}, ${at}, null, null)`.execute(db)
  return id
}

export async function insertHiringFeed(db: Db, candidateId: string, url: string): Promise<string> {
  const id = randomUUID()
  await sql`insert into hiring_alert_feed (candidate_id, id, url, label, created_at, last_read_at, last_failure_reason, last_failed_at)
    values (${candidateId}::uuid, ${id}::uuid, ${url}, null, now(), now(), null, null)`.execute(db)
  return id
}

export async function insertStackPosts(db: Db, candidateId: string, count: number, options: { prefix?: string; firstSeen?: (i: number) => Date; sourceFeedId?: string | null } = {}): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await sql`insert into stack_post (candidate_id, id, canonical_url, kind, title, snippet, published_at, matched_technologies, source_feed_id, first_seen_at)
      values (${candidateId}::uuid, ${randomUUID()}::uuid, ${`https://www.linkedin.com/posts/${options.prefix ?? "qa8"}-${i}-${randomUUID().slice(0, 8)}`}, 'post',
              ${`${options.prefix ?? "qa8"} post ${i}`}, 'SNIPPET-SENTINEL', null, '{React}', ${options.sourceFeedId ?? null}::uuid,
              ${options.firstSeen ? options.firstSeen(i) : new Date(Date.UTC(2026, 9, 1) + i * 60_000)})`.execute(db)
  }
}

export async function stackFeedUrls(db: Db, candidateId: string): Promise<string[]> {
  return (await sql<{ url: string }>`select url from alert_feed where candidate_id = ${candidateId}::uuid order by created_at, id`.execute(db)).rows.map((r) => r.url)
}

export async function countRows(db: Db, table: string, candidateId?: string): Promise<number> {
  const where = candidateId === undefined ? sql`` : sql` where candidate_id = ${candidateId}::uuid`
  return (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}${where}`.execute(db)).rows[0]?.n ?? 0
}

export async function stackRuns(db: Db, candidateId: string): Promise<string[]> {
  return (await sql<{ outcome: string }>`select outcome from stack_post_run where candidate_id = ${candidateId}::uuid order by started_at`.execute(db)).rows.map((r) => r.outcome)
}

/** Adds an invited Candidate (role candidate) with a job_criteria row; returns its id. */
export async function insertInvitee(db: Db, email: string, state: "active" | "revoked" | "deleting" = "active"): Promise<string> {
  const existing = await db.selectFrom("candidate").select("id").where("email", "=", email).executeTakeFirst()
  const id = existing?.id ?? (await db.insertInto("candidate").values({ email, google_sub: `qa8-${randomUUID()}`, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  await db.updateTable("candidate").set({ state } as never).where("id", "=", id).execute()
  await db.insertInto("job_criteria").values({ candidate_id: id, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  return id
}

/**
 * Takes away every runtime-role privilege on `table` until the returned undo
 * runs, so any application statement that names it fails loudly. Used to prove
 * a path never reads the legacy row (or the other list's record) at all.
 */
export async function revokeRuntime(db: Db, runtimeRole: string, table: string): Promise<() => Promise<void>> {
  await sql`revoke all on ${sql.table(table)} from ${sql.id(runtimeRole)}`.execute(db)
  return async () => void (await sql`grant select, insert, update, delete on ${sql.table(table)} to ${sql.id(runtimeRole)}`.execute(db))
}

/**
 * Makes `table`'s insert raise for one Candidate (fixture-only fault, applied as
 * the bootstrap superuser). The scheduled read's first step for a Candidate is
 * its run-row insert, so on `stack_post_run` this is "an internal error before
 * its first request". Returns the undo.
 */
export async function failInsertsFor(db: Db, table: "hiring_post_run" | "stack_post_run" | "stack_post", candidateId: string | null): Promise<() => Promise<void>> {
  const name = `qa8_fail_${table}_${randomUUID().replaceAll("-", "").slice(0, 8)}`
  const condition = candidateId === null ? "true" : `new.candidate_id = '${candidateId}'::uuid`
  await sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin
      if ${condition} then raise exception 'qa injected fault'; end if; return new; end $$`).execute(db)
  await sql.raw(`create trigger ${name} before insert on ${table} for each row execute function ${name}()`).execute(db)
  return async () => {
    await sql.raw(`drop trigger if exists ${name} on ${table}`).execute(db)
    await sql.raw(`drop function if exists ${name}()`).execute(db)
  }
}

/** A runtime-role client that runs `work` in one transaction scoped to `candidateId` (null: no scope), then rolls back. */
export async function asRuntime<T>(client: pg.Client, candidateId: string | null, work: (client: pg.Client) => Promise<T>): Promise<T> {
  await client.query("begin")
  try {
    // EPIC-0002 A2 (migration 0022-candidate-binding): a Candidate scope is the setting AND the transaction's binding, as TenantDatabase sets both.
    if (candidateId) await client.query("select set_config('eve.candidate_id', $1, true), public.bind_candidate($1::uuid)", [candidateId])
    else if (candidateId !== null) await client.query("select set_config('eve.candidate_id', $1, true)", [candidateId])
    return await work(client)
  } finally {
    await client.query("rollback")
  }
}

/** Polls `predicate` every 10 ms; only observes state, never orders work. */
export async function until(predicate: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not reached")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Finds the EPIC-0008 migration by name, whatever number it gets at merge (D19). */
export function epic8MigrationName(names: readonly string[]): string | undefined {
  return names.find((name) => /^\d{4}-alert-feed-candidate-verification$/.test(name))
}
