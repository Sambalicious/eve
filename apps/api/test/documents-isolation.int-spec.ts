import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { DocumentsService } from "../src/documents/documents.service.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync, candidateDir } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"
import { insertPostingFor } from "./support/candidate-posting.js"

/**
 * EPIC-0002 A1 unit 2 (documents group): Applications, Tailored Documents and
 * contact details belong to one Candidate. The other Candidate's Application
 * and files answer 404, their contact details are never read or overwritten,
 * and the owner can still create an Application for the same requisition.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let storage: string
let otherId: string
const clock = new TestClock("2026-10-16T09:00:00.000Z")
const POSTING_ID = "00000000-0000-4000-8000-0000000000d1"
const OTHER_APPLICATION_ID = "00000000-0000-4000-8000-0000000000d2"
const URL = "https://boards.greenhouse.io/shared/jobs/4242"

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-documents-iso-"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: markStorageMigratedSync(storage) } })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
})

beforeEach(async () => {
  for (const table of ["tailored_document", "application", "candidate_posting", "job_posting"] as const) await database.db.deleteFrom(table).execute()
  await database.db.deleteFrom("candidate_contact").where("candidate_id", "=", otherId).execute()
  await insertPostingFor(database.db, database.operatorId, { id: POSTING_ID, application_url: URL, requisition_id: "4242", apply_url: URL, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Shared Role", company: "Shared Co", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date("2026-10-01"), evaluated_at: new Date("2026-10-01") })
  await database.db
    .insertInto("application")
    .values({ id: OTHER_APPLICATION_ID, candidate_id: otherId, job_posting_id: POSTING_ID, application_url: URL, requisition_id: "4242", company: "Shared Co", role_title: "OTHER-ROLE", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date("2026-10-01T10:00:00Z"), updated_at: new Date("2026-10-01T10:00:00Z") })
    .execute()
  for (const kind of ["resume", "cover_letter"] as const) {
    const fileId = randomUUID()
    await writeFile(join(candidateDir(storage, otherId, "documents"), `${fileId}.pdf`), "OTHER-PDF")
    await writeFile(join(candidateDir(storage, otherId, "documents"), `${fileId}.docx`), "OTHER-DOCX")
    await database.db
      .insertInto("tailored_document")
      .values({ id: randomUUID(), candidate_id: otherId, application_id: OTHER_APPLICATION_ID, kind, career_profile_version: 1, content: "{}", pdf_storage_name: `${fileId}.pdf`, docx_storage_name: `${fileId}.docx`, pdf_sha256: "x", docx_sha256: "x", created_at: new Date() })
      .execute()
  }
  await database.db.insertInto("candidate_contact").values({ candidate_id: otherId, full_name: "OTHER-NAME", lines: JSON.stringify(["Nairobi"]), updated_at: new Date() }).execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

const otherApplication = () => database.db.selectFrom("application").select(["state", "role_title"]).where("id", "=", OTHER_APPLICATION_ID).executeTakeFirst()

describe("documents group is scoped to the session's Candidate", () => {
  it("lists none of the other Candidate's Applications or documents", async () => {
    expect((await owner.get("/v1/applications").expect(200)).body.applications).toEqual([])
    expect(JSON.stringify((await owner.get("/v1/documents").expect(200)).body)).not.toContain("OTHER-ROLE")
  })

  it("answers 404 to the other Candidate's Application, its generation and its files", async () => {
    await owner.get(`/v1/applications/${OTHER_APPLICATION_ID}`).expect(404)
    await owner.post(`/v1/applications/${OTHER_APPLICATION_ID}/documents/generate`).expect(404)
    for (const file of ["resume.pdf", "resume.docx", "cover-letter.pdf"]) {
      const response = await owner.get(`/v1/applications/${OTHER_APPLICATION_ID}/documents/${file}`)
      expect([404]).toContain(response.status)
      expect(response.text).not.toContain("OTHER-")
    }
    expect(await otherApplication()).toEqual({ state: "documents_ready", role_title: "OTHER-ROLE" })
  })

  it("creates the owner's own Application for a requisition the other Candidate already applied to", async () => {
    const created = await owner.post("/v1/applications").send({ jobPostingId: POSTING_ID })
    expect([200, 201]).toContain(created.status)
    expect(created.body.id).not.toBe(OTHER_APPLICATION_ID)
    const rows = await database.db.selectFrom("application").select("candidate_id").where("requisition_id", "=", "4242").execute()
    expect(rows).toHaveLength(2)
  })

  it("reads and writes only the owner's contact details", async () => {
    expect(JSON.stringify((await owner.get("/v1/candidate-settings/contact").expect(200)).body)).not.toContain("OTHER-NAME")
    await owner.put("/v1/candidate-settings/contact").send({ fullName: "Ada Okafor", lines: ["Lagos"] }).expect(200)
    const other = await database.db.selectFrom("candidate_contact").select("full_name").where("candidate_id", "=", otherId).executeTakeFirstOrThrow()
    expect(other.full_name).toBe("OTHER-NAME")
  })

  it("refuses a documents call outside any Candidate scope", async () => {
    await expect(app.get(DocumentsService).contact()).rejects.toBeInstanceOf(MissingCandidateScopeError)
  })
})
