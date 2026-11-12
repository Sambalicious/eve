import { describe, expect, it } from "vitest"

import { issueProof, verifyProof } from "./fill-proof.js"

const key = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 8)
const T0 = Date.parse("2026-10-21T10:00:00.000Z")

describe("fill-time proof (architecture.r1 7.6, AC 11.11)", () => {
  it("has the shape <issuedAtMs>.<base64url sig of 16 bytes>", () => {
    const proof = issueProof(T0, key)
    expect(proof).toMatch(/^\d+\.[A-Za-z0-9_-]{22}$/)
    expect(proof.startsWith(`${T0}.`)).toBe(true)
    expect(proof.length).toBeLessThanOrEqual(200)
  })

  it("2999 ms is too young, exactly 3000 ms passes", () => {
    const proof = issueProof(T0, key)
    expect(verifyProof(proof, T0 + 2999, key)).toBe(false)
    expect(verifyProof(proof, T0 + 3000, key)).toBe(true)
  })

  it("24 h passes, 24 h plus 1 ms is expired", () => {
    const proof = issueProof(T0, key)
    expect(verifyProof(proof, T0 + 24 * 3_600_000, key)).toBe(true)
    expect(verifyProof(proof, T0 + 24 * 3_600_000 + 1, key)).toBe(false)
  })

  it("a future issue time fails", () => {
    expect(verifyProof(issueProof(T0 + 10_000, key), T0 + 5_000, key)).toBe(false)
  })

  it("a tampered time, a tampered signature or another key fails", () => {
    const proof = issueProof(T0, key)
    const [, sig] = proof.split(".")
    expect(verifyProof(`${T0 - 60_000}.${sig}`, T0 + 5_000, key)).toBe(false)
    const flipped = `${T0}.${sig!.startsWith("A") ? "B" : "A"}${sig!.slice(1)}`
    expect(verifyProof(flipped, T0 + 5_000, key)).toBe(false)
    expect(verifyProof(proof, T0 + 5_000, otherKey)).toBe(false)
  })

  it.each([null, "", "abc", "1.2.3", ".x", "12.", "-5.AAAAAAAAAAAAAAAAAAAAAA", "1e3.AAAAAAAAAAAAAAAAAAAAAA", `${"9".repeat(30)}.AAAAAAAAAAAAAAAAAAAAAA`])(
    "malformed %j fails without throwing",
    (proof) => {
      expect(verifyProof(proof, T0 + 5_000, key)).toBe(false)
    }
  )
})
