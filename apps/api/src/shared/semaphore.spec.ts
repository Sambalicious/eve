import { describe, expect, it } from "vitest"

import { Semaphore } from "./semaphore.js"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("Semaphore", () => {
  it("runs at most `slots` holders at once and starts waiters in arrival order", async () => {
    const semaphore = new Semaphore(2)
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []
    let peak = 0
    const runs = gates.map((gate, index) =>
      semaphore.use(async () => {
        started.push(index)
        peak = Math.max(peak, semaphore.inUse)
        await gate.promise
        return index
      })
    )
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    gates[1]!.resolve()
    await runs[1]
    expect(started).toEqual([0, 1, 2])
    gates[0]!.resolve()
    gates[2]!.resolve()
    gates[3]!.resolve()
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3])
    expect(started).toEqual([0, 1, 2, 3])
    expect(peak).toBe(2)
    expect(semaphore.inUse).toBe(0)
  })

  it("releases the slot when the work throws", async () => {
    const semaphore = new Semaphore(1)
    await expect(semaphore.use(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(await semaphore.use(() => Promise.resolve("next"))).toBe("next")
    expect(semaphore.inUse).toBe(0)
  })

  it("refuses zero or fractional slots", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError)
    expect(() => new Semaphore(1.5)).toThrow(RangeError)
  })
})
