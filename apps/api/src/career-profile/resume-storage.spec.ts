import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { CandidateFiles } from "../files/candidate-files.js"
import { displayFilename, storeResume } from "./resume-storage.js"

const ADA = "00000000-0000-4000-8000-0000000000a1"

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ja-resume-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("storeResume", () => {
  it("writes <id>.pdf with mode 0600 inside the Candidate's 0700 resumes directory", async () => {
    const dir = join(root, "store", ADA, "resumes")
    const name = await storeResume(new CandidateFiles(join(root, "store")), ADA, "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", "application/pdf", Buffer.from("%PDF-"))
    expect(name).toBe("1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.pdf")
    expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it("refuses to overwrite an existing file", async () => {
    await expect(storeResume(new CandidateFiles(join(root, "store")), ADA, "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", "application/pdf", Buffer.from("x"))).rejects.toThrow(/EEXIST/)
  })

  it("refuses an id that would escape the directory", async () => {
    await expect(storeResume(new CandidateFiles(join(root, "jail")), ADA, "../../escaped", "application/pdf", Buffer.from("x"))).rejects.toThrow(/storage name/)
    expect(await readdir(root)).not.toContain("escaped.pdf")
  })
})

describe("displayFilename", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\ada\\cv.docx", "cv.docx"],
    ["ada\u0000okafor\n.pdf", "adaokafor.pdf"],
    ["", "resume"],
    [undefined, "resume"],
  ])("%j -> %j", (input, expected) => {
    expect(displayFilename(input)).toBe(expected)
  })
})
