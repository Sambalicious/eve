import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import { assertCandidateId } from "../db/candidate-scope.js"

/** The per-Candidate file areas (architecture r1/r4 File storage layout). `exports` is written from slice G. */
export const FILE_AREAS = ["resumes", "documents", "exports"] as const
export type FileArea = (typeof FILE_AREAS)[number]

/** `<uuid>.pdf|docx|zip`: the only names the server writes or reads. Never derived from an upload. */
export const CANDIDATE_STORAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|docx|zip)$/

/** Written by storage:migrate as its last step; the api and worker refuse to start without it. */
export const STORAGE_MIGRATED_MARKER = ".storage-migrated"
const MARKER_VERSION = 1

export class StorageNotMigratedError extends Error {
  constructor() {
    super("Stored files are not in the per-Candidate layout; run storage:migrate before starting the api or worker")
    this.name = "StorageNotMigratedError"
  }
}

/**
 * The only file API (EPIC-0002 A2; architecture r1/r4 File storage layout):
 * `<root>/<candidate_id>/<area>/<storage_name>`. Callers look the row up
 * through `forCandidate` first, so a guessed name, ID or path never reaches the
 * disk for another Candidate. Directories 0700, files 0600, created
 * exclusively so nothing is overwritten.
 */
export class CandidateFiles {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  path(candidateId: string, area: FileArea, storageName: string): string {
    const directory = this.directory(candidateId, area)
    if (!CANDIDATE_STORAGE_NAME.test(storageName)) throw new Error("Invalid storage name")
    const target = resolve(join(directory, storageName))
    if (!target.startsWith(directory + sep)) throw new Error("Invalid storage name")
    return target
  }

  directory(candidateId: string, area: FileArea): string {
    if (!FILE_AREAS.includes(area)) throw new Error("Invalid file area")
    const candidate = resolve(join(this.root, assertCandidateId(candidateId)))
    if (!candidate.startsWith(this.root + sep)) throw new Error("Invalid Candidate directory")
    return join(candidate, area)
  }

  async write(candidateId: string, area: FileArea, storageName: string, bytes: Buffer): Promise<void> {
    const target = this.path(candidateId, area, storageName)
    await this.ensureDirectory(candidateId, area)
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 })
  }

  /** Never follows a symlink: not in the Candidate or area directory, nor the file itself (F-SEC-03). */
  async read(candidateId: string, area: FileArea, storageName: string): Promise<Buffer> {
    const target = this.path(candidateId, area, storageName)
    await this.assertRealDirectories(candidateId, area)
    return readRegularFile(target)
  }

  /** A missing file or directory is fine. Never acts through a symlinked Candidate or area directory (F-SEC-04). */
  async remove(candidateId: string, area: FileArea, storageName: string): Promise<void> {
    const target = this.path(candidateId, area, storageName)
    if (!(await this.realDirectoriesOrMissing(candidateId, area))) return
    await rm(target, { force: true })
  }

  /** Every entry name in one Candidate's area; an absent area is empty. Never reads through a symlinked directory (F-SEC-04). */
  async list(candidateId: string, area: FileArea): Promise<string[]> {
    const directory = this.directory(candidateId, area)
    if (!(await this.realDirectoriesOrMissing(candidateId, area))) return []
    return readdir(directory).catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return []
      throw error
    })
  }

  /** Creates `<root>/<id>` and `<root>/<id>/<area>` with 0700 (mkdir's mode is masked, so each level is created explicitly). */
  async ensureDirectory(candidateId: string, area: FileArea): Promise<string> {
    const directory = this.directory(candidateId, area)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(resolve(directory, ".."), { recursive: true, mode: 0o700 })
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await this.assertRealDirectories(candidateId, area)
    return directory
  }

  /** False when a level is missing (nothing to list or remove); throws when a level exists and is not a real directory. */
  private async realDirectoriesOrMissing(candidateId: string, area: FileArea): Promise<boolean> {
    try {
      await this.assertRealDirectories(candidateId, area)
      return true
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return false
      throw error
    }
  }

  /** `<root>/<id>` and `<root>/<id>/<area>` must be real directories: mkdir and open would follow a planted symlink. */
  private async assertRealDirectories(candidateId: string, area: FileArea): Promise<void> {
    const directory = this.directory(candidateId, area)
    for (const level of [resolve(directory, ".."), directory]) {
      const entry = await lstat(level)
      if (!entry.isDirectory()) throw new NotRegularFileError()
    }
  }
}

export class NotRegularFileError extends Error {
  constructor() {
    super("Stored file path is not a regular file or directory")
    this.name = "NotRegularFileError"
  }
}

/**
 * Reads a regular file without following a symlink at the last component
 * (O_NOFOLLOW gives ELOOP), and refuses anything that is not a regular file.
 */
export async function readRegularFile(path: string): Promise<Buffer> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as { code?: string }).code === "ELOOP") throw new NotRegularFileError()
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) throw new NotRegularFileError()
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** Boot check: the api and worker start only after storage:migrate wrote its completion marker. */
export async function assertStorageMigrated(root: string): Promise<void> {
  let marker: unknown
  try {
    marker = JSON.parse(await readFile(join(resolve(root), STORAGE_MIGRATED_MARKER), "utf8"))
  } catch {
    throw new StorageNotMigratedError()
  }
  if (typeof marker !== "object" || marker === null || (marker as { version?: unknown }).version !== MARKER_VERSION) throw new StorageNotMigratedError()
}

export async function markStorageMigrated(root: string, summary: { files: number }): Promise<void> {
  await mkdir(resolve(root), { recursive: true, mode: 0o700 })
  const body = JSON.stringify({ version: MARKER_VERSION, files: summary.files, completedAt: new Date().toISOString() })
  await writeFile(join(resolve(root), STORAGE_MIGRATED_MARKER), body, { mode: 0o600 })
}
