import { randomUUID } from "node:crypto"

import pg from "pg"

import { stackState } from "./db.ts"

/**
 * EPIC-0007 Phase 3 fixtures (api-contract.r1 "Migration"): the four
 * per-Candidate tables `hiring_feed_verification`, `hiring_alert_feed`,
 * `hiring_post`, `hiring_post_run`, plus the EPIC-0005 tables the cross-list
 * scenarios touch. Written as the bootstrap superuser (RLS does not bind it),
 * as the api's own int-spec fixtures do. Never used to drive a write the
 * journey itself is about: those go through the browser.
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

const candidateId = (client: pg.Client, email: string) =>
  client.query<{ id: string }>("select id from candidate where email = $1", [email]).then((r) => {
    const id = r.rows[0]?.id
    if (!id) throw new Error(`No candidate ${email}`)
    return id
  })

/** Empties every Phase 3 row and the EPIC-0005 feed rows, so each test starts from nothing recorded. */
export async function resetPhase3(): Promise<void> {
  await withDb(async (client) => {
    for (const table of ["hiring_post", "hiring_post_run", "hiring_alert_feed", "hiring_feed_verification", "stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification", "alert_feed_verification"]) {
      await client.query(`delete from ${pg.escapeIdentifier(table)}`)
    }
  })
}

export type Verification = Readonly<{ verifiedOn: string; verificationBasis: string; updatedAt: Date }>

/** One Candidate's own Hiring feed verification, or null. */
export async function hiringVerification(email: string): Promise<Verification | null> {
  return withDb(async (client) => {
    const { rows } = await client.query<Verification>(
      `select v.verified_on::text as "verifiedOn", v.verification_basis as "verificationBasis", v.updated_at as "updatedAt"
         from hiring_feed_verification v join candidate c on c.id = v.candidate_id where c.email = $1`,
      [email]
    )
    return rows[0] ?? null
  })
}

export async function hiringVerificationCount(): Promise<number> {
  return withDb(async (client) => Number((await client.query<{ n: string }>("select count(*) as n from hiring_feed_verification")).rows[0]?.n ?? 0))
}

export async function setHiringVerification(email: string, verifiedOn = "2026-10-21", basis = "Read Google's terms for Alerts RSS on 21 Oct."): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      `insert into hiring_feed_verification (candidate_id, verified_on, verification_basis, updated_at) values ($1, $2, $3, now())
       on conflict (candidate_id) do update set verified_on = excluded.verified_on, verification_basis = excluded.verification_basis, updated_at = now()`,
      [await candidateId(client, email), verifiedOn, basis]
    )
  })
}

/** The shared EPIC-0005 record (Operator-written; Stack posts only, D15). */
export async function setSharedVerification(recorded: boolean): Promise<void> {
  await withDb(async (client) => {
    await client.query("delete from alert_feed_verification")
    if (recorded) await client.query("insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-09-30', 'Operator shared basis.', now())")
  })
}

export async function sharedVerificationExists(): Promise<boolean> {
  return withDb(async (client) => Number((await client.query<{ n: string }>("select count(*) as n from alert_feed_verification")).rows[0]?.n ?? 0) > 0)
}

/** Stores a Hiring Alert feed by fixture (no fetch). Returns its id. */
export async function insertHiringFeed(email: string, url: string, label: string | null = null, failing: string | null = null): Promise<string> {
  return withDb(async (client) => {
    const id = randomUUID()
    await client.query(
      `insert into hiring_alert_feed (candidate_id, id, url, label, created_at, last_read_at, last_failure_reason, last_failed_at)
       values ($1, $2, $3, $4, now(), now(), $5, case when $5::text is null then null else now() end)`,
      [await candidateId(client, email), id, url, label, failing]
    )
    return id
  })
}

/** Stores a Stack posts Alert feed (EPIC-0005 `alert_feed`) by fixture. */
export async function insertStackFeed(email: string, url: string, label: string | null = null): Promise<string> {
  return withDb(async (client) => {
    const id = randomUUID()
    await client.query(
      `insert into alert_feed (candidate_id, id, url, label, created_at, last_read_at, last_failure_reason, last_failed_at)
       values ($1, $2, $3, $4, now(), now(), null, null)`,
      [await candidateId(client, email), id, url, label]
    )
    return id
  })
}

export async function hiringFeeds(email: string): Promise<{ id: string; url: string; label: string | null }[]> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ id: string; url: string; label: string | null }>(
      "select f.id, f.url, f.label from hiring_alert_feed f join candidate c on c.id = f.candidate_id where c.email = $1 order by f.created_at, f.id",
      [email]
    )
    return rows
  })
}

export async function stackFeeds(email: string): Promise<{ id: string; url: string }[]> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ id: string; url: string }>(
      "select f.id, f.url from alert_feed f join candidate c on c.id = f.candidate_id where c.email = $1 order by f.created_at, f.id",
      [email]
    )
    return rows
  })
}

export type HiringPostFixture = Readonly<{
  canonicalUrl?: string
  title?: string
  snippet?: string
  publishedAt?: Date | null
  firstSeenAt?: Date
  matched?: readonly string[]
  sourceFeedId?: string | null
  kind?: "post" | "article"
}>

/** Stores Hiring posts by fixture; returns their ids in input order. */
export async function insertHiringPosts(email: string, posts: readonly HiringPostFixture[]): Promise<string[]> {
  return withDb(async (client) => {
    const owner = await candidateId(client, email)
    const ids: string[] = []
    for (const [i, post] of posts.entries()) {
      const id = randomUUID()
      ids.push(id)
      await client.query(
        `insert into hiring_post (candidate_id, id, canonical_url, kind, title, snippet, published_at, matched_technologies, source_feed_id, first_seen_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          owner,
          id,
          post.canonicalUrl ?? `https://www.linkedin.com/posts/e2e-hiring-${i}-${id.slice(0, 8)}`,
          post.kind ?? "post",
          post.title ?? `Hiring post ${i}`,
          post.snippet ?? `Snippet ${i}`,
          post.publishedAt === undefined ? null : post.publishedAt,
          post.matched ?? [],
          post.sourceFeedId ?? null,
          post.firstSeenAt ?? new Date(Date.UTC(2026, 9, 1) + i * 60_000),
        ]
      )
    }
    return ids
  })
}

export async function hiringPostCount(email: string): Promise<number> {
  return withDb(async (client) =>
    Number((await client.query<{ n: string }>("select count(*) as n from hiring_post p join candidate c on c.id = p.candidate_id where c.email = $1", [email])).rows[0]?.n ?? 0)
  )
}

export async function stackPostCount(email: string): Promise<number> {
  return withDb(async (client) =>
    Number((await client.query<{ n: string }>("select count(*) as n from stack_post p join candidate c on c.id = p.candidate_id where c.email = $1", [email])).rows[0]?.n ?? 0)
  )
}
