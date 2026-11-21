import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { Logger, type LoggerService } from "@nestjs/common"
import {
  applicationAddedFactPath,
  applicationAddedFactsConfirmPath,
  applicationAddedFactsPath,
  applicationDetailSchema,
  applicationPath,
  addedFactsViewSchema,
  apiErrorResponseSchema,
} from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { anthropicConfig } from "../src/config/env.js"
import { DocumentsService } from "../src/documents/documents.service.js"
import { Browser } from "./support/browser.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertApplication, signInInvitee } from "./support/qa-epic-0011.js"
import { SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * FEAT-0017 backend smoke coverage: the real api, real Postgres and migration
 * 0042, end to end for the routes the backend owns. QA's
 * `added-facts.feat-0017.int-spec.ts` is the acceptance spec; this file proves the
 * backend path independently of it (api-contract v1.32.0, architecture).
 */

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let flagOffApp: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let offCandidate: SignedInCandidate
let invitee: SignedInCandidate
let inviteeId: string
let storage: string
const clock = new TestClock("2026-11-21T09:00:00.000Z")

/** Every Nest log line, for the SEC-R05 marker check: added text must never reach a log. */
const logs: string[] = []
const capture: LoggerService = {
  log: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
  warn: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
  error: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
  debug: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
  verbose: (message: unknown, ...rest: unknown[]) => void logs.push([message, ...rest].map(String).join(" ")),
}

const POSTING = {
  applicationUrl: "https://boards.greenhouse.io/northwind/jobs/1701",
  requisition: "AF-1701",
  title: "Senior Frontend Engineer",
  company: "Northwind Labs",
  text: "Build design systems with React and TypeScript. You own CI/CD pipelines and Figma handoff.",
}

const PROFILE = [
  {
    id: "sec-exp-1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021 to 2024",
    sourceQuote: null,
    facts: [
      { id: "6f1c0e8a-1111-4a6b-9a01-000000000001", text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", sourceQuote: null },
      { id: "6f1c0e8a-2222-4a6b-9a01-000000000002", text: "Senior Frontend Engineer at Brightwave Ltd, 2021 to 2024", sourceQuote: null },
      { id: "6f1c0e8a-3333-4a6b-9a01-000000000003", text: "Mentored 6 junior developers", sourceQuote: null },
    ],
  },
  {
    id: "sec-exp-2",
    kind: "experience",
    title: "Frontend Engineer",
    organization: "Acme Ltd",
    period: "2018 to 2021",
    sourceQuote: null,
    facts: [{ id: "6f1c0e8a-4444-4a6b-9a01-000000000004", text: "Frontend Engineer at Acme Ltd, 2018 to 2021", sourceQuote: null }],
  },
]

const GAPS = ["Figma", "design systems", "CI/CD pipelines", "frontend testing", "component library", "error boundaries"]

const RESUME = {
  kind: "resume",
  summary: [{ text: "Senior Frontend Engineer who builds products from scratch to production.", factIds: ["6f1c0e8a-1111-4a6b-9a01-000000000001"] }],
  experience: [{ heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021 to 2024", factIds: ["6f1c0e8a-2222-4a6b-9a01-000000000002"] }, bullets: [{ text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["6f1c0e8a-1111-4a6b-9a01-000000000001"] }] }],
  skills: [{ text: "React, TypeScript", factIds: ["6f1c0e8a-1111-4a6b-9a01-000000000001"] }],
  education: [],
  ats: { score: 62, total: 9, matched: ["React", "TypeScript"], missing: [], gaps: [...GAPS] },
}
const LETTER = { kind: "cover_letter", greeting: "Dear Hiring Team at Northwind Labs,", opening: null, paragraphs: [{ text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["6f1c0e8a-1111-4a6b-9a01-000000000001"] }], closingLine: null, closing: "Kind regards," }

const MATCH_ITEMS = [
  { group: "core", text: "Build design systems with React", factId: "6f1c0e8a-1111-4a6b-9a01-000000000001" },
  { group: "core", text: "Own the CI/CD pipelines", factId: null },
  { group: "core", text: "Own the design process end to end", factId: null },
  { group: "core", text: "Mentor junior engineers", factId: "6f1c0e8a-3333-4a6b-9a01-000000000003" },
  { group: "core", text: "Ship weekly with TypeScript", factId: "6f1c0e8a-1111-4a6b-9a01-000000000001" },
  { group: "core", text: "Review pull requests", factId: null },
  { group: "core", text: "Write frontend tests", factId: null },
  { group: "core", text: "Work with product", factId: null },
  { group: "core", text: "Maintain a component library", factId: null },
  { group: "core", text: "Run releases", factId: null },
  { group: "mandatory", text: "Experience with React", factId: "6f1c0e8a-1111-4a6b-9a01-000000000001" },
]

const LIFTING = [
  { kind: "one_liner" as const, text: "Owned the CI/CD pipelines at Acme" },
  { kind: "one_liner" as const, text: "Owned the design process end to end at Acme" },
  { kind: "one_liner" as const, text: "Reviewed pull requests at Acme" },
  { kind: "one_liner" as const, text: "Wrote frontend testing notes at Acme" },
]

/** A valid generated document set for the fixtures above, and a support verdict for every claim it makes. */
const GOOD = {
  resume: { summary: [], experience: [{ heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021 to 2024", factIds: ["F2"] }, bullets: [{ text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["F1"] }] }], skills: [{ text: "React, TypeScript, Figma", factIds: ["F1", "F5"] }], education: [] },
  coverLetter: { paragraphs: [{ text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] }] },
}
const SUPPORTS_ALL = { results: Array.from({ length: 200 }, (_, id) => ({ id, supported: true })) }

/** A valid document set that cites no added fact, for the tests about what reaches the prompt. */
const PROFILE_ONLY = {
  resume: { summary: [], experience: [{ heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021 to 2024", factIds: ["F2"] }, bullets: [{ text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["F1"] }] }], skills: [{ text: "React, TypeScript", factIds: ["F1"] }], education: [] },
  coverLetter: { paragraphs: [{ text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] }] },
}

beforeAll(async () => {
  Logger.overrideLogger(capture)
  storage = await mkdtemp(join(tmpdir(), "ja-af-smoke-"))
  markStorageMigratedSync(join(storage, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  const base = { candidateStorageDir: join(storage, "candidates"), anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5") }
  app = await createTestApp({ databaseUrl: database.url, clock, config: { ...base, addedFactsEnabled: true } })
  flagOffApp = await createTestApp({ databaseUrl: database.url, clock, config: { ...base, addedFactsEnabled: false } })
  // `@nestjs/testing`'s compile() replaces the static logger with its own TestingLogger, so the capture
  // is installed after both modules exist and before any route runs.
  Logger.overrideLogger(capture)
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
  offCandidate = new SignedInCandidate(new Browser(flagOffApp, google), candidate.cookie, candidate.csrfToken, candidate.email)
  const invited = await signInInvitee(app, google, database.db)
  invitee = invited.session
  inviteeId = invited.id
})

beforeEach(async () => {
  logs.length = 0
  await app.get(DocumentsService).settled()
  anthropic.install()
  anthropic.reset()
  for (const table of ["application_added_fact", "outreach_message", "tailored_document", "submission_event", "ai_call", "application", "match_evidence", "eligibility_result", "candidate_posting", "job_posting"] as const) {
    await sql`delete from ${sql.table(table)}`.execute(database.db)
  }
  await database.db.deleteFrom("career_profile_version").execute()
  await database.db.updateTable("activation_state").set({ gate_passed_at: null, automatic_enabled: false, existing_applications_completed_at: null }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("job_criteria").set({ min_core_match_percent: 70, frameworks: [], technologies: [] }).execute()
  await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  // Generation needs the Candidate's contact header (the documents render it).
  await database.db.insertInto("candidate_contact").values({ candidate_id: database.operatorId, full_name: "Sam Example", lines: JSON.stringify(["Lagos, Nigeria"]), updated_at: clock.now() } as never).onConflict((oc) => oc.column("candidate_id").doUpdateSet({ full_name: "Sam Example", lines: JSON.stringify(["Lagos, Nigeria"]) })).execute()
  await database.db.insertInto("career_profile_version").values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(PROFILE), created_at: clock.now(), approved_at: clock.now() }).execute()
})

afterAll(async () => {
  await app?.close()
  await flagOffApp?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
  Logger.overrideLogger(false)
})

async function posting(overrides: Partial<{ status: "ranked" | "skipped" | "excluded" | "checking"; skipReason: string | null; technologies: string[] }> = {}): Promise<string> {
  const id = randomUUID()
  await insertPostingFor(database.db, database.operatorId, {
    id,
    application_url: POSTING.applicationUrl,
    requisition_id: `${POSTING.requisition}-${id.slice(0, 4)}`,
    apply_url: POSTING.applicationUrl,
    application_system: "Greenhouse",
    apply_mode: "automatic",
    origin: "employer_board",
    employer_board_id: null,
    remote_board_key: null,
    attribution_name: null,
    attribution_url: null,
    title: POSTING.title,
    company: POSTING.company,
    posting_text: POSTING.text,
    technologies: JSON.stringify((overrides.technologies ?? ["React"]).map((name) => ({ name, quote: name }))),
    status: overrides.status ?? "ranked",
    skip_reason: overrides.skipReason ?? (overrides.status === "ranked" || overrides.status === undefined ? null : "weak_core_match"),
    skip_detail: null,
    evaluation_failure: null,
    role_family: "senior_frontend",
    discovered_at: clock.now(),
    evaluated_at: clock.now(),
  })
  return id
}

async function match(postingId: string): Promise<void> {
  await database.db.insertInto("match_evidence").values({
    candidate_id: database.operatorId,
    job_posting_id: postingId,
    career_profile_version: 1,
    verdict: "weak",
    weak_reason: "coverage_below_threshold",
    covered_count: 3,
    total_count: 10,
    threshold: "0.700",
    items: JSON.stringify(MATCH_ITEMS),
    evaluated_at: clock.now(),
    criteria_version: 1,
  }).execute()
}

async function application(options: { state?: string; submissionState?: string | null; documents?: boolean; storedVersion?: number; postingStatus?: "ranked" | "skipped"; postingSkip?: string | null } = {}): Promise<{ id: string; postingId: string }> {
  const postingId = await posting({ status: options.postingStatus, skipReason: options.postingSkip })
  await match(postingId)
  const id = randomUUID()
  const state = options.state ?? "documents_ready"
  await database.db.insertInto("application").values({
    candidate_id: database.operatorId,
    id,
    job_posting_id: postingId,
    application_url: POSTING.applicationUrl,
    requisition_id: `${POSTING.requisition}-${id.slice(0, 4)}`,
    company: POSTING.company,
    role_title: POSTING.title,
    state,
    career_profile_version: 1,
    created_at: clock.now(),
    updated_at: clock.now(),
    ...(options.submissionState === undefined ? {} : { submission_state: options.submissionState }),
  } as never).execute()
  if (options.documents !== false && state === "documents_ready") {
    for (const [kind, content] of [["resume", RESUME], ["cover_letter", LETTER]] as const) {
      await database.db.insertInto("tailored_document").values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: JSON.stringify(content), pdf_storage_name: `${randomUUID()}.pdf`, docx_storage_name: `${randomUUID()}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: clock.now() }).execute()
    }
    if (options.storedVersion !== undefined) await setDocumentsVersion(id, options.storedVersion, [], [])
  }
  return { id, postingId }
}

async function setDocumentsVersion(id: string, version: number, available: unknown[], cited: string[]): Promise<void> {
  await sql`update tailored_document set added_facts_version = ${version}, added_facts = ${JSON.stringify({ available, cited })}::jsonb where application_id = ${id}`.execute(database.db)
}

/** Replaces the resume's stored `ats.gaps`, as a hostile posting's extraction could. */
async function setResumeGaps(id: string, gaps: readonly string[]): Promise<void> {
  const row = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", id).where("kind", "=", "resume").executeTakeFirstOrThrow()
  const content = row.content as Record<string, unknown>
  const ats = { ...(content.ats as Record<string, unknown>), gaps: [...gaps] }
  await database.db.updateTable("tailored_document").set({ content: JSON.stringify({ ...content, ats }) }).where("application_id", "=", id).where("kind", "=", "resume").execute()
}

async function insertFact(id: string, fact: { kind: "skill_only" | "one_liner"; text: string; term?: string | null; roleSectionId?: string }): Promise<string> {
  const factId = randomUUID()
  const role = fact.kind === "one_liner" ? { title: "Frontend Engineer", employer: "Acme Ltd", period: "2018 to 2021" } : null
  await sql`insert into application_added_fact (candidate_id, application_id, id, kind, text, text_key, term, role_section_id, role_snapshot, save_to_profile, profile_draft_version, affirmed_at, created_at, updated_at)
    values (${database.operatorId}, ${id}, ${factId}, ${fact.kind}, ${fact.text}, ${fact.text.trim().toLowerCase()}, ${fact.term ?? (fact.kind === "skill_only" ? fact.text : null)}, ${fact.kind === "one_liner" ? fact.roleSectionId ?? "sec-exp-2" : null}, ${role === null ? null : JSON.stringify(role)}::jsonb, false, null, ${clock.now()}, ${clock.now()}, ${clock.now()})`.execute(database.db)
  await sql`update application set added_facts_version = added_facts_version + 1 where id = ${id}`.execute(database.db)
  return factId
}

async function appRow(id: string) {
  const rows = await sql<{ added_facts_version: number; added_facts_confirmed_version: number | null; submission_state: string | null; state: string; added_facts_match: unknown }>`
    select added_facts_version, added_facts_confirmed_version, submission_state, state, added_facts_match from application where id = ${id}`.execute(database.db)
  return rows.rows[0]!
}

const viewPath = (id: string) => applicationAddedFactsPath(id)
const factPath = (id: string, factId: string) => applicationAddedFactPath(id, factId)
const confirmPath = (id: string) => applicationAddedFactsConfirmPath(id)

async function view(id: string) {
  return addedFactsViewSchema.parse((await candidate.get(viewPath(id)).expect(200)).body)
}

function add(id: string, items: unknown[], expectedVersion: number) {
  return candidate.post(viewPath(id)).send({ expectedVersion, items })
}

describe("FEAT-0017 backend: flag, routes and the view", () => {
  it("with the flag off every new route answers 404 before body parsing, and the detail carries no addedFacts", async () => {
    const { id } = await application()
    const get = await offCandidate.get(viewPath(id)).expect(404)
    expect(apiErrorResponseSchema.parse(get.body)).toEqual({ error: { code: "not_found", message: "Not found." } })
    const post = await offCandidate.post(viewPath(id)).send({ nonsense: true }).expect(404)
    expect(apiErrorResponseSchema.parse(post.body).error.code).toBe("not_found")
    const detail = await offCandidate.get(applicationPath(id)).expect(200)
    expect(detail.body).not.toHaveProperty("addedFacts")
    for (const document of detail.body.documents as Array<Record<string, unknown>>) expect(document).not.toHaveProperty("addedFactsUsed")
    expect(applicationDetailSchema.safeParse(detail.body).success).toBe(true)
  })

  it("a malformed or foreign id is 404, and an unauthenticated read is 401", async () => {
    expect((await candidate.get("/v1/applications/not-a-uuid/added-facts").expect(404)).body).toMatchObject({ error: { code: "not_found" } })
    expect((await candidate.get(viewPath(randomUUID())).expect(404)).status).toBe(404)
    expect((await browser.http().get(viewPath(randomUUID())).expect(401)).body).toMatchObject({ error: { code: "unauthenticated" } })
  })

  it("a fresh Application reads version 0, Editable, with roles, gaps and both Match numbers", async () => {
    const { id } = await application()
    expect(await view(id)).toMatchObject({
      version: 0,
      editable: true,
      frozenReason: null,
      busyReason: null,
      profileVersion: 1,
      roles: [
        { sectionId: "sec-exp-1", title: "Senior Frontend Engineer", employer: "Brightwave Ltd", period: "2021 to 2024" },
        { sectionId: "sec-exp-2", title: "Frontend Engineer", employer: "Acme Ltd", period: "2018 to 2021" },
      ],
      facts: [],
      counts: { oneLiner: 0, skillOnly: 0 },
      limits: { oneLiner: 10, skillOnly: 40, textMax: 300 },
      postingGaps: { available: true, terms: GAPS },
      documentsStale: false,
      addedFactsCited: [],
      match: { careerProfileVersion: 1, thresholdPercent: 70, posting: { covered: 3, total: 10, verdict: "weak" }, withAdded: { covered: 3, total: 10, verdict: "weak" }, lifted: false, covers: [] },
      confirmation: { state: "not_required", voided: false, confirmedAt: null },
    })
  })

  it("a frozen Application answers 409 added_facts_frozen and a generating one 409 added_facts_busy", async () => {
    const confirmed = await application({ submissionState: "confirmed" })
    expect(apiErrorResponseSchema.parse((await add(confirmed.id, [{ kind: "skill_only", term: "Figma", affirmed: true }], 0)).body).error.code).toBe("added_facts_frozen")
    expect((await view(confirmed.id)).frozenReason).toBe("submitted")
    const generating = await application({ state: "generating", documents: false })
    expect(apiErrorResponseSchema.parse((await add(generating.id, [{ kind: "skill_only", term: "Figma", affirmed: true }], 0)).body).error.code).toBe("added_facts_busy")
  })
})

describe("FEAT-0017 backend: ticks, one-liners and the counter", () => {
  it("ticks two terms in one action: one counter step, the posting's wording, the gaps closed", async () => {
    const { id } = await application()
    const response = await add(id, [{ kind: "skill_only", term: "figma", affirmed: true }, { kind: "skill_only", term: "CI/CD pipelines", affirmed: true }], 0).expect(200)
    const body = addedFactsViewSchema.parse(response.body.view)
    expect(body.version).toBe(1)
    expect(body.counts).toEqual({ oneLiner: 0, skillOnly: 2 })
    expect(body.facts.map((fact) => fact.text)).toEqual(expect.arrayContaining(["Figma", "CI/CD pipelines"]))
    expect(body.postingGaps.terms).not.toContain("Figma")
    expect(response.body.profileSave).toEqual([
      { position: 1, factId: expect.any(String), outcome: "not_requested", draftVersion: null },
      { position: 2, factId: expect.any(String), outcome: "not_requested", draftVersion: null },
    ])
    expect(anthropic.requests).toEqual([])
  })

  it("a term that is not a live gap, a duplicate and a missing Affirmation are 422 field errors and store nothing", async () => {
    const { id } = await application()
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "skill_only", term: "Kubernetes", affirmed: true }], 0)).body).error.fieldErrors).toEqual([{ source: "added_facts", field: "term", position: 1, problem: "term_not_a_gap" }])
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "skill_only", term: "Figma" }], 0)).body).error.fieldErrors).toEqual([{ source: "added_facts", field: "affirmed", position: 1, problem: "affirmation_required" }])
    await add(id, [{ kind: "skill_only", term: "Figma", affirmed: true }], 0).expect(200)
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "skill_only", term: "figma", affirmed: true }], 1)).body).error.fieldErrors).toEqual([{ source: "added_facts", field: "term", position: 1, problem: "duplicate" }])
    expect(await appRow(id)).toMatchObject({ added_facts_version: 1 })
  })

  it("a one-liner is validated in order, stored under its role, and duplicated case-insensitively", async () => {
    const { id } = await application()
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "one_liner", text: "Set up CI/CD at Acme, write to ada@example.com", roleSectionId: "sec-exp-2", affirmed: true }], 0)).body).error.fieldErrors?.[0]).toMatchObject({ field: "text", problem: "contact_detail" })
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "one_liner", text: "Built a learning platform with React at Acme", roleSectionId: "sec-exp-2", affirmed: true }], 0)).body).error.fieldErrors?.[0]).toMatchObject({ problem: "aspiration_text" })
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "one_liner", text: "Set up the release workflow at Acme", term: "CI/CD pipelines", roleSectionId: "sec-exp-2", affirmed: true }], 0)).body).error.fieldErrors?.[0]).toMatchObject({ field: "text", problem: "term_not_named" })
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "one_liner", text: "Set up CI/CD at Acme", roleSectionId: "sec-elsewhere", affirmed: true }], 0)).body).error.fieldErrors).toEqual([{ source: "added_facts", field: "roleSectionId", position: 1, problem: "role_unknown" }])

    const created = addedFactsViewSchema.parse((await add(id, [{ kind: "one_liner", text: "  Set up GitHub Actions CI/CD at Acme  ", roleSectionId: "sec-exp-2", affirmed: true }], 0).expect(200)).body.view)
    expect(created.facts[0]).toMatchObject({ kind: "one_liner", text: "Set up GitHub Actions CI/CD at Acme", term: null, role: { sectionId: "sec-exp-2", title: "Frontend Engineer", employer: "Acme Ltd", period: "2018 to 2021", inProfileVersion: true } })
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "one_liner", text: "set up github actions ci/cd at acme", roleSectionId: "sec-exp-1", affirmed: true }], 1)).body).error.fieldErrors?.[0]).toMatchObject({ field: "text", problem: "duplicate" })
  })

  it("the limits are 10 one-liners and 40 skill-only facts", async () => {
    const { id } = await application()
    await add(id, Array.from({ length: 10 }, (_, index) => ({ kind: "one_liner", text: `Built pipeline number ${index} at Acme`, roleSectionId: "sec-exp-2", affirmed: true })), 0).expect(200)
    const eleventh = await add(id, [{ kind: "one_liner", text: "Built a Storybook library at Acme", roleSectionId: "sec-exp-2", affirmed: true }], 1)
    expect(eleventh.status).toBe(422)
    expect(apiErrorResponseSchema.parse(eleventh.body)).toEqual({ error: { code: "added_facts_limit", message: "That would pass the limit of added facts for this Application. Nothing was saved.", fieldErrors: [{ source: "added_facts", field: "items", position: null, problem: "one_liner_limit" }] } })
  })

  it("an upgrade keeps the fact and its term; a no-op edit changes no counter; a removal returns the term", async () => {
    const { id } = await application()
    const factId = await insertFact(id, { kind: "skill_only", text: "CI/CD pipelines", term: "CI/CD pipelines" })
    const upgraded = addedFactsViewSchema.parse((await candidate.patch(factPath(id, factId)).send({ expectedVersion: 1, text: "Set up GitHub Actions CI/CD pipelines at Acme", roleSectionId: "sec-exp-2" }).expect(200)).body)
    expect(upgraded.facts[0]).toMatchObject({ id: factId, kind: "one_liner", term: "CI/CD pipelines", text: "Set up GitHub Actions CI/CD pipelines at Acme" })
    expect(upgraded.version).toBe(2)
    const same = addedFactsViewSchema.parse((await candidate.patch(factPath(id, factId)).send({ expectedVersion: 2, text: "Set up GitHub Actions CI/CD pipelines at Acme", roleSectionId: "sec-exp-2" }).expect(200)).body)
    expect(same.version).toBe(2)
    const removed = addedFactsViewSchema.parse((await candidate.delete(`${factPath(id, factId)}?expectedVersion=2`).expect(200)).body)
    expect(removed.facts).toEqual([])
    expect(removed.postingGaps.terms).toContain("CI/CD pipelines")
  })

  it("a stale expectedVersion is a conflict before any field rule", async () => {
    const { id } = await application()
    await add(id, [{ kind: "skill_only", term: "Figma", affirmed: true }], 0).expect(200)
    expect(apiErrorResponseSchema.parse((await add(id, [{ kind: "skill_only", term: "Not a gap", affirmed: false }], 0)).body).error.code).toBe("added_facts_conflict")
  })
})

describe("FEAT-0017 backend: Application Match, confirmation and the queue", () => {
  it("a one-liner covers a requirement, is marked in covers, and lifts a Match-only skip", async () => {
    const { id } = await application({ postingStatus: "skipped", postingSkip: "weak_core_match" })
    await insertFact(id, { kind: "one_liner", text: "Owned the CI/CD pipelines at Acme" })
    const seen = await view(id)
    expect(seen.match?.withAdded).toEqual({ covered: 4, total: 10, unmetMandatory: 0, verdict: "weak" })
    expect(seen.match?.covers).toEqual([{ group: "core", requirement: "Own the CI/CD pipelines", factId: expect.any(String), kind: "one_liner" }])
    for (const fact of LIFTING.slice(1)) await insertFact(id, fact)
    const lifted = await view(id)
    expect(lifted.match).toMatchObject({ posting: { covered: 3, verdict: "weak" }, withAdded: { covered: 7, verdict: "strong" }, lifted: true })
    expect(lifted.confirmation.state).toBe("stale")
  })

  it("Figma never covers an unrelated responsibility (OD-12) and the audit snapshot records the set", async () => {
    const { id } = await application()
    await add(id, [{ kind: "skill_only", term: "Figma", affirmed: true }], 0).expect(200)
    expect((await view(id)).match?.covers).toEqual([])
    expect((await appRow(id)).added_facts_match).toMatchObject({ profileVersion: 1, addedFactsVersion: 1, criteriaVersion: 1, lifted: false })
  })

  it("confirm records the confirmation and queues in one request; a later change voids it and drops the queue", async () => {
    const { id } = await application({ postingStatus: "skipped", postingSkip: "weak_core_match" })
    for (const fact of LIFTING) await insertFact(id, fact)
    await setDocumentsVersion(id, LIFTING.length, [], [])
    const response = await candidate.post(confirmPath(id)).send({ expectedVersion: 4 }).expect(200)
    expect(response.body).toMatchObject({ state: "queued", kind: "automatic" })
    expect(await appRow(id)).toMatchObject({ submission_state: "queued", added_facts_confirmed_version: 4 })
    expect((await view(id)).confirmation).toMatchObject({ state: "confirmed", voided: false })

    const factId = (await sql<{ id: string }>`select id from application_added_fact where application_id = ${id} order by created_at limit 1`.execute(database.db)).rows[0]!.id
    await candidate.delete(`${factPath(id, factId)}?expectedVersion=4`).expect(200)
    expect(await appRow(id)).toMatchObject({ submission_state: null })
    const drop = await database.db.selectFrom("submission_event").select(["kind", "detail"]).where("application_id", "=", id).execute()
    expect(drop).toContainEqual({ kind: "queued_posting_dropped", detail: "documents_stale" })
    expect((await view(id)).confirmation).toMatchObject({ state: "stale", voided: true, confirmedAt: null })
  })

  it("confirm queues through /queue's guard: a non-Operator's own Application gets the same 409 feature_not_yet_available, and nothing is written", async () => {
    const id = await insertApplication(database.db, inviteeId)
    const queued = await invitee.post(`/v1/applications/${id}/queue`)
    const confirmed = await invitee.post(confirmPath(id)).send({ expectedVersion: 0 })
    expect(queued.status).toBe(409)
    expect(confirmed.status).toBe(queued.status)
    expect(apiErrorResponseSchema.parse(confirmed.body)).toEqual(apiErrorResponseSchema.parse(queued.body))
    expect(apiErrorResponseSchema.parse(confirmed.body)).toEqual({ error: { code: "feature_not_yet_available", message: "This feature isn't available for your account yet.", feature: "submission" } })
    expect(await appRow(id)).toMatchObject({ added_facts_confirmed_version: null, submission_state: null })
  })

  it("queue without the confirmation is refused; with it, the same tap is a 200 no-op", async () => {    const { id } = await application({ postingStatus: "skipped", postingSkip: "weak_core_match" })
    for (const fact of LIFTING) await insertFact(id, fact)
    await setDocumentsVersion(id, LIFTING.length, [], [])
    expect(apiErrorResponseSchema.parse((await candidate.post(`/v1/applications/${id}/queue`)).body).error.code).toBe("added_facts_confirmation_required")
    await candidate.post(confirmPath(id)).send({ expectedVersion: 4 }).expect(200)
    const events = async () => (await database.db.selectFrom("submission_event").select("id").where("application_id", "=", id).execute()).length
    const before = await events()
    await candidate.post(confirmPath(id)).send({ expectedVersion: 4 }).expect(200)
    expect(await events()).toBe(before)
  })

  it("a Match below the threshold cannot be confirmed", async () => {
    const { id } = await application({ postingStatus: "skipped", postingSkip: "weak_core_match" })
    await insertFact(id, { kind: "one_liner", text: "Owned the CI/CD pipelines at Acme" })
    expect(apiErrorResponseSchema.parse((await candidate.post(confirmPath(id)).send({ expectedVersion: 1 })).body).error.code).toBe("added_facts_not_lifted")
  })
})

describe("FEAT-0017 backend: generation", () => {
  it("the prompt lists the added facts by alias, the documents record the counter and the cited set, and generation records it", async () => {
    const { id } = await application({ state: "prepared", documents: false })
    const figma = await insertFact(id, { kind: "skill_only", text: "Figma", term: "Figma" })
    anthropic.replyWithObject(GOOD)
    anthropic.replyWithObject(SUPPORTS_ALL)
    await candidate.post(`/v1/applications/${id}/documents/generate`).expect(202)
    await app.get(DocumentsService).settled()
    const prompt = JSON.stringify(anthropic.requests.map((request) => request.body))
    expect(prompt).toContain("<added_facts>")
    expect(prompt).toContain("[skill_only]")
    expect(prompt).not.toContain("added:s:")
    const detail = applicationDetailSchema.parse((await candidate.get(applicationPath(id)).expect(200)).body)
    expect(detail.state).toBe("documents_ready")
    expect(detail.addedFacts).toMatchObject({ version: 1, documentsStale: false })
    for (const document of detail.documents) expect(document).toHaveProperty("addedFactsUsed")
    expect(detail.addedFacts?.addedFactsCited).toEqual([{ id: figma, kind: "skill_only", text: "Figma", role: null }])
    const stored = await sql<{ kind: "resume" | "cover_letter"; added_facts_version: number; added_facts: { available: unknown[]; cited: string[] } }>`select kind, added_facts_version, added_facts from tailored_document where application_id = ${id} order by kind`.execute(database.db)
    // The Skills line of the resume cited the tick; the cover letter cited no added fact, so each row records its own set.
    expect(stored.rows.find((row) => row.kind === "resume")).toMatchObject({ added_facts_version: 1, added_facts: { cited: [figma] } })
    expect(stored.rows.find((row) => row.kind === "cover_letter")).toMatchObject({ added_facts_version: 1, added_facts: { cited: [] } })
    for (const row of stored.rows) {
      expect(row.added_facts_version).toBe(1)
      expect(row.added_facts.available).toHaveLength(1)
    }
  })

  it("a change after generation makes the documents stale and the view says so", async () => {
    const { id } = await application()
    expect((await view(id)).documentsStale).toBe(false)
    await add(id, [{ kind: "skill_only", term: "Figma", affirmed: true }], 0).expect(200)
    expect((await view(id)).documentsStale).toBe(true)
  })
})

describe("FEAT-0017 backend: SEC-001 flag-off stale gate", () => {
  it("with the flag off a letter that cites an added fact is 409 documents_stale on queue; empty cited lists queue", async () => {
    const stale = await application({ storedVersion: 0 })
    const figma = await insertFact(stale.id, { kind: "skill_only", text: "Figma" })
    await sql`update tailored_document set added_facts = ${JSON.stringify({ available: [{ id: figma, kind: "skill_only", text: "Figma", role: null }], cited: [figma] })}::jsonb where application_id = ${stale.id} and kind = 'cover_letter'`.execute(database.db)
    const refused = await offCandidate.post(`/v1/applications/${stale.id}/queue`)
    expect(refused.status).toBe(409)
    expect(apiErrorResponseSchema.parse(refused.body).error.code).toBe("documents_stale")

    const fine = await application({ storedVersion: 0 })
    await insertFact(fine.id, { kind: "skill_only", text: "Figma" })
    await offCandidate.post(`/v1/applications/${fine.id}/queue`).expect(200)
    expect((await appRow(fine.id)).submission_state).toBe("queued")
  })

  it("generating with the flag off records counter 0 and an empty snapshot", async () => {
    const { id } = await application({ state: "prepared", documents: false })
    await insertFact(id, { kind: "skill_only", text: "Figma" })
    anthropic.replyWithObject({ resume: { summary: [], experience: [], skills: [], education: [] }, coverLetter: { paragraphs: [{ text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] }] } })
    anthropic.replyWithObject({ results: Array.from({ length: 200 }, (_, index) => ({ id: index, supported: true })) })
    await offCandidate.post(`/v1/applications/${id}/documents/generate`).expect(202)
    await flagOffApp.get(DocumentsService).settled()
    const rows = await sql<{ added_facts_version: number; added_facts: unknown }>`select added_facts_version, added_facts from tailored_document where application_id = ${id}`.execute(database.db)
    for (const row of rows.rows) {
      expect(row.added_facts_version).toBe(0)
      expect(row.added_facts).toEqual({ available: [], cited: [] })
    }
    expect(JSON.stringify(anthropic.requests)).not.toContain("<added_facts>")
  })
})

describe("FEAT-0017 backend: Career Profile save and deletion", () => {
  it("saveToProfile appends a Candidate-written fact to the draft and marks the row", async () => {
    const { id } = await application()
    const response = await add(id, [{ kind: "skill_only", term: "Figma", affirmed: true, saveToProfile: true }], 0).expect(200)
    expect(response.body.profileSave).toEqual([{ position: 1, factId: expect.any(String), outcome: "saved_to_draft", draftVersion: 2 }])
    const draft = await database.db.selectFrom("career_profile_version").select(["version", "sections"]).where("candidate_id", "=", database.operatorId).where("status", "=", "draft").executeTakeFirstOrThrow()
    expect(draft.version).toBe(2)
    expect(JSON.stringify(draft.sections)).toContain("Figma")
    expect((await view(id)).facts[0]?.profile).toEqual({ status: "draft", version: 2 })
    expect((await view(id)).profileVersion).toBe(1)
  })

  it("deleting the detailed records removes the facts and nulls the confirmation and Match audit", async () => {
    const { id } = await application()
    await insertFact(id, { kind: "skill_only", text: "Figma", term: "Figma" })
    await sql`update application set added_facts_confirmed_version = 1, added_facts_confirmed_at = now(), added_facts_match = '{}'::jsonb where id = ${id}`.execute(database.db)
    await candidate.post("/v1/applications/delete-details").send({ applicationIds: [id] }).expect(200)
    const rows = await sql<{ added_facts_confirmed_version: number | null; added_facts_match: unknown }>`select added_facts_confirmed_version, added_facts_match from application where id = ${id}`.execute(database.db)
    expect(rows.rows[0]).toEqual({ added_facts_confirmed_version: null, added_facts_match: null })
    expect((await sql`select id from application_added_fact where application_id = ${id}`.execute(database.db)).rows).toEqual([])
    expect((await view(id)).frozenReason).toBe("details_deleted")
  })
})

describe("FEAT-0017 backend: SEC-R01 hostile gap terms", () => {
  it("a zero-width, over-long or link term is not offered as a gap and a tick of it is term_not_a_gap with nothing written", async () => {
    const { id } = await application()
    const invisible = "Figma\u200B"
    const overLong = "L".repeat(201)
    const link = "www.evil.example"
    await setResumeGaps(id, ["Figma", invisible, overLong, link])

    const seen = await view(id)
    expect(seen.postingGaps).toEqual({ available: true, terms: ["Figma"] })

    for (const term of [invisible, link]) {
      const refused = await add(id, [{ kind: "skill_only", term, affirmed: true }], 0)
      expect(refused.status).toBe(422)
      expect(apiErrorResponseSchema.parse(refused.body).error.fieldErrors).toEqual([{ source: "added_facts", field: "term", position: 1, problem: "term_not_a_gap" }])
    }
    // The view dropped the 201-code-point term too. Ticking it never reaches the gap rule: the wire
    // schema caps `term` at 200 (contracts `addSkillOnlyItemSchema`), so it is a 400 and nothing is written.
    const tooLongTick = await add(id, [{ kind: "skill_only", term: overLong, affirmed: true }], 0)
    expect(tooLongTick.status).toBe(400)
    expect(apiErrorResponseSchema.parse(tooLongTick.body).error.code).toBe("bad_request")
    // Nothing was written by any of the three refusals, and no write reached the database CHECK.
    expect((await view(id)).facts).toEqual([])
    expect(await appRow(id)).toMatchObject({ added_facts_version: 0 })
    // The live term next to them is unaffected.
    expect((await add(id, [{ kind: "skill_only", term: "Figma", affirmed: true }], 0).expect(200)).body.view.facts).toHaveLength(1)
  })

  it("a 200 code point term is offered, and a 201 is dropped", async () => {
    const { id } = await application()
    const atLimit = "K".repeat(200)
    await setResumeGaps(id, [atLimit, "K".repeat(201)])
    expect((await view(id)).postingGaps.terms).toEqual([atLimit])
    expect((await add(id, [{ kind: "skill_only", term: atLimit, affirmed: true }], 0).expect(200)).body.view.facts).toHaveLength(1)
  })

  it("a one-liner holding U+FFF9 is 422 invalid_characters, never the 0042 CHECK's 500 (CR-1)", async () => {
    const { id } = await application()
    const refused = await add(id, [{ kind: "one_liner", text: "Ran CI\uFFF9 at Acme", roleSectionId: "sec-exp-2", affirmed: true }], 0)
    expect(refused.status).toBe(422)
    expect(apiErrorResponseSchema.parse(refused.body).error.fieldErrors).toEqual([{ source: "added_facts", field: "text", position: 1, problem: "invalid_characters" }])
    expect((await view(id)).facts).toEqual([])
    expect(await appRow(id)).toMatchObject({ added_facts_version: 0 })
  })

  it("a gap term holding U+FFFA is not offered and its tick is term_not_a_gap (CR-1)", async () => {
    const { id } = await application()
    const annotation = "Figma\uFFFA"
    await setResumeGaps(id, ["Figma", annotation])
    expect((await view(id)).postingGaps).toEqual({ available: true, terms: ["Figma"] })
    const refused = await add(id, [{ kind: "skill_only", term: annotation, affirmed: true }], 0)
    expect(refused.status).toBe(422)
    expect(apiErrorResponseSchema.parse(refused.body).error.fieldErrors).toEqual([{ source: "added_facts", field: "term", position: 1, problem: "term_not_a_gap" }])
    expect((await view(id)).facts).toEqual([])
  })
})

describe("FEAT-0017 backend: SEC-R06 one duplicate key function", () => {
  it("a PATCH to a text whose case-fold differs between JavaScript and SQL is a 200, and text_key follows the SQL rule", async () => {
    const { id } = await application()
    const created = addedFactsViewSchema.parse((await add(id, [{ kind: "one_liner", text: "Built the dashboard at Acme", roleSectionId: "sec-exp-2", affirmed: true }], 0).expect(200)).body.view)
    const factId = created.facts[0]!.id
    const patched = await candidate.patch(factPath(id, factId)).send({ expectedVersion: 1, text: "Built ΟΔΟΣ at Acme", roleSectionId: "sec-exp-2" }).expect(200)
    expect(addedFactsViewSchema.parse(patched.body).facts[0]).toMatchObject({ text: "Built ΟΔΟΣ at Acme" })
    const row = await sql<{ key_matches: boolean }>`select text_key = lower(btrim(text)) as key_matches from application_added_fact where id = ${factId}`.execute(database.db)
    expect(row.rows[0]?.key_matches).toBe(true)
  })

  it("the same Greek text twice is a 422 duplicate, not a unique-violation 500", async () => {
    const { id } = await application()
    await add(id, [{ kind: "one_liner", text: "Built ΟΔΟΣ at Acme", roleSectionId: "sec-exp-2", affirmed: true }], 0).expect(200)
    const refused = await add(id, [{ kind: "one_liner", text: "Built ΟΔΟΣ at Acme", roleSectionId: "sec-exp-2", affirmed: true }], 1)
    expect(refused.status).toBe(422)
    expect(apiErrorResponseSchema.parse(refused.body).error.fieldErrors).toEqual([{ source: "added_facts", field: "text", position: 1, problem: "duplicate" }])
    expect(await appRow(id)).toMatchObject({ added_facts_version: 1 })
  })

  it("the İ variant is one key too: a PATCH is a 200 and the duplicate add is a 422", async () => {
    const { id } = await application()
    const created = addedFactsViewSchema.parse((await add(id, [{ kind: "one_liner", text: "Worked the Berlin market at Acme", roleSectionId: "sec-exp-2", affirmed: true }], 0).expect(200)).body.view)
    const factId = created.facts[0]!.id
    await candidate.patch(factPath(id, factId)).send({ expectedVersion: 1, text: "Worked İstanbul market at Acme", roleSectionId: "sec-exp-2" }).expect(200)
    const refused = await add(id, [{ kind: "one_liner", text: "Worked İstanbul market at Acme", roleSectionId: "sec-exp-2", affirmed: true }], 2)
    expect(refused.status).toBe(422)
    expect(apiErrorResponseSchema.parse(refused.body).error.fieldErrors).toEqual([{ source: "added_facts", field: "text", position: 1, problem: "duplicate" }])
  })
})

describe("FEAT-0017 backend: SEC-R05 named tests", () => {
  it("with the flag off requeueAtsHeld keeps a held Application whose documents cite an added fact", async () => {
    const held = async (id: string) => {
      await database.db.updateTable("application").set({ submission_state: "blocked", submission_kind: "automatic", blocked_reason: "ats_below_minimum", blocked_detail: "ATS match 62% is below your minimum of 70%.", blocked_at: clock.now() }).where("id", "=", id).execute()
    }
    const stale = await application()
    const figma = await insertFact(stale.id, { kind: "skill_only", text: "Figma", term: "Figma" })
    await setDocumentsVersion(stale.id, 0, [], [figma])
    await held(stale.id)

    const fine = await application()
    await insertFact(fine.id, { kind: "skill_only", text: "Figma", term: "Figma" })
    await setDocumentsVersion(fine.id, 0, [], [])
    await held(fine.id)

    // Lowering the minimum to 0 is the requeue trigger; the same transaction sees both Applications.
    await offCandidate.put("/v1/candidate-settings/ats").send({ minAtsPercent: 0 }).expect(200)
    expect(await appRow(stale.id)).toMatchObject({ submission_state: "blocked" })
    expect(await appRow(fine.id)).toMatchObject({ submission_state: "queued" })
    await candidate.put("/v1/candidate-settings/ats").send({ minAtsPercent: 40 }).expect(200)
  })

  it("added-fact text never reaches a log line on add, generate or confirm", async () => {
    const marker = "MARKERzq7m4rk3rXyZW"
    const { id } = await application({ postingStatus: "skipped", postingSkip: "weak_core_match" })
    await setResumeGaps(id, [marker])
    await add(id, [{ kind: "skill_only", term: marker, affirmed: true }], 0).expect(200)
    for (const fact of LIFTING) await insertFact(id, fact)
    anthropic.replyWithObject(PROFILE_ONLY)
    anthropic.replyWithObject(SUPPORTS_ALL)
    await candidate.post(`/v1/applications/${id}/documents/generate`).expect(202)
    await app.get(DocumentsService).settled()
    await candidate.post(confirmPath(id)).send({ expectedVersion: 5 }).expect(200)

    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join("\n")).not.toContain(marker)
    // The text did reach the prompt, so the absence above is about the logs, not about the fact being ignored.
    expect(JSON.stringify(anthropic.requests)).toContain(marker)
  })

  it("a one-liner that becomes a contact detail when the header changes is not citable at generation", async () => {
    const marker = "Mentored juniors on 12 Marina Road"
    const address = "12 Marina Road"
    const { id } = await application({ postingStatus: "skipped", postingSkip: "weak_core_match" })
    for (const fact of LIFTING) await insertFact(id, fact)
    await add(id, [{ kind: "one_liner", text: marker, roleSectionId: "sec-exp-2", affirmed: true }], LIFTING.length).expect(200)
    await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Sam Example", lines: [address] }).expect(200)

    anthropic.replyWithObject(PROFILE_ONLY)
    anthropic.replyWithObject(SUPPORTS_ALL)
    await candidate.post(`/v1/applications/${id}/documents/generate`).expect(202)
    await app.get(DocumentsService).settled()

    const prompt = JSON.stringify(anthropic.requests)
    // The other added facts were citable, so the prompt really did carry added-fact text.
    expect(prompt).toContain(LIFTING[0]!.text)
    expect(prompt).not.toContain(marker)
    const snapshots = await database.db.selectFrom("tailored_document").select("added_facts").where("application_id", "=", id).execute()
    expect(snapshots).toHaveLength(2)
    for (const snapshot of snapshots) expect(JSON.stringify(snapshot.added_facts)).not.toContain(marker)
    // It is still the Candidate's fact; the header only keeps it out of the documents.
    expect((await view(id)).facts.map((fact) => fact.text)).toContain(marker)
  })
})
