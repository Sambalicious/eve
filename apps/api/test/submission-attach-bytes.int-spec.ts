import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CandidateFiles } from "../src/files/candidate-files.js"
import type { FormSession, FormSessionFactory } from "../src/submission/form-session.js"
import { SubmissionService } from "../src/submission/submission.service.js"
import { insertEligibilityFor, insertPostingFor } from "./support/candidate-posting.js"
import { FakeAtsForms, STANDARD_FORM } from "./support/fake-ats-form.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * QA gap test (qa-1, A2 repair wave 2, F-SEC-03 regression). `FormSession.attach`
 * now takes a StoredDocument whose bytes come only through CandidateFiles.read.
 * The shared fake form records the document name and never reads it, so no other
 * test proves which bytes reach the upload. This wraps the fake to read each
 * attached document and checks the bytes against the files written for this
 * Application: the right Candidate, the right kind, and the PDF, not the DOCX.
 */
let database: TestDatabase
let app: INestApplication
let storage: string
let files: CandidateFiles
let otherCandidate: string
const forms = new FakeAtsForms()
const uploaded: Array<Readonly<{ ref: string; name: string; bytes: Buffer }>> = []
const clock = new TestClock("2026-10-20T09:00:00.000Z")
const APPLY_HOST = "boards.greenhouse.io"

const readingForms: FormSessionFactory = {
  async create(attemptId: string): Promise<FormSession> {
    const session = await forms.create(attemptId)
    return {
      ...session,
      attach: async (ref, document) => {
        uploaded.push({ ref, name: document.name, bytes: await document.read() })
        await session.attach(ref, document)
      },
    }
  },
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-qa-attach-"))
  markStorageMigratedSync(storage)
  files = new CandidateFiles(storage)
  database = await startMigratedDatabase()
  otherCandidate = await insertSecondCandidate(database.db)
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: storage }, formSessions: readingForms, questionSchemas: forms.questionSchemas })
})

beforeEach(async () => {
  uploaded.length = 0
  await database.db.updateTable("activation_state").set({ gate_passed_at: new Date("2026-10-19T12:00:00Z"), automatic_enabled: true, existing_applications_completed_at: new Date() }).execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
  await database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
})

afterAll(async () => {
  await app?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

type Stored = { name: string; pdf: Buffer; docx: string }

/** A queued automatic Application whose Tailored Documents exist on disk with random bytes. */
async function queuedWithFiles(): Promise<{ id: string; resume: Stored; cover: Stored }> {
  const requisition = `R-${randomUUID().slice(0, 6)}`
  const url = `https://${APPLY_HOST}/acme/jobs/${requisition}`
  const postingId = randomUUID()
  await insertPostingFor(database.db, database.operatorId, {
    id: postingId, application_url: url, requisition_id: requisition, apply_url: url, application_system: "greenhouse", apply_mode: "automatic",
    origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null,
    title: "Senior Frontend Engineer", company: `Acme ${requisition}`, posting_text: "Remote, open to candidates in Nigeria.", status: "ranked",
    skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date(), evaluated_at: new Date(),
  })
  await insertEligibilityFor(database.db, database.operatorId, postingId)
  const id = randomUUID()
  await database.db
    .insertInto("application")
    .values({
      candidate_id: database.operatorId, id, job_posting_id: postingId, application_url: url, requisition_id: requisition, company: `Acme ${requisition}`,
      role_title: "Senior Frontend Engineer", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null,
      created_at: new Date(), updated_at: new Date(), submission_state: "queued", submission_kind: "automatic",
    })
    .execute()
  const stored = {} as Record<"resume" | "cover_letter", Stored>
  for (const kind of ["resume", "cover_letter"] as const) {
    const item: Stored = { name: `${randomUUID()}.pdf`, pdf: randomBytes(4096 + Math.floor(Math.random() * 4096)), docx: `${randomUUID()}.docx` }
    await files.write(database.operatorId, "documents", item.name, item.pdf)
    await files.write(database.operatorId, "documents", item.docx, randomBytes(2048))
    // A decoy with the same storage name in another Candidate's directory: the upload must never be these bytes.
    await files.write(otherCandidate, "documents", item.name, Buffer.from(`decoy for ${kind}`))
    await database.db
      .insertInto("tailored_document")
      .values({ candidate_id: database.operatorId, id: randomUUID(), application_id: id, kind, career_profile_version: 1, content: "{}", pdf_storage_name: item.name, docx_storage_name: item.docx, pdf_sha256: "x", docx_sha256: "x", created_at: new Date() })
      .execute()
    stored[kind] = item
  }
  return { id, resume: stored.resume, cover: stored.cover_letter }
}

describe("submission attach uploads the stored document bytes (F-SEC-03 regression)", () => {
  it("the resume field gets the Operator's resume PDF bytes, byte for byte", async () => {
    forms.use({ host: APPLY_HOST, controls: STANDARD_FORM })
    const { id, resume } = await queuedWithFiles()
    expect(await asOperator(app, app.get(SubmissionService)).submit(id, "automatic")).toEqual({ result: "confirmed" })
    expect(uploaded.map((item) => [item.ref, item.name])).toEqual([["resume", resume.name]])
    expect(uploaded[0]?.bytes.equals(resume.pdf)).toBe(true)
  })

  it("with a cover letter field, each field gets its own document's bytes", async () => {
    forms.use({ host: APPLY_HOST, controls: [...STANDARD_FORM, { ref: "cl", label: "Cover Letter", kind: "file", required: false }], afterSubmit: "Your application ID: GH-889201" })
    const { id, resume, cover } = await queuedWithFiles()
    expect(await asOperator(app, app.get(SubmissionService)).submit(id, "automatic")).toEqual({ result: "confirmed" })
    expect(uploaded.map((item) => [item.ref, item.name])).toEqual([["resume", resume.name], ["cl", cover.name]])
    expect(uploaded[0]?.bytes.equals(resume.pdf)).toBe(true)
    expect(uploaded[1]?.bytes.equals(cover.pdf)).toBe(true)
  })
})
