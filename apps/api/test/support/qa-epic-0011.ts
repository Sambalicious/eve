import { randomUUID } from "node:crypto"

import type { INestApplication } from "@nestjs/common"
import type { Kysely } from "kysely"
import { sql } from "kysely"

import { SESSION_COOKIE } from "../../src/auth/cookies.js"
import type { Database } from "../../src/db/schema.js"
import { Browser } from "./browser.js"
import { insertPostingFor } from "./candidate-posting.js"
import type { FakeGoogle } from "./fake-google.js"
import { SignedInCandidate } from "./signed-in.js"

/**
 * QA test authoring, EPIC-0011 (Simplify Eve, api-contract.md v1.28.0). Shared
 * fixtures for the C1 to C4, RLS, lock-race and upgrade-seeding tests. Rows are
 * inserted as the bootstrap superuser (RLS does not bind it). Raw SQL is used
 * for `candidate_view_setting` and for `offer` Outcomes so these files compile
 * before the product's Kysely schema types gain them.
 */
export const BISI = { email: "bisi@example.test", sub: "300000000000000000011" } as const

export type ApplicationValues = Record<string, unknown>

/** An invitee (role candidate, active) with a signed-in session. */
export async function signInInvitee(app: INestApplication, google: FakeGoogle, db: Kysely<Database>, who: { email: string; sub: string } = BISI): Promise<{ id: string; session: SignedInCandidate }> {
  const existing = await db.selectFrom("candidate").select("id").where("email", "=", who.email).executeTakeFirst()
  const id = existing?.id ?? (await db.insertInto("candidate").values({ email: who.email, google_sub: who.sub, role: "candidate" } as never).returning("id").executeTakeFirstOrThrow()).id
  // The per-Candidate singleton rows every invited Candidate has in production (migration 0016 seeds them for existing
  // Candidates): GET /v1/applications/{id} reads job_criteria and fails with "no result for Candidate" without it.
  await db.insertInto("job_criteria").values({ candidate_id: id, min_core_match_percent: 70 }).onConflict((oc) => oc.column("candidate_id").doNothing()).execute()
  const browser = new Browser(app, google)
  const { sessionCookie } = await browser.signIn({ sub: who.sub, email: who.email, email_verified: true })
  const csrf = (await browser.getSession(sessionCookie).expect(200)).body.csrfToken as string
  return { id, session: new SignedInCandidate(browser, `${SESSION_COOKIE}=${sessionCookie}`, csrf, who.email) }
}

/** A visible ranked Greenhouse posting held by `candidateId`, and an Application on it. */
export async function insertApplication(db: Kysely<Database>, candidateId: string, values: ApplicationValues = {}, company = "Acme"): Promise<string> {
  const postingId = randomUUID()
  const id = randomUUID()
  const url = `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${id.slice(0, 8)}`
  const now = new Date("2026-11-01T09:00:00.000Z")
  // DB checks: application_deleted_has_final_status ((details_deleted_at is null) = (final_status is null)) and
  // application_blocked_pair ((state = 'documents_blocked') = (blocked_document is not null)).
  const deleted = values.details_deleted_at !== undefined && values.details_deleted_at !== null
  const derived: ApplicationValues = {}
  if (deleted && values.final_status === undefined) derived.final_status = "not_submitted"
  // application_submitting_has_click: submission_state 'submitting' needs submit_clicked_at.
  if (values.submission_state === "submitting" && values.submit_clicked_at === undefined) derived.submit_clicked_at = now
  if (values.state === "documents_blocked" && values.blocked_document === undefined) derived.blocked_document = "resume"
  await insertPostingFor(db, candidateId, {
    id: postingId, application_url: url, requisition_id: id.slice(0, 8), apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board",
    employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company, status: "ranked", skip_reason: null,
    skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: now, evaluated_at: now,
  } as never)
  await db
    .insertInto("application")
    .values({ id, candidate_id: candidateId, job_posting_id: postingId, application_url: url, requisition_id: id.slice(0, 8), company, role_title: "Senior Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: now, updated_at: now, ...derived, ...values } as never)
    .execute()
  return id
}

export const applicationRow = (db: Kysely<Database>, id: string) => db.selectFrom("application").selectAll().where("id", "=", id).executeTakeFirstOrThrow()

/** An Outcome row of any type, including `offer` (before the Kysely type has it). */
export async function insertOutcome(db: Kysely<Database>, candidateId: string, applicationId: string, type: string, createdAt: Date): Promise<string> {
  const id = randomUUID()
  await sql`insert into outcome (candidate_id, id, application_id, type, source, excerpt, created_at, updated_at)
    values (${candidateId}::uuid, ${id}::uuid, ${applicationId}::uuid, ${type}, 'candidate', null, ${createdAt}, ${createdAt})`.execute(db)
  return id
}

export type ViewSettingRow = { advanced_enabled: boolean; simpler_note_due: boolean; improve_list_dismissed_at: Date | null }

export async function viewSetting(db: Kysely<Database>, candidateId: string): Promise<ViewSettingRow | undefined> {
  return (await sql<ViewSettingRow>`select advanced_enabled, simpler_note_due, improve_list_dismissed_at from candidate_view_setting where candidate_id = ${candidateId}::uuid`.execute(db)).rows[0]
}

export async function setViewSetting(db: Kysely<Database>, candidateId: string, values: { advanced?: boolean; note?: boolean }): Promise<void> {
  await sql`insert into candidate_view_setting (candidate_id, advanced_enabled, simpler_note_due, updated_at) values (${candidateId}::uuid, ${values.advanced ?? false}, ${values.note ?? false}, now())
    on conflict (candidate_id) do update set advanced_enabled = excluded.advanced_enabled, simpler_note_due = excluded.simpler_note_due, updated_at = excluded.updated_at`.execute(db)
}

/** Sets automatic_enabled directly in the database (a non-Operator cannot turn it on through the route). */
export async function setAutomatic(db: Kysely<Database>, candidateId: string, enabled: boolean): Promise<void> {
  const exists = await db.selectFrom("activation_state").select("candidate_id").where("candidate_id", "=", candidateId).executeTakeFirst()
  if (exists) await db.updateTable("activation_state").set({ automatic_enabled: enabled }).where("candidate_id", "=", candidateId).execute()
  else await db.insertInto("activation_state").values({ candidate_id: candidateId, gate_passed_at: new Date("2026-10-01T00:00:00Z"), automatic_enabled: enabled, existing_applications_completed_at: new Date("2026-10-01T00:00:00Z") } as never).execute()
}

/** A stable text digest of every row of `tables`, ordered by the row's JSON text. UPG:11 compares two of these. */
export async function tableDigests(db: Kysely<Database>, tables: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const table of tables) {
    const result = await sql<{ digest: string }>`select coalesce(md5(string_agg(r::text, '|' order by r::text)), 'empty') as digest from ${sql.table(table)} r`.execute(db)
    out[table] = result.rows[0]!.digest
  }
  return out
}

/** Every public table except the one 0033 adds, the migration marker and Kysely bookkeeping. */
export async function tablesExcept0033(db: Kysely<Database>): Promise<string[]> {
  const rows = await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = 'public' and tablename not like 'kysely_%' and tablename not in ('candidate_view_setting', 'migration_marker') order by tablename`.execute(db)
  return rows.rows.map((r) => r.tablename)
}

export const MESSAGES = {
  advancedLocked: "Advanced stays on while automatic applying is on. Turn off automatic applying first.",
  stateConflict: "This Application can't do that in its current state.",
  notFound: "Not found.",
  notAvailable: "This feature isn't available for your account yet.",
} as const

export const ME_KEYS = ["advancedEnabled", "advancedLocked", "candidateId", "capabilities", "email", "improveListDismissed", "isOperator", "simplerNoteDue"] as const
