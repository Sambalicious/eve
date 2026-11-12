// Slice 5 compose browser check (project ja-s05-backend). Runs inside the api
// image on the compose network: real Postgres, the real SubmissionService, the
// pinned Playwright MCP browser, the Squid egress proxy and the fake ATS
// fixture server. No real employer host and no model provider are reachable
// (egress-out is internal, ANTHROPIC_API_KEY is empty). Prints one JSON line per
// check and exits non-zero if any check fails.
import "reflect-metadata"

import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { request } from "node:http"

import { Module } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"

import { anthropicConfig } from "/app/dist/config/env.js"
import { ConfigModule } from "/app/dist/config/config.module.js"
import { DatabaseModule } from "/app/dist/db/database.module.js"
import { TenantDatabase } from "/app/dist/db/tenant-database.js"
import { ClockModule } from "/app/dist/shared/clock.js"
import { SubmissionWorkerModule } from "/app/dist/submission/submission.module.js"
import { SubmissionService } from "/app/dist/submission/submission.service.js"

const DOCUMENTS = "/tmp/documents"
const ALLOWLIST = "/data/egress/allowlist.txt"
const browser = {
  mcpUrl: "http://browser:8931/mcp",
  uploadDir: "/data/uploads",
  uploadDirInBrowser: "/home/node/uploads",
  allowlistFile: ALLOWLIST,
  reviewedHostsFile: null,
}

class CheckModule {}
Module({})(CheckModule)

// Scope 05d: the fake Greenhouse question API, read by backend code outside the
// browser. Every Greenhouse fixture form's sponsorship select is in it; the
// work_auth select only on tamper-* pages, whose rendered label says
// "...Nigeria and Togo?" while the schema asks the question below. trick-*
// pages have no schema match, so their work question blocks.
const SPONSOR_Q = "Will you now or in the future require sponsorship for employment visa status?"
const NIGERIA_Q = "Are you legally authorized to work in Nigeria?"
const SCHEMA_WORK_AUTH = { "tamper-c7c": NIGERIA_Q, "tamper-e7b": "Are you legally authorized to work in the United States?", "tamper-e3e": NIGERIA_Q, "tamper-e8a": NIGERIA_Q, "tamper-rename": NIGERIA_Q }
const questionSchemas = {
  forPosting: async ({ applicationSystem, applyUrl }) => {
    if (applicationSystem !== "greenhouse") return null
    const variant = new URL(applyUrl).pathname.split("/")[3] ?? ""
    const schema = [{ text: SPONSOR_Q, fieldName: "sponsor", options: ["Yes", "No"] }]
    if (SCHEMA_WORK_AUTH[variant]) schema.push({ text: SCHEMA_WORK_AUTH[variant], fieldName: "work_auth", options: ["Yes", "No"] })
    return schema
  },
}

const app = await NestFactory.createApplicationContext(
  {
    module: CheckModule,
    imports: [
      ConfigModule.forRoot({ databaseUrl: process.env.DATABASE_URL, anthropic: anthropicConfig(undefined, "claude-haiku-5-5"), documentStorageDir: DOCUMENTS, formAgentEnabled: false }),
      ClockModule,
      DatabaseModule,
      SubmissionWorkerModule.forRoot(browser, { questionSchemas }),
    ],
  },
  { logger: ["error", "warn"] }
)
// EPIC-0002 A1: every Candidate table forces RLS (migration 0017). Fixtures and
// reads run in an Operator-scoped transaction (TenantDatabase.forCandidate) and
// name candidate_id; the service runs in the Operator's scope, as the worker's
// Operator-only submission job does.
const tenant = app.get(TenantDatabase)
const OPERATOR_ID = await tenant.operatorId()
const asOperator = (work) => tenant.forCandidate(OPERATOR_ID, work)
const service = app.get(SubmissionService)
const results = []
const check = (name, ok, detail = {}) => {
  results.push(ok)
  process.stdout.write(JSON.stringify({ check: name, ok, ...detail }) + "\n")
}

await asOperator(async (db) => {
  await db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada.fixture@example.test", "+234 800 000 0000"]) }).where("candidate_id", "=", OPERATOR_ID).execute()
  await db.updateTable("activation_state").set({ gate_passed_at: new Date(), automatic_enabled: true, existing_applications_completed_at: new Date() }).where("candidate_id", "=", OPERATOR_ID).execute()
})
// Lever and Ashby publish no schema. Late 705dede review: these saved work answers never fill their page-read questions;
// Lever/Ashby pages carry a sponsorship question only in the sponsor-answered and work-auth variants.
const approve = (question, value) =>
  asOperator((db) => db.insertInto("approved_answer").values({ candidate_id: OPERATOR_ID, id: randomUUID(), answer_group: "custom", topic: null, skill: null, question, answer_key: `custom:${question.toLowerCase()}`, value, created_at: new Date(), updated_at: new Date() }).onConflict((oc) => oc.columns(["candidate_id", "answer_key"]).doNothing()).execute())
await approve(SPONSOR_Q, "Yes")
await approve("Will you now or in the future require visa sponsorship?", "Yes")

async function queuedApplication(system, host, company, variant) {
  const postingId = randomUUID()
  const id = randomUUID()
  const url = `http://${host}/${company}/jobs/${variant}`
  await asOperator(async (db) => {
    await db
      .insertInto("job_posting")
      .values({ id: postingId, application_url: url, requisition_id: `R-${variant}`, apply_url: url, application_system: system, apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Senior Frontend Engineer", company, posting_text: "Remote, open to Nigeria.", role_family: "senior_frontend", discovered_at: new Date() })
      .execute()
    // EPIC-0002 A1 item 6: the owner's own state for the shared posting.
    await db
      .insertInto("candidate_posting")
      .values({ candidate_id: OPERATOR_ID, job_posting_id: postingId, origin: "employer_board", status: "ranked", discovered_at: new Date(), evaluated_at: new Date() })
      .execute()
    await db
      .insertInto("application")
      .values({ candidate_id: OPERATOR_ID, id, job_posting_id: postingId, application_url: url, requisition_id: `R-${variant}`, company, role_title: "Senior Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date(), submission_state: "queued", submission_kind: "automatic" })
      .execute()
    for (const kind of ["resume", "cover_letter"]) {
      const name = `${kind}-${id}.pdf`
      await writeFile(`${DOCUMENTS}/${name}`, "%PDF-1.4 fixture", { mode: 0o644 })
      await db.insertInto("tailored_document").values({ candidate_id: OPERATOR_ID, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: "{}", pdf_storage_name: name, docx_storage_name: `${kind}-${id}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: new Date() }).execute()
    }
  })
  return id
}

const row = (id) => asOperator((db) => db.selectFrom("application").selectAll().where("candidate_id", "=", OPERATOR_ID).where("id", "=", id).executeTakeFirstOrThrow())
const events = (id) => asOperator((db) => db.selectFrom("submission_event").select(["kind", "detail"]).where("candidate_id", "=", OPERATOR_ID).where("application_id", "=", id).execute())

const scenarios = [
  { name: "greenhouse_confirmed", system: "greenhouse", host: "boards.greenhouse.fixture.test", company: "acme", variant: "confirmed", expect: { result: "confirmed", state: "confirmed", evidence_kind: "confirmation_page", cover_letter_status: "no_field" } },
  { name: "lever_confirmed_cover_letter_application_id", system: "lever", host: "jobs.lever.fixture.test", company: "globex", variant: "cover-letter", expect: { result: "confirmed", state: "confirmed", evidence_kind: "application_id", evidence_text: "LV-48213", cover_letter_status: "uploaded" } },
  { name: "ashby_uncertain_no_confirmation", system: "ashby", host: "jobs.ashbyhq.fixture.test", company: "initech", variant: "no-confirmation", expect: { result: "uncertain", state: "uncertain" } },
  { name: "greenhouse_uncertain_validation_error_rerender", system: "greenhouse", host: "boards.greenhouse.fixture.test", company: "cyberdyne", variant: "validation-error", expect: { result: "uncertain", state: "uncertain", evidence_kind: null } },
  { name: "greenhouse_blocked_login", system: "greenhouse", host: "boards.greenhouse.fixture.test", company: "umbrella", variant: "login", expect: { result: "blocked", state: "blocked", blocked_reason: "login" } },
  { name: "ashby_blocked_captcha", system: "ashby", host: "jobs.ashbyhq.fixture.test", company: "hooli", variant: "captcha", expect: { result: "blocked", state: "blocked", blocked_reason: "captcha" } },
  { name: "greenhouse_blocked_assessment", system: "greenhouse", host: "boards.greenhouse.fixture.test", company: "stark", variant: "assessment", expect: { result: "blocked", state: "blocked", blocked_reason: "assessment" } },
  { name: "ashby_blocked_declaration", system: "ashby", host: "jobs.ashbyhq.fixture.test", company: "wayne", variant: "declaration", expect: { result: "blocked", state: "blocked", blocked_reason: "declaration" } },
  { name: "lever_blocked_personal_data", system: "lever", host: "jobs.lever.fixture.test", company: "tyrell", variant: "personal-data", expect: { result: "blocked", state: "blocked", blocked_reason: "personal_data_request" } },
  // Scope 05d (was: answers Yes): Lever publishes no schema, so a pure-Nigeria page question blocks until the Candidate approves an answer.
  { name: "lever_nigeria_only_authorization_blocks_without_approved_answer", system: "lever", host: "jobs.lever.fixture.test", company: "soylent", variant: "nigeria-only", expect: { result: "blocked", state: "blocked", blocked_reason: "missing_approved_answer", blocked_question: null, detail_contains: "complete this one manually" } },
  { name: "ashby_nigeria_only_authorization_blocks_without_approved_answer", system: "ashby", host: "jobs.ashbyhq.fixture.test", company: "contoso", variant: "nigeria-only", expect: { result: "blocked", state: "blocked", blocked_reason: "missing_approved_answer", blocked_question: null, detail_contains: "complete this one manually" } },
  // Late 705dede review (was: filled from the exact Approved Answer): a saved work answer fills only a Greenhouse schema question,
  // so Lever's page-read Nigeria question blocks for the Candidate to complete manually, with 0 POSTs.
  { name: "lever_nigeria_only_saved_answer_blocks_for_manual", before: () => approve(NIGERIA_Q, "Yes"), system: "lever", host: "jobs.lever.fixture.test", company: "soylent2", variant: "nigeria-only-answered", expect: { result: "blocked", state: "blocked", blocked_reason: "missing_approved_answer", blocked_question: null, detail_contains: "complete this one manually" } },
  { name: "lever_sponsorship_saved_answer_blocks_for_manual", system: "lever", host: "jobs.lever.fixture.test", company: "sponsorco", variant: "sponsor-answered", expect: { result: "blocked", state: "blocked", blocked_reason: "missing_approved_answer", blocked_question: null, detail_contains: "complete this one manually" } },
  { name: "ashby_sponsorship_saved_answer_blocks_for_manual", system: "ashby", host: "jobs.ashbyhq.fixture.test", company: "sponsorco2", variant: "sponsor-answered", expect: { result: "blocked", state: "blocked", blocked_reason: "missing_approved_answer", blocked_question: null, detail_contains: "complete this one manually" } },
  // Scope 05d: Greenhouse tamper pages answer from the fetched schema, never the rendered label; a renamed field aborts (SEC-514).
  ...["c7c", "e7b", "e3e", "e8a"].map((trick) => ({
    name: `greenhouse_tamper_${trick}_answers_from_schema`,
    system: "greenhouse",
    host: "boards.greenhouse.fixture.test",
    company: `tamper-${trick}`,
    variant: `tamper-${trick}`,
    expect: { result: "confirmed", state: "confirmed" },
  })),
  { name: "greenhouse_tamper_rename_after_fill_aborts_before_click", system: "greenhouse", host: "boards.greenhouse.fixture.test", company: "tamper-rename", variant: "tamper-rename", expect: { result: "blocked", state: "blocked", blocked_reason: "automation_incomplete", blocked_sub_reason: "value_mismatch" } },
  { name: "lever_nigeria_togo_authorization_blocks", system: "lever", host: "jobs.lever.fixture.test", company: "massive", variant: "nigeria-togo", expect: { result: "blocked", state: "blocked", blocked_reason: "missing_approved_answer" } },
  // SEC-513: one hostile-label page per technique; each must block before any click.
  ...["aria-hidden", "hidden-attr", "role-button", "unstyled-button", "readonly-input", "pseudo-after", "closed-shadow", "offscreen-labelledby", "aria-label", "nested-select", "role-option", "readonly-textarea"].map((trick) => ({
    name: `greenhouse_sec513_${trick.replace(/-/g, "_")}_blocks`,
    system: "greenhouse",
    host: "boards.greenhouse.fixture.test",
    company: `trick-${trick}`,
    variant: `trick-${trick}`,
    expect: { result: "blocked", state: "blocked", blocked_reason: "missing_approved_answer" },
  })),
  { name: "lever_injected_instruction", system: "lever", host: "jobs.lever.fixture.test", company: "vandelay", variant: "injected", expect: { result: "blocked", state: "blocked", blocked_reason: "missing_approved_answer" } },
]

for (const scenario of scenarios) {
  // Test database only: earlier Confirmed attempts move to a past WAT day so the daily cap of 5 never refuses a scenario.
  await asOperator((db) => db.updateTable("application").set({ submitted_local_day: "2000-01-01" }).where("candidate_id", "=", OPERATOR_ID).where("submission_kind", "=", "automatic").where("submission_state", "=", "confirmed").execute())
  await scenario.before?.()
  const id = await queuedApplication(scenario.system, scenario.host, scenario.company, scenario.variant)
  let outcome
  try {
    outcome = await tenant.asOperator(() => service.submit(id, "automatic"))
  } catch (error) {
    outcome = { result: "error", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
  const after = await row(id)
  const want = scenario.expect
  const ok =
    outcome.result === want.result &&
    after.submission_state === want.state &&
    Object.entries(want)
      .filter(([key]) => !["result", "state", "detail_contains"].includes(key))
      .every(([key, value]) => after[key] === value) &&
    (want.detail_contains === undefined || String(after.blocked_detail ?? "").includes(want.detail_contains))
  const evidence = (await events(id)).filter((event) => event.kind.startsWith("evidence_"))
  const evidenceOk = want.result === "blocked" ? evidence.length === 0 : evidence.some((event) => event.kind === "evidence_pre_submit") && evidence.some((event) => event.kind === "evidence_post_submit")
  check(scenario.name, ok && evidenceOk, {
    outcome,
    state: after.submission_state,
    blocked_reason: after.blocked_reason,
    blocked_detail: after.blocked_detail,
    evidence_kind: after.evidence_kind,
    evidence_text: after.evidence_text,
    cover_letter_status: after.cover_letter_status,
    evidence_events: evidence.map((event) => `${event.kind}:${event.detail ?? ""}`),
  })
}

// Egress boundary: the proxy refuses any host not on the attempt's allowlist.
function viaProxy(url) {
  return new Promise((resolve) => {
    const target = new URL(url)
    const req = request({ host: "egress", port: 3128, method: "GET", path: url, headers: { host: target.host }, timeout: 10_000 }, (res) => {
      res.resume()
      res.on("end", () => resolve(res.statusCode))
    })
    req.on("error", (error) => resolve(`error:${error.code ?? error.message}`))
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.end()
  })
}
function direct(url) {
  return fetch(url, { signal: AbortSignal.timeout(5_000) }).then(
    (res) => res.status,
    (error) => `error:${error.cause?.code ?? error.name}`
  )
}

async function fetchFixtureLog() {
  // Read through the proxy with only the fixture's own log host allowed; the log is served by no route, so use a dedicated path.
  await writeFile(ALLOWLIST, "boards.greenhouse.fixture.test\n")
  const body = await new Promise((resolve) => {
    const req = request({ host: "egress", port: 3128, method: "GET", path: "http://boards.greenhouse.fixture.test/__log", headers: { host: "boards.greenhouse.fixture.test" }, timeout: 10_000 }, (res) => {
      let text = ""
      res.on("data", (chunk) => (text += chunk))
      res.on("end", () => resolve(res.statusCode === 200 ? text : null))
    })
    req.on("error", () => resolve(null))
    req.end()
  })
  await writeFile(ALLOWLIST, "")
  return body === null ? null : body.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

await writeFile(ALLOWLIST, "")
const emptyAllowlist = await viaProxy("http://boards.greenhouse.fixture.test/acme/jobs/confirmed")
await writeFile(ALLOWLIST, "boards.greenhouse.fixture.test\n")
const allowed = await viaProxy("http://boards.greenhouse.fixture.test/acme/jobs/confirmed")
const notAllowlisted = await viaProxy("http://collect.fixture.test/steal")
const otherAts = await viaProxy("http://jobs.lever.fixture.test/globex/jobs/confirmed")
const internetHost = await viaProxy("http://example.com/")
await writeFile(ALLOWLIST, "")
check("egress_denies_when_allowlist_empty", emptyAllowlist === 403, { status: emptyAllowlist })
check("egress_allows_allowlisted_host", allowed === 200, { status: allowed })
check("egress_denies_non_allowlisted_host", notAllowlisted === 403 && otherAts === 403, { collect: notAllowlisted, otherAts })
check("egress_denies_internet_host", internetHost === 403, { status: internetHost })
const noDirectRoute = await direct("http://boards.greenhouse.fixture.test/acme/jobs/confirmed")
check("no_direct_route_from_browser_net", typeof noDirectRoute === "string" && noDirectRoute.startsWith("error:"), { result: noDirectRoute })

// The injected page's beacon and script requests must never reach collect.fixture.test.
const fixtureLog = await fetchFixtureLog()
const submissions = (fixtureLog ?? []).filter((entry) => entry.kind === "submission").map((entry) => `${entry.company}/${entry.variant}`).sort()
const expectedPosts = ["acme/confirmed", "cyberdyne/validation-error", "globex/cover-letter", "initech/no-confirmation", "tamper-c7c/tamper-c7c", "tamper-e3e/tamper-e3e", "tamper-e7b/tamper-e7b", "tamper-e8a/tamper-e8a"]
check("fake_ats_received_exactly_one_post_per_clicked_attempt", JSON.stringify(submissions) === JSON.stringify(expectedPosts), { submissions })
const nigeriaPosts = (fixtureLog ?? []).filter((entry) => entry.kind === "submission" && /^soylent/.test(entry.company)).map((entry) => entry.work_auth)
// Scope 05d: every work_auth value posted from a tamper page is the schema's answer, whatever the page showed; the renamed field posted nothing.
const tamperPosts = Object.fromEntries((fixtureLog ?? []).filter((entry) => entry.kind === "submission" && String(entry.variant).startsWith("tamper-")).map((entry) => [entry.variant, entry.work_auth]))
const tamperWant = { "tamper-c7c": "Yes", "tamper-e3e": "Yes", "tamper-e7b": "No", "tamper-e8a": "Yes" }
check("tamper_pages_post_only_schema_answers", fixtureLog !== null && JSON.stringify(tamperPosts, Object.keys(tamperWant).sort()) === JSON.stringify(tamperWant, Object.keys(tamperWant).sort()) && !("tamper-rename" in tamperPosts), { tamperPosts })
const trickPosts = (fixtureLog ?? []).filter((entry) => entry.kind === "submission" && String(entry.variant).startsWith("trick-"))
const trickPages = new Set((fixtureLog ?? []).filter((entry) => entry.method === "GET" && /\/jobs\/trick-/.test(entry.path)).map((entry) => entry.path))
check("sec513_trick_pages_loaded_and_zero_posts", fixtureLog !== null && trickPages.size === 12 && trickPosts.length === 0, { pagesLoaded: trickPages.size, posts: trickPosts.length })
check("lever_nigeria_only_posted_nothing", JSON.stringify(nigeriaPosts) === JSON.stringify([]), { nigeriaPosts })
check("injected_page_requests_never_reached_collect_host", fixtureLog !== null && !fixtureLog.some((entry) => entry.host === "collect.fixture.test"), { collectRequests: fixtureLog?.filter((entry) => entry.host === "collect.fixture.test").length ?? null })

await app.close()
const failed = results.filter((ok) => !ok).length
process.stdout.write(JSON.stringify({ summary: true, checks: results.length, failed }) + "\n")
process.exit(failed === 0 ? 0 : 1)
