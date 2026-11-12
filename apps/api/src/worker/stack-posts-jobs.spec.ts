import { Logger } from "@nestjs/common"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TenantDatabase } from "../db/tenant-database.js"
import type { Clock } from "../shared/clock.js"
import type { HiringPostsReader } from "../stack-posts/hiring-posts-reader.js"
import type { StackPostsReader } from "../stack-posts/stack-posts-reader.js"
import type { JobQueue } from "./job-queue.js"
import { SCHEDULED_READ_FAILURE_EVENT, SCHEDULED_READ_WARN_AFTER_MS, StackPostsJobs } from "./stack-posts-jobs.js"

/**
 * SEC-P3-02 (threat model P3-11): one scheduled run (every Candidate's Stack
 * posts read, then every Candidate's Hiring read, EPIC-0008 AR-6) must finish inside the 6-hour gap between cron
 * ticks. The queue is a singleton, so an overrunning run makes the next tick be
 * skipped silently; the job logs a warning with the elapsed time and the
 * Candidate count instead.
 */
const HOUR = 3_600_000
const START = Date.parse("2026-10-24T01:00:00Z")

const COMPLETED = { outcome: "completed", feedsRead: 0, feedsFailed: 0, postsStored: 0, postsDeleted: 0 } as const

/** Stack posts reads take no clock time unless `stackRunMs` says so; Hiring reads take `hiringRunMs[i]` each. */
function jobs(hiringRunMs: readonly number[], options: Readonly<{ stackRunMs?: readonly number[]; states?: Readonly<Record<string, string>> }> = {}) {
  let now = START
  const clock: Clock = { now: () => new Date(now) }
  const ids = hiringRunMs.map((_, i) => `c${i}`)
  const order: string[] = []
  let scope: string | null = null
  const tenant = {
    eachCandidate: async <T>(work: (id: string) => Promise<T>) => {
      const out: T[] = []
      for (const id of ids) {
        scope = id
        out.push(await work(id))
        scope = null
      }
      return out
    },
    candidateIdentity: async (id: string) => ({ role: "candidate", state: options.states?.[id] ?? "active" }),
  } as unknown as TenantDatabase
  let stackCall = 0
  const reader = {
    runRead: async () => {
      order.push(`stack:${scope}`)
      now += options.stackRunMs?.[stackCall++] ?? 0
      return COMPLETED
    },
  } as unknown as StackPostsReader
  let call = 0
  const hiringReader = {
    runRead: async () => {
      order.push(`hiring:${scope}`)
      now += hiringRunMs[call++] ?? 0
      return COMPLETED
    },
  } as unknown as HiringPostsReader
  const job = new StackPostsJobs({} as JobQueue, reader, hiringReader, tenant, clock)
  return Object.assign(job, { order, stubs: { reader, hiringReader, tenant } })
}

afterEach(() => vi.restoreAllMocks())

describe("scheduled read run time (SEC-P3-02)", () => {
  it("the limit is the 6-hour gap between the 02:00, 08:00, 14:00 and 20:00 runs", () => {
    expect(SCHEDULED_READ_WARN_AFTER_MS).toBe(6 * HOUR)
  })

  it("warns once with the elapsed time and the Candidate count when a run passes 6 hours", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    await jobs([3 * HOUR, 3 * HOUR + 60_000, 0]).runScheduled()
    expect(warn.mock.calls).toEqual([["Stack posts scheduled read took 361 min, over the 360 min limit (Candidates: 3); the next scheduled run may be skipped"]])
  })

  it("does not warn at exactly 6 hours or less", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    await jobs([2 * HOUR, 4 * HOUR]).runScheduled()
    await jobs([60_000]).runScheduled()
    expect(warn).not.toHaveBeenCalled()
  })

  it("still warns when a Hiring read fails, and never logs anything but the counts", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    const job = jobs([7 * HOUR])
    const hiring = (job as unknown as { hiringReader: { runRead: () => Promise<unknown> } }).hiringReader
    const original = hiring.runRead
    hiring.runRead = async () => {
      await original()
      throw new Error("feed https://www.google.com/alerts/feeds/1/2 failed")
    }
    const result = await job.runScheduled()
    expect(result.hiring).toEqual([{ candidateId: "c0", result: "failed" }])
    expect(warn.mock.calls).toEqual([["Stack posts scheduled read took 420 min, over the 360 min limit (Candidates: 1); the next scheduled run may be skipped"]])
  })
})

describe("scheduled Stack posts read per Candidate (EPIC-0008 AR-6, AR-10)", () => {
  it("SFS:26, SFS:44: reads each active Candidate's Stack posts one after another in her own scope, all before the Hiring loop", async () => {
    const job = jobs([0, 0, 0])
    const result = await job.runScheduled()
    expect(job.order).toEqual(["stack:c0", "stack:c1", "stack:c2", "hiring:c0", "hiring:c1", "hiring:c2"])
    expect(result.stack).toEqual([
      { candidateId: "c0", result: COMPLETED },
      { candidateId: "c1", result: COMPLETED },
      { candidateId: "c2", result: COMPLETED },
    ])
  })

  it.each(["revoked", "deleting"])("SFS:129: a Candidate whose state is %s is not_active with no Stack posts read", async (state) => {
    const job = jobs([0, 0], { states: { c1: state } })
    const result = await job.runScheduled()
    expect(result.stack).toEqual([
      { candidateId: "c0", result: COMPLETED },
      { candidateId: "c1", result: "not_active" },
    ])
    expect(job.order.filter((entry) => entry.startsWith("stack:"))).toEqual(["stack:c0"])
  })

  it("SFS:173, SFS:211: one Candidate's failure is logged with her id and no URL, the others are still read, and the job resolves", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    const job = jobs([0, 0, 0])
    const original = job.stubs.reader.runRead
    job.stubs.reader.runRead = async () => {
      const value = await original()
      if (job.order.at(-1) === "stack:c1") throw new Error("feed https://www.google.com/alerts/feeds/1/2 basis Secret")
      return value
    }
    const result = await job.runScheduled()
    expect(result.stack.map((entry) => entry.result)).toEqual([COMPLETED, "failed", COMPLETED])
    expect(result.hiring.map((entry) => entry.result)).toEqual([COMPLETED, COMPLETED, COMPLETED])
    const lines = error.mock.calls.map((call) => String(call[0]))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^Stack posts read for Candidate c1 failed: /)
    expect(lines[1]).toBe("Scheduled feed read finished with failed Candidates: event=scheduled_read_candidate_failures stack_failed=1 hiring_failed=0 candidates=3")
    for (const line of lines) expect(line).not.toMatch(/google\.com|alerts\/feeds|Secret/)
  })

  it("SEC-E8-05: the alert event name is stable", () => {
    expect(SCHEDULED_READ_FAILURE_EVENT).toBe("scheduled_read_candidate_failures")
  })

  it("SEC-E8-05: a run with no failed Candidate logs no failure event", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    await jobs([0, 0, 0]).runScheduled()
    expect(error).not.toHaveBeenCalled()
  })

  it("SEC-E8-05: Stack posts and Hiring failures are counted in one event line with no Candidate id", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    const job = jobs([0, 0, 0])
    const stackRead = job.stubs.reader.runRead
    job.stubs.reader.runRead = async () => {
      const value = await stackRead()
      if (job.order.at(-1) !== "stack:c1") throw new Error("boom")
      return value
    }
    const hiringRead = job.stubs.hiringReader.runRead
    job.stubs.hiringReader.runRead = async () => {
      const value = await hiringRead()
      if (job.order.at(-1) === "hiring:c2") throw new Error("boom")
      return value
    }
    await job.runScheduled()
    const events = error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(`event=${SCHEDULED_READ_FAILURE_EVENT}`))
    expect(events).toEqual(["Scheduled feed read finished with failed Candidates: event=scheduled_read_candidate_failures stack_failed=2 hiring_failed=1 candidates=3"])
  })

  it("SFS:188: a Hiring failure for one Candidate leaves every Stack posts read and the other Hiring reads in place", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    const job = jobs([0, 0])
    const original = job.stubs.hiringReader.runRead
    job.stubs.hiringReader.runRead = async () => {
      const value = await original()
      if (job.order.at(-1) === "hiring:c0") throw new Error("boom")
      return value
    }
    const result = await job.runScheduled()
    expect(result.stack.map((entry) => entry.result)).toEqual([COMPLETED, COMPLETED])
    expect(result.hiring.map((entry) => entry.result)).toEqual(["failed", COMPLETED])
  })

  it("SFS:203: when listing Candidates fails for the Stack posts loop, the Hiring loop still runs and the job then fails", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    const job = jobs([0, 0])
    const each = job.stubs.tenant.eachCandidate.bind(job.stubs.tenant)
    let calls = 0
    ;(job.stubs.tenant as { eachCandidate: typeof each }).eachCandidate = async (work) => {
      if (calls++ === 0) throw new Error("candidate list query failed")
      return each(work)
    }
    await expect(job.runScheduled()).rejects.toThrow("candidate list query failed")
    expect(job.order).toEqual(["hiring:c0", "hiring:c1"])
  })

  it("SFS:96, SFS:144: the Candidate state is re-checked at every run", async () => {
    const states: Record<string, string> = { c0: "revoked" }
    const job = jobs([0], { states })
    expect((await job.runScheduled()).stack).toEqual([{ candidateId: "c0", result: "not_active" }])
    states.c0 = "active"
    expect((await job.runScheduled()).stack).toEqual([{ candidateId: "c0", result: COMPLETED }])
  })

  it("the overrun warning counts the larger loop and includes Stack posts read time", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    await jobs([0, 0], { stackRunMs: [4 * HOUR, 2 * HOUR + 60_000] }).runScheduled()
    expect(warn.mock.calls).toEqual([["Stack posts scheduled read took 361 min, over the 360 min limit (Candidates: 2); the next scheduled run may be skipped"]])
  })

  it("AR-11: the job registers one singleton, no-retry queue on the fixed cron and never sends to it", async () => {
    const calls: string[] = []
    // Merge with A2: the job reaches pg-boss only through JobQueue's declared-queue methods (sharedQueue, workShared).
    const queue = {
      createQueue: async (q: { name: string }, options: unknown) => void calls.push(`create ${q.name} ${JSON.stringify(options)}`),
      schedule: async (q: { name: string }, cron: string, options: unknown) => void calls.push(`schedule ${q.name} ${cron} ${JSON.stringify(options)}`),
      workShared: async (q: { name: string }, options: unknown) => void calls.push(`work ${q.name} ${JSON.stringify(options)}`),
      sendShared: async () => void calls.push("send"),
      sendForCandidate: async () => void calls.push("send"),
    }
    const job = new StackPostsJobs(queue as unknown as JobQueue, {} as StackPostsReader, {} as HiringPostsReader, {} as TenantDatabase, { now: () => new Date(START) })
    await job.onApplicationBootstrap()
    expect(calls).toEqual([
      'create stack-posts.read {"policy":"singleton","retryLimit":0}',
      'schedule stack-posts.read 0 2,8,14,20 * * * {"tz":"Africa/Lagos"}',
      'work stack-posts.read {"batchSize":1}',
    ])
  })
})
