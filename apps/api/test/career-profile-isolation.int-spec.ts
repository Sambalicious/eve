import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { INestApplication } from "@nestjs/common"
import { careerProfileResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CareerProfileService } from "../src/career-profile/career-profile.service.js"
import { MissingCandidateScopeError } from "../src/db/candidate-scope.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, markStorageMigratedSync } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * EPIC-0002 A1 unit 2 (career-profile group): versions, drafts and resume
 * uploads belong to one Candidate. The other Candidate's approved version,
 * draft and in-progress upload are invisible to the owner, answer 404, and
 * never block or renumber the owner's own draft.
 */
let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let owner: SignedInCandidate
let storage: string
let otherId: string
const clock = new TestClock("2026-10-16T09:00:00.000Z")

const section = (title: string) => ({ id: randomUUID(), kind: "experience", title, organization: "Other Co", period: "2020", sourceQuote: null, facts: [{ id: randomUUID(), text: `${title} fact`, sourceQuote: null }] })
const editRequest = { sections: [{ kind: "experience", title: "Owner role", organization: "Owner Co", period: "2024", facts: [{ text: "Owner fact" }] }] }

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), "ja-profile-iso-"))
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock, config: { candidateStorageDir: markStorageMigratedSync(storage) } })
  owner = await signInCandidate(new Browser(app, google))
  otherId = await insertSecondCandidate(database.db)
})

beforeEach(async () => {
  await database.db.deleteFrom("career_profile_version").execute()
  await database.db.deleteFrom("resume_upload").execute()
  const now = new Date("2026-10-10T09:00:00.000Z")
  await database.db
    .insertInto("career_profile_version")
    .values([
      { candidate_id: otherId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify([section("OTHER-APPROVED")]), rejected_fact_count: 0, created_at: now, approved_at: now },
      { candidate_id: otherId, version: 2, status: "draft", source: "edit", resume_upload_id: null, sections: JSON.stringify([section("OTHER-DRAFT")]), rejected_fact_count: 0, created_at: now, approved_at: null },
    ])
    .execute()
  await database.db
    .insertInto("resume_upload")
    .values({ candidate_id: otherId, id: randomUUID(), original_filename: "other.pdf", media_type: "application/pdf", byte_size: 10, sha256: "x", storage_name: "other.pdf", status: "drafting", failure_reason: null, started_at: now, finished_at: null })
    .execute()
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
  await rm(storage, { recursive: true, force: true })
})

const otherVersions = () => database.db.selectFrom("career_profile_version").select(["version", "status"]).where("candidate_id", "=", otherId).orderBy("version").execute()

describe("career-profile group is scoped to the session's Candidate", () => {
  it("shows none of the other Candidate's versions, draft or upload, and answers 404 to their version", async () => {
    const body = (await owner.get("/v1/career-profile").expect(200)).body
    careerProfileResponseSchema.parse(body)
    expect(JSON.stringify(body)).not.toMatch(/OTHER-|other\.pdf/)
    await owner.get("/v1/career-profile/versions/1").expect(404)
    await owner.get("/v1/career-profile/versions/2").expect(404)
  })

  it("saves the owner's own draft as version 1, unblocked by the other Candidate's draft and upload", async () => {
    const saved = (await owner.put("/v1/career-profile/draft").send(editRequest).expect(200)).body
    expect(saved.version).toBe(1)
    expect(await otherVersions()).toEqual([
      { version: 1, status: "approved" },
      { version: 2, status: "draft" },
    ])
  })

  it("answers 404 to approving or discarding the other Candidate's draft and leaves it unchanged", async () => {
    await owner.post("/v1/career-profile/draft/approve").send({ version: 2 }).expect(404)
    await owner.delete("/v1/career-profile/draft?version=2").expect(404)
    expect(await otherVersions()).toEqual([
      { version: 1, status: "approved" },
      { version: 2, status: "draft" },
    ])
  })

  it("refuses a career-profile call outside any Candidate scope", async () => {
    await expect(app.get(CareerProfileService).versionInUse()).rejects.toBeInstanceOf(MissingCandidateScopeError)
  })
})
