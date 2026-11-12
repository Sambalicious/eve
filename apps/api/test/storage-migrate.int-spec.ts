import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { StorageNotMigratedError } from "../src/files/candidate-files.js"
import { migrateStorage } from "../src/files/storage-migrate.js"
import { countStoredFileRows, storedFileRows } from "../src/files/storage-migrate-rows.js"
import { createDatabase } from "../src/db/create-database.js"
import { insertSecondCandidate } from "./support/second-candidate.js"
import { insertPostingFor } from "./support/candidate-posting.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { Test } from "@nestjs/testing"

import { ConfigModule } from "../src/config/config.module.js"
import { FilesModule } from "../src/files/files.module.js"

/**
 * EPIC-0002 A2 storage:migrate against the migrated database (exit proof: file
 * SHA-256 test) and the boot refusal (architecture r4 Files; gap G1;
 * migration-and-operator-bootstrap.feature:701, :709).
 */
let database: TestDatabase
let base: string
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex")

beforeAll(async () => {
  database = await startMigratedDatabase()
  base = await mkdtemp(join(tmpdir(), "ja-storage-int-"))
})

afterAll(async () => {
  await database?.stop()
  await rm(base, { recursive: true, force: true })
})

describe("storage:migrate over the owner's rows", () => {
  it("moves the owner's resume and 18 document files under the owner's ID with unchanged SHA-256", async () => {
    const op = database.operatorId
    const resumes = join(base, "resumes")
    const documents = join(base, "documents")
    await mkdir(resumes)
    await mkdir(documents)
    const resumeId = randomUUID()
    await writeFile(join(resumes, `${resumeId}.pdf`), "RESUME")
    await database.db.insertInto("resume_upload").values({ candidate_id: op, id: resumeId, original_filename: "ada.pdf", media_type: "application/pdf", byte_size: 6, sha256: sha("RESUME"), storage_name: `${resumeId}.pdf`, status: "drafted", failure_reason: null, started_at: new Date(), finished_at: new Date() }).execute()
    const postingId = randomUUID()
    const url = "https://boards.greenhouse.io/storage/jobs/1"
    await insertPostingFor(database.db, op, { id: postingId, application_url: url, requisition_id: "1", apply_url: url, application_system: "greenhouse", apply_mode: "automatic", origin: "employer_board", employer_board_id: null, remote_board_key: null, attribution_name: null, attribution_url: null, title: "Role", company: "Co", status: "ranked", skip_reason: null, skip_detail: null, evaluation_failure: null, role_family: "senior_frontend", discovered_at: new Date(), evaluated_at: new Date() })
    for (let n = 0; n < 9; n++) {
      const applicationId = randomUUID()
      await database.db.insertInto("application").values({ id: applicationId, candidate_id: op, job_posting_id: postingId, application_url: url, requisition_id: `R-${n}`, company: "Co", role_title: "Role", state: "documents_ready", career_profile_version: 1, blocked_document: null, blocked_claim: null, failure: null, created_at: new Date(), updated_at: new Date() }).execute()
      const fileId = randomUUID()
      await writeFile(join(documents, `${fileId}.pdf`), `PDF ${n}`)
      await writeFile(join(documents, `${fileId}.docx`), `DOCX ${n}`)
      await database.db.insertInto("tailored_document").values({ id: randomUUID(), candidate_id: op, application_id: applicationId, kind: "resume", career_profile_version: 1, content: "{}", pdf_storage_name: `${fileId}.pdf`, docx_storage_name: `${fileId}.docx`, pdf_sha256: sha(`PDF ${n}`), docx_sha256: sha(`DOCX ${n}`), created_at: new Date() }).execute()
    }
    const rows = await storedFileRows(database.db)
    expect(rows).toHaveLength(19)
    const root = join(base, "candidates")
    const report = await migrateStorage(rows, { oldResumeDir: resumes, oldDocumentDir: documents, candidateRoot: root })
    expect(report).toMatchObject({ result: "completed", copied: 19, problems: [] })
    for (const row of rows) expect(sha((await readFile(join(root, op, row.area, row.storageName))).toString())).toBe(row.sha256)
    expect(await readdir(join(root, op, "documents"))).toHaveLength(18)
    expect(await readdir(documents)).toEqual([])
    expect(await readdir(resumes)).toEqual([])
  })
})

describe("storage:migrate as the migration owner role (F-QA-01)", () => {
  it("moves the Operator's and an invitee's files and counts the same rows it read", async () => {
    const resumes = join(base, "owner-resumes")
    const documents = join(base, "owner-documents")
    await mkdir(resumes)
    await mkdir(documents)
    const invitee = await insertSecondCandidate(database.db, "owner-role.invitee@example.test")
    const names = new Set<string>()
    for (const candidateId of [database.operatorId, invitee]) {
      const id = randomUUID()
      names.add(`${id}.pdf`)
      await writeFile(join(resumes, `${id}.pdf`), `R ${id}`)
      await database.db.insertInto("resume_upload").values({ candidate_id: candidateId, id, original_filename: "r.pdf", media_type: "application/pdf", byte_size: 1, sha256: sha(`R ${id}`), storage_name: `${id}.pdf`, status: "drafted", failure_reason: null, started_at: new Date(), finished_at: new Date() }).execute()
    }
    const superuserCount = (await storedFileRows(database.db)).length
    const owner = createDatabase(database.ownerUrl, { statementTimeoutMs: 0 })
    try {
      const rows = await storedFileRows(owner)
      expect(rows).toHaveLength(superuserCount)
      expect(await countStoredFileRows(owner)).toBe(superuserCount)
      const mine = rows.filter((row) => names.has(row.storageName))
      expect(mine.map((row) => row.candidateId).sort()).toEqual([database.operatorId, invitee].sort())
      const root = join(base, "owner-candidates")
      const report = await migrateStorage(mine, { oldResumeDir: resumes, oldDocumentDir: join(base, "owner-none"), candidateRoot: root, expectedRows: mine.length })
      expect(report).toMatchObject({ result: "completed", copied: 2, problems: [] })
      for (const row of mine) expect(sha((await readFile(join(root, row.candidateId, "resumes", row.storageName))).toString())).toBe(row.sha256)
    } finally {
      await owner.destroy()
    }
  })
})

describe("boot refuses until storage:migrate has completed", () => {
  it("FilesModule (imported by the api and the worker) refuses to initialise on a root without the completion marker", async () => {
    const unmigrated = await mkdtemp(join(base, "unmigrated-"))
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ candidateStorageDir: unmigrated } as never), FilesModule] }).compile()
    await expect(moduleRef.init()).rejects.toBeInstanceOf(StorageNotMigratedError)
    await moduleRef.close().catch(() => undefined)
  })

  it("the api and worker entry points check before anything else starts", async () => {
    for (const entry of ["../src/main.api.ts", "../src/main.worker.ts"]) {
      const source = await readFile(new URL(entry, import.meta.url), "utf8")
      expect(source.indexOf("assertStorageMigrated(")).toBeGreaterThan(-1)
      expect(source.indexOf("assertStorageMigrated(")).toBeLessThan(source.indexOf("NestFactory.create"))
    }
  })
})
