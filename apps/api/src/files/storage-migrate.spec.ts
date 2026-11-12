import { createHash } from "node:crypto"
import { access, chmod, lstat, mkdir, symlink, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { assertStorageMigrated } from "./candidate-files.js"
import { type StoredFileRow, migrateStorage } from "./storage-migrate.js"

const ADA = "00000000-0000-4000-8000-0000000000a1"
const KOFI = "00000000-0000-4000-8000-0000000000b2"
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const uuidName = (n: number, ext: "pdf" | "docx") => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.${ext}`

let base: string
let oldResumes: string
let oldDocuments: string
let root: string

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ja-storage-migrate-"))
  oldResumes = join(base, "resumes")
  oldDocuments = join(base, "documents")
  root = join(base, "candidates")
  await mkdir(oldResumes)
  await mkdir(oldDocuments)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

/** Ada's resume and 18 Tailored Document files (9 pairs), as migration-and-operator-bootstrap.feature:701 and :709 describe. */
async function seedOwner(): Promise<StoredFileRow[]> {
  const rows: StoredFileRow[] = []
  const resume = uuidName(1, "pdf")
  await writeFile(join(oldResumes, resume), "ADA RESUME %PDF")
  rows.push({ candidateId: ADA, area: "resumes", storageName: resume, sha256: sha("ADA RESUME %PDF"), required: true })
  for (let n = 0; n < 9; n++) {
    for (const ext of ["pdf", "docx"] as const) {
      const name = uuidName(100 + n, ext)
      const bytes = `ADA DOC ${n} ${ext}`
      await writeFile(join(oldDocuments, name), bytes)
      rows.push({ candidateId: ADA, area: "documents", storageName: name, sha256: sha(bytes), required: true })
    }
  }
  return rows
}

const options = () => ({ oldResumeDir: oldResumes, oldDocumentDir: oldDocuments, candidateRoot: root })

describe("storage:migrate (architecture r4 Files; exit proof: file SHA-256 test)", () => {
  it("moves every file to the owner's per-Candidate location with unchanged SHA-256, then deletes the originals (:701, :709)", async () => {
    const rows = await seedOwner()
    const report = await migrateStorage(rows, options())
    expect(report).toMatchObject({ result: "completed", copied: 19, alreadyInPlace: 0, problems: [] })
    for (const row of rows) {
      const moved = join(root, row.candidateId, row.area, row.storageName)
      expect(sha(await readFile(moved))).toBe(row.sha256)
      expect((await stat(moved)).mode & 0o777).toBe(0o600)
    }
    expect((await readdir(join(root, ADA, "documents"))).length).toBe(18)
    expect((await stat(join(root, ADA))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, ADA, "documents"))).mode & 0o777).toBe(0o700)
    expect(await readdir(oldResumes)).toEqual([])
    expect(await readdir(oldDocuments)).toEqual([])
    await expect(assertStorageMigrated(root)).resolves.toBeUndefined()
  })

  it("a second run changes nothing (idempotent)", async () => {
    const rows = await seedOwner()
    await migrateStorage(rows, options())
    const marker = await readFile(join(root, ".storage-migrated"), "utf8")
    const second = await migrateStorage(rows, options())
    expect(second).toMatchObject({ result: "already_complete" })
    expect(await readFile(join(root, ".storage-migrated"), "utf8")).toBe(marker)
    expect((await readdir(join(root, ADA, "documents"))).length).toBe(18)
  })

  it("resumes after a crash: files already copied and verified count as in place", async () => {
    const rows = await seedOwner()
    const first = rows[1]!
    await mkdir(join(root, ADA, "documents"), { recursive: true })
    await writeFile(join(root, ADA, "documents", first.storageName), await readFile(join(oldDocuments, first.storageName)))
    const report = await migrateStorage(rows, options())
    expect(report).toMatchObject({ result: "completed", copied: 18, alreadyInPlace: 1 })
  })

  it("a resumed run sets 0600 on a file already in place and 0700 on its directories (F-QA-02)", async () => {
    const rows = await seedOwner()
    const first = rows[1]!
    await mkdir(join(root, ADA, "documents"), { recursive: true, mode: 0o755 })
    const target = join(root, ADA, "documents", first.storageName)
    await writeFile(target, await readFile(join(oldDocuments, first.storageName)), { mode: 0o644 })
    await chmod(join(root, ADA), 0o755)
    await chmod(join(root, ADA, "documents"), 0o755)
    await chmod(target, 0o644)
    expect(await migrateStorage(rows, options())).toMatchObject({ result: "completed", alreadyInPlace: 1 })
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, ADA))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, ADA, "documents"))).mode & 0o777).toBe(0o700)
  })

  it("refuses an original that is a symlink, even when its target has the right SHA-256 (F-SEC-03)", async () => {
    const rows = await seedOwner()
    const linked = rows[3]!
    const real = join(base, "planted")
    await writeFile(real, await readFile(join(oldDocuments, linked.storageName)))
    await rm(join(oldDocuments, linked.storageName))
    await symlink(real, join(oldDocuments, linked.storageName))
    const report = await migrateStorage(rows, options())
    expect(report.result).toBe("failed")
    expect(report.problems).toEqual([{ kind: "not_regular_file", candidateId: ADA, area: "documents", storageName: linked.storageName }])
    expect(await exists(join(root, ".storage-migrated"))).toBe(false)
  })

  it("does not count a symlink at the target as in place; replaces it with a real copy (F-SEC-03)", async () => {
    const rows = await seedOwner()
    const first = rows[1]!
    const real = join(base, "planted")
    await writeFile(real, await readFile(join(oldDocuments, first.storageName)))
    await mkdir(join(root, ADA, "documents"), { recursive: true })
    const target = join(root, ADA, "documents", first.storageName)
    await symlink(real, target)
    expect(await migrateStorage(rows, options())).toMatchObject({ result: "completed", copied: 19, alreadyInPlace: 0 })
    expect((await lstat(target)).isFile()).toBe(true)
    expect(await exists(real)).toBe(true)
  })

  it("a SHA-256 mismatch keeps every original, writes no marker and fails", async () => {
    const rows = await seedOwner()
    const bad = rows[5]!
    await writeFile(join(oldDocuments, bad.storageName), "TAMPERED")
    const report = await migrateStorage(rows, options())
    expect(report.result).toBe("failed")
    expect(report.problems).toEqual([{ kind: "sha256_mismatch", candidateId: ADA, area: "documents", storageName: bad.storageName }])
    expect((await readdir(oldDocuments)).length).toBe(18)
    expect((await readdir(oldResumes)).length).toBe(1)
    expect(await exists(join(root, ADA, "documents", bad.storageName))).toBe(false)
    expect(await exists(join(root, ".storage-migrated"))).toBe(false)
    await expect(assertStorageMigrated(root)).rejects.toThrow()
  })

  it("a missing required file fails and keeps every original; a missing optional one (failed upload) is skipped", async () => {
    const rows = await seedOwner()
    const optional: StoredFileRow = { candidateId: ADA, area: "resumes", storageName: uuidName(2, "pdf"), sha256: sha("never written"), required: false }
    expect((await migrateStorage([...rows, optional], options())).result).toBe("completed")
    await rm(base, { recursive: true, force: true })
    await mkdir(oldResumes, { recursive: true })
    await mkdir(oldDocuments, { recursive: true })
    const again = await seedOwner()
    const missing: StoredFileRow = { ...optional, required: true }
    const report = await migrateStorage([...again, missing], options())
    expect(report.result).toBe("failed")
    expect(report.problems).toEqual([{ kind: "missing", candidateId: ADA, area: "resumes", storageName: missing.storageName }])
    expect((await readdir(oldDocuments)).length).toBe(18)
  })

  it("files of two Candidates sharing nothing go to their own directories; unreferenced files are left alone", async () => {
    const rows = await seedOwner()
    const kofiName = uuidName(500, "pdf")
    await writeFile(join(oldDocuments, kofiName), "KOFI")
    await writeFile(join(oldDocuments, "unrelated.txt"), "keep")
    const report = await migrateStorage([...rows, { candidateId: KOFI, area: "documents", storageName: kofiName, sha256: sha("KOFI"), required: true }], options())
    expect(report).toMatchObject({ result: "completed", copied: 20, unreferenced: 1 })
    expect((await readFile(join(root, KOFI, "documents", kofiName))).toString()).toBe("KOFI")
    expect(await exists(join(root, ADA, "documents", kofiName))).toBe(false)
    expect(await readdir(oldDocuments)).toEqual(["unrelated.txt"])
  })

  it("a fresh installation with no files completes and writes the marker", async () => {
    expect(await migrateStorage([], options())).toMatchObject({ result: "completed", copied: 0 })
    await expect(assertStorageMigrated(root)).resolves.toBeUndefined()
  })

  it("writes no marker when the rows read differ from the expected row count (F-QA-01)", async () => {
    const rows = await seedOwner()
    const report = await migrateStorage([], { ...options(), expectedRows: rows.length })
    expect(report).toMatchObject({ result: "failed", copied: 0, problems: [{ kind: "row_count_mismatch" }] })
    expect(await exists(join(root, ".storage-migrated"))).toBe(false)
    expect((await readdir(oldDocuments)).length).toBe(18)
  })

  it("refuses a row whose storage name is not a server name, and fails before touching anything", async () => {
    const rows = await seedOwner()
    const report = await migrateStorage([...rows, { candidateId: ADA, area: "documents", storageName: "../../etc/passwd", sha256: "x", required: true }], options())
    expect(report.result).toBe("failed")
    expect(report.problems[0]).toMatchObject({ kind: "invalid_row" })
    expect((await readdir(oldDocuments)).length).toBe(18)
  })
})
