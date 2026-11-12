import { inspect } from "node:util"

import { describe, expect, it } from "vitest"

import { accessRequestKeys } from "./access-request-keys.js"

const SECRET = "test-access-request-secret-0123456789-SENTINEL"

describe("access-request keys (architecture.r1 7.5)", () => {
  it("derives two different 32-byte subkeys", () => {
    const keys = accessRequestKeys(SECRET)
    expect(keys.ipKey()).toHaveLength(32)
    expect(keys.proofKey()).toHaveLength(32)
    expect(keys.ipKey().equals(keys.proofKey())).toBe(false)
  })

  it("is deterministic for one secret and differs for another", () => {
    expect(accessRequestKeys(SECRET).ipKey().equals(accessRequestKeys(SECRET).ipKey())).toBe(true)
    expect(accessRequestKeys(`${SECRET}x`).ipKey().equals(accessRequestKeys(SECRET).ipKey())).toBe(false)
  })

  it("never reveals the secret or keys when serialised or inspected", () => {
    const keys = accessRequestKeys(SECRET)
    expect(JSON.stringify(keys)).not.toContain("SENTINEL")
    expect(inspect(keys, { depth: 10 })).not.toContain("SENTINEL")
    expect(inspect(keys, { depth: 10 })).not.toContain(keys.ipKey().toString("hex"))
  })
})
