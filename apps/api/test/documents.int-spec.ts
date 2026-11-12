import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import {
  DELETE_DETAILS_PATH,
  applicationDetailSchema,
  applicationsResponseSchema,
  createApplicationResponseSchema,
  documentsListResponseSchema,
} from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { DocumentsRepository } from "../src/documents/documents.repository.js"
import { DocumentsService } from "../src/documents/documents.service.js"
import type { CoverLetterContent, ResumeContent } from "../src/documents/document-model.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { extractPdfText } from "../src/documents/render.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { anthropicConfig } from "../src/config/env.js"
import { TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor } from "./support/candidate-posting.js"

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let storage: string
/** EPIC-0002 A2: the Operator's documents directory under the per-Candidate root. */
const docsDir = () => join(storage, "candidates", database.operatorId, "documents")
const clock = new TestClock("2026-10-20T09:00:00.000Z")

/**
 * Synthetic profile from the gherkin background. No real data. Fact IDs are UUIDs, as in production; the
 * model sees them as F1 to F4 (profile order), so the replies below cite F1 to F4 and the stored content
 * must hold these UUIDs.
 */
const V1 = [
  {
    id: "s1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021–2024",
    sourceQuote: null,
    facts: [
      { id: "6f1c0e8a-1111-4a6b-9a01-000000000001", text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", sourceQuote: null },
      { id: "6f1c0e8a-2222-4a6b-9a01-000000000002", text: "Senior Frontend Engineer at Brightwave Ltd, 2021–2024", sourceQuote: null },
      { id: "6f1c0e8a-3333-4a6b-9a01-000000000003", text: "Mentored 6 junior developers", sourceQuote: null },
      { id: "6f1c0e8a-4444-4a6b-9a01-000000000004", text: "Cut release cycle from 2 weeks to 3 days", sourceQuote: null },
    ],
  },
]
const V2_DRAFT = [{ ...V1[0], facts: [...V1[0]!.facts, { id: "6f1c0e8a-9999-4a6b-9a01-000000000009", text: "Staff Engineer at Brightwave Ltd, 2021–2024", sourceQuote: null }] }]

const GOOD = {
  resume: {
    summary: [{ text: "Senior Frontend Engineer who builds products from scratch to production.", factIds: ["F1", "F2"] }],
    experience: [
      {
        heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021–2024", factIds: ["F2"] },
        bullets: [
          { text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["F1"] },
          { text: "Cut the release cycle from 2 weeks to 3 days.", factIds: ["F4"] },
          { text: "Mentored 6 junior developers.", factIds: ["F3"] },
        ],
      },
    ],
    skills: [{ text: "React, TypeScript", factIds: ["F1"] }],
    education: [],
  },
  coverLetter: {
    paragraphs: [
      { text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
      { text: "I cut our release cycle from 2 weeks to 3 days and mentored 6 junior developers.", factIds: ["F3", "F4"] },
    ],
  },
}

/** A judge answer that supports every line it is sent (Revision 2, 2.1). */
const SUPPORTS_ALL = { results: Array.from({ length: 200 }, (_, id) => ({ id, supported: true })) }
const supportAll = () => anthropic.replyWithObject(SUPPORTS_ALL)

/** Direct service and repository calls run in the owner's (Operator's) scope, as the session gives it. */
const asOwner = <T>(work: () => Promise<T>) => app.get(TenantDatabase).asOperator(work)

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-docs-int-"))
  markStorageMigratedSync(join(storage, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  app = await createTestApp({
    databaseUrl: database.url,
    clock,
    config: { candidateStorageDir: join(storage, "candidates"), anthropic: anthropicConfig(TEST_ANTHROPIC_KEY, TEST_ANTHROPIC_MODEL, "claude-sonnet-5-5") },
  })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  await app.get(DocumentsService).settled()
  anthropic.install()
  anthropic.reset()
  await database.db.deleteFrom("tailored_document").execute()
  await database.db.deleteFrom("ai_call").execute()
  await database.db.deleteFrom("application").execute()
  await database.db.deleteFrom("eligibility_result").execute()
  await database.db.deleteFrom("candidate_posting").execute()
  await database.db.deleteFrom("job_posting").execute()
  await database.db.deleteFrom("career_profile_version").execute()
  await database.db.deleteFrom("ai_provider_approval").execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "", lines: "[]" }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

async function setup(options: { approve?: boolean; contact?: boolean; draft?: boolean } = {}) {
  if (options.approve !== false) await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
  await database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(V1), created_at: new Date(), approved_at: new Date() })
    .execute()
  if (options.draft) {
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 2, status: "draft", source: "edit", resume_upload_id: null, sections: JSON.stringify(V2_DRAFT), created_at: new Date(), approved_at: null })
      .execute()
  }
  if (options.contact !== false) {
    await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"] }).expect(200)
  }
}

async function posting(company: string, title: string, status = "ranked", requisition = `R-${company}`) {
  const id = crypto.randomUUID()
  await insertPostingFor(database.db, database.operatorId, {
      id,
      application_url: `https://boards.greenhouse.io/${company.toLowerCase().replace(/\W/g, "")}/jobs/1`,
      requisition_id: requisition,
      apply_url: `https://boards.greenhouse.io/${company.toLowerCase().replace(/\W/g, "")}/jobs/1`,
      application_system: "Greenhouse",
      apply_mode: "automatic",
      origin: "employer_board",
      employer_board_id: null,
      remote_board_key: null,
      attribution_name: null,
      attribution_url: null,
      title,
      company,
      posting_text: `${title} at ${company}. Remote, open to candidates in Nigeria. Build React features.`,
      status: status as "ranked",
      skip_reason: null,
      skip_detail: null,
      evaluation_failure: null,
      role_family: "senior_frontend",
      discovered_at: new Date(),
      evaluated_at: new Date(),
    })
  return id
}

/** An Eligibility result with the given rules violated (every other rule met). */
async function insertEligibility(jobPostingId: string, violated: readonly string[]) {
  const rules = ["location", "sponsorship", "pay", "hours", "industry"].map((rule) => ({ rule, result: violated.includes(rule) ? "violated" : "met", quote: null }))
  await database.db
    .insertInto("eligibility_result")
    .values({ candidate_id: database.operatorId, job_posting_id: jobPostingId, arrangement: "remote", relocation_country: null, employment_type: "direct", rules: JSON.stringify(rules), eligible: violated.length === 0, normalized_monthly_max_usd: null, fx_rate_date: null, evaluated_at: new Date() })
    .execute()
}

async function createApplication(jobPostingId: string) {
  const response = await candidate.post("/v1/applications").send({ jobPostingId })
  return { status: response.status, body: response.body }
}

async function generate(applicationId: string) {
  await candidate.post(`/v1/applications/${applicationId}/documents/generate`).expect(202)
  await app.get(DocumentsService).settled()
  return applicationDetailSchema.parse((await candidate.get(`/v1/applications/${applicationId}`).expect(200)).body)
}

/** The stored resume content of an Application, as the API stored it. */
async function storedResume(applicationId: string): Promise<ResumeContent> {
  const row = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", applicationId).where("kind", "=", "resume").executeTakeFirstOrThrow()
  return row.content as ResumeContent
}

describe("Generate again on ready documents", () => {
  async function readyApplication() {
    await setup()
    anthropic.replyWithObject(GOOD)
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    return application.id
  }

  it("redoes the documents of an Application that has not entered submission, including a sample awaiting review", async () => {
    const id = await readyApplication()
    await database.db.updateTable("application").set({ sample_state: "awaiting_review" }).where("id", "=", id).execute()
    anthropic.replyWithObject(GOOD)
    supportAll()
    expect((await generate(id)).state).toBe("documents_ready")
    expect(anthropic.requests).toHaveLength(4)
  })

  it("an automatic submission held below the ATS minimum can get new documents, and goes back to the queue once it reaches the minimum", async () => {
    const id = await readyApplication()
    const hold = { submission_state: "blocked" as const, submission_kind: "automatic" as const, blocked_reason: "ats_below_minimum" as const, blocked_detail: "ATS match 0% is below your minimum of 40%.", blocked_at: new Date() }
    await database.db.updateTable("application").set(hold).where("id", "=", id).execute()
    // Still below the default minimum (this posting names no keywords, so it scores 0): new documents, still held.
    anthropic.replyWithObject(GOOD)
    expect((await generate(id)).state).toBe("documents_ready")
    expect(await database.db.selectFrom("application").select(["submission_state", "blocked_reason"]).where("id", "=", id).executeTakeFirstOrThrow()).toEqual({ submission_state: "blocked", blocked_reason: "ats_below_minimum" })
    // With the gate off, the next generation releases it.
    await candidate.put("/v1/candidate-settings/ats").send({ minAtsPercent: 0 }).expect(200)
    expect(await database.db.selectFrom("application").select(["submission_state", "blocked_reason"]).where("id", "=", id).executeTakeFirstOrThrow()).toEqual({ submission_state: "queued", blocked_reason: null })
    await candidate.put("/v1/candidate-settings/ats").send({ minAtsPercent: 40 }).expect(200)
  })

  it.each([
    ["once submission has started", { submission_state: "queued" }],
    ["after the sample was approved", { sample_state: "approved" }],
  ] as const)("does nothing %s: what was sent keeps its documents", async (_name, change) => {
    const id = await readyApplication()
    await database.db.updateTable("application").set(change).where("id", "=", id).execute()
    await candidate.post(`/v1/applications/${id}/documents/generate`).expect(202)
    await app.get(DocumentsService).settled()
    expect(anthropic.requests).toHaveLength(2)
    const row = await database.db.selectFrom("application").select("state").where("id", "=", id).executeTakeFirstOrThrow()
    expect(row.state).toBe("documents_ready")
  })
})

describe("Applications (prepared) from ranked postings", () => {
  it("a ranked posting becomes one Application; a second create returns it", async () => {
    const jobPostingId = await posting("Acme Payments", "Senior Frontend Engineer")
    const first = await createApplication(jobPostingId)
    expect(first.status).toBe(201)
    const created = createApplicationResponseSchema.parse(first.body)
    expect(created.application).toMatchObject({ state: "prepared", company: "Acme Payments", careerProfileVersion: null })
    const second = await createApplication(jobPostingId)
    expect(second.status).toBe(200)
    expect(createApplicationResponseSchema.parse(second.body)).toMatchObject({ created: false, application: { id: created.application.id } })
    expect(applicationsResponseSchema.parse((await candidate.get("/v1/applications").expect(200)).body).applications).toHaveLength(1)
  })

  it("a ranked posting's Application is not an override", async () => {
    const jobPostingId = await posting("Acme Payments", "Senior Frontend Engineer")
    const created = createApplicationResponseSchema.parse((await createApplication(jobPostingId)).body)
    // v1.24.0: `override` is null on the summary; nothing is stored.
    expect(created.application.override).toBeNull()
    const row = await database.db.selectFrom("application").select(["candidate_override_at", "override_created_at"]).where("id", "=", created.application.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ candidate_override_at: null, override_created_at: null })
  })

  // r-AA (AA-1.1, AA-2.1, AA-2.2; apply-anyway.feature:59, :274): only an overridable decision with an acknowledgement
  // becomes an override, and the decision is stored. Supersedes the v1.23.0 "any skipped or excluded posting" case.
  it.each([
    ["skipped", "weak_core_match", null, []],
    ["excluded", "violated_rule", "industry", ["industry"]],
  ] as const)("apply anyway: an overridable %s posting with an acknowledgement becomes an Application storing the decision", async (status, skipReason, skipDetail, rules) => {
    const jobPostingId = await posting("Initech", "Engineer", status)
    await database.db.updateTable("candidate_posting").set({ skip_reason: skipReason, skip_detail: skipDetail }).where("job_posting_id", "=", jobPostingId).execute()
    if (rules.length > 0) await insertEligibility(jobPostingId, rules)
    const decision = { status, skipReason, skipDetail, violatedRules: [...rules] }
    const response = await candidate.post("/v1/applications").send({ jobPostingId, acknowledgement: { confirmed: true, decision } })
    expect(response.status).toBe(201)
    const created = createApplicationResponseSchema.parse(response.body)
    expect(created.application).toMatchObject({ state: "prepared", company: "Initech", override: { ...decision, applies: true, notAppliesReason: null } })
    const row = await database.db.selectFrom("application").select(["candidate_override_at", "override_status", "override_skip_reason", "override_skip_detail", "override_violated_rules"]).where("id", "=", created.application.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ candidate_override_at: null, override_status: status, override_skip_reason: skipReason, override_skip_detail: skipDetail, override_violated_rules: [...rules] })
  })

  it.each(["skipped", "excluded"])("r-AA (AA-1.2): a %s posting with no overridable reason is 409 override_not_allowed and creates nothing", async (status) => {
    const jobPostingId = await posting("Initech", "Engineer", status)
    const response = await createApplication(jobPostingId)
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe("override_not_allowed")
    expect(await database.db.selectFrom("application").select("id").where("job_posting_id", "=", jobPostingId).execute()).toEqual([])
  })

  it.each(["checking", "evaluation_failed"])("a %s posting can't become an Application", async (status) => {
    const jobPostingId = await posting("Initech", "Engineer", status)
    const response = await createApplication(jobPostingId)
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe("application_not_eligible")
  })

  it("an unknown posting is not_found", async () => {
    expect((await createApplication(crypto.randomUUID())).status).toBe(404)
  })
})

describe("Tailored Documents (AC 5.1 to 5.4)", () => {
  it("generates a resume and cover letter as PDF and DOCX, recording profile version 1, stored owner-only", async () => {
    await setup()
    anthropic.replyWithObject(GOOD)
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const detail = await generate(application.id)
    expect(detail).toMatchObject({ state: "documents_ready", careerProfileVersion: 1, blockedDocument: null })
    expect(detail.documents.map((document) => document.kind)).toEqual(["resume", "cover_letter"])
    expect(detail.documents[0]?.previewText.slice(0, 2)).toEqual(["Ada Okafor", "Lagos, Nigeria"])

    // Downloads: headers and real files.
    const pdf = await candidate.get(detail.documents[0]!.pdfUrl).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => done(null, Buffer.concat(chunks)))
    }).expect(200)
    expect(pdf.headers["content-type"]).toBe("application/pdf")
    expect(pdf.headers["content-disposition"]).toBe('attachment; filename="Resume - Acme Payments - R-Acme Payments.pdf"')
    expect(pdf.headers["x-content-type-options"]).toBe("nosniff")
    expect(pdf.headers["cache-control"]).toBe("private, no-store")
    const text = await extractPdfText(pdf.body as Buffer)
    expect(text).toContain("Built a React and TypeScript merchant dashboard from scratch to production.")
    expect(text).toContain("PROFESSIONAL EXPERIENCE")

    const docx = await candidate.get(detail.documents[1]!.docxUrl).expect(200)
    expect(docx.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(docx.headers["content-disposition"]).toContain("Cover letter - Acme Payments")

    const files = (await database.db.selectFrom("tailored_document").select(["pdf_storage_name", "docx_storage_name"]).execute()).flatMap((row) => [
      row.pdf_storage_name,
      row.docx_storage_name,
    ])
    expect(files).toHaveLength(4)
    expect((await stat(docsDir())).mode & 0o777).toBe(0o700)
    for (const file of files) expect((await stat(join(docsDir(), file))).mode & 0o777).toBe(0o600)

    // Metered, and contact details never reached the model.
    const calls = await database.db.selectFrom("ai_call").selectAll().execute()
    expect(calls).toHaveLength(2)
    expect(calls.find((call) => call.purpose === "tailored_documents")).toMatchObject({ purpose: "tailored_documents", status: "succeeded", application_id: application.id, model: "claude-sonnet-5-5" })
    // Tailoring runs on the documents model with room for the full resume, letter and thinking.
    expect(anthropic.requests[0]?.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 16000, output_config: { effort: "medium" } })
    const sent = JSON.stringify(anthropic.requests[0]?.body)
    expect(sent).not.toMatch(/Ada Okafor|ada@example\.com|\+234 800/)
    expect(sent).toContain("F1: Built a React and TypeScript merchant dashboard")
    // EPIC-0012 rule 4: no stored forward statements, no direction block.
    expect(sent).not.toContain("<company_direction>")
    // The model sees only aliases; what is stored cites the real fact IDs.
    expect(sent).not.toContain("6f1c0e8a")
    const storedResume = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", application.id).where("kind", "=", "resume").executeTakeFirstOrThrow()
    expect(JSON.stringify(storedResume.content)).toContain("6f1c0e8a-2222-4a6b-9a01-000000000002")
    expect(JSON.stringify(storedResume.content)).not.toMatch(/"F\d+"/)
  })

  it("keeps stored forward statements out of the prompt while DOCUMENT_DIRECTION_ENABLED is off (EPIC-0012 Revision 2, 2.4)", async () => {
    await setup()
    const jobPostingId = await posting("Acme Payments", "Senior Frontend Engineer")
    await database.db
      .updateTable("job_posting")
      .set({ forward_statements: JSON.stringify(["Acme aims to reach net zero by 2030", "Acme will run on renewable power by 2040"]) })
      .where("id", "=", jobPostingId)
      .execute()
    anthropic.replyWithObject(GOOD)
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(jobPostingId)).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    const sent = FakeAnthropic.promptOf(anthropic.requests[0]!)
    // Revision 2 addendum, B: the flag gates the block, so a stored quote is neither sent nor lent.
    expect(sent).not.toContain("<company_direction>")
    expect(sent).not.toContain("Acme aims to reach net zero by 2030")
    expect(sent).not.toContain("Acme will run on renewable power by 2040")
    // Extraction keeps storing the quotes on the posting row, flags off or on.
    const row = await database.db.selectFrom("job_posting").select("forward_statements").where("id", "=", jobPostingId).executeTakeFirstOrThrow()
    expect(row.forward_statements).toEqual(["Acme aims to reach net zero by 2030", "Acme will run on renewable power by 2040"])
  })

  it("each Application has its own documents", async () => {
    await setup()
    anthropic.replyWithObject(GOOD)
    supportAll()
    anthropic.replyWithObject(GOOD)
    supportAll()
    const acme = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const globex = createApplicationResponseSchema.parse((await createApplication(await posting("Globex", "Frontend Tech Lead"))).body).application
    const one = await generate(acme.id)
    const two = await generate(globex.id)
    expect(one.documents[0]?.pdfUrl).not.toBe(two.documents[0]?.pdfUrl)
    const rows = await database.db.selectFrom("tailored_document").select(["application_id", "pdf_storage_name"]).execute()
    expect(new Set(rows.map((row) => row.pdf_storage_name)).size).toBe(4)
    expect(documentsListResponseSchema.parse((await candidate.get("/v1/documents").expect(200)).body).rows).toHaveLength(2)
  })

  it.each([
    "10 years of Kubernetes experience",
    "Increased revenue by 40%",
    "Senior Frontend Engineer, 2018–2024",
    "AWS Certified Solutions Architect",
    "Staff Engineer at Brightwave Ltd",
  ])("an unsourced claim never reaches the resume: the line is dropped and the rest is kept: %s", async (claim) => {
    await setup()
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, skills: [...GOOD.resume.skills, { text: claim, factIds: ["F1", "F2"] }] } })
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const detail = await generate(application.id)
    expect(detail.state).toBe("documents_ready")
    const stored = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", application.id).where("kind", "=", "resume").executeTakeFirstOrThrow()
    expect(JSON.stringify(stored.content)).not.toContain(claim)
    expect(JSON.stringify(stored.content)).toContain("React, TypeScript")
  })

  it("an experience bullet with an unsourced claim falls back to its fact's approved wording", async () => {
    await setup()
    const bullets = [...GOOD.resume.experience[0]!.bullets.slice(0, 2), { text: "Mentored 6 junior developers in Kubernetes and Rust.", factIds: ["F3"] }]
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, experience: [{ ...GOOD.resume.experience[0]!, bullets }] } })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    const stored = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", application.id).where("kind", "=", "resume").executeTakeFirstOrThrow()
    expect(JSON.stringify(stored.content)).not.toContain("Kubernetes")
    expect(JSON.stringify(stored.content)).toContain("Mentored 6 junior developers")
  })

  it("repairs a four-keyword bullet to its fact wording and never blocks (EPIC-0012 rule 3)", async () => {
    await setup()
    const jobPostingId = await posting("Acme Payments", "Senior Frontend Engineer")
    await database.db
      .updateTable("job_posting")
      .set({
        technologies: JSON.stringify([{ name: "React", quote: "React" }, { name: "TypeScript", quote: "TypeScript" }]),
        ats_skills: JSON.stringify([{ name: "release cycle", quote: "release cycle" }, { name: "dashboard", quote: "dashboard" }]),
      })
      .where("id", "=", jobPostingId)
      .execute()
    const stuffed = {
      ...GOOD,
      resume: {
        ...GOOD.resume,
        skills: [],
        experience: [
          {
            ...GOOD.resume.experience[0]!,
            bullets: [
              ...GOOD.resume.experience[0]!.bullets,
              {
                text: "Built a React and TypeScript merchant dashboard from scratch to production, mentored 6 junior developers and cut the release cycle from 2 weeks to 3 days.",
                factIds: ["F1", "F3", "F4"],
              },
            ],
          },
        ],
      },
    }
    anthropic.replyWithObject(stuffed)
    const application = createApplicationResponseSchema.parse((await createApplication(jobPostingId)).body).application
    const detail = await generate(application.id)
    expect(detail).toMatchObject({ state: "documents_ready", blockedDocument: null })
    const stored = await storedResume(application.id)
    // The four-keyword line fell back to F1's plain wording instead of blocking.
    expect(JSON.stringify(stored)).not.toContain("mentored 6 junior developers and cut")
    expect(JSON.stringify(stored)).toContain("Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd")
  })

  it("a skills line with five keywords is left untouched (EPIC-0012 rule 3)", async () => {
    await setup()
    const jobPostingId = await posting("Acme Payments", "Senior Frontend Engineer")
    await database.db
      .updateTable("job_posting")
      .set({
        technologies: JSON.stringify([{ name: "React", quote: "React" }, { name: "TypeScript", quote: "TypeScript" }, { name: "Brightwave", quote: "Brightwave" }]),
        ats_skills: JSON.stringify([{ name: "dashboard", quote: "dashboard" }, { name: "release cycle", quote: "release cycle" }]),
      })
      .where("id", "=", jobPostingId)
      .execute()
    const skillsLine = "React, TypeScript, dashboard, Brightwave, release cycle"
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, skills: [{ text: skillsLine, factIds: ["F1", "F4"] }] } })
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(jobPostingId)).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    const stored = await storedResume(application.id)
    // A skills line lists many keywords by design: replacing it would drop skills and lower the ATS score.
    expect(stored.skills).toEqual([{ text: skillsLine, factIds: ["6f1c0e8a-1111-4a6b-9a01-000000000001", "6f1c0e8a-4444-4a6b-9a01-000000000004"] }])
  })

  it("a keyword in a skills line plus two body lines needs no repair (EPIC-0012 rule 3)", async () => {
    await setup()
    const jobPostingId = await posting("Acme Payments", "Senior Frontend Engineer")
    await database.db.updateTable("job_posting").set({ technologies: JSON.stringify([{ name: "React", quote: "React" }]) }).where("id", "=", jobPostingId).execute()
    const bullets = [
      GOOD.resume.experience[0]!.bullets[0]!,
      { text: "Built a React dashboard.", factIds: ["F1"] },
      GOOD.resume.experience[0]!.bullets[2]!,
    ]
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, experience: [{ ...GOOD.resume.experience[0]!, bullets }] } })
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(jobPostingId)).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    const stored = await storedResume(application.id)
    expect(stored.experience[0]?.bullets[1]?.text).toBe("Built a React dashboard.")
    expect(stored.skills).toEqual([{ text: "React, TypeScript", factIds: ["6f1c0e8a-1111-4a6b-9a01-000000000001"] }])
  })

  it("a keyword in three body lines repairs the third (EPIC-0012 rule 3)", async () => {
    await setup()
    const jobPostingId = await posting("Acme Payments", "Senior Frontend Engineer")
    await database.db.updateTable("job_posting").set({ technologies: JSON.stringify([{ name: "React", quote: "React" }]) }).where("id", "=", jobPostingId).execute()
    const bullets = [
      GOOD.resume.experience[0]!.bullets[0]!,
      { text: "Built a React dashboard.", factIds: ["F1"] },
      { text: "Built a React dashboard from scratch.", factIds: ["F1"] },
    ]
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, experience: [{ ...GOOD.resume.experience[0]!, bullets }] } })
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(jobPostingId)).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    const stored = await storedResume(application.id)
    expect(stored.experience[0]?.bullets[1]?.text).toBe("Built a React dashboard.")
    expect(stored.experience[0]?.bullets[2]).toEqual({
      text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd",
      factIds: ["6f1c0e8a-1111-4a6b-9a01-000000000001"],
    })
  })

  it("caps a keyword at three mentions in the cover letter, dropping the fourth sentence and never blocking (Revision 1, R7)", async () => {
    await setup()
    const jobPostingId = await posting("Acme Payments", "Senior Frontend Engineer")
    await database.db.updateTable("job_posting").set({ technologies: JSON.stringify([{ name: "React", quote: "React" }]) }).where("id", "=", jobPostingId).execute()
    anthropic.replyWithObject({
      ...GOOD,
      coverLetter: {
        paragraphs: [
          { text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
          { text: "I took a React and TypeScript merchant dashboard from scratch to production.", factIds: ["F1"] },
          { text: "My React and TypeScript work shipped a merchant dashboard to production.", factIds: ["F1"] },
          { text: "I built React merchant dashboards. Mentored 6 junior developers.", factIds: ["F1", "F3"] },
        ],
      },
    })
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(jobPostingId)).body).application
    const detail = await generate(application.id)
    expect(detail).toMatchObject({ state: "documents_ready", blockedDocument: null })
    const row = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", application.id).where("kind", "=", "cover_letter").executeTakeFirstOrThrow()
    const stored = row.content as CoverLetterContent
    // Three mentions stay; the fourth sentence drops, and its paragraph keeps its other sentence.
    expect(stored.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.",
      "I took a React and TypeScript merchant dashboard from scratch to production.",
      "My React and TypeScript work shipped a merchant dashboard to production.",
      "Mentored 6 junior developers.",
    ])
  })

  it.each([
    [true, "Mentored 6 junior developers through weekly pairing."],
    [false, "Mentored 6 junior developers"],
  ] as const)("a reworded bullet goes to the meaning check: supported %s stores %s", async (supported, stored) => {
    await setup()
    const bullets = [...GOOD.resume.experience[0]!.bullets.slice(0, 2), { text: "Mentored 6 junior developers through weekly pairing.", factIds: ["F3"] }]
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, experience: [{ ...GOOD.resume.experience[0]!, bullets }] } })
    anthropic.replyWithObject(supported ? SUPPORTS_ALL : { results: [] })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    expect(anthropic.requests).toHaveLength(2)
    expect(anthropic.requests[1]?.body.model).toBe(TEST_ANTHROPIC_MODEL)
    expect(JSON.stringify(anthropic.requests[1]?.body)).toContain("weekly pairing")
    const content = JSON.stringify((await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", application.id).where("kind", "=", "resume").executeTakeFirstOrThrow()).content)
    expect(content).toContain(stored)
    if (!supported) expect(content).not.toContain("weekly")
  })

  it("a failed meaning check accepts nothing extra: the reworded bullet falls back", async () => {
    await setup()
    const bullets = [...GOOD.resume.experience[0]!.bullets.slice(0, 2), { text: "Mentored 6 junior developers through weekly pairing.", factIds: ["F3"] }]
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, experience: [{ ...GOOD.resume.experience[0]!, bullets }] } })
    anthropic.replyWithStatus(529)
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    const content = JSON.stringify((await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", application.id).where("kind", "=", "resume").executeTakeFirstOrThrow()).content)
    expect(content).not.toContain("weekly")
  })

  it("a reworded line with a number or name its facts don't state never reaches the meaning check", async () => {
    await setup()
    const bullets = [...GOOD.resume.experience[0]!.bullets.slice(0, 2), { text: "Mentored 9 junior developers in Kubernetes.", factIds: ["F3"] }]
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, experience: [{ ...GOOD.resume.experience[0]!, bullets }] } })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    expect(anthropic.requests).toHaveLength(2)
    expect(FakeAnthropic.promptOf(anthropic.requests[1]!)).not.toContain("Mentored 9 junior developers in Kubernetes.")
  })

  it("one unsourced claim among sourced paragraphs is dropped from the cover letter, not sent", async () => {
    await setup()
    const sourced = Array.from({ length: 5 }, () => ({ text: "I mentored 6 junior developers.", factIds: ["F3"] }))
    anthropic.replyWithObject({ ...GOOD, coverLetter: { paragraphs: [...sourced, { text: "I led a team of 15 engineers.", factIds: ["F3"] }] } })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect((await generate(application.id)).state).toBe("documents_ready")
    const stored = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", application.id).where("kind", "=", "cover_letter").executeTakeFirstOrThrow()
    expect(JSON.stringify(stored.content)).not.toContain("15 engineers")
  })

  it("a refused paragraph keeps its judged sentences: only the unsupported sentence goes, and the letter is stored", async () => {
    await setup()
    const paragraph = "I bring energy to every team. I guided six junior developers week to week."
    anthropic.replyWithObject({ ...GOOD, coverLetter: { paragraphs: [{ text: paragraph, factIds: ["F3"] }] } })
    // The paragraph verdict is refused, as it was for the owner's blocked Applications.
    anthropic.replyWithObject({ results: [] })
    // The sentence pass supports the second sentence only.
    anthropic.replyWithObject({ results: [{ id: 0, supported: false }, { id: 1, supported: true }] })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const detail = await generate(application.id)
    expect(detail).toMatchObject({ state: "documents_ready", blockedDocument: null })
    expect(anthropic.requests).toHaveLength(3)
    const row = await database.db.selectFrom("tailored_document").select("content").where("application_id", "=", application.id).where("kind", "=", "cover_letter").executeTakeFirstOrThrow()
    const stored = row.content as CoverLetterContent
    expect(stored.paragraphs).toEqual([{ text: "I guided six junior developers week to week.", factIds: ["6f1c0e8a-3333-4a6b-9a01-000000000003"] }])
  })

  it("a paragraph refused at both levels still blocks, and the claim names the refused sentence", async () => {
    await setup()
    const paragraph = "I bring energy to every team. I guided six junior developers week to week."
    anthropic.replyWithObject({ ...GOOD, coverLetter: { paragraphs: [{ text: paragraph, factIds: ["F3"] }] } })
    anthropic.replyWithObject({ results: [] })
    anthropic.replyWithObject({ results: [] })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const detail = await generate(application.id)
    expect(detail).toMatchObject({ state: "documents_blocked", blockedDocument: "cover_letter", blockedClaim: "I bring energy to every team." })
  })

  it("a cover letter whose every paragraph is unsourced is still blocked", async () => {
    await setup()
    anthropic.replyWithObject({ ...GOOD, coverLetter: { paragraphs: [{ text: "I led a team of 15 engineers.", factIds: ["F3"] }] } })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect(await generate(application.id)).toMatchObject({ state: "documents_blocked", blockedDocument: "cover_letter", blockedClaim: "I led a team of 15 engineers." })
  })

  it("draft facts never reach a document: only version 1 is sent and used", async () => {
    await setup({ draft: true })
    anthropic.replyWithObject({ ...GOOD, resume: { ...GOOD.resume, summary: [{ text: "Staff Engineer at Brightwave Ltd.", factIds: ["F9"] }] } })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const detail = await generate(application.id)
    expect(detail.state).toBe("documents_blocked")
    expect(detail.careerProfileVersion).toBe(1)
    // The draft fact (its text and its ID) never reaches the prompt; "F9" is no alias, so the line is blocked.
    expect(JSON.stringify(anthropic.requests[0]?.body)).not.toContain("Staff Engineer at Brightwave")
    expect(JSON.stringify(anthropic.requests[0]?.body)).not.toContain("6f1c0e8a-9999")
  })

  it("regeneration replaces both documents and removes the old files", async () => {
    await setup()
    anthropic.replyWithObject(GOOD)
    supportAll()
    anthropic.replyWithObject(GOOD)
    supportAll()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const names = async () =>
      (await database.db.selectFrom("tailored_document").select(["pdf_storage_name", "docx_storage_name"]).where("application_id", "=", application.id).execute()).flatMap(
        (row) => [row.pdf_storage_name, row.docx_storage_name]
      )
    await generate(application.id)
    const before = await names()
    await generate(application.id)
    const after = await names()
    const onDisk = await readdir(docsDir())
    expect(after).toHaveLength(4)
    expect(after.some((file) => before.includes(file))).toBe(false)
    expect(before.some((file) => onDisk.includes(file))).toBe(false)
    expect(after.every((file) => onDisk.includes(file))).toBe(true)
  })

  it("without contact details, generation is refused and nothing is sent", async () => {
    await setup({ contact: false })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const response = await candidate.post(`/v1/applications/${application.id}/documents/generate`).expect(409)
    expect(response.body.error.code).toBe("contact_details_missing")
    expect(anthropic.requests).toHaveLength(0)
  })

  it("without provider approval nothing leaves the backend and the failure is shown", async () => {
    await setup({ approve: false })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect(await generate(application.id)).toMatchObject({ state: "documents_failed", failure: "not_approved" })
    expect(anthropic.requests).toHaveLength(0)
  })

  it("model output that doesn't fit the schema fails as invalid_output", async () => {
    await setup()
    anthropic.replyWithObject({ resume: "nope" })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    expect(await generate(application.id)).toMatchObject({ state: "documents_failed", failure: "invalid_output" })
  })
})

describe("slice 7: pauses stop document generation (AC 10.1, AC 10.2)", () => {
  it("while globally paused, generation does not start: no model request, back to prepared with no failure", async () => {
    await setup()
    const created = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body)
    await candidate.put("/v1/controls/global-pause").send({ paused: true }).expect(200)
    try {
      const detail = await generate(created.application.id)
      expect(anthropic.requests).toHaveLength(0)
      expect(detail).toMatchObject({ state: "prepared", failure: null })
    } finally {
      await candidate.put("/v1/controls/global-pause").send({ paused: false }).expect(200)
    }
  })

  it("a global pause turned on while the model call runs stops it within one minute; nothing is stored", async () => {
    await setup()
    const created = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body)
    anthropic.replyByHanging()
    await candidate.post(`/v1/applications/${created.application.id}/documents/generate`).expect(202)
    await anthropic.waitForRequests(1)
    const pausedAt = Date.now()
    await candidate.put("/v1/controls/global-pause").send({ paused: true }).expect(200)
    try {
      await app.get(DocumentsService).settled()
      expect(Date.now() - pausedAt).toBeLessThan(60_000)
      const detail = applicationDetailSchema.parse((await candidate.get(`/v1/applications/${created.application.id}`).expect(200)).body)
      expect(detail).toMatchObject({ state: "prepared", failure: null })
      expect(detail.documents).toEqual([])
    } finally {
      anthropic.release()
      await candidate.put("/v1/controls/global-pause").send({ paused: false }).expect(200)
    }
  }, 60_000)

  it("while cost-paused, regenerating keeps the earlier documents: back to documents_ready, no model request", async () => {
    await setup()
    const created = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body)
    anthropic.replyWithObject(GOOD)
    expect((await generate(created.application.id)).state).toBe("documents_ready")
    anthropic.reset()
    await database.db.updateTable("control_state").set({ cost_paused: true, cost_paused_month: "2026-10-01" }).execute()
    try {
      const detail = await generate(created.application.id)
      expect(anthropic.requests).toHaveLength(0)
      expect(detail).toMatchObject({ state: "documents_ready", failure: null })
      expect(detail.documents).toHaveLength(2)
    } finally {
      await database.db.updateTable("control_state").set({ cost_paused: false, cost_paused_month: null }).execute()
    }
  })
})

describe("access", () => {
  it("unauthenticated requests can't list, generate or download", async () => {
    const id = crypto.randomUUID()
    await browser.http().get("/v1/applications").expect(401)
    await browser.http().get(`/v1/applications/${id}/documents/resume.pdf`).expect(401)
    await browser.http().post(`/v1/applications/${id}/documents/generate`).expect(401)
    await browser.http().get("/v1/documents").expect(401)
  })

  it("a signed-in POST without the CSRF token is refused", async () => {
    await browser.http().post("/v1/applications").set("cookie", candidate.cookie).send({ jobPostingId: crypto.randomUUID() }).expect(403)
  })

  it.each(["resume.exe", "..%2F..%2Fetc%2Fpasswd", "resume.pdf.docx", "cover_letter.pdf"])("an unknown download name %s is not_found", async (file) => {
    await candidate.get(`/v1/applications/${crypto.randomUUID()}/documents/${file}`).expect(404)
  })

  it("a malformed application id is not_found", async () => {
    await candidate.get("/v1/applications/not-a-uuid").expect(404)
  })

  it("contact details are validated", async () => {
    await candidate.put("/v1/candidate-settings/contact").send({ fullName: "", lines: [] }).expect(400)
    await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada", lines: ["a", "b", "c", "d", "e", "f", "g"] }).expect(400)
    // Six lines fit a resume header: headline, location, phone, email and a profile link.
    await candidate.put("/v1/candidate-settings/contact").send({ fullName: "Ada", lines: ["a", "b", "c", "d", "e", "f"] }).expect(200)
  })
})

describe("repair wave 1: storage failure and restart (F-QA4-01, F-QA4-02)", () => {
  it("an unwritable document directory is recorded as storage_error, not provider_error", async () => {
    const locked = join(storage, "locked")
    await mkdir(locked, { mode: 0o700 })
    markStorageMigratedSync(locked)
    await chmod(locked, 0o500)
    const lockedApp = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: locked } })
    try {
      await setup()
      anthropic.replyWithObject(GOOD)
      const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
      const id = await startGeneratingRow(application.id)
      await lockedApp.get(TenantDatabase).asOperator(() => lockedApp.get(DocumentsService).generate(id))
      const row = await database.db.selectFrom("application").selectAll().where("id", "=", application.id).executeTakeFirstOrThrow()
      expect(row).toMatchObject({ state: "documents_failed", failure: "storage_error" })
      expect(await database.db.selectFrom("tailored_document").select("id").where("application_id", "=", application.id).execute()).toEqual([])
    } finally {
      await lockedApp.close()
      await chmod(locked, 0o700)
    }
  })

  it("an Application left in generating by a restart is reset to interrupted on startup, and retry regenerates", async () => {
    await setup()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    await database.db.updateTable("application").set({ state: "generating" }).where("id", "=", application.id).execute()

    // A new api process starts (the old one died mid-generation).
    const restarted = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: join(storage, "candidates") } })
    try {
      const after = await database.db.selectFrom("application").selectAll().where("id", "=", application.id).executeTakeFirstOrThrow()
      expect(after).toMatchObject({ state: "documents_failed", failure: "interrupted" })
    } finally {
      await restarted.close()
    }
    const summary = applicationDetailSchema.parse((await candidate.get(`/v1/applications/${application.id}`).expect(200)).body)
    expect(summary).toMatchObject({ state: "documents_failed", failure: "interrupted" })

    anthropic.replyWithObject(GOOD)
    supportAll()
    expect(await generate(application.id)).toMatchObject({ state: "documents_ready", failure: null })
    expect(anthropic.requests).toHaveLength(2)
  })
})

async function startGeneratingRow(id: string): Promise<string> {
  await database.db.updateTable("application").set({ state: "generating" }).where("id", "=", id).execute()
  return id
}

describe("repair wave 2: no orphan files (SEC-408)", () => {
  const filesOnDisk = async () => (await readdir(docsDir()).catch(() => [] as string[])).filter((name) => /\.(pdf|docx)$/.test(name))
  const rowFiles = async () =>
    (await database.db.selectFrom("tailored_document").select(["pdf_storage_name", "docx_storage_name"]).execute()).flatMap((row) => [row.pdf_storage_name, row.docx_storage_name])

  it("a regeneration that ends blocked removes the earlier documents' files", async () => {
    await setup()
    anthropic.replyWithObject(GOOD)
    supportAll()
    // Still blocks: a cover letter with no supported paragraph at all.
    anthropic.replyWithObject({ ...GOOD, coverLetter: { paragraphs: [{ text: "I led a team of 15 engineers.", factIds: ["F3"] }] } })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    await generate(application.id)
    const first = await rowFiles()
    expect(first).toHaveLength(4)
    expect((await generate(application.id)).state).toBe("documents_blocked")
    const onDisk = await filesOnDisk()
    expect(first.some((name) => onDisk.includes(name))).toBe(false)
  })

  it("a database failure after the files are written removes them", async () => {
    await setup()
    anthropic.replyWithObject(GOOD)
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const before = await filesOnDisk()
    const spy = vi.spyOn(app.get(DocumentsRepository), "recordDocuments").mockRejectedValueOnce(new Error("connection terminated"))
    try {
      await generate(application.id)
    } finally {
      spy.mockRestore()
    }
    expect(await filesOnDisk()).toEqual(before)
  })

  it("at startup, files with no tailored_document row are removed and referenced files are kept", async () => {
    await setup()
    anthropic.replyWithObject(GOOD)
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    await generate(application.id)
    const kept = await rowFiles()
    const orphan = `${crypto.randomUUID()}.pdf`
    await writeFile(join(docsDir(), orphan), "%PDF-orphan", { mode: 0o600 })
    const unrelated = "notes.txt"
    await writeFile(join(docsDir(), unrelated), "keep me", { mode: 0o600 })
    const restarted = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: join(storage, "candidates") } })
    await restarted.close()
    const onDisk = await readdir(docsDir())
    expect(onDisk).not.toContain(orphan)
    expect(onDisk).toContain(unrelated)
    for (const name of kept) expect(onDisk).toContain(name)
  })
})

describe("repair wave 3: the backend writes every sentence naming the employer or role (SEC-403 r2, F-QA4-06)", () => {
  it("a realistic letter with the model following the new prompt is ready, with the backend opening and closing", async () => {
    await setup()
    anthropic.replyWithObject({
      ...GOOD,
      coverLetter: {
        paragraphs: [
          { text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
          { text: "As a Senior Frontend Engineer at Brightwave Ltd from 2021 to 2024, I cut our release cycle from 2 weeks to 3 days.", factIds: ["F2", "F4"] },
          { text: "I mentored 6 junior developers along the way.", factIds: ["F3"] },
        ],
      },
    })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Brightwave Health", "Staff Engineer"))).body).application
    const detail = await generate(application.id)
    expect(detail).toMatchObject({ state: "documents_ready", blockedClaim: null })
    const letter = detail.documents.find((document) => document.kind === "cover_letter")!
    expect(letter.previewText).toContain("I am applying for the Staff Engineer role at Brightwave Health.")
    expect(letter.previewText).toContain("I would welcome the chance to discuss how I can contribute to Brightwave Health.")
    const pdf = await candidate.get(letter.pdfUrl).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => done(null, Buffer.concat(chunks)))
    }).expect(200)
    const text = await extractPdfText(pdf.body as Buffer)
    expect(text).toContain("I am applying for the Staff Engineer role at Brightwave Health.")
    expect(text).toContain("I would welcome the chance to discuss how I can contribute to Brightwave Health.")
    const sent = JSON.stringify(anthropic.requests[0]?.body)
    expect(sent).toMatch(/never name the employer or the role/i)
  })

  it("a model-written closing naming the employer blocks the letter and is returned", async () => {
    await setup()
    anthropic.replyWithObject({
      ...GOOD,
      coverLetter: {
        paragraphs: [
          { text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
          { text: "I would welcome the chance to bring this experience to Brightwave Health.", factIds: [] },
        ],
      },
    })
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Brightwave Health", "Staff Engineer"))).body).application
    expect(await generate(application.id)).toMatchObject({
      state: "documents_blocked",
      blockedDocument: "cover_letter",
      blockedClaim: "I would welcome the chance to bring this experience to Brightwave Health.",
    })
  })
})

describe("repair wave 1 (slice 7): deleting details holds against a generation in flight (SEC-701, AC 10.3)", () => {
  const filesOnDisk = async () => (await readdir(docsDir()).catch(() => [] as string[])).filter((name) => /\.(pdf|docx)$/.test(name))
  const documentRows = (id: string) => database.db.selectFrom("tailored_document").select("id").where("application_id", "=", id).execute()

  it("a delete while documents are generating is refused with 409; after the generation, deletion leaves 0 documents, 0 files and a 404 download", async () => {
    await setup()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const before = await filesOnDisk()
    anthropic.replyWithObjectWhenReleased(GOOD)
    await candidate.post(`/v1/applications/${application.id}/documents/generate`).expect(202)
    await anthropic.waitForHeld(1)
    try {
      const refused = await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [application.id] }).expect(409)
      expect(refused.body.error.code).toBe("application_state_conflict")
      expect((await database.db.selectFrom("application").select("details_deleted_at").where("id", "=", application.id).executeTakeFirstOrThrow()).details_deleted_at).toBeNull()
    } finally {
      anthropic.releaseHeld()
      await app.get(DocumentsService).settled()
    }
    expect(await documentRows(application.id)).toHaveLength(2)
    await candidate.post(DELETE_DETAILS_PATH).send({ applicationIds: [application.id] }).expect(200)
    expect(await documentRows(application.id)).toEqual([])
    expect(await filesOnDisk()).toEqual(before)
    await candidate.get(`/v1/applications/${application.id}/documents/resume.pdf`).expect(404)
  })

  it("a generation that finishes on a record deleted under it writes nothing back: 0 documents, 0 files, download 404", async () => {
    await setup()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const before = await filesOnDisk()
    anthropic.replyWithObjectWhenReleased(GOOD)
    await candidate.post(`/v1/applications/${application.id}/documents/generate`).expect(202)
    await anthropic.waitForHeld(1)
    try {
      // A delete that committed while the model call ran (the 409 above refuses it; this proves the writer guard on its own).
      await database.db.updateTable("application").set({ details_deleted_at: new Date(), final_status: "generating", role_title: null }).where("id", "=", application.id).execute()
    } finally {
      anthropic.releaseHeld()
      await app.get(DocumentsService).settled()
    }
    expect(await documentRows(application.id)).toEqual([])
    expect(await filesOnDisk()).toEqual(before)
    await candidate.get(`/v1/applications/${application.id}/documents/resume.pdf`).expect(404)
    expect((await database.db.selectFrom("application").select("state").where("id", "=", application.id).executeTakeFirstOrThrow()).state).not.toBe("documents_ready")
  })

  it("late failure, pause and blocked writers leave a deleted record as it is", async () => {
    await setup()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const repository = app.get(DocumentsRepository)
    expect(await asOwner(() => repository.startGenerating(application.id, new Date()))).toBe(true)
    const deletedAt = new Date("2026-10-20T08:00:00.000Z")
    await database.db.updateTable("application").set({ details_deleted_at: deletedAt, final_status: "generating" }).where("id", "=", application.id).execute()
    await asOwner(() => repository.markFailed(application.id, "provider_error", new Date()))
    await asOwner(() => repository.markPaused(application.id, new Date()))
    expect(await asOwner(() => repository.markBlocked(application.id, 1, "resume", { ok: false, reason: "unsupported_claim", claim: "Ten years of Kubernetes", unsupported: ["kubernetes"], hardFail: "claim_word" }, new Date()))).toEqual([])
    const row = await database.db.selectFrom("application").selectAll().where("id", "=", application.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ state: "generating", failure: null, blocked_claim: null, blocked_document: null, details_deleted_at: deletedAt })
  })

  it("a blocked Application can generate again and keeps no stale block data (EPIC-0009 OD-2)", async () => {
    await setup()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    const repository = app.get(DocumentsRepository)
    expect(await asOwner(() => repository.startGenerating(application.id, new Date()))).toBe(true)
    await asOwner(() =>
      repository.markBlocked(
        application.id,
        1,
        "cover_letter",
        { ok: false, reason: "unsupported_claim", claim: "I work well in remote teams.", unsupported: ["remote"], hardFail: "claim_word" },
        new Date()
      )
    )
    expect(await database.db.selectFrom("application").selectAll().where("id", "=", application.id).executeTakeFirstOrThrow()).toMatchObject({
      state: "documents_blocked",
      blocked_claim_cause: "unsupported_terms",
      blocked_claim_terms: ["remote"],
      blocked_claim_more_terms: 0,
    })
    // The check constraint `application_blocked_pair` refuses `generating` with a document still named, so this
    // passing is the regression test for the fix: the one UPDATE clears every block column with the state.
    expect(await asOwner(() => repository.startGenerating(application.id, new Date()))).toBe(true)
    expect(await database.db.selectFrom("application").selectAll().where("id", "=", application.id).executeTakeFirstOrThrow()).toMatchObject({
      state: "generating",
      blocked_document: null,
      blocked_claim: null,
      blocked_claim_cause: null,
      blocked_claim_terms: null,
      blocked_claim_more_terms: null,
    })
  })

  it("generation can't start on a record deleted after the request's check", async () => {
    await setup()
    const application = createApplicationResponseSchema.parse((await createApplication(await posting("Acme Payments", "Senior Frontend Engineer"))).body).application
    await database.db.updateTable("application").set({ details_deleted_at: new Date(), final_status: "prepared" }).where("id", "=", application.id).execute()
    expect(await asOwner(() => app.get(DocumentsRepository).startGenerating(application.id, new Date()))).toBe(false)
  })
})
