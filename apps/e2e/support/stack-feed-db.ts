import { randomUUID } from "node:crypto"

import pg from "pg"

import { stackState } from "./db.ts"

/**
 * EPIC-0008 fixtures (api-contract.md v1.22.0 "Migration 0024"): the
 * per-Candidate table `alert_feed_candidate_verification`, the legacy EPIC-0005
 * row, Stack posts feeds and posts. Written as the bootstrap superuser (RLS does
 * not bind it), as the api's int-spec fixtures do. Never used for a write the
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

const candidateId = async (client: pg.Client, email: string) => {
  const id = (await client.query<{ id: string }>("select id from candidate where email = $1", [email])).rows[0]?.id
  if (!id) throw new Error(`No candidate ${email}`)
  return id
}

/** Empties every Stack posts and Hiring feed row and both pauses, so each test starts from nothing recorded. */
export async function resetEpic8(): Promise<void> {
  await withDb(async (client) => {
    for (const table of ["stack_post", "stack_post_run", "alert_feed", "alert_feed_candidate_verification", "alert_feed_verification", "hiring_post", "hiring_post_run", "hiring_alert_feed", "hiring_feed_verification"]) {
      await client.query(`delete from ${pg.escapeIdentifier(table)}`)
    }
    await client.query("update control_state set global_paused = false, cost_paused = false")
  })
}

export type OwnRecord = Readonly<{ verifiedOn: string; verificationBasis: string; updatedAt: Date }>

/** One Candidate's own Stack posts record, or null. */
export async function ownStackRecord(email: string): Promise<OwnRecord | null> {
  return withDb(async (client) => {
    const { rows } = await client.query<OwnRecord>(
      `select v.verified_on::text as "verifiedOn", v.verification_basis as "verificationBasis", v.updated_at as "updatedAt"
         from alert_feed_candidate_verification v join candidate c on c.id = v.candidate_id where c.email = $1`,
      [email]
    )
    return rows[0] ?? null
  })
}

export async function ownStackRecordCount(): Promise<number> {
  return withDb(async (client) => Number((await client.query<{ n: string }>("select count(*) as n from alert_feed_candidate_verification")).rows[0]?.n ?? 0))
}

export async function setOwnStackRecord(email: string, verifiedOn = "2026-10-21", basis = "Read Google's Alerts RSS terms on 21 Oct."): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      `insert into alert_feed_candidate_verification (candidate_id, verified_on, verification_basis, updated_at) values ($1, $2, $3, now())
       on conflict (candidate_id) do update set verified_on = excluded.verified_on, verification_basis = excluded.verification_basis, updated_at = now()`,
      [await candidateId(client, email), verifiedOn, basis]
    )
  })
}

/** The legacy EPIC-0005 shared row (kept and unread after EPIC-0008). */
export async function setLegacyRecord(recorded: boolean): Promise<void> {
  await withDb(async (client) => {
    await client.query("delete from alert_feed_verification")
    if (recorded) await client.query("insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-09-30', 'Reviewed Google Alerts terms on 30 Sep.', '2026-09-30T10:15:00Z')")
  })
}

export async function legacyRecord(): Promise<{ verifiedOn: string; verificationBasis: string } | null> {
  return withDb(async (client) => (await client.query<{ verifiedOn: string; verificationBasis: string }>(`select verified_on::text as "verifiedOn", verification_basis as "verificationBasis" from alert_feed_verification`)).rows[0] ?? null)
}

export async function hiringRecord(email: string): Promise<{ verifiedOn: string; verificationBasis: string; updatedAt: Date } | null> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ verifiedOn: string; verificationBasis: string; updatedAt: Date }>(
      `select v.verified_on::text as "verifiedOn", v.verification_basis as "verificationBasis", v.updated_at as "updatedAt"
         from hiring_feed_verification v join candidate c on c.id = v.candidate_id where c.email = $1`,
      [email]
    )
    return rows[0] ?? null
  })
}

/** Stores a Stack posts Alert feed by fixture (no fetch), e.g. an invitee's feed registered before EPIC-0008. */
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

export async function stackFeedUrls(email: string): Promise<string[]> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ url: string }>("select f.url from alert_feed f join candidate c on c.id = f.candidate_id where c.email = $1 order by f.created_at, f.id", [email])
    return rows.map((r) => r.url)
  })
}

/** Stores Stack posts by fixture; titles are `${prefix} ${i}`. */
export async function insertStackPosts(email: string, count: number, prefix = "Stack post"): Promise<void> {
  await withDb(async (client) => {
    const id = await candidateId(client, email)
    for (let i = 0; i < count; i += 1) {
      await client.query(
        `insert into stack_post (candidate_id, id, canonical_url, kind, title, snippet, published_at, matched_technologies, source_feed_id, first_seen_at)
         values ($1, $2, $3, 'post', $4, '', null, '{React}', null, now() - ($5 || ' minutes')::interval)`,
        [id, randomUUID(), `https://www.linkedin.com/posts/e8-${randomUUID().slice(0, 8)}-activity-72500000000000${String(i).padStart(5, "0")}`, `${prefix} ${i}`, String(i)]
      )
    }
  })
}

export async function stackPostCount(email: string): Promise<number> {
  return withDb(async (client) => Number((await client.query<{ n: string }>("select count(*) as n from stack_post p join candidate c on c.id = p.candidate_id where c.email = $1", [email])).rows[0]?.n ?? 0))
}

export async function setPaused(global: boolean): Promise<void> {
  await withDb((client) => client.query("update control_state set global_paused = $1", [global]))
}
