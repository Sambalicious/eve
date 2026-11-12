import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"

import { SESSION_COOKIE } from "../../src/auth/cookies.js"
import type { Database } from "../../src/db/schema.js"
import type { Browser } from "./browser.js"
import { SignedInCandidate } from "./signed-in.js"

/**
 * EPIC-0007 Phase 3 fixtures (hiring-alert-feeds.feature header, hiring-posts.feature header).
 * Synthetic URLs only; every feed is served by the local FakeFeedServer, never by Google.
 */
export const HFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555123456"
export const HFEED_A_DIGITS = "01234567890123456789/5555555555555123456"
export const HFEED_B = "https://www.google.com/alerts/feeds/01234567890123456789/5555555555555777888"
export const SFEED_A = "https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321"
export const POST_1 = "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000001-aaaa"
export const POST_2 = "https://www.linkedin.com/posts/beta_frontend-activity-7250000000000000002-bbbb"
export const ART_1 = "https://www.linkedin.com/pulse/were-hiring-frontend-engineers-ada-obi"

/** A distinct valid feed URL per n (n < 1000). */
export const hiringFeedUrl = (n: number) => `https://www.google.com/alerts/feeds/${String(n).padStart(20, "7")}/${900000 + n}`

export const BOLA_SUB = "100000000000000000777"
export const BOLA_EMAIL = "bola@example.test"

/** "bola", an invited Candidate, signed in over HTTP with her own session and CSRF token. */
export async function signInBola(db: Kysely<Database>, browser: Browser): Promise<{ id: string; session: SignedInCandidate }> {
  const existing = await db.selectFrom("candidate").select("id").where("google_sub", "=", BOLA_SUB).executeTakeFirst()
  const id = existing?.id ?? (await db.insertInto("candidate").values({ email: BOLA_EMAIL, google_sub: BOLA_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  await db.insertInto("job_criteria").values({ candidate_id: id, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const { sessionCookie } = await browser.signIn({ sub: BOLA_SUB, email: BOLA_EMAIL, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  return { id, session: new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, BOLA_EMAIL) }
}

/** The Candidate's own Hiring feed record, written as a fixture (superuser). */
export async function recordOwn(db: Kysely<Database>, candidateId: string, basis = "Read Google's terms for Alerts RSS on 21 Oct.", verifiedOn = "2026-10-21"): Promise<void> {
  await db
    .insertInto("hiring_feed_verification")
    .values({ candidate_id: candidateId, verified_on: verifiedOn, verification_basis: basis, updated_at: new Date("2026-10-21T10:00:00Z") })
    .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ verified_on: verifiedOn, verification_basis: basis }))
    .execute()
}

/** EPIC-0008: the Candidate's own Stack posts feed record (`alert_feed_candidate_verification`), written as a fixture (superuser). */
export async function recordOwnStack(db: Kysely<Database>, candidateId: string, basis = "Operator Stack posts basis.", verifiedOn = "2026-10-20"): Promise<void> {
  await db
    .insertInto("alert_feed_candidate_verification")
    .values({ candidate_id: candidateId, verified_on: verifiedOn, verification_basis: basis, updated_at: new Date("2026-10-20T10:00:00Z") })
    .onConflict((oc) => oc.column("candidate_id").doUpdateSet({ verified_on: verifiedOn, verification_basis: basis }))
    .execute()
}

/** EPIC-0008: the legacy shared EPIC-0005 row, which no code reads any more (raw SQL: the table is not in `Database`). */
export async function recordLegacyShared(db: Kysely<Database>): Promise<void> {
  await sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-10-20', 'Operator shared basis.', '2026-10-20T10:00:00Z') on conflict (singleton) do nothing`.execute(db)
}

export async function legacySharedRows(db: Kysely<Database>): Promise<{ verified_on: string; verification_basis: string }[]> {
  return (await sql<{ verified_on: string; verification_basis: string }>`select verified_on::text, verification_basis from alert_feed_verification`.execute(db)).rows
}

export async function clearLegacyShared(db: Kysely<Database>): Promise<void> {
  await sql`delete from alert_feed_verification`.execute(db)
}

type FeedFixture = Readonly<{ label?: string | null; createdAt?: Date; failure?: "timed_out" | "redirected" | "not_a_feed" | null }>

export async function insertHiringFeed(db: Kysely<Database>, candidateId: string, url: string, options: FeedFixture = {}): Promise<string> {
  const id = randomUUID()
  const at = options.createdAt ?? new Date("2026-10-21T08:00:00Z")
  await db
    .insertInto("hiring_alert_feed")
    .values({ candidate_id: candidateId, id, url, label: options.label ?? null, created_at: at, last_read_at: at, last_failure_reason: options.failure ?? null, last_failed_at: options.failure ? at : null })
    .execute()
  return id
}

export async function insertStackFeed(db: Kysely<Database>, candidateId: string, url: string, options: FeedFixture = {}): Promise<string> {
  const id = randomUUID()
  const at = options.createdAt ?? new Date("2026-10-21T08:00:00Z")
  await db
    .insertInto("alert_feed")
    .values({ candidate_id: candidateId, id, url, label: options.label ?? null, created_at: at, last_read_at: at, last_failure_reason: options.failure ?? null, last_failed_at: options.failure ? at : null })
    .execute()
  return id
}

type PostFixture = Readonly<{ canonicalUrl?: string; title?: string; snippet?: string; publishedAt?: Date | null; firstSeenAt?: Date; matched?: string[]; feedId?: string | null }>

export async function insertHiringPosts(db: Kysely<Database>, candidateId: string, posts: readonly PostFixture[]): Promise<void> {
  const rows = posts.map((post) => ({
    candidate_id: candidateId,
    id: randomUUID(),
    canonical_url: post.canonicalUrl ?? `https://www.linkedin.com/posts/fixture-${randomUUID()}`,
    kind: "post" as const,
    title: post.title ?? "Hiring",
    snippet: post.snippet ?? "",
    published_at: post.publishedAt ?? null,
    matched_technologies: post.matched ?? [],
    source_feed_id: post.feedId ?? null,
    first_seen_at: post.firstSeenAt ?? new Date("2026-10-21T08:00:00Z"),
  }))
  for (let i = 0; i < rows.length; i += 500) await db.insertInto("hiring_post").values(rows.slice(i, i + 500)).execute()
}

/** Every Phase 3, EPIC-0005 and EPIC-0008 row a test may leave behind (the legacy shared row: `clearLegacyShared`). */
export const HIRING_AND_STACK_TABLES = ["hiring_post", "hiring_post_run", "hiring_alert_feed", "hiring_feed_verification", "stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification"] as const
