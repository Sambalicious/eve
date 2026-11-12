import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CandidateFiles, NotRegularFileError, StorageNotMigratedError, assertStorageMigrated, markStorageMigrated } from "./candidate-files.js"

const ADA = "00000000-0000-4000-8000-0000000000a1"
const KOFI = "00000000-0000-4000-8000-0000000000b2"
const NAME = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.pdf"
let root: string
let files: CandidateFiles

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ja-candidate-files-"))
  files = new CandidateFiles(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("CandidateFiles (architecture r1/r4 File storage layout; data-isolation.feature:311, :318, :337)", () => {
  it("stores under <root>/<candidate_id>/<area>/<storage_name> with directory 0700 and file 0600", async () => {
    await files.write(ADA, "resumes", NAME, Buffer.from("ADA"))
    const path = join(root, ADA, "resumes", NAME)
    expect(files.path(ADA, "resumes", NAME)).toBe(path)
    expect((await stat(join(root, ADA))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, ADA, "resumes"))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await files.read(ADA, "resumes", NAME)).toString()).toBe("ADA")
  })

  it("the same storage name resolves to each Candidate's own file", async () => {
    await files.write(ADA, "documents", NAME, Buffer.from("ADA"))
    await files.write(KOFI, "documents", NAME, Buffer.from("KOFI"))
    expect((await files.read(KOFI, "documents", NAME)).toString()).toBe("KOFI")
    expect((await files.read(ADA, "documents", NAME)).toString()).toBe("ADA")
  })

  it("never overwrites a stored file", async () => {
    await files.write(ADA, "documents", NAME, Buffer.from("first"))
    await expect(files.write(ADA, "documents", NAME, Buffer.from("second"))).rejects.toThrow(/EEXIST/)
  })

  it.each([
    ["a name that is not a server name", ADA, "documents", "resume.pdf"],
    ["a traversal name", ADA, "documents", `../${KOFI}/documents/${NAME}`],
    ["an encoded traversal name", ADA, "documents", "%2e%2e%2f" + NAME],
    ["a Candidate ID that is not a UUID", "../x", "documents", NAME],
    ["an unknown area", ADA, "submissions", NAME],
  ])("refuses %s", (_label, candidateId, area, name) => {
    expect(() => files.path(candidateId, area as never, name)).toThrow()
  })

  it("lists one Candidate's area only, and an absent area as empty", async () => {
    await files.write(ADA, "documents", NAME, Buffer.from("x"))
    expect(await files.list(ADA, "documents")).toEqual([NAME])
    expect(await files.list(KOFI, "documents")).toEqual([])
  })

  it("remove is idempotent and checks the name", async () => {
    await files.write(ADA, "documents", NAME, Buffer.from("x"))
    await files.remove(ADA, "documents", NAME)
    await files.remove(ADA, "documents", NAME)
    expect(await files.list(ADA, "documents")).toEqual([])
    await expect(files.remove(ADA, "documents", "../escape.pdf")).rejects.toThrow()
  })
})

describe("CandidateFiles never follows a symlink planted in the root (F-SEC-03)", () => {
  it("refuses to read a stored name that is a symlink", async () => {
    const outside = join(root, "outside.txt")
    await writeFile(outside, "SECRET")
    await files.ensureDirectory(ADA, "resumes")
    await symlink(outside, join(root, ADA, "resumes", NAME))
    await expect(files.read(ADA, "resumes", NAME)).rejects.toThrow()
  })

  it("refuses to read through a Candidate or area directory that is a symlink", async () => {
    await files.write(KOFI, "resumes", NAME, Buffer.from("KOFI"))
    await symlink(join(root, KOFI), join(root, ADA))
    await expect(files.read(ADA, "resumes", NAME)).rejects.toThrow()
    await mkdir(join(root, "elsewhere"))
    await rm(join(root, ADA))
    await mkdir(join(root, ADA))
    await symlink(join(root, KOFI, "resumes"), join(root, ADA, "documents"))
    await expect(files.read(ADA, "documents", NAME)).rejects.toThrow()
    await expect(files.write(ADA, "documents", "2b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.pdf", Buffer.from("X"))).rejects.toThrow()
  })

  it("remove unlinks a planted symlink without touching its target", async () => {
    const outside = join(root, "outside.txt")
    await writeFile(outside, "KEEP")
    await files.ensureDirectory(ADA, "resumes")
    await symlink(outside, join(root, ADA, "resumes", NAME))
    await files.remove(ADA, "resumes", NAME)
    expect((await readFile(outside)).toString()).toBe("KEEP")
  })
})

/** F-SEC-04: remove and list did not check the Candidate and area directories, so a symlinked level reached the link target. */
describe("remove and list never act through a symlinked Candidate or area directory (F-SEC-04)", () => {
  async function kofiDocument(): Promise<string> {
    await files.write(KOFI, "documents", NAME, Buffer.from("KOFI"))
    return join(root, KOFI, "documents", NAME)
  }

  it("remove through a symlinked area directory refuses and leaves the target's file", async () => {
    const kofi = await kofiDocument()
    await mkdir(join(root, ADA), { mode: 0o700 })
    await symlink(join(root, KOFI, "documents"), join(root, ADA, "documents"))
    await expect(files.remove(ADA, "documents", NAME)).rejects.toBeInstanceOf(NotRegularFileError)
    expect((await readFile(kofi)).toString()).toBe("KOFI")
  })

  it("remove through a symlinked Candidate directory refuses and leaves the target's file", async () => {
    const kofi = await kofiDocument()
    await symlink(join(root, KOFI), join(root, ADA))
    await expect(files.remove(ADA, "documents", NAME)).rejects.toBeInstanceOf(NotRegularFileError)
    expect((await readFile(kofi)).toString()).toBe("KOFI")
  })

  it("list through a symlinked area or Candidate directory refuses instead of reading the target", async () => {
    await kofiDocument()
    await mkdir(join(root, ADA), { mode: 0o700 })
    await symlink(join(root, KOFI, "documents"), join(root, ADA, "documents"))
    await expect(files.list(ADA, "documents")).rejects.toBeInstanceOf(NotRegularFileError)
    await rm(join(root, ADA), { recursive: true })
    await symlink(join(root, KOFI), join(root, ADA))
    await expect(files.list(ADA, "documents")).rejects.toBeInstanceOf(NotRegularFileError)
  })

  it("a missing Candidate or area directory stays empty for list and a no-op for remove", async () => {
    await expect(files.list(ADA, "documents")).resolves.toEqual([])
    await expect(files.remove(ADA, "documents", NAME)).resolves.toBeUndefined()
    await mkdir(join(root, ADA), { mode: 0o700 })
    await expect(files.list(ADA, "documents")).resolves.toEqual([])
    await expect(files.remove(ADA, "documents", NAME)).resolves.toBeUndefined()
  })

  it("list and remove still work on real directories", async () => {
    await files.write(ADA, "documents", NAME, Buffer.from("ADA"))
    expect(await files.list(ADA, "documents")).toEqual([NAME])
    await files.remove(ADA, "documents", NAME)
    expect(await files.list(ADA, "documents")).toEqual([])
  })
})

describe("boot refuses until storage:migrate has completed (architecture r4 Files; gap G1)", () => {
  it("refuses a root without the completion marker and accepts one with it", async () => {
    await expect(assertStorageMigrated(root)).rejects.toBeInstanceOf(StorageNotMigratedError)
    await expect(assertStorageMigrated(join(root, "missing"))).rejects.toBeInstanceOf(StorageNotMigratedError)
    await markStorageMigrated(root, { files: 0 })
    await expect(assertStorageMigrated(root)).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(root, ".storage-migrated"), "utf8"))).toMatchObject({ version: 1, files: 0 })
  })

  it("refuses a marker that is not the completion record", async () => {
    await writeFile(join(root, ".storage-migrated"), "garbage")
    await expect(assertStorageMigrated(root)).rejects.toBeInstanceOf(StorageNotMigratedError)
  })
})
