import { describe, expect, it, vi } from "vitest"

import type { TenantDatabase } from "../db/tenant-database.js"
import { DiscoveryRepository, isLockTimeout } from "./discovery.repository.js"

type Once = (...args: unknown[]) => Promise<unknown>

/** A repository whose single verdict transaction is replaced by `attempt` (CR-04). */
function withAttempts(...outcomes: Array<Error | "ok">) {
  const repository = new DiscoveryRepository({} as TenantDatabase)
  const attempt = vi.fn<Once>()
  for (const outcome of outcomes) {
    if (outcome === "ok") attempt.mockResolvedValueOnce({ version: 2 })
    else attempt.mockRejectedValueOnce(outcome)
  }
  ;(repository as unknown as { recordEvaluationOnce: Once }).recordEvaluationOnce = attempt
  const record = (): Promise<unknown> => repository.recordEvaluation("p1", {} as never, () => ({}) as never)
  return { attempt, record }
}

const lockTimeout = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" })

describe("DiscoveryRepository.recordEvaluation lock-timeout retry (architecture 'Lock waits in the worker', CR-04)", () => {
  it("retries once after a lock timeout and returns the second attempt's criteria", async () => {
    const { attempt, record } = withAttempts(lockTimeout(), "ok")
    await expect(record()).resolves.toEqual({ version: 2 })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it("gives up after the one retry: a second lock timeout propagates", async () => {
    const { attempt, record } = withAttempts(lockTimeout(), lockTimeout(), "ok")
    await expect(record()).rejects.toMatchObject({ code: "55P03" })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it("does not retry any other error", async () => {
    const { attempt, record } = withAttempts(Object.assign(new Error("deadlock"), { code: "40P01" }), "ok")
    await expect(record()).rejects.toMatchObject({ code: "40P01" })
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it.each([[{ code: "55P03" }, true], [{ code: "57014" }, false], [new Error("x"), false], [null, false], ["55P03", false]])("isLockTimeout(%j) is %s", (error, expected) => {
    expect(isLockTimeout(error)).toBe(expected)
  })
})
