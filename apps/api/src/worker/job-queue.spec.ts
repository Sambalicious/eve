import { PgBoss } from "pg-boss"
import { afterEach, describe, expect, it, vi } from "vitest"

import "./candidate-job-runner.js"
import { JobQueue, candidateQueue, claimCandidateWorker, sharedQueue } from "./job-queue.js"

const SHARED = sharedQueue("test.shared")
const FOR_CANDIDATE = candidateQueue<{ postingId: string }>("test.candidate")
const ID = "00000000-0000-4000-8000-0000000000aa"

function queueWithFakeBoss() {
  const queue = new JobQueue({ databaseUrl: "postgres://unused/unused" })
  const send = vi.spyOn(PgBoss.prototype, "send").mockResolvedValue("job-id")
  const work = vi.spyOn(PgBoss.prototype, "work").mockResolvedValue("worker-id")
  return { queue, send, work }
}

describe("JobQueue split (architecture r1/r4 Worker job scoping; gap G4)", () => {
  afterEach(() => vi.restoreAllMocks())

  it("sendForCandidate writes the Candidate ID into the payload", async () => {
    const { queue, send } = queueWithFakeBoss()
    await queue.sendForCandidate(FOR_CANDIDATE, ID, { postingId: "p1" }, { singletonKey: "p1" })
    expect(send).toHaveBeenCalledWith("test.candidate", { postingId: "p1", candidateId: ID }, { singletonKey: "p1" })
  })

  it("sendForCandidate refuses an ID that is not a Candidate ID, and a shared queue", async () => {
    const { queue, send } = queueWithFakeBoss()
    await expect(queue.sendForCandidate(FOR_CANDIDATE, "not-a-uuid", { postingId: "p1" })).rejects.toThrow(/Candidate ID/)
    await expect(queue.sendForCandidate(SHARED as never, ID, { postingId: "p1" })).rejects.toThrow(/test\.shared is a shared queue/)
    expect(send).not.toHaveBeenCalled()
  })

  it("sendShared refuses a Candidate queue and a payload carrying a Candidate ID", async () => {
    const { queue, send } = queueWithFakeBoss()
    await expect(queue.sendShared(FOR_CANDIDATE as never, { postingId: "p1" })).rejects.toThrow(/test\.candidate is a Candidate queue/)
    await expect(queue.sendShared(SHARED, { candidateId: ID })).rejects.toThrow(/carries no Candidate ID/)
    expect(send).not.toHaveBeenCalled()
    await queue.sendShared(SHARED, { postingId: "p1" })
    expect(send).toHaveBeenCalledWith("test.shared", { postingId: "p1" }, undefined)
  })

  it("workShared refuses a Candidate queue: Candidate handlers register only through CandidateJobRunner", async () => {
    const { queue, work } = queueWithFakeBoss()
    await expect(queue.workShared(FOR_CANDIDATE as never, {}, async () => undefined)).rejects.toThrow(/CandidateJobRunner/)
    expect(work).not.toHaveBeenCalled()
  })
})

/**
 * F-SEC-06: whether a queue is shared or Candidate is decided by a private
 * name-to-kind registry in job-queue.ts, not by the label on the object the
 * caller passes. Each misuse the security review probed is refused before
 * pg-boss sees it.
 */
describe("queue kind registry (F-SEC-06)", () => {
  afterEach(() => vi.restoreAllMocks())
  const REGISTERED_CANDIDATE = candidateQueue<{ applicationId: string }>("test.registry.candidate", { legacyMissingIsOperator: true })
  const REGISTERED_SHARED = sharedQueue("test.registry.shared")

  it("declaring a Candidate queue's name as shared throws, and the reverse", () => {
    expect(() => sharedQueue("test.registry.candidate")).toThrow(/test\.registry\.candidate is a Candidate queue/)
    expect(() => candidateQueue("test.registry.shared")).toThrow(/test\.registry\.shared is a shared queue/)
  })

  it("declaring the same name twice with the same kind is allowed", () => {
    expect(sharedQueue("test.registry.shared").name).toBe("test.registry.shared")
    expect(candidateQueue("test.registry.candidate", { legacyMissingIsOperator: true })).toBe(REGISTERED_CANDIDATE)
  })

  it("redeclaring a Candidate queue with other options throws, so no later declaration widens the legacy rule", () => {
    expect(() => candidateQueue("test.registry.candidate")).toThrow(/already declared with other Candidate queue options/)
  })

  it("workShared refuses a Candidate queue relabelled as shared by spreading", async () => {
    const { queue, work } = queueWithFakeBoss()
    const forged = { ...REGISTERED_CANDIDATE, kind: "shared" } as never
    await expect(queue.workShared(forged, {}, async () => undefined)).rejects.toThrow(/test\.registry\.candidate is a Candidate queue/)
    expect(work).not.toHaveBeenCalled()
  })

  it("sendShared refuses a relabelled Candidate queue, so no Candidate-queue job is ever enqueued without a Candidate ID", async () => {
    const { queue, send } = queueWithFakeBoss()
    const forged = { ...REGISTERED_CANDIDATE, kind: "shared" } as never
    await expect(queue.sendShared(forged, { applicationId: "a1" })).rejects.toThrow(/test\.registry\.candidate is a Candidate queue/)
    expect(send).not.toHaveBeenCalled()
  })

  it("schedule and unschedule refuse a relabelled Candidate queue", async () => {
    const { queue } = queueWithFakeBoss()
    const schedule = vi.spyOn(PgBoss.prototype, "schedule").mockResolvedValue(undefined)
    const unschedule = vi.spyOn(PgBoss.prototype, "unschedule").mockResolvedValue(undefined)
    const forged = { ...REGISTERED_CANDIDATE, kind: "shared" } as never
    await expect(queue.schedule(forged, "* * * * *")).rejects.toThrow(/Candidate queue/)
    await expect(queue.unschedule(forged)).rejects.toThrow(/Candidate queue/)
    expect(schedule).not.toHaveBeenCalled()
    expect(unschedule).not.toHaveBeenCalled()
  })

  it("the shared methods refuse a hand-built queue whose name was never declared", async () => {
    const { queue, send, work } = queueWithFakeBoss()
    const handBuilt = { name: "test.registry.undeclared", kind: "shared" } as never
    await expect(queue.sendShared(handBuilt, {})).rejects.toThrow(/test\.registry\.undeclared is not a declared shared queue/)
    await expect(queue.workShared(handBuilt, {}, async () => undefined)).rejects.toThrow(/not a declared shared queue/)
    await expect(queue.schedule(handBuilt, "* * * * *")).rejects.toThrow(/not a declared shared queue/)
    expect(send).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
  })

  it("a hand-built object carrying a declared shared name is refused: only the declared object opens the shared door", async () => {
    const { queue, send } = queueWithFakeBoss()
    await expect(queue.sendShared({ ...REGISTERED_SHARED } as never, {})).rejects.toThrow(/not a declared shared queue/)
    expect(send).not.toHaveBeenCalled()
  })

  it("sendForCandidate refuses a shared queue relabelled as Candidate, and an undeclared Candidate queue", async () => {
    const { queue, send } = queueWithFakeBoss()
    const forged = { ...REGISTERED_SHARED, kind: "candidate", options: {} } as never
    await expect(queue.sendForCandidate(forged, ID, {})).rejects.toThrow(/test\.registry\.shared is a shared queue/)
    await expect(queue.sendForCandidate({ name: "test.registry.undeclared2", kind: "candidate", options: {} } as never, ID, {})).rejects.toThrow(/not a declared Candidate queue/)
    expect(send).not.toHaveBeenCalled()
  })

  it("sendForCandidate refuses a missing Candidate ID: a Candidate-queue job is never enqueued without one", async () => {
    const { queue, send } = queueWithFakeBoss()
    await expect(queue.sendForCandidate(REGISTERED_CANDIDATE, undefined as never, { applicationId: "a1" })).rejects.toThrow(/not a Candidate ID/)
    await expect(queue.sendForCandidate(REGISTERED_CANDIDATE, "", { applicationId: "a1" })).rejects.toThrow(/not a Candidate ID/)
    expect(send).not.toHaveBeenCalled()
  })

  it("sendForCandidate refuses a payload that tries to override the Candidate ID", async () => {
    const { queue, send } = queueWithFakeBoss()
    await queue.sendForCandidate(REGISTERED_CANDIDATE, ID, { applicationId: "a1", candidateId: "00000000-0000-4000-8000-0000000000ff" } as never)
    expect(send).toHaveBeenCalledWith("test.registry.candidate", { applicationId: "a1", candidateId: ID }, undefined)
  })

  it("createQueue refuses an undeclared or relabelled queue", async () => {
    const { queue } = queueWithFakeBoss()
    const create = vi.spyOn(PgBoss.prototype, "createQueue").mockResolvedValue(undefined)
    await expect(queue.createQueue({ name: "test.registry.undeclared3", kind: "shared" } as never)).rejects.toThrow(/not a declared/)
    await expect(queue.createQueue({ ...REGISTERED_CANDIDATE, kind: "shared" } as never)).rejects.toThrow(/Candidate queue/)
    expect(create).not.toHaveBeenCalled()
    await queue.createQueue(REGISTERED_CANDIDATE)
    expect(create).toHaveBeenCalledWith("test.registry.candidate", undefined)
  })
})

/** F-SEC-02 / F-SEC-05: no property access, however spelled, returns the pg-boss instance. */
describe("JobQueue holds pg-boss where no property access reaches it (F-SEC-02)", () => {
  const queue = new JobQueue({ databaseUrl: "postgres://unused/unused" })

  function everyKey(target: object): PropertyKey[] {
    const keys: PropertyKey[] = []
    for (let proto: object | null = target; proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) keys.push(...Reflect.ownKeys(proto))
    return keys
  }

  it("no own or inherited key, read with Reflect.get or a variable key, is a PgBoss", () => {
    for (const key of everyKey(queue)) expect(Reflect.get(queue, key)).not.toBeInstanceOf(PgBoss)
    const key = "raw" + "Boss"
    expect((queue as unknown as Record<string, unknown>)[key]).toBeUndefined()
    expect(Reflect.get(queue, "rawBoss")).toBeUndefined()
    expect(Object.values(queue).some((value) => value instanceof PgBoss)).toBe(false)
  })

  it("the Candidate worker registration is claimed once, by CandidateJobRunner when its module loads", () => {
    expect(() => claimCandidateWorker()).toThrow(/already claimed by CandidateJobRunner/)
  })
})
