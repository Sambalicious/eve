import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import type { BrowserContext } from "@playwright/test"
import pg from "pg"

import { assertDisposableAdminUrl } from "./database-locality.ts"
import { STATE_FILE, type StackState } from "./stack.ts"

/** apps/api/src/auth/cookies.ts SESSION_COOKIE. */
export const SESSION_COOKIE = "__Host-ja_session"
/** @eve/contracts CSRF_HEADER. */
export const CSRF_HEADER = "x-csrf-token"
/** @eve/contracts JOB_POSTING_LINKS_PATH. */
export const JOB_POSTING_LINKS_PATH = "/v1/job-postings/links"

export function stackState(): StackState {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StackState
  // SEC-P2-01: every fixture reads the admin URL through here, so check it here too.
  assertDisposableAdminUrl(state.adminUrl)
  return state
}

async function withDb<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: stackState().adminUrl })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

export type Session = Readonly<{ candidateId: string; cookie: string; csrfToken: string }>

/**
 * Synthetic session (declared double): a `dashboard_session` row exactly as
 * SessionService.start writes it (sha256 of a 256-bit token), so the real
 * AuthGuard, CSRF check and RLS scope run unchanged. Google OAuth is not exercised.
 */
export async function createSession(email: string): Promise<Session> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ id: string; google_sub: string }>("select id, google_sub from candidate where email = $1", [email])
    const candidate = rows[0]
    if (!candidate) throw new Error(`No candidate ${email}; global setup seeds ada@example.com and bola@example.com`)
    const cookie = randomBytes(32).toString("base64url")
    const csrfToken = randomBytes(32).toString("base64url")
    await client.query(
      "insert into dashboard_session (id_hash, csrf_token, google_sub, candidate_id, last_active_at) values ($1, $2, $3, $4, now())",
      [createHash("sha256").update(cookie).digest("hex"), csrfToken, candidate.google_sub, candidate.id]
    )
    return { candidateId: candidate.id, cookie, csrfToken }
  })
}

/** Signs the browser context in as `email`. */
export async function signIn(context: BrowserContext, email: string): Promise<Session> {
  const session = await createSession(email)
  // `__Host-` needs Secure, Path=/ and no Domain. CDP refuses a Secure cookie set
  // for an http:// URL, so it is set for the https form of the same host; Chrome
  // treats localhost as a secure context and sends it to http://localhost too.
  const host = new URL(stackState().baseUrl)
  host.protocol = "https:"
  await context.addCookies([{ name: SESSION_COOKIE, value: session.cookie, url: host.origin, secure: true, httpOnly: true, sameSite: "Lax" }])
  return session
}

/** Ages a session past the 14-day idle limit (ADR 0007). */
export async function expireSession(session: Session): Promise<void> {
  await withDb((client) =>
    client.query("update dashboard_session set last_active_at = now() - interval '15 days' where id_hash = $1", [createHash("sha256").update(session.cookie).digest("hex")])
  )
}

/** Removes every posting (and its per-Candidate rows) so each test starts from none stored. */
export async function resetPostings(): Promise<void> {
  await withDb(async (client) => {
    await client.query("delete from ai_call where job_posting_id is not null")
    await client.query("delete from candidate_posting")
    await client.query("delete from job_posting where id not in (select job_posting_id from application where job_posting_id is not null)")
  })
}

export type StoredPosting = Readonly<{ id: string; applicationUrl: string; applyUrl: string; origin: string; status: string; skipReason: string | null; candidateEmail: string; postedAt: Date | null }>

/** Every `candidate_posting` whose posting's application or apply URL equals `url` (normalised by the api). */
export async function postingsWithUrl(url: string): Promise<StoredPosting[]> {
  return withDb(async (client) => {
    const { rows } = await client.query<StoredPosting>(
      `select p.id, p.application_url as "applicationUrl", p.apply_url as "applyUrl", cp.origin, cp.status,
              cp.skip_reason as "skipReason", c.email as "candidateEmail", p.posted_at as "postedAt"
         from candidate_posting cp join job_posting p on p.id = cp.job_posting_id join candidate c on c.id = cp.candidate_id
        where p.application_url = $1 or p.apply_url = $1 or p.application_url = $2`,
      [url, url.replace(/^https?:\/\/(www\.)?/i, "https://")]
    )
    return rows
  })
}

export async function postingCount(): Promise<number> {
  return withDb(async (client) => Number((await client.query<{ n: string }>("select count(*) as n from candidate_posting")).rows[0]?.n ?? 0))
}

/**
 * Stores a posting for `email` as if pasted earlier, for the "already saved" case.
 * Repair wave 1 (check-this-job.feature r3, D10): by default the row is a
 * visible posting (posted 2 days ago, Role family Frontend, mid-or-higher
 * marker), the facts the api stores at first insert. `postedAt: null` stores it
 * undated, so EPIC-0006 hides it ("no posted date"), for CTJ:112 and CTJ:217.
 */
export async function insertPastedPosting(
  email: string,
  url: string,
  options: { title?: string; postedAt?: Date | null; applicationSystem?: string; requisitionId?: string } = {}
): Promise<string> {
  const title = options.title ?? "Senior Frontend Engineer"
  const postedAt = options.postedAt === undefined ? new Date(Date.now() - 2 * 86_400_000) : options.postedAt
  const system = options.applicationSystem ?? "greenhouse"
  return withDb(async (client) => {
    const id = randomUUID()
    await client.query(
      `insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, posting_text, discovered_at,
                               role_family, seniority_marker, posted_at, posted_date_kind)
       values ($1, $2, $3, $2, $5, $6, 'pasted_link', $4, lower($4), 'Acme', 'Remote.', now(), 'senior_frontend', 'mid_plus', $7, $8)`,
      [id, url, options.requisitionId ?? "4012345", title, system, system === "greenhouse" || system === "lever" || system === "ashby" ? "automatic" : "manual", postedAt, postedAt === null ? null : "published"]
    )
    await client.query(
      `insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at, evaluated_at)
       select id, $2, 'pasted_link', $3, now(), now() from candidate where email = $1`,
      [email, id, postedAt === null ? "not_checked" : "skipped"]
    )
    return id
  })
}

/** Rows in `ai_call` for postings whose application or apply URL is `url`. */
export async function aiCallsForUrl(url: string): Promise<number> {
  return withDb(async (client) =>
    Number(
      (
        await client.query<{ n: string }>(
          "select count(*) as n from ai_call a join job_posting p on p.id = a.job_posting_id where p.application_url = $1 or p.apply_url = $1",
          [url]
        )
      ).rows[0]?.n ?? 0
    )
  )
}

/** Sets one Candidate's target Role families and seniority setting (check-this-job.feature r3 Background). */
export async function setRelevance(email: string, families: readonly string[], seniorityFloor: "all_levels" | "hide_entry_level" = "hide_entry_level"): Promise<void> {
  await withDb((client) =>
    client.query("update job_criteria set target_role_families = $2, seniority_floor = $3 where candidate_id = (select id from candidate where email = $1)", [email, families, seniorityFloor])
  )
}

/** EPIC-0005 fixture for the unchanged Stack posts view: criteria terms the Search links are built from. */
export async function setJobCriteriaTerms(email: string, frameworks: string[], technologies: string[]): Promise<void> {
  await withDb((client) =>
    client.query(
      "update job_criteria set frameworks = $2, technologies = $3 where candidate_id = (select id from candidate where email = $1)",
      [email, frameworks, technologies]
    )
  )
}

/** Lines the api's outbound recorder wrote (support/outbound-stub.mjs). */
export function outboundRequests(): { method: string; url: string; at: string }[] {
  const text = readFileSync(stackState().outboundLog, "utf8")
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; url: string; at: string })
}
