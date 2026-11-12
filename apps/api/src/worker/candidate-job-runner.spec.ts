import { Logger } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { CandidateScope } from "../db/candidate-scope.js"
import type { TenantDatabase } from "../db/tenant-database.js"
import { CandidateJobRunner } from "./candidate-job-runner.js"
import { type CandidateQueue, candidateQueue, sharedQueue } from "./job-queue.js"
import type { JobQueue } from "./job-queue.js"
import { SAMPLE_SUBMISSION } from "./submission-jobs.js"

const OPERATOR = "00000000-0000-4000-8000-0000000000a1"
const INVITEE = "00000000-0000-4000-8000-0000000000b2"
const REVOKED = "00000000-0000-4000-8000-0000000000c3"
const IDENTITIES: Record<string, { role: "operator" | "candidate"; state: "active" | "revoked" | "deleting" }> = {
  [OPERATOR]: { role: "operator", state: "active" },
  [INVITEE]: { role: "candidate", state: "active" },
  [REVOKED]: { role: "candidate", state: "revoked" },
}
const tenant = {
  operatorId: async () => OPERATOR,
  candidateIdentity: async (id: string) => IDENTITIES[id],
} as unknown as TenantDatabase
const runner = new CandidateJobRunner({} as JobQueue, tenant)

const STRICT = candidateQueue<{ postingId: string }>("test.strict")
const LEGACY = candidateQueue<{ applicationId: string }>("test.legacy", { legacyMissingIsOperator: true })
const SUBMISSION = candidateQueue<{ applicationId: string }>("test.submission", { legacyMissingIsOperator: true, operatorOnlyUntil: "submission" })

function recording() {
  const calls: { candidateId: string; scope: string | undefined; data: unknown }[] = []
  return { calls, handler: async (candidateId: string, data: unknown) => void calls.push({ candidateId, scope: CandidateScope.current(), data }) }
}

describe("CandidateJobRunner (data-isolation.feature:361, :391, :612)", () => {
  it("runs the handler in the job's Candidate scope with the payload minus the ID", async () => {
    const { calls, handler } = recording()
    expect(await runner.run(STRICT, { candidateId: INVITEE, postingId: "p1" }, handler)).toEqual({ result: "ran", candidateId: INVITEE })
    expect(calls).toEqual([{ candidateId: INVITEE, scope: INVITEE, data: { postingId: "p1" } }])
  })

  it("refuses a job with no Candidate ID, logs the refusal and runs nothing (:391)", async () => {
    const { calls, handler } = recording()
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    try {
      expect(await runner.run(STRICT, { postingId: "p1" }, handler)).toEqual({ result: "refused", reason: "missing_candidate_id" })
      expect(await runner.run(STRICT, { candidateId: "nope", postingId: "p1" }, handler)).toEqual({ result: "refused", reason: "missing_candidate_id" })
      expect(warn.mock.calls.map((call) => String(call[0]))).toContain("Refused a test.strict job: missing_candidate_id")
    } finally {
      warn.mockRestore()
    }
    expect(calls).toEqual([])
  })

  it("treats a missing ID as the Operator on a queue with pre-migration payloads (submission.sample before 0010)", async () => {
    const { calls, handler } = recording()
    expect(await runner.run(LEGACY, { applicationId: "a1" }, handler)).toEqual({ result: "ran", candidateId: OPERATOR })
    expect(calls[0]?.scope).toBe(OPERATOR)
  })

  it("refuses an unknown or revoked Candidate", async () => {
    const { calls, handler } = recording()
    expect(await runner.run(STRICT, { candidateId: "00000000-0000-4000-8000-0000000000ff", postingId: "p" }, handler)).toEqual({ result: "refused", reason: "candidate_not_active" })
    expect(await runner.run(STRICT, { candidateId: REVOKED, postingId: "p" }, handler)).toEqual({ result: "refused", reason: "candidate_not_active" })
    expect(calls).toEqual([])
  })

  it("before conversion, refuses a non-Operator on an Operator-only queue and runs the Operator's job (:612)", async () => {
    const { calls, handler } = recording()
    expect(await runner.run(SUBMISSION, { candidateId: INVITEE, applicationId: "a1" }, handler)).toEqual({ result: "refused", reason: "feature_not_yet_available" })
    expect(await runner.run(SUBMISSION, { candidateId: OPERATOR, applicationId: "a2" }, handler)).toEqual({ result: "ran", candidateId: OPERATOR })
    expect(calls.map((call) => call.data)).toEqual([{ applicationId: "a2" }])
  })
})

describe("CandidateJobRunner resolves the queue through the private registry (F-SEC-08)", () => {
  const forged = <T extends object>(queue: object) => queue as CandidateQueue<T>
  const NOT_REGISTERED = /is not a declared Candidate queue|is a shared queue/

  it("refuses a hand-built object naming a shared queue, in work and in run, and runs nothing", async () => {
    sharedQueue("retention.daily")
    const { calls, handler } = recording()
    const fake = forged<object>({ name: "retention.daily", kind: "candidate", options: { legacyMissingIsOperator: true } })
    await expect(runner.work(fake, {}, handler)).rejects.toThrow(/retention\.daily is a shared queue/)
    await expect(runner.run(fake, {}, handler)).rejects.toThrow(/retention\.daily is a shared queue/)
    expect(calls).toEqual([])
  })

  it("refuses a hand-built object naming an undeclared queue", async () => {
    const { calls, handler } = recording()
    const fake = forged<object>({ name: "never.declared", kind: "candidate", options: { legacyMissingIsOperator: true } })
    await expect(runner.work(fake, {}, handler)).rejects.toThrow(/never\.declared is not a declared Candidate queue/)
    await expect(runner.run(fake, {}, handler)).rejects.toThrow(/never\.declared is not a declared Candidate queue/)
    expect(calls).toEqual([])
  })

  it("a copy of SAMPLE_SUBMISSION without operatorOnlyUntil does not run an invitee's job; the declared object still refuses it", async () => {
    const { calls, handler } = recording()
    const copy = forged<{ applicationId: string }>({ ...SAMPLE_SUBMISSION, options: {} })
    const relabelled = forged<{ applicationId: string }>({ ...SAMPLE_SUBMISSION })
    for (const queue of [copy, relabelled]) {
      await expect(runner.work(queue, {}, handler)).rejects.toThrow(NOT_REGISTERED)
      await expect(runner.run(queue, { candidateId: INVITEE, applicationId: "a1" }, handler)).rejects.toThrow(NOT_REGISTERED)
    }
    expect(await runner.run(SAMPLE_SUBMISSION, { candidateId: INVITEE, applicationId: "a1" }, handler)).toEqual({ result: "refused", reason: "feature_not_yet_available" })
    expect(calls).toEqual([])
  })

  it("reads options from the registry entry, not from a caller's object that mutates after declaration", async () => {
    const { calls, handler } = recording()
    expect(Object.isFrozen(SAMPLE_SUBMISSION) && Object.isFrozen(SAMPLE_SUBMISSION.options)).toBe(true)
    expect(() => Object.assign(SAMPLE_SUBMISSION.options as object, { operatorOnlyUntil: undefined })).toThrow(TypeError)
    expect(await runner.run(SAMPLE_SUBMISSION, { candidateId: INVITEE, applicationId: "a1" }, handler)).toEqual({ result: "refused", reason: "feature_not_yet_available" })
    expect(calls).toEqual([])
  })

  it("refuses a job with no Candidate ID on a declared strict queue, and a forged legacy label cannot change that", async () => {
    const { calls, handler } = recording()
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    try {
      expect(await runner.run(STRICT, { postingId: "p1" }, handler)).toEqual({ result: "refused", reason: "missing_candidate_id" })
      await expect(runner.run(forged<{ postingId: string }>({ ...STRICT, options: { legacyMissingIsOperator: true } }), { postingId: "p1" }, handler)).rejects.toThrow(NOT_REGISTERED)
    } finally {
      warn.mockRestore()
    }
    expect(calls).toEqual([])
  })
})
