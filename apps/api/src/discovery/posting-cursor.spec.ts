import { createHash } from "node:crypto"

import { createHmac, hkdfSync, randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { type CursorBinding, InvalidCursorError, MAX_CURSOR_MICROS, MIN_CURSOR_MICROS, type PostingKey, PostingCursorCodec, TIER_HASH, tierMapHash } from "./posting-cursor.js"
import { TIER } from "./rules/ranking.js"

/**
 * Slice 8d (8d.7, 8d.8, SEC-801, CR8-04; PF-66, PF-67): a cursor with a valid
 * MAC whose `micros` lies outside 1970-01-01 to 2200-01-01 (architecture r4
 * "A1: cursor", C40) is refused by the codec,
 * before any SQL. The codec signs whatever it is given, so `encode` builds the
 * MAC-valid cursors with the test key.
 */
const codec = new PostingCursorCodec("test-secret")
const SCOPE = { candidateId: "11111111-1111-4111-8111-111111111111", tierHash: TIER_HASH }
const ranked: CursorBinding = { tab: "ranked", families: [], foldedKeyword: null, ...SCOPE }
const all: CursorBinding = { tab: "all", families: [], foldedKeyword: null, ...SCOPE }
const skippedTab: CursorBinding = { tab: "skipped", families: [], foldedKeyword: null, ...SCOPE }

const rankedKey = (discoveredUs: string): PostingKey => ({ kind: "ranked", tier: 0, atsFit: 50, covered: 1, total: 2, fromEmployerBoard: true, discoveredUs, id: randomUUID() })
const newestKey = (discoveredUs: string): PostingKey => ({ kind: "newest", discoveredUs, id: randomUUID() })

const OUTSIDE = ["9223372036854775807", "9999999999999999999", "-9223372036854775808", "253402300800000000", "-62135596800000001", "-1", "7258118400000001"]
/** PF-66 r2 (CR8D-01, SEC-8D-01): not a decimal integer string. Must be a 400 (InvalidCursorError), never a SyntaxError. */
const NOT_A_NUMBER = ["abc", "1.5", "1e5", "-", "--1", "12 34", "", "+1", " 1", "0x10", "1n"]
const INSIDE = ["0", "1", "7258118400000000", "7258118399999999", "1792483200000000"]

describe("cursor timestamp bounds (8d.7, 8d.8)", () => {
  it("states the bounds as 1970-01-01T00:00:00Z and 2200-01-01T00:00:00Z in microseconds, both inclusive (C40)", () => {
    expect(MIN_CURSOR_MICROS).toBe(0n)
    expect(MAX_CURSOR_MICROS).toBe(7258118400000000n)
    expect(new Date(Number(MIN_CURSOR_MICROS / 1000n)).toISOString()).toBe("1970-01-01T00:00:00.000Z")
    expect(new Date(Number(MAX_CURSOR_MICROS / 1000n)).toISOString()).toBe("2200-01-01T00:00:00.000Z")
  })

  describe.each([
    ["ranked", ranked, rankedKey],
    ["all", all, newestKey],
    ["skipped", skippedTab, newestKey],
  ] as const)("tab %s", (_tab, binding, key) => {
    it.each(OUTSIDE)("PF-66: micros %s is refused", (micros) => {
      const cursor = codec.encode(binding, key(micros))
      expect(() => codec.decode(cursor, binding)).toThrow(InvalidCursorError)
    })

    it.each(NOT_A_NUMBER)("PF-66 r2: micros %j is refused with InvalidCursorError", (micros) => {
      const cursor = codec.encode(binding, key(micros))
      expect(() => codec.decode(cursor, binding)).toThrow(InvalidCursorError)
    })

    it.each(INSIDE)("PF-67: micros %s is accepted", (micros) => {
      const issued = key(micros)
      expect(codec.decode(codec.encode(binding, issued), binding)).toEqual(issued)
    })
  })
})

/**
 * EPIC-0002 A1 (architecture r4 "A1: cursor", C30, C40): version 2 binds the
 * cursor to the Candidate and to the tier map the page was ranked with. A
 * cursor from another Candidate, from another tier map, or of version 1 is
 * refused (400 over HTTP; the client reloads page 1).
 */
describe("cursor version 2 (EPIC-0002 A1)", () => {
  const owner = "11111111-1111-4111-8111-111111111111"
  const invitee = "22222222-2222-4222-8222-222222222222"
  const bindingFor = (candidateId: string, tierHash = TIER_HASH): CursorBinding => ({ tab: "all", families: ["backend"], foldedKeyword: "react", candidateId, tierHash })
  const key = newestKey("1792483200000000")

  it("round-trips for the Candidate it was issued to", () => {
    expect(codec.decode(codec.encode(bindingFor(owner), key), bindingFor(owner))).toEqual(key)
  })

  it("refuses another Candidate's cursor", () => {
    expect(() => codec.decode(codec.encode(bindingFor(owner), key), bindingFor(invitee))).toThrow(InvalidCursorError)
  })

  it("refuses a cursor issued under another tier map", () => {
    expect(() => codec.decode(codec.encode(bindingFor(owner, "a-different-tier-hash"), key), bindingFor(owner))).toThrow(InvalidCursorError)
  })

  it("writes version 2 and refuses a version 1 payload even with a valid MAC", () => {
    const cursor = codec.encode(bindingFor(owner), key)
    const [payload] = cursor.split(".") as [string]
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v: number }
    expect(decoded.v).toBe(2)
    const v1 = Buffer.from(JSON.stringify({ ...decoded, v: 1 }), "utf8").toString("base64url")
    const mac = createHmac("sha256", Buffer.from(hkdfSync("sha256", Buffer.from("test-secret", "utf8"), Buffer.alloc(0), "eve/job-postings-cursor/v2", 32))).update(v1, "utf8").digest("base64url")
    expect(() => codec.decode(`${v1}.${mac}`, bindingFor(owner))).toThrow(InvalidCursorError)
  })

  it("refuses a ranked key without ATS fit (written before 0029), even with a valid MAC", () => {
    const ranked: CursorBinding = { ...bindingFor(owner), tab: "ranked" }
    // A current ranked key decodes...
    const cursor = codec.encode(ranked, rankedKey("1700000000000000"))
    expect(codec.decode(cursor, ranked)).toMatchObject({ kind: "ranked", atsFit: 50 })
    const [payload] = cursor.split(".") as [string]
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { k: unknown[] }
    const old = Buffer.from(JSON.stringify({ ...decoded, k: [decoded.k[0], decoded.k[1], ...decoded.k.slice(3)] }), "utf8").toString("base64url")
    const mac = createHmac("sha256", Buffer.from(hkdfSync("sha256", Buffer.from("test-secret", "utf8"), Buffer.alloc(0), "eve/job-postings-cursor/v2", 32))).update(old, "utf8").digest("base64url")
    // ...one without ATS fit does not.
    expect(() => codec.decode(`${old}.${mac}`, ranked)).toThrow(InvalidCursorError)
  })

  it("keys the MAC under the v2 label: a v1-label MAC is refused", () => {
    const cursor = codec.encode(bindingFor(owner), key)
    const [payload] = cursor.split(".") as [string]
    const v1Mac = createHmac("sha256", Buffer.from(hkdfSync("sha256", Buffer.from("test-secret", "utf8"), Buffer.alloc(0), "eve/job-postings-cursor/v1", 32))).update(payload, "utf8").digest("base64url")
    expect(() => codec.decode(`${payload}.${v1Mac}`, bindingFor(owner))).toThrow(InvalidCursorError)
  })

  it("EPIC-0006: TIER_HASH differs from the nine-family v1.17 hash, so every cursor issued before the deploy is 400 once", () => {
    const nine = [["senior_frontend", 0], ["technical_lead", 0], ["fullstack", 1], ["product_engineering", 1], ["backend", 2], ["mobile", 2], ["devops_platform", 2], ["people_management", 2], ["other", 2]]
    const v117 = createHash("sha256").update(JSON.stringify(nine), "utf8").digest("base64url").slice(0, 22)
    expect(TIER_HASH).not.toBe(v117)
    const issuedBefore = codec.encode({ tab: "all", families: [], foldedKeyword: null, candidateId: SCOPE.candidateId, tierHash: v117 }, { kind: "newest", discoveredUs: "1792400000000000", id: SCOPE.candidateId })
    expect(() => codec.decode(issuedBefore, { tab: "all", families: [], foldedKeyword: null, candidateId: SCOPE.candidateId, tierHash: TIER_HASH })).toThrow(InvalidCursorError)
  })

  it("TIER_HASH is the hash of the built TIER map and changes with it", () => {
    expect(TIER_HASH).toBe(tierMapHash(TIER))
    expect(tierMapHash({ ...TIER, backend: 0 })).not.toBe(TIER_HASH)
  })
})
