// Slice 5 compose gate check (F-QA5-01). Runs after submission-check.mjs, with
// the real api and worker containers up and the worker's browser enabled.
// Approves five Activation Gate samples through the api's HTTP routes as the
// signed-in Candidate, polls GET /v1/applications/{id}/submission as the
// dashboard does, and checks that the worker submitted each one to the fake ATS
// and that the gate passed at the fifth. Prints one JSON line per check and
// exits non-zero if any check fails. Test database only.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { request } from "node:http"

import pg from "pg"

const API = "http://api:3000"
const DOCUMENTS = "/data/documents"
const ALLOWLIST = "/data/egress/allowlist.txt"
const CANDIDATE_SUB = process.env.CANDIDATE_GOOGLE_SUB
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
// EPIC-0002 A1: every Candidate table forces RLS (migration 0017) and names its
// Candidate on every write. This dedicated, unpooled client scopes itself to the
// Operator for its whole session, as TenantDatabase.forCandidate does per
// transaction in the app; the shared tables (job_posting, control_state) are unaffected.
const OPERATOR_ID = (await db.query("select id from candidate where role = 'operator'")).rows[0]?.id
if (!OPERATOR_ID) throw new Error("No Operator: run the migrate step first")
await db.query("select set_config('eve.candidate_id', $1, false)", [OPERATOR_ID])
const results = []
const check = (name, ok, detail = {}) => {
  results.push(ok)
  process.stdout.write(JSON.stringify({ check: name, ok, ...detail }) + "\n")
}

// The gate starts un-passed in this test database only; the career profile is approved and existing applications are complete.
await db.query("update activation_state set gate_passed_at = null, automatic_enabled = false, existing_applications_completed_at = now()")
await db.query("update control_state set global_paused = false, cost_paused = false")
await db.query(`insert into career_profile_version (candidate_id, version, status, source, resume_upload_id, sections, created_at, approved_at)
  values ($1, 1, 'approved', 'edit', null, '[]', now(), now()) on conflict do nothing`, [OPERATOR_ID])

// The fixture Greenhouse host publishes no question schema, and a saved work
// answer fills only a schema-matched field (late 705dede review), so the sample
// pages are the "plain" variant with no work question. The saved answer stays
// to show it is never used on a page-read field.
const SPONSOR_Q = "Will you now or in the future require sponsorship for employment visa status?"
await db.query(
  `insert into approved_answer (candidate_id, id, answer_group, topic, skill, question, answer_key, value, created_at, updated_at)
   values ($4, $1, 'custom', null, null, $2, $3, 'Yes', now(), now()) on conflict (candidate_id, answer_key) do nothing`,
  [randomUUID(), SPONSOR_Q, `custom:${SPONSOR_Q.toLowerCase()}`, OPERATOR_ID]
)

// A dashboard session as sign-in would create it: the cookie carries the token, the database only its hash.
const token = randomBytes(32).toString("base64url")
const csrf = randomBytes(32).toString("base64url")
await db.query(
  "insert into dashboard_session (id_hash, csrf_token, google_sub, last_active_at, candidate_id) values ($1, $2, $3, now(), (select id from candidate where google_sub = $3))",
  [createHash("sha256").update(token).digest("hex"), csrf, CANDIDATE_SUB]
)
const headers = { cookie: `__Host-ja_session=${token}`, "x-csrf-token": csrf }
const api = async (method, path) => {
  const response = await fetch(`${API}${path}`, { method, headers, signal: AbortSignal.timeout(15_000) })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function sampleApplication(company) {
  const postingId = randomUUID()
  const id = randomUUID()
  const url = `http://boards.greenhouse.fixture.test/${company}/jobs/plain`
  await db.query(
    `insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, company, posting_text, role_family, discovered_at)
     values ($1, $2, $3, $2, 'greenhouse', 'automatic', 'employer_board', 'Senior Frontend Engineer', $4, 'Remote, open to Nigeria.', 'senior_frontend', now())`,
    [postingId, url, `R-${company}`, company]
  )
  // EPIC-0002 A1 item 6: the owner's own state for the shared posting.
  await db.query(
    `insert into candidate_posting (candidate_id, job_posting_id, origin, status, discovered_at, evaluated_at)
     values ($2, $1, 'employer_board', 'ranked', now(), now())`,
    [postingId, OPERATOR_ID]
  )
  await db.query(
    `insert into application (candidate_id, id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at)
     values ($6, $1, $2, $3, $4, $5, 'Senior Frontend Engineer', 'documents_ready', 1, now(), now())`,
    [id, postingId, url, `R-${company}`, company, OPERATOR_ID]
  )
  for (const kind of ["resume", "cover_letter"]) {
    const name = `${kind}-${id}.pdf`
    await writeFile(`${DOCUMENTS}/${name}`, "%PDF-1.4 fixture", { mode: 0o644 })
    await db.query(
      `insert into tailored_document (candidate_id, id, application_id, kind, career_profile_version, content, pdf_storage_name, docx_storage_name, pdf_sha256, docx_sha256, created_at)
       values ($6, $1, $2, $3, 1, '{}', $4, $5, 'x', 'x', now())`,
      [randomUUID(), id, kind, name, `${kind}-${id}.docx`, OPERATOR_ID]
    )
  }
  return id
}

const TERMINAL = new Set(["confirmed", "uncertain", "blocked", "not_submitted", "manual", "declined"])
/** Polls the Submission as the dashboard does until the worker settles the sample. */
async function settled(id) {
  const end = Date.now() + 120_000
  for (;;) {
    const { body } = await api("GET", `/v1/applications/${id}/submission`)
    if (body && (TERMINAL.has(body.state) || (body.state === null && body.sample?.state === "awaiting_review"))) return body
    if (Date.now() > end) return body
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

const companies = ["gate-a", "gate-b", "gate-c", "gate-d", "gate-e"]
// submission-check.mjs already made automatic submissions today; samples must not add to that count.
const todayBefore = (await api("GET", "/v1/submission/status")).body?.todayCount
for (const [index, company] of companies.entries()) {
  const id = await sampleApplication(company)
  const made = await api("POST", `/v1/applications/${id}/sample`)
  const approval = await api("POST", `/v1/applications/${id}/sample/approve`)
  const submission = await settled(id)
  const status = (await api("GET", "/v1/submission/status")).body
  const gateOk = index < 4 ? status?.gatePassedAt === null : typeof status?.gatePassedAt === "string"
  check(`http_approval_${index + 1}_submitted_by_worker`, made.status === 200 && approval.status === 200 && approval.body?.result === "pending" && submission?.state === "confirmed" && status?.countingSamples === index + 1 && status?.todayCount === todayBefore && gateOk, {
    approval: approval.body,
    state: submission?.state,
    evidence: submission?.evidence?.kind ?? null,
    countingSamples: status?.countingSamples,
    todayCount: status?.todayCount,
    todayBefore,
    gatePassedAt: status?.gatePassedAt,
  })
}

// Exactly one POST per approved sample reached the fake ATS.
await writeFile(ALLOWLIST, "boards.greenhouse.fixture.test\n")
const log = await new Promise((resolve) => {
  const req = request({ host: "egress", port: 3128, method: "GET", path: "http://boards.greenhouse.fixture.test/__log", headers: { host: "boards.greenhouse.fixture.test" }, timeout: 10_000 }, (res) => {
    let text = ""
    res.on("data", (chunk) => (text += chunk))
    res.on("end", () => resolve(res.statusCode === 200 ? text : null))
  })
  req.on("error", () => resolve(null))
  req.end()
})
await writeFile(ALLOWLIST, "")
const posts = (log ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === "submission" && entry.company.startsWith("gate-")).map((entry) => entry.company).sort()
check("fake_ats_received_one_post_per_approved_sample", JSON.stringify(posts) === JSON.stringify(companies), { posts })

await db.end()
const failed = results.filter((ok) => !ok).length
process.stdout.write(JSON.stringify({ summary: true, checks: results.length, failed }) + "\n")
process.exit(failed === 0 ? 0 : 1)
