import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { CANDIDATE_TABLES } from "../src/db/migrations/0016-multi-candidate.js"
import { migrationsFor } from "../src/db/migrations/index.js"

/**
 * EPIC-0002 A1, AC 1 (architecture r2 "Migration test"; gherkin
 * migration-and-operator-bootstrap.feature). A database at the last migration
 * before 0016, seeded with rows in every Candidate table, including the
 * slice 5 to 8 tables: every submission state, both gate seeds, every outbox
 * status and kind, a daily summary, cap days, existing applications, form
 * reads and events. After 0016 every row belongs to the owner and every
 * column is byte-equal through the column map (three renames).
 */
const OWNER_SUB = "google-sub-ada-0001"
const admin = () => createDatabase(inject("postgresAdminUrl")) as unknown as Kysely<unknown>
/**
 * EPIC-0006 (architecture.r1 "Migration interplay"): this file proves EPIC-0002's chain (0016 to 0019,
 * and A2's 0022 and 0023), so it leaves out 0020-role-relevance, which reclassifies role families on
 * purpose; its own test is role-relevance-migration.int-spec.ts. It also leaves out EPIC-0007's
 * 0021-hiring-posts (run a2i), which adds four new tables and is tested by the hiring specs, and
 * EPIC-0008's 0024-alert-feed-candidate-verification (merged after A2), tested by the stack-feed specs, and
 * EPIC-0002 B1's 0027-preferences-version, tested by preferences-version-migration.int-spec.ts.
 * Before the renumbers (runs a2e and a2i) A2's migrations were 0020 and 0021.
 */
const OTHER_EPICS = new Set(["0020-role-relevance", "0021-hiring-posts", "0024-alert-feed-candidate-verification", "0025-apply-anyway", "0026-apply-anyway-bounds", "0027-preferences-version", "0028-ats-skills", "0029-ats-fit", "0030-ats-minimum", "0031-pasted-description", "0032-stuck-checking", "0033-simplify-eve", "0034-forward-statements", "0035-manual-apply-lane", "0036-retry-failed-checks", "0037-retry-backfill", "0038-lead-pipeline", "0039-blocked-claim-cause", "0040-outreach-messages", "0041-lead-policy-binding"])
const throughEpic0002 = (migrations: ReturnType<typeof migrationsFor>) => Object.fromEntries(Object.entries(migrations).filter(([name]) => !OTHER_EPICS.has(name)))
const ALL = throughEpic0002(migrationsFor({ operatorGoogleSub: OWNER_SUB }))
const BEFORE = Object.fromEntries(Object.entries(ALL).filter(([name]) => name < "0016"))
const SUBMISSION_STATES = ["queued", "submit_claimed", "submitting", "confirmed", "uncertain", "blocked", "manual", "not_submitted", "declined", null] as const

type Db = Kysely<unknown>
const opened: { name: string; db: Db }[] = []
let cluster: Db

beforeAll(() => {
  cluster = admin()
})

afterAll(async () => {
  for (const { name, db } of opened) {
    await db.destroy()
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  }
  await cluster.destroy()
})

async function databaseAtPrevious(): Promise<Db> {
  const name = `ja_mc_mig_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const url = new URL(inject("postgresAdminUrl"))
  url.pathname = `/${name}`
  const db = createDatabase(url.toString()) as unknown as Db
  opened.push({ name, db })
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => BEFORE } }).migrateToLatest()
  if (error) throw error
  return db
}

async function migrate(db: Db, sub: string | null = OWNER_SUB) {
  return new Migrator({ db, provider: { getMigrations: async () => throughEpic0002(migrationsFor({ operatorGoogleSub: sub ?? undefined })) } }).migrateToLatest()
}

async function appliedNames(db: Db): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db)
  return rows.map((row) => row.name)
}

/** Rows in every Candidate table and the shared tables they reference. Returns the seeded ids. */
async function seed(db: Db, gatePassed: boolean): Promise<void> {
  const q = (statement: ReturnType<typeof sql>) => statement.execute(db)
  const t0 = "2026-10-20T08:00:00Z"
  const resume = randomUUID()
  await q(sql`insert into resume_upload (id, original_filename, media_type, byte_size, sha256, storage_name, status, started_at, finished_at)
    values (${resume}, 'cv.pdf', 'application/pdf', 1234, ${"a".repeat(64)}, ${randomUUID()}, 'drafted', ${t0}, ${t0})`)
  await q(sql`insert into career_profile_version (version, status, source, resume_upload_id, sections, created_at, approved_at)
    values (1, 'approved', 'resume', ${resume}, '[{"id":"s1","kind":"skills","title":"Skills","organization":null,"period":null,"sourceQuote":null,"facts":[]}]', ${t0}, ${t0}),
           (2, 'draft', 'edit', null, '[]', ${t0}, null)`)
  await q(sql`insert into approved_answer (id, answer_group, topic, skill, question, answer_key, value, created_at, updated_at)
    values (${randomUUID()}, 'standard', 'notice_period', null, null, 'standard:notice_period', '4 weeks', ${t0}, ${t0}),
           (${randomUUID()}, 'custom', null, null, 'Why us?', 'custom:why us?', 'Because', ${t0}, ${t0})`)
  await q(sql`insert into gross_salary_answer (kind, amount, currency, period, updated_at) values ('gross_salary_policy', '48000.00', 'USD', 'year', ${t0}), ('current_salary', '30000.50', 'USD', 'year', ${t0})`)
  await q(sql`insert into preferred_net_pay (amount, currency, updated_at) values ('3000.00', 'USD', ${t0})`)
  await q(sql`insert into ai_provider_approval (provider, approved_at, terms_checked_on, training_line, retention_line, whats_sent_line)
    values ('anthropic', ${t0}, '2026-10-01', 'No training on API data.', 'Deleted after 30 days.', 'Resume text and posting text.')`)
  await q(sql`update candidate_contact set full_name = 'Ada Okafor', lines = '["Lagos, Nigeria","ada@example.com"]'`)
  await q(sql`update candidate_setting set work_authorization = 'None outside Nigeria.'`)
  await q(sql`update evaluation_setting set hours_cutoff = '22:30'`)
  await q(sql`update activation_state set existing_applications_completed_at = ${gatePassed ? t0 : null}, gate_passed_at = ${gatePassed ? t0 : null}, automatic_enabled = ${gatePassed}`)

  for (const [index, state] of SUBMISSION_STATES.entries()) {
    const posting = randomUUID()
    const application = randomUUID()
    const url = `https://boards.greenhouse.io/acme/jobs/${index}`
    await q(sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, structured, status, role_family, discovered_at, evaluated_at, title_folded)
      values (${posting}, ${url}, ${`R-${index}`}, ${url}, 'greenhouse', 'automatic', 'employer_board', 'Senior Frontend Engineer', ${`Co${index}`}, '{}', 'ranked', 'senior_frontend', ${t0}, ${t0}, 'senior frontend engineer')`)
    await q(sql`insert into eligibility_result (job_posting_id, arrangement, relocation_country, employment_type, rules, eligible, normalized_monthly_max_usd, fx_rate_date, evaluated_at)
      values (${posting}, 'remote', null, 'direct', '[{"rule":"location","result":"met","quote":"Remote"}]', true, '5000.00', '2026-10-16', ${t0})`)
    await q(sql`insert into match_evidence (job_posting_id, career_profile_version, verdict, weak_reason, covered_count, total_count, threshold, items, evaluated_at)
      values (${posting}, 1, 'strong', null, 3, 4, '0.700', '[]', ${t0})`)
    const submitted = state === "submit_claimed" || state === "submitting" || state === "confirmed" || state === "uncertain"
    await q(sql`insert into application (id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at,
        submission_state, submission_kind, attempt_id, attempt_number, submit_clicked_at, submitted_wat_day, confirmed_at, evidence_kind, evidence_text,
        blocked_reason, blocked_detail, blocked_at, sample_state, sample_counts, queued_for_wat_day, same_company_approved_at)
      values (${application}, ${posting}, ${url}, ${`R-${index}`}, ${`Co${index}`}, 'Senior Frontend Engineer', 'documents_ready', 1, ${t0}, ${t0},
        ${state}, ${state === null ? null : index % 3 === 0 ? "sample" : "automatic"}, ${submitted ? randomUUID() : null}, ${submitted ? 1 : 0},
        ${state === "submitting" || state === "confirmed" || state === "uncertain" ? t0 : null}, ${submitted ? "2026-10-20" : null},
        ${state === "confirmed" ? t0 : null}, ${state === "confirmed" ? "confirmation_page" : null}, ${state === "confirmed" ? "Thank you" : null},
        ${state === "blocked" ? "captcha" : null}, ${state === "blocked" ? "A CAPTCHA" : null}, ${state === "blocked" ? t0 : null},
        ${index % 3 === 0 && state !== null ? "approved" : null}, ${index % 3 === 0 && state !== null}, ${state === "queued" ? "2026-10-21" : null}, null)`)
    await q(sql`insert into tailored_document (id, application_id, kind, career_profile_version, content, pdf_storage_name, docx_storage_name, pdf_sha256, docx_sha256, created_at)
      values (${randomUUID()}, ${application}, 'resume', 1, '{"a":1}', ${randomUUID()}, ${randomUUID()}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${t0})`)
    await q(sql`insert into application_form_read (application_id, host, controls, read_at) values (${application}, 'boards.greenhouse.io', '[]', ${t0})`)
    await q(sql`insert into submission_event (id, application_id, kind, detail, created_at) values (${randomUUID()}, ${application}, 'claimed', null, ${t0})`)
    await q(sql`insert into ai_call (id, purpose, provider, model, status, input_tokens, output_tokens, job_posting_id, application_id, started_at, finished_at)
      values (${randomUUID()}, 'job_posting_evaluation', 'anthropic', 'claude-haiku-5-5', 'succeeded', 10, 20, ${posting}, null, ${t0}, ${t0}),
             (${randomUUID()}, 'tailored_documents', 'anthropic', 'claude-haiku-5-5', 'succeeded', 10, 20, null, ${application}, ${t0}, ${t0})`)
    if (state === "confirmed") {
      await q(sql`insert into outcome (id, application_id, type, excerpt, created_at, updated_at) values (${randomUUID()}, ${application}, 'confirmation', null, ${t0}, ${t0})`)
    }
    // Every outbox status for the per-Application kinds.
    const kind = index % 2 === 0 ? "blocked" : "confirmed"
    const status = (["pending", "sending", "sent", "failed", "skipped"] as const)[index % 5]
    await q(sql`insert into notification_outbox (id, application_id, kind, created_at, sent_at, status, attempts, next_attempt_at, claimed_at, last_error, last_failed_at)
      values (${randomUUID()}, ${application}, ${kind}, ${t0}, ${status === "sent" ? t0 : null}, ${status}, ${index % 4}, ${status === "pending" ? "2026-10-20T09:05:00Z" : null},
        ${status === "sending" ? t0 : null}, ${status === "failed" ? "timeout" : null}, ${status === "failed" ? t0 : null})`)
  }
  // Postings with no Application: one pre-filter skip, one Match skip, one waiting during a cost pause, one failed (item 6 backfill).
  for (const [index, [status, reason, failure]] of ([["skipped", "not_software_role", null], ["skipped", "weak_core_match", null], ["waiting_to_be_checked", null, null], ["evaluation_failed", null, "provider_error"]] as const).entries()) {
    const url = `https://jobs.lever.co/acme/${index}`
    await q(sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, structured, status, skip_reason, skip_detail, evaluation_failure, role_family, discovered_at, evaluated_at, title_folded)
      values (${randomUUID()}, ${url}, ${`L-${index}`}, ${url}, 'lever', 'automatic', ${index % 2 === 0 ? "pasted_link" : "remote_board"}, 'Office Manager', 'Acme', '{}', ${status}, ${reason}, ${reason === "weak_core_match" ? "detail" : null}, ${failure},
        ${status === "waiting_to_be_checked" ? null : "other"}, ${`2026-10-19T0${index}:00:00.123456Z`}, ${status === "waiting_to_be_checked" ? null : t0}, 'office manager')`)
  }
  await q(sql`insert into ai_call (id, purpose, provider, model, status, resume_upload_id, started_at) values (${randomUUID()}, 'career_profile_extraction', 'anthropic', 'claude-haiku-5-5', 'started', ${resume}, ${t0})`)
  await q(sql`insert into submission_event (id, application_id, kind, detail, created_at) values (${randomUUID()}, null, 'pre_gate_refused', 'x', ${t0})`)
  await q(sql`insert into notification_outbox (id, application_id, kind, created_at, wat_day, status) values
    (${randomUUID()}, null, 'daily_summary', ${t0}, '2026-10-19', 'sent'),
    (${randomUUID()}, null, 'daily_summary', ${t0}, '2026-10-20', 'pending')`)
  await q(sql`insert into notification_outbox (id, application_id, kind, created_at, status, payload) values
    (${randomUUID()}, null, 'cost_pause', ${t0}, 'pending', '{"month":"2026-10-01","spentMicros":1,"ceilingMicros":2,"action":null,"estimateMicros":null,"pausedAt":"x"}')`)
  await q(sql`insert into submission_day (wat_day) values ('2026-10-19'), ('2026-10-20')`)
  await q(sql`insert into existing_application (id, company, role_title, application_url, requisition_id, applied_on, created_at) values
    (${randomUUID()}, 'Acme', 'FE', 'https://boards.greenhouse.io/acme/jobs/99', null, '2026-09-01', ${t0}),
    (${randomUUID()}, 'Acme', 'FE', 'https://boards.greenhouse.io/acme/jobs/99', 'R-99', '2026-09-02', ${t0})`)
  // EPIC-0005 (0013): the installation's verification (shared, r5 K6), a feed, a post from it and a read run.
  const feed = randomUUID()
  await q(sql`insert into alert_feed_verification (verified_on, verification_basis, updated_at) values ('2026-10-19', 'Reviewed terms.', ${t0})`)
  await q(sql`insert into alert_feed (id, url, label, created_at, last_read_at, last_failure_reason, last_failed_at)
    values (${feed}, 'https://www.google.com/alerts/feeds/01234567890123456789/9876543210987654321', 'React', ${t0}, ${t0}, 'redirected', ${t0})`)
  await q(sql`insert into stack_post (id, canonical_url, kind, title, snippet, published_at, matched_technologies, source_feed_id, first_seen_at)
    values (${randomUUID()}, 'https://www.linkedin.com/posts/ada_react-1', 'post', 'Hooks', 'Snippet', ${t0}, '{React}', ${feed}, ${t0})`)
  await q(sql`insert into stack_post_run (id, started_at, finished_at, outcome, feeds_read, posts_stored) values (${randomUUID()}, ${t0}, ${t0}, 'completed', 1, 1)`)
  // EPIC-0001 slice 9 (0015-retention): the owner's expiry runs become theirs (merge 11).
  await q(sql`insert into retention_run (id, wat_date, started_at, finished_at, outcome, due_count, deleted_count) values (${randomUUID()}, '2026-10-19', ${t0}, ${t0}, 'completed', 2, 1)`)
  // EPIC-0003 (0014): installation data (r4 seed): two requests (one hash nulled), a drop, and outbox rows of both kinds.
  const windowA = randomUUID()
  const windowB = randomUUID()
  await q(sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id, status) values
    (${windowA}, 'visitor@example.com', 'visitor@example.com', 'hi', ${t0}, ${"d".repeat(64)}, ${windowA}, 'waiting'),
    (${windowB}, 'other@example.com', 'other@example.com', '', ${t0}, null, ${windowB}, 'sent')`)
  await q(sql`insert into access_request_drop (id, ip_hash, reason, created_at) values (${randomUUID()}, ${"e".repeat(64)}, 'fill_time', ${t0})`)
  await q(sql`insert into notification_outbox (id, application_id, kind, created_at, status, access_request_window_id) values
    (${randomUUID()}, null, 'access_request', ${t0}, 'pending', ${windowA}), (${randomUUID()}, null, 'access_request', ${t0}, 'sent', ${windowB})`)
  await q(sql`insert into notification_outbox (id, application_id, kind, created_at, wat_day, status) values (${randomUUID()}, null, 'access_request_cap', ${t0}, '2026-10-19', 'sent')`)
  await q(sql`insert into dashboard_session (id_hash, csrf_token, google_sub, last_active_at) values ('h-owner', 'c', ${OWNER_SUB}, ${t0}), ('h-stranger', 'c', 'someone-else', ${t0})`)
}

/** Old column names to new ones (the architecture's column map). */
const RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  submission_day: { wat_day: "day" },
  notification_outbox: { wat_day: "local_day" },
  application: { submitted_wat_day: "submitted_local_day", queued_for_wat_day: "queued_for_local_day" },
}
const DROPPED: readonly string[] = ["singleton"]
const ADDED: Readonly<Record<string, readonly string[]>> = { application: ["submitted_local_day_zone"], job_posting: ["prefilter_skip"] }

/** Every row as text per column, keyed by its old column names, in a stable order. */
async function snapshot(db: Db, table: string, after: boolean): Promise<Record<string, string | null>[]> {
  const columns = await sql<{ column_name: string }>`
    select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table} order by column_name`.execute(db)
  const back = Object.fromEntries(Object.entries(RENAMES[table] ?? {}).map(([old, renamed]) => [renamed, old]))
  const names = columns.rows.map((row) => row.column_name).filter((name) => name !== "candidate_id" && !DROPPED.includes(name) && !(ADDED[table] ?? []).includes(name))
  const select = sql.join(names.map((name) => sql`${sql.ref(name)}::text as ${sql.id(after ? (back[name] ?? name) : name)}`))
  const { rows } = await sql<Record<string, string | null>>`select ${select} from ${sql.table(table)}`.execute(db)
  return rows.map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

const COMPARED = [...CANDIDATE_TABLES, "ai_call", "access_request", "access_request_drop", "job_posting", "control_state", "evaluation_setting", "notification_sender_state", "spend_month", "spend_entry", "alert_feed_verification"]

describe("migration 0016 on the owner's live data (AC 1)", () => {
  let db: Db
  const before = new Map<string, Record<string, string | null>[]>()

  beforeAll(async () => {
    db = await databaseAtPrevious()
    await seed(db, true)
    for (const table of COMPARED) before.set(table, await snapshot(db, table, false))
    const { error } = await migrate(db)
    if (error) throw error
  })

  it("runs after 0013-stack-posts (EPIC-0005), 0014-access-request (EPIC-0003) and 0015-retention (EPIC-0001 slice 9), with no gap (D19, K7)", async () => {
    expect(await appliedNames(db)).toContain("0016-multi-candidate")
    expect((await appliedNames(db)).at(-1)).toBe("0023-runtime-no-temporary")
    expect(Object.keys(ALL).filter((name) => name.startsWith("0014"))).toEqual(["0014-access-request"])
    expect(Object.keys(ALL).slice(-10)).toEqual(["0012-job-criteria", "0013-stack-posts", "0014-access-request", "0015-retention", "0016-multi-candidate", "0017-row-level-security", "0018-owner-preferences", "0019-candidate-posting", "0022-candidate-binding", "0023-runtime-no-temporary"])
  })

  it("creates one Candidate for the owner, the Operator, with the bound sub and no email yet", async () => {
    const { rows } = await sql<{ role: string; google_sub: string; email: string | null; state: string; onboarded: boolean }>`
      select role, google_sub, email, state, onboarded_at is not null as onboarded from candidate`.execute(db)
    expect(rows).toEqual([{ role: "operator", google_sub: OWNER_SUB, email: null, state: "active", onboarded: true }])
  })

  it.each(COMPARED)("%s: same rows, every column byte-equal through the column map", async (table) => {
    expect(await snapshot(db, table, true)).toEqual(before.get(table))
  })

  it.each([...CANDIDATE_TABLES, "ai_call"])("%s: every row belongs to the owner, with a not-null FK and a leading index", async (table) => {
    const owner = await sql<{ id: string }>`select id from candidate`.execute(db)
    // C36: the outbox's access-request rows are installation data, owned by no Candidate (checked below).
    const installation = table === "notification_outbox" ? sql`where kind not in ('access_request', 'access_request_cap')` : sql``
    const { rows } = await sql<{ n: number; owners: number }>`
      select count(*)::int as n, count(*) filter (where candidate_id = ${owner.rows[0]?.id})::int as owners from ${sql.table(table)} ${installation}`.execute(db)
    expect(rows[0]?.owners).toBe(rows[0]?.n)
    const fk = await sql<{ n: number }>`select count(*)::int as n from pg_constraint where conrelid = ${table}::regclass and contype = 'f' and conname = ${`${table}_candidate_fk`}`.execute(db)
    expect(fk.rows[0]?.n).toBe(1)
    const nullable = await sql<{ is_nullable: string }>`select is_nullable from information_schema.columns where table_name = ${table} and column_name = 'candidate_id'`.execute(db)
    // C36 (0017): the outbox's installation kinds carry no Candidate, so its column is nullable, tied to the kind.
    expect(nullable.rows[0]?.is_nullable).toBe(table === "ai_call" || table === "notification_outbox" ? "YES" : "NO")
  })

  it("C36: EPIC-0003's rows stay installation data: null Candidate on the outbox, none visible to the owner, all visible to the installation scope", async () => {
    const outbox = await sql<{ kind: string; candidate: string | null }>`select kind, candidate_id::text as candidate from notification_outbox where kind like 'access_request%' order by kind`.execute(db)
    expect(outbox.rows).toEqual([{ kind: "access_request", candidate: null }, { kind: "access_request", candidate: null }, { kind: "access_request_cap", candidate: null }])
    const owner = (await sql<{ id: string }>`select id from candidate`.execute(db)).rows[0]!.id
    // This database's connection is the bootstrap superuser, which RLS never binds: read as a plain role.
    const reader = `ja_mc_reader_${randomUUID().replaceAll("-", "").slice(0, 8)}`
    await sql`create role ${sql.id(reader)} nologin`.execute(db)
    await sql`grant select on access_request, access_request_drop, notification_outbox to ${sql.id(reader)}`.execute(db)
    const counts = async (scope: ReturnType<typeof sql>) =>
      db.transaction().execute(async (tx) => {
        await sql`set local role ${sql.id(reader)}`.execute(tx)
        await scope.execute(tx)
        const read = async (q: ReturnType<typeof sql<{ n: number }>>) => (await q.execute(tx)).rows[0]!.n
        return {
          requests: await read(sql<{ n: number }>`select count(*)::int as n from access_request`),
          drops: await read(sql<{ n: number }>`select count(*)::int as n from access_request_drop`),
          outbox: await read(sql<{ n: number }>`select count(*)::int as n from notification_outbox where kind like 'access_request%'`),
        }
      })
    expect(await counts(sql`select set_config('eve.candidate_id', ${owner}, true)`)).toEqual({ requests: 0, drops: 0, outbox: 0 })
    expect(await counts(sql`select set_config('eve.scope', 'installation', true)`)).toEqual({ requests: 2, drops: 1, outbox: 3 })
    await sql`drop owned by ${sql.id(reader)}`.execute(db)
    await sql`drop role ${sql.id(reader)}`.execute(db)
  })

  it("has a row for every slice 5 to 8 Candidate table, so the comparison covered real data", async () => {
    for (const table of CANDIDATE_TABLES) expect(before.get(table)?.length, table).toBeGreaterThan(0)
    expect(before.get("application")?.map((row) => row.submission_state).sort()).toEqual([...SUBMISSION_STATES].map((s) => s ?? null).sort())
  })

  it("keeps today's automatic count and the cap days, now keyed by Candidate and local day", async () => {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from application
      where submission_kind = 'automatic' and submission_state in ('submit_claimed', 'submitting', 'confirmed') and submitted_local_day = '2026-10-20'`.execute(db)
    expect(rows[0]?.n).toBe(before.get("application")?.filter((r) => r.submission_kind === "automatic" && ["submit_claimed", "submitting", "confirmed"].includes(r.submission_state ?? "") && r.submitted_wat_day === "2026-10-20").length)
    const zones = await sql<{ zone: string | null; n: number }>`select submitted_local_day_zone as zone, count(*)::int as n from application where submitted_local_day is not null group by 1`.execute(db)
    expect(zones.rows).toEqual([{ zone: "Africa/Lagos", n: 4 }])
    const pk = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'submission_day'::regclass and contype = 'p'`.execute(db)
    expect(pk.rows[0]?.def).toBe("PRIMARY KEY (candidate_id, day)")
  })

  it("a summary row written before migration still blocks a second summary for that day", async () => {
    await expect(sql`insert into notification_outbox (candidate_id, id, kind, created_at, local_day) values ((select id from candidate where role = 'operator'), ${randomUUID()}, 'daily_summary', now(), '2026-10-20')`.execute(db)).rejects.toThrow(/notification_outbox_summary_once/)
  })

  it("existing applications keep their URLs and still block a duplicate for the owner", async () => {
    await expect(sql`insert into existing_application (candidate_id, id, company, role_title, application_url, requisition_id, applied_on, created_at)
      values ((select id from candidate where role = 'operator'), ${randomUUID()}, 'Acme', 'FE', 'https://boards.greenhouse.io/acme/jobs/99', null, '2026-09-03', now())`.execute(db)).rejects.toThrow(/existing_application_key_idx/)
  })

  it("the owner's sessions keep working; a session for any other Google account is removed", async () => {
    const { rows } = await sql<{ id_hash: string }>`select id_hash from dashboard_session`.execute(db)
    expect(rows).toEqual([{ id_hash: "h-owner" }])
  })

  it("writes the multi_candidate marker, then each later EPIC-0002 migration's schema marker (F-CR-05)", async () => {
    const { rows } = await sql<{ name: string }>`select name from migration_marker order by name`.execute(db)
    expect(rows.map((row) => row.name)).toEqual(["0017-row-level-security", "0018-owner-preferences", "0019-candidate-posting", "0022-candidate-binding", "0023-runtime-no-temporary", "multi_candidate"])
  })

  it("re-keys every per-Candidate unique as the column map says", async () => {
    const { rows } = await sql<{ indexname: string; indexdef: string }>`select indexname, indexdef from pg_indexes where schemaname = 'public'`.execute(db)
    const def = (name: string) => rows.find((row) => row.indexname === name)?.indexdef ?? ""
    expect(def("application_requisition_key_idx")).toMatch(/\(candidate_id, application_url, requisition_id\)/)
    expect(def("approved_answer_candidate_key_idx")).toMatch(/\(candidate_id, answer_key\)/)
    expect(def("existing_application_key_idx")).toMatch(/\(candidate_id, application_url, COALESCE\(requisition_id, ''::text\)\)/)
    expect(def("notification_outbox_summary_once")).toMatch(/\(candidate_id, local_day\) WHERE \(kind = 'daily_summary'::text\)/)
    expect(def("career_profile_one_approved_idx")).toMatch(/\(candidate_id\) WHERE/)
    expect(def("resume_upload_one_drafting_idx")).toMatch(/\(candidate_id\) WHERE/)
    expect(def("notification_outbox_due")).toMatch(/\(candidate_id, created_at\)/)
    // architecture r4 column map, `outcome` row (F-CR-03): the list index leads with the Candidate.
    expect(def("outcome_application_idx")).toMatch(/\(candidate_id, application_id, created_at\)/)
  })
})

describe("migration 0016 with the gate not yet passed (AC 1, second gate seed)", () => {
  it("keeps the unpassed gate exactly", async () => {
    const db = await databaseAtPrevious()
    await seed(db, false)
    const before = await snapshot(db, "activation_state", false)
    const { error } = await migrate(db)
    expect(error).toBeUndefined()
    expect(await snapshot(db, "activation_state", true)).toEqual(before)
    expect(before).toEqual([{ automatic_enabled: "false", existing_applications_completed_at: null, gate_passed_at: null }])
  })
})

describe("migration 0016 preflight and rollback (AC 1, R2-6)", () => {
  it.each([
    ["hours cutoff 00:00", sql`update evaluation_setting set hours_cutoff = '00:00'`, /hours_cutoff/],
    ["work authorization Nigeria and Ghana", sql`update candidate_setting set work_authorization = 'Nigeria and Ghana'`, /work_authorization/],
  ])("refuses on %s, names the setting and changes nothing", async (_name, change, message) => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    await change.execute(db)
    const before = new Map<string, unknown>()
    for (const table of COMPARED) before.set(table, await snapshot(db, table, false))
    const { error } = await migrate(db)
    expect(String((error as Error | undefined)?.message ?? "")).toMatch(message)
    expect((await appliedNames(db)).at(-1)).toBe("0015-retention")
    for (const table of COMPARED) expect(await snapshot(db, table, false)).toEqual(before.get(table))
    const candidate = await sql<{ t: string | null }>`select to_regclass('public.candidate')::text as t`.execute(db)
    expect(candidate.rows[0]?.t).toBeNull()
  })

  it.each(["", "none outside Nigeria", "Nigeria", "Nigeria only", "only Nigeria", "  NIGERIA ONLY! "])("accepts work authorization %j", async (text) => {
    const db = await databaseAtPrevious()
    await sql`update candidate_setting set work_authorization = ${text}`.execute(db)
    const { error } = await migrate(db)
    expect(error).toBeUndefined()
  })

  it("refuses without the owner's Google sub when the owner has data", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    const { error } = await migrate(db, null)
    expect(String((error as Error | undefined)?.message ?? "")).toMatch(/CANDIDATE_GOOGLE_SUB/)
    expect((await appliedNames(db)).at(-1)).toBe("0015-retention")
  })

  it("refuses without the owner's Google sub when the only data is stored Job Postings (F-CR-06, PRD AC 1)", async () => {
    // 0019 gives every stored posting to the Operator as their candidate_posting; with no sub, nobody could sign in to them.
    const db = await databaseAtPrevious()
    await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, structured, status, role_family, discovered_at)
      values (${randomUUID()}, 'https://jobs.lever.co/only/1', '1', 'https://jobs.lever.co/only/1', 'lever', 'automatic', 'pasted_link', 'Frontend Engineer', 'Only', '{}', 'skipped', null, now())`.execute(db)
    const { error } = await migrate(db, null)
    expect(String((error as Error | undefined)?.message ?? "")).toMatch(/CANDIDATE_GOOGLE_SUB/)
    expect((await appliedNames(db)).at(-1)).toBe("0015-retention")
  })

  it("accepts a missing sub on an empty database (a fresh install)", async () => {
    const db = await databaseAtPrevious()
    const { error } = await migrate(db, null)
    expect(error).toBeUndefined()
  })

  it("rolls everything back when the last step fails", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    const before = new Map<string, unknown>()
    for (const table of COMPARED) before.set(table, await snapshot(db, table, false))
    // The marker table already existing makes the final step fail.
    await sql`create table migration_marker (name text primary key)`.execute(db)
    const { error } = await migrate(db)
    expect(error).toBeDefined()
    expect((await appliedNames(db)).at(-1)).toBe("0015-retention")
    for (const table of COMPARED) expect(await snapshot(db, table, false)).toEqual(before.get(table))
    const columns = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_schema = 'public' and column_name = 'candidate_id'`.execute(db)
    expect(columns.rows[0]?.n).toBe(0)
  })
})

/**
 * EPIC-0002 A1 unit 4: rollback of 0017 (RLS) on its own and of 0016 + 0017 in
 * one migrate run. A policy named like the one 0017 creates makes 0017 fail
 * partway through its loop, after earlier tables already have RLS forced.
 */
describe("migration 0017 rollback, alone and together with 0016", () => {
  const THROUGH_0016 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name < "0017"))
  const BLOCKER = sql`create policy application_candidate on application for select using (true)`

  async function rlsTables(db: Db): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and (c.relrowsecurity or c.relforcerowsecurity) order by 1`.execute(db)
    return rows.map((row) => row.name)
  }

  async function policies(db: Db): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`select polname::text as name from pg_policy order by 1`.execute(db)
    return rows.map((row) => row.name)
  }

  async function defaults(db: Db): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`
      select table_name as name from information_schema.columns
      where table_schema = 'public' and column_name = 'candidate_id' and column_default is not null order by 1`.execute(db)
    return rows.map((row) => row.name)
  }

  it("a failure inside 0017 leaves the database at 0016: no RLS, no policy, owner defaults kept, rows unchanged", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    const step = await new Migrator({ db, provider: { getMigrations: async () => THROUGH_0016 } }).migrateToLatest()
    if (step.error) throw step.error
    const defaultsBefore = await defaults(db)
    expect(defaultsBefore.length).toBeGreaterThan(0)
    const before = new Map<string, unknown>()
    for (const table of COMPARED) before.set(table, await snapshot(db, table, true))
    await BLOCKER.execute(db)

    const { error } = await migrate(db)
    expect(String((error as Error | undefined)?.message ?? "")).toMatch(/application_candidate.*already exists/)
    expect((await appliedNames(db)).at(-1)).toBe("0016-multi-candidate")
    expect(await rlsTables(db)).toEqual([])
    expect(await policies(db)).toEqual(["application_candidate"])
    expect(await defaults(db)).toEqual(defaultsBefore)
    for (const table of COMPARED) expect(await snapshot(db, table, true)).toEqual(before.get(table))

    // Roll forward once the blocker is gone.
    await sql`drop policy application_candidate on application`.execute(db)
    const retry = await migrate(db)
    expect(retry.error).toBeUndefined()
    expect((await appliedNames(db)).at(-1)).toBe("0023-runtime-no-temporary")
    expect(await defaults(db)).toEqual([])
  })

  it("a failure in 0017 during one migrate run also rolls back 0016: no candidate table, no candidate_id, rows unchanged", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    const before = new Map<string, unknown>()
    for (const table of COMPARED) before.set(table, await snapshot(db, table, false))
    await BLOCKER.execute(db)

    const { error } = await migrate(db)
    expect(error).toBeDefined()
    expect((await appliedNames(db)).at(-1)).toBe("0015-retention")
    const candidate = await sql<{ present: boolean }>`select to_regclass('public.candidate') is not null as present`.execute(db)
    expect(candidate.rows[0]?.present).toBe(false)
    const columns = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_schema = 'public' and column_name = 'candidate_id'`.execute(db)
    expect(columns.rows[0]?.n).toBe(0)
    const renamed = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_schema = 'public' and column_name like '%wat_day%'`.execute(db)
    expect(renamed.rows[0]?.n).toBeGreaterThanOrEqual(4)
    expect(await rlsTables(db)).toEqual([])
    for (const table of COMPARED) expect(await snapshot(db, table, false)).toEqual(before.get(table))
  })
})

/**
 * EPIC-0002 A1 unit 4 item 5 (architecture r2 "Migration of the owner" step 6;
 * PRD r4 AC 1 "The owner's Job Preferences are created from current values").
 * Migration 0018 writes the owner's Job Preferences version 1 and turns the
 * slice 2 provider approval into AI terms record 1 plus the owner's approval.
 */
describe("migration 0018: owner Job Preferences v1 and AI terms record", () => {
  /** Reads Candidate rows as the bootstrap superuser (RLS is forced for every role but superusers). */
  async function preferences(db: Db) {
    const { rows } = await sql<{ version: number; values: Record<string, unknown>; owner: boolean }>`
      select p.version, p.values, p.candidate_id = c.id as owner from job_preferences p join candidate c on c.role = 'operator'`.execute(db)
    return rows
  }

  it("writes version 1 for the owner from PRD AC 1, reading time zone, latest work hour and preferred pay from current settings", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    await sql`update evaluation_setting set hours_time_zone = 'Africa/Lagos', hours_cutoff = '22:30'`.execute(db)
    const { error } = await migrate(db)
    expect(error).toBeUndefined()
    const rows = await preferences(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.owner).toBe(true)
    expect(rows[0]?.version).toBe(1)
    expect(rows[0]?.values).toEqual({
      homeCountry: "NG",
      timeZone: "Africa/Lagos",
      latestWorkHour: "22:30",
      workAuthorizedCountries: ["NG"],
      remoteAccepted: true,
      relocationAccepted: true,
      sponsorshipNeededForRelocation: true,
      excludedRelocationCountries: ["OM", "TR", "JO", "LB", "TH"],
      excludedIndustries: ["adult_content", "video_games_and_gaming_platforms", "gambling", "betting"],
      payFloor: { amount: "2000.00", currency: "USD", period: "month", basis: "gross" },
      preferredPay: { amount: "3000.00", currency: "USD", period: "month", basis: "net" },
      roleFamilyTiers: { senior_frontend: 1, technical_lead: 1, fullstack: 2, product_engineering: 2, backend: 3, mobile: 3, devops_platform: 3, people_management: 3, other: 3 },
      excludedRoleFamilies: [],
      titleKeyword: null,
      seniorityLevels: "all",
      employmentTypes: ["direct", "employer_of_record", "contract"],
      dailyCap: 5,
      emphasisThemes: ["building projects from scratch to production", "accelerating team delivery", "mentoring developers"],
    })
    const history = await sql<{ version: number; same: boolean }>`
      select v.version, v.values = p.values as same from job_preferences_version v join job_preferences p using (candidate_id)`.execute(db)
    expect(history.rows).toEqual([{ version: 1, same: true }])
  })

  it("uses the PRD preferred pay (USD 5,000 net per month) when the owner saved none", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    await sql`delete from preferred_net_pay`.execute(db)
    expect((await migrate(db)).error).toBeUndefined()
    expect((await preferences(db))[0]?.values.preferredPay).toEqual({ amount: "5000.00", currency: "USD", period: "month", basis: "net" })
  })

  it("turns the provider approval into AI terms record 1 (shared) and the owner's approval of it", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    expect((await migrate(db)).error).toBeUndefined()
    const terms = await sql`select version, provider, terms_checked_on::text as checked, training_line, retention_line, whats_sent_line, recorded_at::text as recorded from ai_terms_record`.execute(db)
    expect(terms.rows).toEqual([{ version: 1, provider: "anthropic", checked: "2026-10-01", training_line: "No training on API data.", retention_line: "Deleted after 30 days.", whats_sent_line: "Resume text and posting text.", recorded: "2026-10-20 08:00:00+00" }])
    const approvals = await sql`select a.terms_version, a.approved_at::text as approved, a.candidate_id = c.id as owner from ai_terms_approval a join candidate c on c.role = 'operator'`.execute(db)
    expect(approvals.rows).toEqual([{ terms_version: 1, approved: "2026-10-20 08:00:00+00", owner: true }])
    // The slice 2 row stays until the code reads ai_terms_record (slice C).
    const old = await sql<{ n: number }>`select count(*)::int as n from ai_provider_approval`.execute(db)
    expect(old.rows[0]?.n).toBe(1)
  })

  it("writes no terms record and no approval when the owner never approved a provider", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    await sql`delete from ai_provider_approval`.execute(db)
    expect((await migrate(db)).error).toBeUndefined()
    const n = await sql<{ records: number; approvals: number }>`select (select count(*)::int from ai_terms_record) as records, (select count(*)::int from ai_terms_approval) as approvals`.execute(db)
    expect(n.rows[0]).toEqual({ records: 0, approvals: 0 })
  })

  it("forces RLS on the new Candidate tables and leaves no candidate_id default", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    expect((await migrate(db)).error).toBeUndefined()
    const { rows } = await sql<{ name: string; forced: boolean; policies: string[] }>`
      select c.relname as name, c.relforcerowsecurity as forced, array_agg(p.polname::text order by p.polname)::text[] as policies
      from pg_class c join pg_policy p on p.polrelid = c.oid
      where c.relname in ('job_preferences', 'job_preferences_version', 'ai_terms_approval') group by 1, 2 order by 1`.execute(db)
    expect(rows).toEqual([
      { name: "ai_terms_approval", forced: true, policies: ["ai_terms_approval_candidate"] },
      { name: "job_preferences", forced: true, policies: ["job_preferences_candidate"] },
      { name: "job_preferences_version", forced: true, policies: ["job_preferences_version_candidate"] },
    ])
    const terms = await sql<{ rls: boolean }>`select relrowsecurity as rls from pg_class where relname = 'ai_terms_record'`.execute(db)
    expect(terms.rows[0]?.rls).toBe(false)
  })
})

/**
 * EPIC-0002 A1 item 6 (architecture r2 "Shared posting split", r4 step 5).
 * Migration 0019 copies each posting's per-Candidate state to the owner's
 * `candidate_posting` row, byte-equal, records the pre-filter skip as a shared
 * fact, and rolls back whole when any step fails.
 */
describe("migration 0019: job_posting / candidate_posting split", () => {
  const PER_CANDIDATE = ["origin", "status", "skip_reason", "skip_detail", "evaluation_failure", "discovered_at", "evaluated_at"]
  const THROUGH_0018 = Object.fromEntries(Object.entries(ALL).filter(([name]) => name < "0019"))

  async function postingState(db: Db, table: "job_posting" | "candidate_posting"): Promise<Record<string, string | null>[]> {
    const id = table === "job_posting" ? sql.ref("id") : sql.ref("job_posting_id")
    const columns = sql.join(PER_CANDIDATE.map((name) => sql`${sql.ref(name)}::text as ${sql.id(name)}`))
    const { rows } = await sql<Record<string, string | null>>`select ${id}::text as id, ${columns} from ${sql.table(table)} order by 1`.execute(db)
    return rows
  }

  async function databaseAt0017(): Promise<Db> {
    const db = await databaseAtPrevious()
    await seed(db, true)
    const { error } = await new Migrator({ db, provider: { getMigrations: async () => THROUGH_0018 } }).migrateToLatest()
    if (error) throw error
    return db
  }

  it("copies every posting's state to the owner's candidate_posting row, byte-equal", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    const before = await postingState(db, "job_posting")
    expect(new Set(before.map((row) => row.status))).toEqual(new Set(["ranked", "skipped", "waiting_to_be_checked", "evaluation_failed"]))
    expect((await migrate(db)).error).toBeUndefined()
    expect(await postingState(db, "candidate_posting")).toEqual(before)
    const owners = await sql<{ n: number; owned: number }>`
      select count(*)::int as n, count(*) filter (where cp.candidate_id = c.id)::int as owned from candidate_posting cp join candidate c on c.role = 'operator'`.execute(db)
    expect(owners.rows[0]).toEqual({ n: before.length, owned: before.length })
    // The old columns keep their values for one release; no code writes them.
    expect(await postingState(db, "job_posting")).toEqual(before)
  })

  it("records the pre-filter skip on job_posting.prefilter_skip, only for not_software_role skips", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    expect((await migrate(db)).error).toBeUndefined()
    const { rows } = await sql<{ status: string; skip_reason: string | null; prefilter_skip: string | null }>`
      select status, skip_reason, prefilter_skip from job_posting where prefilter_skip is not null or skip_reason is not null`.execute(db)
    expect(rows.sort((a, b) => String(a.skip_reason).localeCompare(String(b.skip_reason)))).toEqual([
      { status: "skipped", skip_reason: "not_software_role", prefilter_skip: "not_software_role" },
      { status: "skipped", skip_reason: "weak_core_match", prefilter_skip: null },
    ])
  })

  it("re-keys Eligibility and Match evidence to candidate_posting, and a held posting cannot be deleted", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    expect((await migrate(db)).error).toBeUndefined()
    const { rows } = await sql<{ conname: string; def: string }>`
      select conname::text, pg_get_constraintdef(oid) as def from pg_constraint where conname like '%candidate_posting_fk' order by 1`.execute(db)
    expect(rows).toEqual([
      { conname: "eligibility_result_candidate_posting_fk", def: "FOREIGN KEY (candidate_id, job_posting_id) REFERENCES candidate_posting(candidate_id, job_posting_id) ON DELETE CASCADE" },
      { conname: "match_evidence_candidate_posting_fk", def: "FOREIGN KEY (candidate_id, job_posting_id) REFERENCES candidate_posting(candidate_id, job_posting_id) ON DELETE CASCADE" },
    ])
    await expect(sql`delete from job_posting where application_url = 'https://jobs.lever.co/acme/0'`.execute(db)).rejects.toThrow(/candidate_posting_job_posting_id_fkey/)
  })

  it("a held posting cannot be deleted while a Candidate's candidate_posting row references it", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    expect((await migrate(db)).error).toBeUndefined()
    await expect(sql`delete from job_posting where application_url = 'https://jobs.lever.co/acme/0'`.execute(db)).rejects.toThrow(/candidate_posting_job_posting_id_fkey/)
  })

  it("forces RLS on candidate_posting with candidate_posting_candidate and leaves job_posting shared", async () => {
    const db = await databaseAtPrevious()
    await seed(db, true)
    expect((await migrate(db)).error).toBeUndefined()
    const { rows } = await sql<{ name: string; rls: boolean; forced: boolean; policies: string[] | null }>`
      select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select array_agg(p.polname::text order by p.polname)::text[] from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c where c.relname in ('candidate_posting', 'job_posting') order by 1`.execute(db)
    expect(rows).toEqual([
      { name: "candidate_posting", rls: true, forced: true, policies: ["candidate_posting_candidate"] },
      { name: "job_posting", rls: false, forced: false, policies: null },
    ])
  })

  it("a failure inside 0019 leaves the database at 0018: no candidate_posting, no prefilter_skip, status still required, rows unchanged", async () => {
    const db = await databaseAt0017()
    const before = await snapshot(db, "job_posting", false)
    // A name clash on the last index makes 0019 fail after its backfill.
    await sql`create index candidate_posting_status_newest_idx on job_posting (title)`.execute(db)

    const { error } = await migrate(db)
    expect(String((error as Error | undefined)?.message ?? "")).toMatch(/candidate_posting_status_newest_idx.*already exists/)
    expect((await appliedNames(db)).at(-1)).toBe("0018-owner-preferences")
    const state = await sql<{ table: boolean; column: number; nullable: string; fks: number }>`
      select to_regclass('public.candidate_posting') is not null as table,
        (select count(*)::int from information_schema.columns where table_name = 'job_posting' and column_name = 'prefilter_skip') as column,
        (select is_nullable from information_schema.columns where table_name = 'job_posting' and column_name = 'status') as nullable,
        (select count(*)::int from pg_constraint where conname like '%candidate_posting%') as fks`.execute(db)
    expect(state.rows[0]).toEqual({ table: false, column: 0, nullable: "NO", fks: 0 })
    expect(await snapshot(db, "job_posting", false)).toEqual(before)

    await sql`drop index candidate_posting_status_newest_idx`.execute(db)
    expect((await migrate(db)).error).toBeUndefined()
    expect((await appliedNames(db)).at(-1)).toBe("0023-runtime-no-temporary")
  })
})
