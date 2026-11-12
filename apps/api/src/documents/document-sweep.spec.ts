import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Logger } from "@nestjs/common"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CandidateFiles } from "../files/candidate-files.js"
import { DocumentSweep, SWEEP_FIRST_DELAY_MS, SWEEP_INTERVAL_MS, SWEEP_MIN_AGE_MS } from "./document-sweep.js"

/** automatic-expiry.feature "The api sweep runs every hour and 60 seconds after the api starts" (E4.4). */
describe("DocumentSweep schedule", () => {
  afterEach(() => vi.useRealTimers())

  it("sweeps 60 s after start, then once an hour, and stops on shutdown", () => {
    vi.useFakeTimers()
    const sweep = new DocumentSweep({} as never, {} as never)
    const run = vi.spyOn(sweep, "sweep").mockResolvedValue({ scanned: 0, removed: 0, failed: 0, ignored: 0, skippedCandidates: 0 })
    sweep.onApplicationBootstrap()
    vi.advanceTimersByTime(SWEEP_FIRST_DELAY_MS - 1)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 2)
    expect(run).toHaveBeenCalledTimes(3)
    sweep.onApplicationShutdown()
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3)
    expect(run).toHaveBeenCalledTimes(3)
  })
})

/**
 * F-CR-11: one Candidate's `documents` path that is not a real directory must
 * not stop the hourly sweep for the Candidates after it. Real files under a
 * temp root; the database stand-in says no Tailored Document references anything.
 */
describe("DocumentSweep with a broken Candidate directory (F-CR-11)", () => {
  const BROKEN = "00000000-0000-4000-8000-000000000001"
  const HEALTHY = "00000000-0000-4000-8000-000000000002"
  const OLD_NAME = "9d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.pdf"
  const YOUNG_NAME = "8d1c2e4a-0b7f-4c1e-9a3d-5f6e7a8b9c0d.docx"
  const OLD = new Date(Date.now() - 2 * SWEEP_MIN_AGE_MS)
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ja-a2j-sweep-"))
    await mkdir(join(root, BROKEN, "resumes"), { recursive: true, mode: 0o700 })
    await writeFile(join(root, BROKEN, "documents"), "not a directory")
    await utimes(join(root, BROKEN, "documents"), OLD, OLD)
    await writeFile(join(root, BROKEN, "resumes", OLD_NAME), "resume")
    await utimes(join(root, BROKEN, "resumes", OLD_NAME), OLD, OLD)
    await mkdir(join(root, HEALTHY, "documents"), { recursive: true, mode: 0o700 })
    await writeFile(join(root, HEALTHY, "documents", OLD_NAME), "old")
    await utimes(join(root, HEALTHY, "documents", OLD_NAME), OLD, OLD)
    await writeFile(join(root, HEALTHY, "documents", YOUNG_NAME), "young")
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  const tenant = {
    tryWithSessionLock: <T>(_key: number, work: () => Promise<T>) => work(),
    candidateIds: async () => [BROKEN, HEALTHY],
    forCandidate: async () => [],
  }

  it("skips that Candidate with a warning that names no path, and still sweeps the next Candidate", async () => {
    const warnings: string[] = []
    vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void warnings.push(String(message)))
    const logs: string[] = []
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)))
    const result = await new DocumentSweep(tenant as never, new CandidateFiles(root)).sweep()
    expect(result).toMatchObject({ removed: 1, failed: 0, skippedCandidates: 1, skipped: "unreadable" })
    expect(logs).toEqual(["Document sweep: scanned 2, removed 1, not removed 0, ignored 0, skipped Candidates 1"])
    expect(await readdir(join(root, HEALTHY, "documents"))).toEqual([YOUNG_NAME])
    expect(await readFile(join(root, BROKEN, "documents"), "utf8")).toBe("not a directory")
    expect(await readdir(join(root, BROKEN, "resumes"))).toEqual([OLD_NAME])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^Document sweep: skipped a Candidate whose document directory could not be read/)
    expect(warnings[0]).not.toContain(root)
    expect(warnings[0]).not.toContain("/")
  })

  /** F-SEC-42: a Candidate skipped every hour must show in the counts line even when nothing else was removed or failed. */
  it("logs the counts line with the skipped Candidate when nothing was removed or failed", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {})
    const logs: string[] = []
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)))
    const onlyBroken = { ...tenant, candidateIds: async () => [BROKEN] }
    const result = await new DocumentSweep(onlyBroken as never, new CandidateFiles(root)).sweep()
    expect(result).toEqual({ scanned: 0, removed: 0, failed: 0, ignored: 0, skippedCandidates: 1, skipped: "unreadable" })
    expect(logs).toEqual(["Document sweep: scanned 0, removed 0, not removed 0, ignored 0, skipped Candidates 1"])
    expect(logs[0]).not.toContain("/")
  })

  it("logs no counts line when nothing was removed, failed or skipped", async () => {
    const logs: string[] = []
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)))
    const onlyHealthy = { ...tenant, candidateIds: async () => [HEALTHY] }
    await rm(join(root, HEALTHY, "documents", OLD_NAME))
    const result = await new DocumentSweep(onlyHealthy as never, new CandidateFiles(root)).sweep()
    expect(result).toEqual({ scanned: 1, removed: 0, failed: 0, ignored: 0, skippedCandidates: 0 })
    expect(logs).toEqual([])
  })
})
