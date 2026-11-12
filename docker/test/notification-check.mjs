// Slice 6 notifications compose check (F-QA6-00, F-QA6-01). Runs after the worker
// passed notification-failclosed.mjs and started with throwaway Gmail settings
// that point (through the smtp.gmail.com DNS alias) at mailpit. Seeds one
// Confirmed automatic Application (plus an in-flight and an Uncertain one the same
// WAT day) and one Blocked Application, each with its outbox row, waits for the
// worker's sender, and checks what mailpit received over TLS with SMTP AUTH.
// Prints one JSON line per check and exits non-zero if any fails. Test database only.
import { randomUUID } from "node:crypto"

import pg from "pg"

const MAILPIT = "http://mailpit:8025/api/v1"
const PASSWORD = process.env.NOTIFY_TEST_APP_PASSWORD ?? ""
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
// EPIC-0002 A1: every Candidate table forces RLS (migration 0017) and names its
// Candidate on every write. This dedicated, unpooled client scopes itself to the
// Operator for its whole session, as TenantDatabase.forCandidate does per
// transaction in the app; the shared tables (job_posting, control_state) are unaffected.
const OPERATOR_ID = (await db.query("select id from candidate where role = 'operator'")).rows[0]?.id
if (!OPERATOR_ID) throw new Error("No Operator: run the migrate step first")
await db.query("select set_config('eve.candidate_id', $1, false)", [OPERATOR_ID])
let failed = 0
const check = (name, ok, detail = {}) => {
  if (!ok) failed += 1
  process.stdout.write(JSON.stringify({ check: name, ok, ...detail }) + "\n")
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())

async function application(company, extra) {
  const postingId = randomUUID()
  const id = randomUUID()
  const url = `https://boards.greenhouse.fixture.test/${company.toLowerCase().replace(/\W+/g, "")}/jobs/${id.slice(0, 8)}`
  await db.query(
    `insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, posting_text, role_family, discovered_at)
     values ($1, $2, $3, $2, 'greenhouse', 'automatic', 'employer_board', 'Senior Frontend Engineer', $4, 'Remote, open to Nigeria.', 'senior_frontend', now())`,
    [postingId, url, `R-${id.slice(0, 6)}`, company]
  )
  // EPIC-0002 A1 item 6: the owner's own state for the shared posting.
  await db.query(
    `insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at, evaluated_at)
     values ($2, $1, 'employer_board', 'ranked', now(), now())`,
    [postingId, OPERATOR_ID]
  )
  const columns = Object.keys(extra)
  await db.query(
    `insert into application (candidate_id, id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at, ${columns.join(", ")})
     values ($6, $1, $2, $3, $4, $5, 'Senior Frontend Engineer', 'documents_ready', 1, now(), now(), ${columns.map((_, i) => `$${i + 7}`).join(", ")})`,
    [id, postingId, url, `R-${id.slice(0, 6)}`, company, OPERATOR_ID, ...Object.values(extra)]
  )
  return id
}
const submitted = { submission_kind: "automatic", submitted_local_day: day, submit_clicked_at: new Date() }

const confirmedId = await application("Confirmed Co", { ...submitted, submission_state: "confirmed", confirmed_at: new Date(), evidence_kind: "confirmation_page" })
await application("In Flight Co", { ...submitted, submission_state: "submitting" })
await application("Unsure Co", { ...submitted, submission_state: "uncertain" })
const blockedId = await application("Blocked Co", { submission_kind: "automatic", submission_state: "blocked", blocked_reason: "login", blocked_at: new Date() })
for (const [applicationId, kind] of [[confirmedId, "confirmed"], [blockedId, "blocked"]]) {
  await db.query("insert into notification_outbox (candidate_id, id, application_id, kind, created_at, sent_at) values ($4, $1, $2, $3, now(), null)", [randomUUID(), applicationId, kind, OPERATOR_ID])
}

// The sender runs every minute (pg-boss cron); allow two and a half cycles.
let rows = []
for (let i = 0; i < 75; i += 1) {
  rows = (await db.query("select kind, status, attempts, last_error from notification_outbox where application_id = any($1) order by kind", [[confirmedId, blockedId]])).rows
  if (rows.length === 2 && rows.every((row) => row.status !== "pending" && row.status !== "sending")) break
  await sleep(2_000)
}
check("outbox_rows_sent", rows.length === 2 && rows.every((row) => row.status === "sent" && row.attempts === 1), { rows })

const list = await fetch(`${MAILPIT}/messages`).then((r) => r.json())
const messages = list.messages ?? []
check("mailpit_received_two", messages.length === 2, { subjects: messages.map((m) => m.Subject) })
const bySubject = (prefix) => messages.find((m) => m.Subject.startsWith(prefix))
const confirmed = bySubject("Applied:")
const blocked = bySubject("Needs you:")
check("confirmed_email_received", Boolean(confirmed), { subject: confirmed?.Subject })
check("blocked_email_received", Boolean(blocked), { subject: blocked?.Subject })

for (const [label, summary] of [["confirmed", confirmed], ["blocked", blocked]]) {
  if (!summary) continue
  const raw = await fetch(`${MAILPIT}/message/${summary.ID}/raw`).then((r) => r.text())
  const full = await fetch(`${MAILPIT}/message/${summary.ID}`).then((r) => r.json())
  check(`${label}_from_and_to`, full.From?.Address === "notify-test-sender@example.test" && full.To?.[0]?.Address === "notify-test-sender@example.test", { from: full.From, to: full.To })
  check(`${label}_links_dashboard_only`, (full.Text ?? "").includes("https://dashboard.test/applications/") && !/Content-Disposition: attachment/i.test(raw))
  check(`${label}_no_app_password`, PASSWORD.length > 0 && !raw.includes(PASSWORD))
  if (label === "confirmed") {
    // F-QA6-01: one Confirmed today; the submitting and Uncertain ones don't count.
    check("confirmed_counts_only_confirmed", (full.Text ?? "").includes("Automatic submissions today: 1 of 5."), { line: (full.Text ?? "").split("\n").find((l) => l.startsWith("Automatic submissions")) })
  }
}

await db.end()
process.exit(failed === 0 ? 0 : 1)
