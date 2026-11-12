import { ANTHROPIC_TERMS } from "@eve/contracts"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { SESSION_COOKIE } from "../src/auth/cookies.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync, candidateDir } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { CROSS_CANDIDATE_CASES, type ForeignResource, type RegistryCase } from "./cross-candidate.cases.js"

/**
 * EPIC-0002 A2: runs the generic case of every registry entry with two
 * Candidates over HTTP: Ada, the Operator, owns sentinel-marked rows of every
 * kind; Kofi, seeded directly (slice C builds invites), signs in and calls each
 * route. A's rows must be byte-equal afterwards, a foreign ID must answer
 * exactly as an ID that never existed, and B's bodies must hold none of A's
 * sentinels. Guarded routes are checked here as well: before conversion Kofi
 * gets the 409, which reads nothing.
 *
 * Gherkin: data-isolation.feature:142, :196, :262, :275, :552, :807;
 * r5-new-tables-isolation.feature:121.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let ada: SignedInCandidate
let kofi: SignedInCandidate
let kofiId: string
let storage: string
const clock = new TestClock("2026-10-21T09:00:00.000Z")
const KOFI_SUB = "200000000000000000a22"
const KOFI_EMAIL = "kofi.registry@example.test"
const SENTINEL = "ADA-SENTINEL"

const A: Record<ForeignResource, string> = {
  application: "00000000-0000-4000-8000-00000000a201",
  outcome: "00000000-0000-4000-8000-00000000a202",
  "minimal-record": "00000000-0000-4000-8000-00000000a203",
  "approved-answer": "00000000-0000-4000-8000-00000000a204",
  posting: "00000000-0000-4000-8000-00000000a205",
  "alert-feed": "00000000-0000-4000-8000-00000000a206",
  "hiring-feed": "00000000-0000-4000-8000-00000000a207",
  "career-profile-version": "7",
}
const NEVER: Record<ForeignResource, string> = {
  application: "00000000-0000-4000-8000-00000000dead",
  outcome: "00000000-0000-4000-8000-00000000dead",
  "minimal-record": "00000000-0000-4000-8000-00000000dead",
  "approved-answer": "00000000-0000-4000-8000-00000000dead",
  posting: "00000000-0000-4000-8000-00000000dead",
  "alert-feed": "00000000-0000-4000-8000-00000000dead",
  "hiring-feed": "00000000-0000-4000-8000-00000000dead",
  "career-profile-version": "999",
}
const OPERATOR_TABLES = [
  "application", "outcome", "tailored_document", "approved_answer", "gross_salary_answer", "preferred_net_pay", "candidate_setting", "candidate_contact",
  "career_profile_version", "candidate_posting", "match_evidence", "alert_feed", "existing_application", "activation_state", "ai_terms_approval", "job_criteria",
  // F-SEC-40: EPIC-0007's four Candidate tables (0021-hiring-posts HIRING_TABLES).
  "hiring_alert_feed", "hiring_post", "hiring_post_run", "hiring_feed_verification",
  // EPIC-0008: A's own Stack posts verification (0024), sentinel-marked.
  "alert_feed_candidate_verification",
  // EPIC-0002 B1: A's Job Preferences record and history (0018, 0027).
  "job_preferences", "job_preferences_version",
  // EPIC-0011: A's Advanced flag and notes (0033).
  "candidate_view_setting",
] as const
const SHARED_TABLES = ["employer_list_state", "remote_board", "evaluation_setting", "control_state", "spend_month", "ai_provider_approval"] as const
/** EPIC-0008 (AR-5): the legacy shared Stack posts record stays for rollback but is not in `Database`; read raw, it must never change. */
const LEGACY_SHARED_TABLES = ["alert_feed_verification"] as const

/** Ada's rows and the shared singletons, as JSON, for the "nothing of A's changed" check. */
async function snapshotOfA(): Promise<string> {
  const rows: Record<string, unknown> = {}
  for (const table of OPERATOR_TABLES) rows[table] = await database.db.selectFrom(table).selectAll().where("candidate_id", "=", database.operatorId).execute()
  for (const table of SHARED_TABLES) rows[table] = await database.db.selectFrom(table).selectAll().execute()
  for (const table of LEGACY_SHARED_TABLES) rows[table] = (await sql`select * from ${sql.table(table)}`.execute(database.db)).rows
  return JSON.stringify(rows, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))
}

async function seedOperatorRows(): Promise<void> {
  const at = new Date("2026-10-01T10:00:00Z")
  const op = database.operatorId
  const url = "https://boards.greenhouse.io/ada-registry/jobs/1"
  await insertPostingFor(database.db, op, { id: A.posting, application_url: url, requisition_id: "1", apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: `${SENTINEL} Role`, company: `${SENTINEL} Co`, status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: at, evaluated_at: at })
  const application = { candidate_id: op, job_posting_id: A.posting, application_url: url, requisition_id: "1", company: `${SENTINEL} Co`, role_title: `${SENTINEL} Role`, state: "documents_ready" as const, career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: at, updated_at: at }
  await database.db.insertInto("application").values({ ...application, id: A.application }).execute()
  await database.db.insertInto("application").values({ ...application, id: A["minimal-record"], requisition_id: "2", details_deleted_at: at, final_status: "confirmed" }).execute()
  await database.db.insertInto("outcome").values({ id: A.outcome, candidate_id: op, application_id: A.application, type: "confirmation", excerpt: SENTINEL, created_at: at, updated_at: at }).execute()
  for (const kind of ["resume", "cover_letter"] as const) {
    const fileId = randomUUID()
    await writeFile(join(candidateDir(storage, op, "documents"), `${fileId}.pdf`), SENTINEL)
    await writeFile(join(candidateDir(storage, op, "documents"), `${fileId}.docx`), SENTINEL)
    await database.db.insertInto("tailored_document").values({ id: randomUUID(), candidate_id: op, application_id: A.application, kind, career_profile_version: 1, content: JSON.stringify({ text: SENTINEL }), pdf_storage_name: `${fileId}.pdf`, docx_storage_name: `${fileId}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: at }).execute()
  }
  await database.db.insertInto("approved_answer").values({ candidate_id: op, id: A["approved-answer"], answer_group: "standard", topic: "notice_period", skill: null, question: null, answer_key: "standard:notice_period", value: SENTINEL, created_at: at, updated_at: at }).execute()
  await database.db.insertInto("gross_salary_answer").values({ candidate_id: op, kind: "gross_salary_policy", amount: "98765.00", currency: "NGN", period: "year", updated_at: at }).execute()
  await database.db.insertInto("preferred_net_pay").values({ candidate_id: op, amount: "87654.00", currency: "NGN", updated_at: at }).execute()
  await database.db.updateTable("candidate_setting").set({ work_authorization: `${SENTINEL} auth` }).where("candidate_id", "=", op).execute()
  await database.db.insertInto("candidate_contact").values({ candidate_id: op, full_name: `${SENTINEL} Name`, lines: JSON.stringify([`${SENTINEL} line`]) }).onConflict((oc) => oc.column("candidate_id").doUpdateSet({ full_name: `${SENTINEL} Name` })).execute()
  for (const version of [1, 7]) {
    await database.db.insertInto("career_profile_version").values({ candidate_id: op, version, status: version === 1 ? "approved" : "draft", source: "edit", resume_upload_id: null, sections: JSON.stringify([{ id: "s1", kind: "summary", title: SENTINEL, facts: [{ id: "f1", text: SENTINEL }] }]), created_at: at, approved_at: version === 1 ? at : null }).execute()
  }
  await database.db.insertInto("candidate_view_setting").values({ candidate_id: op, advanced_enabled: true, simpler_note_due: false, improve_list_dismissed_at: null, updated_at: at }).onConflict((oc) => oc.column("candidate_id").doUpdateSet({ advanced_enabled: true })).execute()
  // EPIC-0008: A's own Stack posts record, sentinel-marked, so B's GET and PUT are checked over HTTP.
  await database.db.insertInto("alert_feed_candidate_verification").values({ candidate_id: op, verified_on: "2026-10-01", verification_basis: `${SENTINEL} stack basis`, updated_at: at }).execute()
  await database.db.insertInto("alert_feed").values({ candidate_id: op, id: A["alert-feed"], url: "https://www.google.com/alerts/feeds/11111111111111111111/3333333333333333333", label: SENTINEL, created_at: at, last_read_at: at, last_failure_reason: null, last_failed_at: null }).execute()
  // F-SEC-40: A's Hiring record, feed, post and run, sentinel-marked, so B's hiring calls are checked over HTTP.
  await database.db.insertInto("hiring_feed_verification").values({ candidate_id: op, verified_on: "2026-10-01", verification_basis: `${SENTINEL} basis`, updated_at: at }).execute()
  await database.db.insertInto("hiring_alert_feed").values({ candidate_id: op, id: A["hiring-feed"], url: "https://www.google.com/alerts/feeds/11111111111111111111/4444444444444444444", label: SENTINEL, created_at: at, last_read_at: at, last_failure_reason: null, last_failed_at: null }).execute()
  await database.db.insertInto("hiring_post").values({ candidate_id: op, id: randomUUID(), canonical_url: "https://www.linkedin.com/posts/ada-registry-hiring", kind: "post", title: `${SENTINEL} Hiring`, snippet: SENTINEL, published_at: at, matched_technologies: ["React"], source_feed_id: A["hiring-feed"], first_seen_at: at }).execute()
  await database.db.insertInto("hiring_post_run").values({ candidate_id: op, id: randomUUID(), started_at: at, finished_at: at, outcome: "completed", feeds_read: 1, feeds_failed: 0, posts_stored: 1, posts_deleted: 0 }).execute()
  await database.db.insertInto("existing_application").values({ candidate_id: op, id: randomUUID(), company: `${SENTINEL} Co`, role_title: SENTINEL, application_url: "https://example.test/ada", requisition_id: null, applied_on: "2026-09-01", created_at: at }).execute()
}

function concretePath(entry: RegistryCase, id: string | undefined): string {
  return entry.path
    .replace(":id", id ?? NEVER.application)
    .replace(":jobPostingId", id ?? NEVER.posting)
    .replace(":version", id ?? NEVER["career-profile-version"])
    .replace(":note", "improve_results")
    .replace(":key", "remoteok")
    .replace(":kind", "referral-request")
    .replace(":file", "resume.pdf")
}

function send(who: SignedInCandidate, entry: RegistryCase, path: string, body: unknown) {
  const request = (() => {
    switch (entry.method) {
      case "GET":
        return who.get(path)
      case "PUT":
        return who.put(path)
      case "POST":
        return who.post(path)
      case "PATCH":
        return who.patch(path)
      case "DELETE":
        return who.delete(path)
    }
  })()
  return body === undefined ? request : request.send(body as object)
}

/** Headers that may differ between two responses: per-request values only. */
const VOLATILE = new Set(["date", "x-request-id", "content-length", "set-cookie", "etag"])
const stableHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).filter(([key]) => !VOLATILE.has(key)))

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-registry-"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: markStorageMigratedSync(storage) } })
  ada = await signInCandidate(new Browser(app, google))
  kofiId = (await database.db.insertInto("candidate").values({ email: KOFI_EMAIL, google_sub: KOFI_SUB, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  // Slice C's onboarding writes an invitee's per-Candidate singletons; seeded here as A2 has no invite flow.
  await database.db.insertInto("activation_state").values({ candidate_id: kofiId, existing_applications_completed_at: null, gate_passed_at: null }).execute()
  await database.db.insertInto("candidate_setting").values({ candidate_id: kofiId, work_authorization: "Kenya" }).execute()
  await database.db.insertInto("job_criteria").values({ candidate_id: kofiId, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: KOFI_SUB, email: KOFI_EMAIL, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  kofi = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, KOFI_EMAIL)
  await seedOperatorRows()
})

beforeEach(() => {
  clock.set("2026-10-21T09:00:00.000Z")
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

const byKind = (kind: RegistryCase["kind"]) => CROSS_CANDIDATE_CASES.filter((entry) => entry.kind === kind && !entry.named)
const label = (entry: RegistryCase) => [`${entry.method} ${entry.path}`, entry] as const

describe("foreign ID: B's call with A's ID answers as a never-existed ID, and A's rows are unchanged", () => {
  it.each(byKind("foreign-id").map(label))("%s", async (_name, entry) => {
    const resource = entry.resource!
    const before = await snapshotOfA()
    const viaPath = entry.path.includes(":id") || entry.path.includes(":jobPostingId") || entry.path.includes(":version")
    const foreign = await send(kofi, entry, concretePath(entry, viaPath ? A[resource] : undefined), entry.body?.(A[resource]))
    const never = await send(kofi, entry, concretePath(entry, viaPath ? NEVER[resource] : undefined), entry.body?.(NEVER[resource]))
    expect(await snapshotOfA()).toBe(before)
    const expected = entry.guarded ? 409 : (entry.status ?? 404)
    expect(foreign.status).toBe(expected)
    expect(foreign.body).toEqual(never.body)
    expect(stableHeaders(foreign.headers)).toEqual(stableHeaders(never.headers))
    expect(JSON.stringify(foreign.body)).not.toContain(SENTINEL)
  })
})

describe("own scope: B's response holds nothing of A's, and A's rows are unchanged", () => {
  it.each(byKind("own-scope").map(label))("%s", async (_name, entry) => {
    const before = await snapshotOfA()
    const response = await send(kofi, entry, concretePath(entry, undefined), entry.send)
    expect(await snapshotOfA()).toBe(before)
    expect(response.status).toBeLessThan(500)
    if (entry.guarded) expect(response.status).toBe(409)
    const text = JSON.stringify(response.body ?? "") + (typeof response.text === "string" ? response.text : "")
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toMatch(/98765|87654/)
  })
})

describe("operator only: B gets 404 and nothing is written; the Operator is not refused", () => {
  it.each(byKind("operator-only").map(label))("%s", async (_name, entry) => {
    const before = await snapshotOfA()
    const response = await send(kofi, entry, concretePath(entry, undefined), entry.send)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: { code: "not_found", message: "Not found." } })
    expect(await snapshotOfA()).toBe(before)
  })

  it("a non-Operator cannot record the installation-wide AI provider approval while none exists (F-SEC-01)", async () => {
    const saved = await database.db.selectFrom("ai_provider_approval").selectAll().execute()
    await database.db.deleteFrom("ai_provider_approval").execute()
    try {
      const response = await kofi.post("/v1/ai-provider/approval").send({ termsCheckedOn: ANTHROPIC_TERMS.checkedOn })
      expect(response.status).toBe(404)
      expect(await database.db.selectFrom("ai_provider_approval").selectAll().execute()).toEqual([])
      await ada.post("/v1/ai-provider/approval").send({ termsCheckedOn: ANTHROPIC_TERMS.checkedOn }).expect(200)
      expect(await database.db.selectFrom("ai_provider_approval").selectAll().execute()).toHaveLength(1)
    } finally {
      await database.db.deleteFrom("ai_provider_approval").execute()
      if (saved.length > 0) await database.db.insertInto("ai_provider_approval").values(saved).execute()
    }
  })

  it("the Operator still reaches the shared catalog writes", async () => {
    await ada.post("/v1/job-sources/employer-list/approve").expect(200)
  })

  it("v1.25.0: PUT /v1/eligibility-settings is removed: 404 for the Operator and for B, and the installation row is unchanged", async () => {
    const before = await snapshotOfA()
    for (const who of [ada, kofi]) {
      const response = await who.put("/v1/eligibility-settings").send({ hoursCutoff: "18:00", hoursTimeZone: "Africa/Lagos" })
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: { code: "not_found", message: "Not found." } })
    }
    expect(await snapshotOfA()).toBe(before)
  })
})

describe("session routes act on the caller only", () => {
  it("GET /v1/me and GET /v1/session return B's own values", async () => {
    const me = (await kofi.get("/v1/me").expect(200)).body as { candidateId: string }
    expect(me.candidateId).toBe(kofiId)
    const session = (await kofi.get("/v1/session").expect(200)).body as { csrfToken: string }
    expect(session.csrfToken).toBe(kofi.csrfToken)
  })

  it("POST /v1/auth/logout by B ends B's session only; A's session still works", async () => {
    const browser = new Browser(app, google)
    const { sessionCookie } = await browser.signIn({ sub: KOFI_SUB, email: KOFI_EMAIL, email_verified: true })
    const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
    const second = new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, KOFI_EMAIL)
    await second.post("/v1/auth/logout").expect(204)
    await second.get("/v1/me").expect(401)
    await ada.get("/v1/me").expect(200)
  })
})

describe("no authenticated route serves an access request by ID (data-isolation.feature:807)", () => {
  it("an access request ID in every :id route answers as a never-existed ID", async () => {
    const accessId = randomUUID()
    await database.db.insertInto("access_request").values({ id: accessId, email: "x@example.test", email_key: "x@example.test", note: "n", created_at: new Date(), ip_hash: null, window_id: accessId }).execute()
    for (const entry of CROSS_CANDIDATE_CASES.filter((candidate) => candidate.path.includes(":id") && candidate.method === "GET")) {
      const withAccessId = await send(kofi, entry, concretePath(entry, accessId), undefined)
      const never = await send(kofi, entry, concretePath(entry, NEVER.application), undefined)
      expect({ route: entry.path, status: withAccessId.status, body: withAccessId.body }).toEqual({ route: entry.path, status: never.status, body: never.body })
    }
  })
})
