import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type INestApplication, Logger } from "@nestjs/common"
import { careerProfileResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { CareerProfileService } from "../src/career-profile/career-profile.service.js"
import { TenantDatabase } from "../src/db/tenant-database.js"
import { Browser } from "./support/browser.js"
import { FakeAnthropic, OutboundRecorder } from "./support/fake-anthropic.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { PNG_BYTES, buildDocx, buildPdf, buildPlainZip } from "./support/resume-fixtures.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

let database: TestDatabase
let google: FakeGoogle
let anthropic: FakeAnthropic
let outbound: OutboundRecorder
let app: INestApplication
let browser: Browser
let candidate: SignedInCandidate
let storageDir: string
const clock = new TestClock("2026-10-16T12:00:00.000Z")

const PDF_TYPE = "application/pdf"
const BRIGHTWAVE_FACT = "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024"

/** What a well-behaved model returns for the synthetic resume. */
const faithfulExtraction = {
  sections: [
    {
      kind: "experience",
      title: "Senior Frontend Engineer",
      organization: "Brightwave Ltd",
      period: "2021-2024",
      sourceQuote: "Brightwave Ltd, Senior Frontend Engineer, 2021-2024",
      facts: [
        { text: BRIGHTWAVE_FACT, sourceQuote: BRIGHTWAVE_FACT },
        { text: "Cut checkout page load time by 38% by moving to server rendering", sourceQuote: "Cut checkout page load time by 38%" },
      ],
    },
    {
      kind: "skills",
      title: "Skills",
      organization: null,
      period: null,
      sourceQuote: "Skills: React, TypeScript, Node.js, GraphQL",
      facts: [{ text: "React, TypeScript, Node.js, GraphQL", sourceQuote: "React, TypeScript, Node.js, GraphQL" }],
    },
  ],
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "ja-resumes-"))
  markStorageMigratedSync(join(storageDir, "candidates"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  anthropic = new FakeAnthropic(google.server)
  outbound = new OutboundRecorder(google.server)
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: join(storageDir, "candidates") } })
  browser = new Browser(app, google)
  candidate = await signInCandidate(browser)
})

beforeEach(async () => {
  await app.get(CareerProfileService).settled()
  google.server.resetHandlers()
  anthropic.install()
  anthropic.reset()
  await database.db.deleteFrom("career_profile_version").execute()
  await database.db.deleteFrom("ai_call").execute()
  await database.db.deleteFrom("resume_upload").execute()
  await database.db.deleteFrom("ai_provider_approval").execute()
  outbound.reset()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storageDir, { recursive: true, force: true })
})

async function approveAnthropic(): Promise<void> {
  await candidate.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
}

function upload(bytes: Buffer, filename: string, contentType = PDF_TYPE, field = "resume") {
  return candidate.post("/v1/career-profile/resume").attach(field, bytes, { filename, contentType })
}

async function profile() {
  return careerProfileResponseSchema.parse((await candidate.get("/v1/career-profile").expect(200)).body)
}

/** Uploads the synthetic resume and waits for drafting to finish. */
async function draftFromResume(extraction: unknown = faithfulExtraction, bytes = buildPdf(), filename = "ada-okafor-resume.pdf") {
  anthropic.replyWithObject(extraction, { input: 2100, output: 640 })
  const accepted = await upload(bytes, filename).expect(202)
  await app.get(CareerProfileService).settled()
  return accepted
}

/** The version in use, read in the owner's (Operator's) scope as a session would. */
const versionInUse = () => app.get(TenantDatabase).asOperator(() => app.get(CareerProfileService).versionInUse())

function approve(version: number) {
  return candidate.post("/v1/career-profile/draft/approve").send({ version })
}

async function approvedVersion1() {
  await approveAnthropic()
  await draftFromResume()
  await approve(1).expect(200)
  return (await profile()).inUse
}

function editRequest(version: Awaited<ReturnType<typeof profile>>["inUse"], factText: (text: string) => string) {
  if (!version) throw new Error("no version")
  return {
    sections: version.sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      title: section.title,
      organization: section.organization,
      period: section.period,
      facts: section.facts.map((fact) => ({ id: fact.id, text: factText(fact.text) })),
    })),
  }
}

describe("AI provider gate on resume upload (AC 1.2)", () => {
  it("refuses the upload before reading it, stores nothing and makes zero outbound calls when Anthropic is not approved", async () => {
    anthropic.replyWithObject(faithfulExtraction)
    const response = await upload(buildPdf(), "ada-okafor-resume.pdf").expect(409)
    expect(response.body).toEqual({ error: { code: "ai_provider_not_approved", message: "Approve Anthropic before uploading your resume." } })
    expect(outbound.urls).toEqual([])
    expect(anthropic.requests).toHaveLength(0)
    expect(await database.db.selectFrom("resume_upload").selectAll().execute()).toEqual([])
    expect(await database.db.selectFrom("ai_call").selectAll().execute()).toEqual([])
    expect((await profile()).inUse).toBeNull()
  })

  it("sends the resume text to Anthropic only, once, after approval", async () => {
    await approveAnthropic()
    await draftFromResume()
    expect(outbound.urls).toEqual(["POST https://api.anthropic.com/v1/messages"])
    expect(FakeAnthropic.promptOf(anthropic.requests[0]!)).toContain(BRIGHTWAVE_FACT)
  })
})

describe("drafting from a resume (AC 1.1)", () => {
  it("uploading a PDF drafts version 1 awaiting approval, with every fact citing the resume", async () => {
    await approveAnthropic()
    const accepted = await draftFromResume()
    expect(accepted.body.drafting).toEqual({ status: "drafting", filename: "ada-okafor-resume.pdf", startedAt: "2026-10-16T12:00:00.000Z", failureReason: null })
    const body = await profile()
    expect(body.inUse).toBeNull()
    expect(body.drafting).toBeNull()
    expect(body.draft).toMatchObject({ version: 1, status: "draft", source: "resume", approvedAt: null, droppedFactCount: 0 })
    const facts = body.draft!.sections.flatMap((section) => section.facts)
    expect(facts.map((fact) => fact.text)).toContain(BRIGHTWAVE_FACT)
    expect(facts.every((fact) => fact.sourceQuote !== null && fact.sourceQuote.length > 0)).toBe(true)
    expect(body.history).toEqual([expect.objectContaining({ version: 1, status: "draft" })])
  })

  it("meters the extraction call's tokens against the upload", async () => {
    await approveAnthropic()
    await draftFromResume()
    const [upload] = await database.db.selectFrom("resume_upload").selectAll().execute()
    const [call] = await database.db.selectFrom("ai_call").selectAll().execute()
    expect(call).toMatchObject({ purpose: "career_profile_extraction", status: "succeeded", input_tokens: 2100, output_tokens: 640, resume_upload_id: upload?.id })
  })

  it("accepts a DOCX resume", async () => {
    await approveAnthropic()
    anthropic.replyWithObject(faithfulExtraction)
    await upload(buildDocx(), "ada-okafor-resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document").expect(202)
    await app.get(CareerProfileService).settled()
    expect((await profile()).draft?.version).toBe(1)
  })

  it("drops facts whose quotes are not in the resume, and counts them", async () => {
    await approveAnthropic()
    const invented = structuredClone(faithfulExtraction)
    invented.sections[0]!.facts.push({ text: "Led a team of 12 engineers at Google", sourceQuote: "Led a team of 12 engineers at Google" })
    invented.sections.push({
      kind: "experience",
      title: "Staff Engineer",
      organization: "Stripe",
      period: "2024-2025",
      sourceQuote: "Stripe, Staff Engineer, 2024-2025",
      facts: [{ text: "Designed the ledger", sourceQuote: "Designed the global ledger" }],
    })
    await draftFromResume(invented)
    const draft = (await profile()).draft!
    const texts = draft.sections.flatMap((section) => section.facts.map((fact) => fact.text))
    expect(texts).not.toContain("Led a team of 12 engineers at Google")
    expect(draft.sections.map((section) => section.organization)).not.toContain("Stripe")
    expect(draft.droppedFactCount).toBe(2)
  })

  it("fails with no_verified_facts when nothing the model returned is in the resume", async () => {
    await approveAnthropic()
    await draftFromResume({
      sections: [{ kind: "skills", title: "Skills", organization: null, period: null, sourceQuote: "Skills: Rust, Go", facts: [{ text: "Rust", sourceQuote: "Rust and Go expert" }] }],
    })
    const body = await profile()
    expect(body.draft).toBeNull()
    expect(body.drafting).toMatchObject({ status: "failed", failureReason: "no_verified_facts", filename: "ada-okafor-resume.pdf" })
  })

  it("fails with invalid_output when the model's JSON does not match the schema", async () => {
    await approveAnthropic()
    await draftFromResume({ profile: "free text" })
    expect((await profile()).drafting).toMatchObject({ status: "failed", failureReason: "invalid_output" })
    const [call] = await database.db.selectFrom("ai_call").selectAll().execute()
    expect(call?.status).toBe("invalid_output")
  })

  it("fails with provider_error on an Anthropic error, after one request", async () => {
    await approveAnthropic()
    anthropic.replyWithStatus(500)
    await upload(buildPdf(), "ada-okafor-resume.pdf").expect(202)
    await app.get(CareerProfileService).settled()
    expect((await profile()).drafting).toMatchObject({ status: "failed", failureReason: "provider_error" })
    expect(anthropic.requests).toHaveLength(1)
  })

  it("stores the file under a server-chosen name with mode 0600, never the uploaded name", async () => {
    await approveAnthropic()
    await draftFromResume(faithfulExtraction, buildPdf(), "../../../etc/cron.d/evil.pdf")
    const [row] = await database.db.selectFrom("resume_upload").selectAll().execute()
    expect(row?.original_filename).toBe("evil.pdf")
    expect(row?.storage_name).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    const files = await readdir(join(storageDir, "candidates", database.operatorId, "resumes"))
    expect(files).toContain(row?.storage_name)
    expect(files.every((name) => /^[0-9a-f-]{36}\.(pdf|docx)$/.test(name))).toBe(true)
    expect((await stat(join(storageDir, "candidates", database.operatorId, "resumes", row!.storage_name))).mode & 0o777).toBe(0o600)
  })
})

describe("upload validation", () => {
  beforeEach(approveAnthropic)

  it.each([
    ["a PNG", PNG_BYTES, "ada-okafor-resume.png", "image/png"],
    ["a PNG renamed .pdf with a PDF content type", PNG_BYTES, "ada-okafor-resume.pdf", PDF_TYPE],
    ["a zip renamed .docx", buildPlainZip(), "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["text renamed .pdf", Buffer.from("Ada Okafor resume in plain text"), "resume.pdf", PDF_TYPE],
    ["an empty file", Buffer.alloc(0), "resume.pdf", PDF_TYPE],
  ])("refuses %s with C-VAL-PROFILE-1 and creates nothing", async (_label, bytes, filename, contentType) => {
    const response = await upload(bytes, filename, contentType).expect(422)
    expect(response.body).toEqual({ error: { code: "resume_file_invalid", message: "Upload a PDF or DOCX resume up to 5 MB." } })
    expect(await database.db.selectFrom("resume_upload").selectAll().execute()).toEqual([])
    expect(outbound.urls).toEqual([])
  })

  it("refuses a file over 5 MB", async () => {
    const big = Buffer.concat([buildPdf(), Buffer.alloc(5 * 1024 * 1024)])
    const response = await upload(big, "big.pdf").expect(422)
    expect(response.body.error.code).toBe("resume_file_invalid")
    expect(outbound.urls).toEqual([])
  })

  it("refuses a file sent under another field name", async () => {
    await upload(buildPdf(), "resume.pdf", PDF_TYPE, "document").expect(422)
  })

  it("refuses a PDF with no readable text with C-PROFILE-4", async () => {
    const response = await upload(buildPdf(["Hi"]), "scan.pdf").expect(422)
    expect(response.body).toEqual({ error: { code: "resume_unreadable", message: "Couldn't draft a Career Profile from this file.", reason: "no_text" } })
    expect(outbound.urls).toEqual([])
  })

  it("refuses a JSON body on the upload route", async () => {
    await candidate.post("/v1/career-profile/resume").send({ resume: "x" }).expect(415)
  })

  it("refuses a second upload while one is drafting", async () => {
    anthropic.replyByHanging()
    await upload(buildPdf(), "a.pdf").expect(202)
    const second = await upload(buildPdf(), "b.pdf").expect(409)
    expect(second.body.error.code).toBe("resume_drafting_in_progress")
    await anthropic.waitForRequests(1)
    expect(anthropic.requests).toHaveLength(1)
    anthropic.release()
    await app.get(CareerProfileService).settled()
    expect((await profile()).drafting).toMatchObject({ status: "failed", failureReason: "provider_error" })
  })
})

// CR2-06: a draft that appears while drafting runs is not an Anthropic failure.
describe("drafting finishes after a draft appeared (CR2-06)", () => {
  it("records draft_exists, keeps the existing draft, and meters the call as succeeded", async () => {
    await approveAnthropic()
    anthropic.replyWithObjectWhenReleased(faithfulExtraction)
    await upload(buildPdf(), "ada-okafor-resume.pdf").expect(202)
    // The model call is in flight once Anthropic holds it (drafting sends it in the background).
    await anthropic.waitForHeld()
    // The race: a draft lands while the model call is in flight (here written
    // directly, as the save endpoint refuses while drafting). It is strictly newer
    // than the upload, as it always is in this race (QA-2B-01: equal timestamps hid it).
    const uploadStartedAt = clock.now()
    clock.set(new Date(uploadStartedAt.getTime() + 60_000))
    await database.db
      .insertInto("career_profile_version")
      .values({ candidate_id: database.operatorId, version: 1, status: "draft", source: "edit", resume_upload_id: null, sections: JSON.stringify([]), created_at: clock.now(), approved_at: null })
      .execute()
    anthropic.releaseHeld()
    await app.get(CareerProfileService).settled()
    // GET /v1/career-profile reports the failed attempt (contract v1.3.0).
    const response = await candidate.get("/v1/career-profile").expect(200)
    const body = careerProfileResponseSchema.parse(response.body)
    expect(body.drafting).toEqual({
      status: "failed",
      filename: "ada-okafor-resume.pdf",
      startedAt: uploadStartedAt.toISOString(),
      failureReason: "draft_exists",
    })
    expect(body.draft).toMatchObject({ version: 1, source: "edit" })
    const [call] = await database.db.selectFrom("ai_call").selectAll().execute()
    expect(call?.status).toBe("succeeded")
    clock.set(uploadStartedAt)
  })
})

describe("versions (AC 1.1, r2)", () => {
  it("approving version 1 makes it the version in use", async () => {
    await approveAnthropic()
    await draftFromResume()
    const response = await approve(1).expect(200)
    expect(response.body.inUse).toMatchObject({ version: 1, status: "approved", approvedAt: "2026-10-16T12:00:00.000Z" })
    expect(response.body.draft).toBeNull()
    expect((await versionInUse())?.version).toBe(1)
  })

  it("a draft has no effect: with no approved version nothing is in use", async () => {
    await approveAnthropic()
    await draftFromResume()
    expect(await versionInUse()).toBeUndefined()
  })

  it("editing an approved profile creates draft version 2 and version 1 stays in use", async () => {
    const v1 = await approvedVersion1()
    const saved = await candidate.put("/v1/career-profile/draft").send(editRequest(v1, (text) => text.replace("team of 4", "team of 5"))).expect(200)
    expect(saved.body).toMatchObject({ version: 2, status: "draft", source: "edit" })
    const edited = saved.body.sections[0].facts[0]
    expect(edited).toMatchObject({ text: "Led a team of 5 frontend engineers at Brightwave Ltd, 2021-2024", sourceQuote: null })
    const inUse = await versionInUse()
    expect(inUse?.version).toBe(1)
    expect(JSON.stringify(inUse)).not.toContain("team of 5")
  })

  it("editing does not need Anthropic and sends nothing", async () => {
    const v1 = await approvedVersion1()
    await database.db.deleteFrom("ai_provider_approval").execute()
    outbound.reset()
    await candidate.put("/v1/career-profile/draft").send(editRequest(v1, (text) => text)).expect(200)
    expect(outbound.urls).toEqual([])
  })

  it("only one draft exists: a second save updates version 2", async () => {
    const v1 = await approvedVersion1()
    await candidate.put("/v1/career-profile/draft").send(editRequest(v1, (text) => text.replace("team of 4", "team of 5"))).expect(200)
    const draft = (await profile()).draft!
    const second = await candidate
      .put("/v1/career-profile/draft")
      .send(editRequest(draft, (text) => text.replace("38%", "40%")))
      .expect(200)
    expect(second.body.version).toBe(2)
    const texts = second.body.sections.flatMap((section: { facts: { text: string }[] }) => section.facts.map((fact) => fact.text))
    expect(texts.join("\n")).toContain("team of 5")
    expect(texts.join("\n")).toContain("40%")
    expect((await profile()).history.map((summary) => summary.version)).toEqual([2, 1])
  })

  it("approving version 2 replaces version 1", async () => {
    const v1 = await approvedVersion1()
    await candidate.put("/v1/career-profile/draft").send(editRequest(v1, (text) => text.replace("team of 4", "team of 5"))).expect(200)
    clock.set("2026-10-17T08:00:00.000Z")
    const response = await approve(2).expect(200)
    clock.set("2026-10-16T12:00:00.000Z")
    expect(response.body.inUse).toMatchObject({ version: 2, status: "approved", approvedAt: "2026-10-17T08:00:00.000Z" })
    expect(response.body.history.map((summary: { version: number; status: string }) => [summary.version, summary.status])).toEqual([
      [2, "approved"],
      [1, "replaced"],
    ])
    const v1Now = await candidate.get("/v1/career-profile/versions/1").expect(200)
    expect(v1Now.body).toMatchObject({ status: "replaced", approvedAt: "2026-10-16T12:00:00.000Z" })
    expect(JSON.stringify(v1Now.body)).toContain("team of 4")
  })

  it("approving a draft with an empty fact is refused and version 1 stays in use", async () => {
    const v1 = await approvedVersion1()
    let first = true
    await candidate
      .put("/v1/career-profile/draft")
      .send(editRequest(v1, (text) => (first ? ((first = false), "") : text)))
      .expect(200)
    const response = await approve(2).expect(422)
    expect(response.body).toEqual({ error: { code: "career_profile_fact_empty", message: "Enter the fact or remove it." } })
    const body = await profile()
    expect(body.draft?.status).toBe("draft")
    expect(body.inUse?.version).toBe(1)
  })

  it("discarding draft version 2 deletes it and leaves version 1 in use", async () => {
    const v1 = await approvedVersion1()
    await candidate.put("/v1/career-profile/draft").send(editRequest(v1, (text) => text)).expect(200)
    await candidate.delete("/v1/career-profile/draft?version=2").expect(204)
    const body = await profile()
    expect(body.draft).toBeNull()
    expect(body.inUse?.version).toBe(1)
    await candidate.get("/v1/career-profile/versions/2").expect(404)
  })

  it("approving a version that is not the current draft is 404", async () => {
    await approvedVersion1()
    await approve(1).expect(404)
    await approve(7).expect(404)
  })

  it("a new resume cannot be uploaded while a draft exists", async () => {
    await approveAnthropic()
    await draftFromResume()
    const response = await upload(buildPdf(), "again.pdf").expect(409)
    expect(response.body.error.code).toBe("career_profile_draft_exists")
    expect(anthropic.requests).toHaveLength(1)
  })

  it("concurrent saves on an approved profile create exactly one draft", async () => {
    const v1 = await approvedVersion1()
    const request = editRequest(v1, (text) => text)
    const results = await Promise.all(Array.from({ length: 5 }, () => candidate.put("/v1/career-profile/draft").send(request)))
    expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200])
    const versions = await database.db.selectFrom("career_profile_version").select(["version", "status"]).orderBy("version").execute()
    expect(versions).toEqual([
      { version: 1, status: "approved" },
      { version: 2, status: "draft" },
    ])
  })

  it.each([
    [{ sections: [] }],
    [{ sections: [{ kind: "experience", title: "", organization: null, period: null, facts: [] }] }],
    [{ sections: [{ kind: "nope", title: "x", organization: null, period: null, facts: [] }] }],
  ])("refuses an invalid draft body %o", async (body) => {
    await approvedVersion1()
    await candidate.put("/v1/career-profile/draft").send(body).expect(400)
  })
})

describe("unauthenticated requests", () => {
  it("cannot approve a Career Profile draft; it stays a draft", async () => {
    await approveAnthropic()
    await draftFromResume()
    await browser.http().post("/v1/career-profile/draft/approve").send({ version: 1 }).expect(401)
    expect((await profile()).draft?.status).toBe("draft")
  })

  it("cannot save an edited draft; no version 2 exists", async () => {
    const v1 = await approvedVersion1()
    await browser.http().put("/v1/career-profile/draft").send(editRequest(v1, (text) => text)).expect(401)
    expect((await profile()).history.map((summary) => summary.version)).toEqual([1])
  })

  it.each([
    ["GET", "/v1/career-profile"],
    ["GET", "/v1/career-profile/versions/1"],
    ["POST", "/v1/career-profile/resume"],
    ["DELETE", "/v1/career-profile/draft"],
  ])("refuses %s %s", async (method, path) => {
    const response = await browser.http()[method.toLowerCase() as "get"](path).expect(401)
    expect(response.body.error.code).toBe("unauthenticated")
  })

  it("cannot upload a resume: nothing stored, nothing sent", async () => {
    await approveAnthropic()
    await browser.http().post("/v1/career-profile/resume").attach("resume", buildPdf(), "r.pdf").expect(401)
    expect(await database.db.selectFrom("resume_upload").selectAll().execute()).toEqual([])
    expect(outbound.urls).toEqual([])
  })

  it("a signed-in upload without the CSRF token is refused", async () => {
    await approveAnthropic()
    await browser.http().post("/v1/career-profile/resume").set("cookie", candidate.cookie).attach("resume", buildPdf(), "r.pdf").expect(403)
    expect(await database.db.selectFrom("resume_upload").selectAll().execute()).toEqual([])
  })
})

describe("restart recovery", () => {
  it("marks a drafting upload left by a previous process as failed on boot", async () => {
    await database.db
      .insertInto("resume_upload")
      .values({ candidate_id: database.operatorId,
        id: "11111111-1111-4111-8111-111111111111",
        original_filename: "ada.pdf",
        media_type: PDF_TYPE,
        byte_size: 10,
        sha256: "x",
        storage_name: "11111111-1111-4111-8111-111111111111.pdf",
        status: "drafting",
        failure_reason: null,
        started_at: clock.now(),
        finished_at: null,
      })
      .execute()
    const restarted = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: join(storageDir, "candidates") } })
    await restarted.close()
    expect((await profile()).drafting).toMatchObject({ status: "failed", failureReason: "timed_out" })
  })
})

describe("no career data or key in logs", () => {
  it("logs neither resume text, model output, nor the API key across success and failure paths", async () => {
    const lines: string[] = []
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
    for (const level of ["log", "error", "warn", "debug", "verbose"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(capture)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true))
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true))
    const consoleSpies = (["log", "error", "warn", "info", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(capture))
    try {
      await approveAnthropic()
      await draftFromResume({ profile: "MODEL-OUTPUT-SENTINEL Led a team of 4" })
      anthropic.replyWithStatus(500)
      await upload(buildPdf(), "ada.pdf").expect(202)
      await app.get(CareerProfileService).settled()
      await draftFromResume()
    } finally {
      stderr.mockRestore()
      stdout.mockRestore()
      for (const spy of consoleSpies) spy.mockRestore()
      vi.restoreAllMocks()
    }
    const all = lines.join("\n")
    expect(all).not.toContain("Brightwave")
    expect(all).not.toContain("MODEL-OUTPUT-SENTINEL")
    expect(all).not.toContain("SYNTHETIC-KEY-SENTINEL")
  })
})

// QA-F2: on the compose stack the resume volume was not writable by the api user.
describe("resume storage unavailable (QA-F2)", () => {
  it("answers 503 resume_storage_unavailable, records storage_error, and never calls Anthropic", async () => {
    const readOnlyDir = join(storageDir, "read-only")
    await mkdir(readOnlyDir, { mode: 0o755 })
    markStorageMigratedSync(readOnlyDir)
    await chmod(readOnlyDir, 0o555)
    const unwritable = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: readOnlyDir } })
    try {
      const unwritableBrowser = new Browser(unwritable, google)
      const signedIn = await signInCandidate(unwritableBrowser)
      await signedIn.post("/v1/ai-provider/approval").send({ termsCheckedOn: "2026-10-16" }).expect(200)
      anthropic.replyWithObject(faithfulExtraction)
      outbound.reset() // sign-in above talked to the fake Google; count only the upload from here
      const response = await signedIn
        .post("/v1/career-profile/resume")
        .attach("resume", buildPdf(), { filename: "ada-okafor-resume.pdf", contentType: PDF_TYPE })
        .expect(503)
      expect(response.body).toEqual({
        error: { code: "resume_storage_unavailable", message: "Couldn't save your resume on the server. Nothing was sent to Anthropic. Try again later." },
      })
      await unwritable.get(CareerProfileService).settled()
      expect(anthropic.requests).toHaveLength(0)
      expect(outbound.urls).toEqual([])
      expect(await database.db.selectFrom("ai_call").selectAll().execute()).toEqual([])
      const [row] = await database.db.selectFrom("resume_upload").selectAll().execute()
      expect(row).toMatchObject({ status: "failed", failure_reason: "storage_error" })
      const profile = careerProfileResponseSchema.parse((await signedIn.get("/v1/career-profile").expect(200)).body)
      expect(profile.drafting).toMatchObject({ status: "failed", failureReason: "storage_error" })
    } finally {
      await unwritable.close()
      await chmod(readOnlyDir, 0o755)
    }
  })
})

