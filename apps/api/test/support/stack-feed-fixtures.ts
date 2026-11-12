import type { INestApplication } from "@nestjs/common"
import { type Kysely, sql } from "kysely"

import { SESSION_COOKIE } from "../../src/auth/cookies.js"
import type { Database } from "../../src/db/schema.js"
import { Browser } from "./browser.js"
import type { FakeGoogle } from "./fake-google.js"
import type { TestDatabase } from "./postgres.js"
import { SignedInCandidate } from "./signed-in.js"

/**
 * EPIC-0008 fixtures (gherkin/stack-feed-*.feature headers). "her own Stack
 * posts record" is a row in `alert_feed_candidate_verification`; "the legacy
 * shared record" is the EPIC-0005 `alert_feed_verification` row, which is not in
 * the Kysely `Database` type any more, so it is read and written with raw SQL.
 * Fixtures run as the bootstrap superuser (`database.db`), which RLS does not bind.
 */
export const SFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
export const SFEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111222333"
export const SFEED_C = "https://www.google.com/alerts/feeds/01234567890123456789/1111111111111444555"
export const HFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555123456"
export const HFEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555777888"
/** A distinct valid Stack posts feed URL per n (n < 1000). */
export const stackFeed = (n: number) => `https://www.google.com/alerts/feeds/04444444444444444444/${600000 + n}`

export const NOT_VERIFIED = { error: { code: "alert_feeds_not_verified", message: "Record the permitted-use verification for Google Alerts feeds before registering a feed." } }

/** GH-2 (stack-feed-copy-and-unchanged.feature header), matched case-insensitively. */
export const BANNED_WORDING = /operator|the person who runs (your )?eve|\badmin(istrator)?\b|shared record|shared verification|shared with hiring|on behalf of|\bowner\b|\bteam\b|installation|job source/i

export type OwnStackRow = { candidate_id: string; verified_on: string; verification_basis: string; updated_at: Date }

/** Every row of `alert_feed_candidate_verification`, by Candidate id. */
export async function ownStackRows(db: Kysely<Database>): Promise<OwnStackRow[]> {
  return (await sql<OwnStackRow>`select candidate_id::text, verified_on::text, verification_basis, updated_at from alert_feed_candidate_verification order by candidate_id`.execute(db)).rows
}

export async function ownStackRow(db: Kysely<Database>, candidateId: string): Promise<OwnStackRow | undefined> {
  return (await ownStackRows(db)).find((row) => row.candidate_id === candidateId)
}

/** Her own Stack posts record, written as a fixture. */
export async function recordStack(db: Kysely<Database>, candidateId: string, options: Readonly<{ basis?: string; verifiedOn?: string; at?: Date }> = {}): Promise<void> {
  const basis = options.basis ?? "Read Google's Alerts RSS terms."
  const verifiedOn = options.verifiedOn ?? "2026-10-21"
  const at = options.at ?? new Date("2026-10-21T09:00:00.000Z")
  await sql`insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values (${candidateId}::uuid, ${verifiedOn}::date, ${basis}, ${at})
    on conflict (candidate_id) do update set verified_on = excluded.verified_on, verification_basis = excluded.verification_basis, updated_at = excluded.updated_at`.execute(db)
}

/** Her own Hiring record (EPIC-0007 Phase 3), written as a fixture. */
export async function recordHiring(db: Kysely<Database>, candidateId: string, options: Readonly<{ basis?: string; verifiedOn?: string; at?: Date }> = {}): Promise<void> {
  const basis = options.basis ?? "Hiring basis"
  const verifiedOn = options.verifiedOn ?? "2026-10-01"
  const at = options.at ?? new Date("2026-10-01T09:00:00.000Z")
  await sql`insert into hiring_feed_verification (candidate_id, verified_on, verification_basis, updated_at) values (${candidateId}::uuid, ${verifiedOn}::date, ${basis}, ${at})
    on conflict (candidate_id) do update set verified_on = excluded.verified_on, verification_basis = excluded.verification_basis, updated_at = excluded.updated_at`.execute(db)
}

export async function hiringRow(db: Kysely<Database>, candidateId: string): Promise<OwnStackRow | undefined> {
  return (await sql<OwnStackRow>`select candidate_id::text, verified_on::text, verification_basis, updated_at from hiring_feed_verification where candidate_id = ${candidateId}::uuid`.execute(db)).rows[0]
}

export const LEGACY_ROW = { verified_on: "2026-09-30", verification_basis: "Reviewed Google Alerts terms on 30 Sep.", updated_at: new Date("2026-09-30T10:15:00.000Z") }

export async function setLegacy(db: Kysely<unknown>, exists: boolean): Promise<void> {
  await sql`delete from alert_feed_verification`.execute(db)
  if (exists) {
    await sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values (${LEGACY_ROW.verified_on}::date, ${LEGACY_ROW.verification_basis}, ${LEGACY_ROW.updated_at})`.execute(db)
  }
}

export async function legacyRows(db: Kysely<unknown>): Promise<{ verified_on: string; verification_basis: string; updated_at: Date }[]> {
  return (await sql<{ verified_on: string; verification_basis: string; updated_at: Date }>`select verified_on::text, verification_basis, updated_at from alert_feed_verification`.execute(db)).rows
}

export async function insertStackFeed(db: Kysely<Database>, candidateId: string, url: string, options: Readonly<{ label?: string | null; id?: string; createdAt?: Date }> = {}): Promise<string> {
  const id = options.id ?? crypto.randomUUID()
  const at = options.createdAt ?? new Date("2026-10-20T08:00:00.000Z")
  await db.insertInto("alert_feed").values({ candidate_id: candidateId, id, url, label: options.label ?? null, created_at: at, last_read_at: at, last_failure_reason: null, last_failed_at: null }).execute()
  return id
}

export async function insertStackPosts(db: Kysely<Database>, candidateId: string, count: number, options: Readonly<{ firstSeen?: Date; title?: (i: number) => string }> = {}): Promise<void> {
  if (count === 0) return
  const rows = Array.from({ length: count }, (_, i) => ({
    candidate_id: candidateId,
    id: crypto.randomUUID(),
    canonical_url: `https://www.linkedin.com/posts/e8-${crypto.randomUUID()}`,
    kind: "post" as const,
    title: options.title?.(i) ?? `Post ${i}`,
    snippet: "",
    published_at: null,
    matched_technologies: [],
    source_feed_id: null,
    first_seen_at: options.firstSeen ?? new Date("2026-10-20T08:00:00.000Z"),
  }))
  for (let i = 0; i < rows.length; i += 500) await db.insertInto("stack_post").values(rows.slice(i, i + 500)).execute()
}

export async function stackFeedUrls(db: Kysely<Database>, candidateId: string): Promise<string[]> {
  return (await db.selectFrom("alert_feed").select("url").where("candidate_id", "=", candidateId).orderBy("created_at").orderBy("url").execute()).map((row) => row.url)
}

export async function stackRuns(db: Kysely<Database>, candidateId: string): Promise<string[]> {
  return (await db.selectFrom("stack_post_run").select("outcome").where("candidate_id", "=", candidateId).orderBy("started_at").execute()).map((row) => row.outcome)
}

export async function stackPostCount(db: Kysely<Database>, candidateId: string): Promise<number> {
  const { n } = await db.selectFrom("stack_post").select((eb) => eb.fn.countAll<string>().as("n")).where("candidate_id", "=", candidateId).executeTakeFirstOrThrow()
  return Number(n)
}

/** Every EPIC-0005, EPIC-0007 and EPIC-0008 Stack posts and Hiring row a test may leave behind, plus the legacy row. */
export async function clearFeeds(db: Kysely<Database>): Promise<void> {
  for (const table of ["stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification", "hiring_post", "hiring_post_run", "hiring_alert_feed", "hiring_feed_verification", "ai_call", "spend_entry"] as const) {
    await db.deleteFrom(table).execute()
  }
  await setLegacy(db as unknown as Kysely<unknown>, false)
  await db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
}

/** An invited Candidate signed in over HTTP with her own session and CSRF token. */
export async function signInInvitee(app: INestApplication, google: FakeGoogle, db: Kysely<Database>, email: string, sub: string): Promise<{ id: string; session: SignedInCandidate }> {
  const existing = await db.selectFrom("candidate").select("id").where("google_sub", "=", sub).executeTakeFirst()
  const id = existing?.id ?? (await db.insertInto("candidate").values({ email, google_sub: sub, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  await db.insertInto("job_criteria").values({ candidate_id: id, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub, email, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  return { id, session: new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, email) }
}

/** A Candidate row with no session (a scheduled-read or summary participant). */
export async function insertCandidate(db: Kysely<Database>, email: string, role: "candidate" | "operator" = "candidate"): Promise<string> {
  const id = (await db.insertInto("candidate").values({ email, google_sub: `sub-${email}`, role } as never).returning("id").executeTakeFirstOrThrow()).id
  await db.insertInto("job_criteria").values({ candidate_id: id, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  return id
}

/**
 * The statement recorder for "no recorded statement reads or writes X": the
 * runtime role loses every privilege on `table`, so any statement the api or
 * worker sends to it fails. Returns the restore function.
 */
export async function revokeRuntime(database: TestDatabase, table: string): Promise<() => Promise<void>> {
  const runtime = sql.id(database.roles.runtime.name)
  await sql`revoke all on ${sql.table(table)} from ${runtime}`.execute(database.db)
  return async () => {
    await sql`grant select, insert, update, delete on ${sql.table(table)} to ${runtime}`.execute(database.db)
  }
}
