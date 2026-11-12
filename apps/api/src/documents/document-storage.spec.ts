import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { NotRegularFileError } from "../files/candidate-files.js"
import { readDocumentFile, storeDocumentFile } from "./document-storage.js"

let root: string
const ID = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b"

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ja-docs-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("document storage (owner-only, like resumes)", () => {
  it("writes <id>.pdf 0600 inside a 0700 directory and reads it back", async () => {
    const dir = join(root, "store")
    const name = await storeDocumentFile(dir, ID, "pdf", Buffer.from("%PDF-1"))
    expect(name).toBe(`${ID}.pdf`)
    expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect(await readDocumentFile(dir, name)).toEqual(Buffer.from("%PDF-1"))
  })

  it("never overwrites", async () => {
    await expect(storeDocumentFile(join(root, "store"), ID, "pdf", Buffer.from("x"))).rejects.toThrow(/EEXIST/)
    expect(await readFile(join(root, "store", `${ID}.pdf`))).toEqual(Buffer.from("%PDF-1"))
  })

  it.each(["../etc/passwd", "a/b.pdf", "x.exe", `${ID}.pdf/..`])("refuses a stored name %s that is not <uuid>.pdf|docx", async (name) => {
    await expect(readDocumentFile(join(root, "store"), name)).rejects.toThrow(/storage name/)
  })

  it("refuses an id that is not a UUID", async () => {
    await expect(storeDocumentFile(join(root, "store"), "../x", "pdf", Buffer.from("x"))).rejects.toThrow(/storage name/)
  })

  it("F-SEC-03: refuses to read a stored name that is a symlink to a file outside the store", async () => {
    const outside = join(root, "outside.txt")
    await writeFile(outside, "HOST SECRET")
    const name = "2b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.pdf"
    await symlink(outside, join(root, "store", name))
    await expect(readDocumentFile(join(root, "store"), name)).rejects.toBeInstanceOf(NotRegularFileError)
  })
})
