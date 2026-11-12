import { describe, expect, it } from "vitest"

import { hashClientIp, normalizeClientIp } from "./client-ip.js"

const key = Buffer.alloc(32, 1)

describe("client IP normalization and hashing (architecture.r1 7.5, AC 11.20)", () => {
  it("keeps IPv4 as is", () => {
    expect(normalizeClientIp("203.0.113.7")).toBe("203.0.113.7")
  })

  it("converts IPv4-mapped IPv6 to IPv4", () => {
    expect(normalizeClientIp("::ffff:203.0.113.7")).toBe("203.0.113.7")
    expect(normalizeClientIp("::FFFF:203.0.113.7")).toBe("203.0.113.7")
  })

  it("cuts IPv6 to its /64 prefix", () => {
    expect(normalizeClientIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64")
    expect(normalizeClientIp("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64")
    expect(normalizeClientIp("2001:DB8:0001:0002::ffff")).toBe("2001:db8:1:2::/64")
    expect(normalizeClientIp("2001:db8::1")).toBe("2001:db8:0:0::/64")
    expect(normalizeClientIp("::1")).toBe("0:0:0:0::/64")
  })

  it("two hosts in one /64 share a hash; another /64 does not", () => {
    const a = hashClientIp("2001:db8:1:2::1", key)
    expect(hashClientIp("2001:db8:1:2:ffff::9", key)).toBe(a)
    expect(hashClientIp("2001:db8:1:3::1", key)).not.toBe(a)
  })

  it("is a keyed 64-hex HMAC that never contains the address", () => {
    const hash = hashClientIp("203.0.113.7", key)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain("203")
    expect(hashClientIp("203.0.113.7", Buffer.alloc(32, 2))).not.toBe(hash)
    expect(hashClientIp("::ffff:203.0.113.7", key)).toBe(hash)
  })

  it("an unparseable address still hashes deterministically", () => {
    expect(hashClientIp("garbage", key)).toMatch(/^[0-9a-f]{64}$/)
  })
})
