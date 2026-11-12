import { describe, expect, it } from "vitest"

import { SETTLE_GIVE_UP_MS, settleDelay } from "./use-sample-settle"

describe("settleDelay", () => {
  it("starts at 2 s, grows by 1.5 and stops at 10 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(settleDelay)).toEqual([2000, 3000, 4500, 6750, 10000, 10000, 10000])
  })
  it("gives up after 5 minutes", () => {
    expect(SETTLE_GIVE_UP_MS).toBe(300_000)
  })
})
