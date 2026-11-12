import { createHash } from "node:crypto"
import { chmod, lstat, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { CANDIDATE_STORAGE_NAME, CandidateFiles, type FileArea, NotRegularFileError, assertStorageMigrated, markStorageMigrated, readRegularFile } from "./candidate-files.js"

/** One stored file a database row names, with the SHA-256 the row recorded. */
export type StoredFileRow = Readonly<{
  candidateId: string
  area: Extract<FileArea, "resumes" | "documents">
  storageName: string
  sha256: string
  /** A failed resume upload may have no file; every other row's file must exist. */
  required: boolean
}>

export type StorageProblem = Readonly<{ kind: "sha256_mismatch" | "missing" | "invalid_row" | "row_count_mismatch" | "not_regular_file"; candidateId: string; area: string; storageName: string }>

export type StorageMigrateReport = Readonly<{
  result: "completed" | "already_complete" | "failed"
  copied: number
  alreadyInPlace: number
  skippedOptional: number
  /** Files in the old directories that no row names; left where they are. */
  unreferenced: number
  problems: StorageProblem[]
}>

export type StorageMigrateOptions = Readonly<{
  oldResumeDir: string
  oldDocumentDir: string
  candidateRoot: string
  /** Rows the database holds, counted separately (countStoredFileRows). A differing row set fails before any I/O and writes no marker. */
  expectedRows?: number
}>

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/**
 * EPIC-0002 A2 `storage:migrate` (architecture r4 Files): copies each resume
 * and Tailored Document from the flat directories into
 * `<root>/<candidate_id>/<area>/`, verifies every copy's SHA-256 against its
 * database row, and deletes the originals only after every copy verified.
 * Then it writes the completion marker the api and worker check at boot.
 * Idempotent: a completed root is left alone, and a copy already in place with
 * the right checksum counts as done, so a crashed run can be rerun. On any
 * problem nothing is deleted, no marker is written and the result is "failed".
 * Logs carry IDs and counts only, never file content.
 */
export async function migrateStorage(rows: readonly StoredFileRow[], options: StorageMigrateOptions): Promise<StorageMigrateReport> {
  const empty = { copied: 0, alreadyInPlace: 0, skippedOptional: 0, unreferenced: 0, problems: [] as StorageProblem[] }
  if (await assertStorageMigrated(options.candidateRoot).then(() => true, () => false)) return { result: "already_complete", ...empty }
  if (options.expectedRows !== undefined && options.expectedRows !== rows.length) {
    return { result: "failed", ...empty, problems: [{ kind: "row_count_mismatch", candidateId: "-", area: "-", storageName: `${rows.length} of ${options.expectedRows}` }] }
  }
  const files = new CandidateFiles(options.candidateRoot)
  const oldDir = (area: StoredFileRow["area"]) => resolve(area === "resumes" ? options.oldResumeDir : options.oldDocumentDir)

  const invalid = rows.filter((row) => !CANDIDATE_STORAGE_NAME.test(row.storageName) || !isPath(() => files.path(row.candidateId, row.area, row.storageName)))
  if (invalid.length > 0) return { result: "failed", ...empty, problems: invalid.map((row) => problem("invalid_row", row)) }

  const problems: StorageProblem[] = []
  const moved: StoredFileRow[] = []
  let copied = 0
  let alreadyInPlace = 0
  let skippedOptional = 0
  for (const row of rows) {
    const target = files.path(row.candidateId, row.area, row.storageName)
    // A symlink at the target never counts as in place (F-SEC-03); it is unlinked below.
    const inPlace = await readRegularFile(target).catch(() => null)
    if (inPlace && sha256(inPlace) === row.sha256) {
      // A crash between copy and chmod leaves the umask mode: fix it on resume (F-QA-02).
      await restrictModes(files, row, target)
      alreadyInPlace++
      moved.push(row)
      continue
    }
    const source = join(oldDir(row.area), row.storageName)
    const original = await readRegularFile(source).catch((error: unknown) => (error instanceof NotRegularFileError ? "not_regular" : null))
    if (original === "not_regular") {
      problems.push(problem("not_regular_file", row))
      continue
    }
    if (!original) {
      if (row.required) problems.push(problem("missing", row))
      else skippedOptional++
      continue
    }
    if (sha256(original) !== row.sha256) {
      problems.push(problem("sha256_mismatch", row))
      continue
    }
    await files.ensureDirectory(row.candidateId, row.area)
    if (await lstat(target).then(() => true, () => false)) await rm(target, { force: true })
    // Writes the verified bytes (never copyFile, which follows a source symlink); wx never follows the target.
    await writeFile(target, original, { flag: "wx", mode: 0o600 })
    await restrictModes(files, row, target)
    const copy = await readRegularFile(target)
    if (sha256(copy) !== row.sha256) {
      await rm(target, { force: true })
      problems.push(problem("sha256_mismatch", row))
      continue
    }
    copied++
    moved.push(row)
  }
  if (options.expectedRows !== undefined && moved.length + skippedOptional !== options.expectedRows) {
    problems.push({ kind: "row_count_mismatch", candidateId: "-", area: "-", storageName: `${moved.length + skippedOptional} of ${options.expectedRows}` })
  }
  if (problems.length > 0) return { result: "failed", copied, alreadyInPlace, skippedOptional, unreferenced: 0, problems }

  // Every copy verified: only now are the originals removed.
  for (const row of moved) await rm(join(oldDir(row.area), row.storageName), { force: true })
  const named = new Set(rows.map((row) => row.storageName))
  let unreferenced = 0
  for (const area of ["resumes", "documents"] as const) {
    for (const name of await readdir(oldDir(area)).catch(() => [] as string[])) if (!named.has(name)) unreferenced++
  }
  await markStorageMigrated(options.candidateRoot, { files: moved.length })
  return { result: "completed", copied, alreadyInPlace, skippedOptional, unreferenced, problems: [] }
}

async function restrictModes(files: CandidateFiles, row: StoredFileRow, target: string): Promise<void> {
  const directory = await files.ensureDirectory(row.candidateId, row.area)
  await chmod(dirname(directory), 0o700)
  await chmod(directory, 0o700)
  await chmod(target, 0o600)
}

function problem(kind: StorageProblem["kind"], row: StoredFileRow): StorageProblem {
  return { kind, candidateId: row.candidateId, area: row.area, storageName: row.storageName }
}

function isPath(build: () => string): boolean {
  try {
    build()
    return true
  } catch {
    return false
  }
}
