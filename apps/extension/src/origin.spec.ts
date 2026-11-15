import { describe, expect, it } from "vitest"

import { eveOriginOf } from "./origin.js"

describe("the Eve address validator (ADR 0016: https only, loopback may use http)", () => {
  it("accepts https and keeps only its origin", () => {
    expect(eveOriginOf("https://eve.example.com/dashboard?tab=1#top")).toEqual({ ok: true, origin: "https://eve.example.com" })
    expect(eveOriginOf("  https://eve.example.com:8443  ")).toEqual({ ok: true, origin: "https://eve.example.com:8443" })
  })

  it("allows http only for localhost and 127.0.0.1, with or without a port", () => {
    expect(eveOriginOf("http://localhost:3000")).toEqual({ ok: true, origin: "http://localhost:3000" })
    expect(eveOriginOf("http://127.0.0.1:3000")).toEqual({ ok: true, origin: "http://127.0.0.1:3000" })
    expect(eveOriginOf("http://localhost")).toEqual({ ok: true, origin: "http://localhost" })
  })

  it("refuses plain http for any other host with the insecure reason", () => {
    expect(eveOriginOf("http://eve.example.com")).toEqual({ ok: false, reason: "insecure" })
    expect(eveOriginOf("http://127.0.0.2:3000")).toEqual({ ok: false, reason: "insecure" })
    expect(eveOriginOf("http://localhost.evil.example")).toEqual({ ok: false, reason: "insecure" })
  })

  it("refuses a non-web scheme and a malformed or empty address", () => {
    expect(eveOriginOf("javascript:alert(1)")).toEqual({ ok: false, reason: "insecure" })
    expect(eveOriginOf("file:///tmp/eve")).toEqual({ ok: false, reason: "insecure" })
    expect(eveOriginOf("eve.example.com")).toEqual({ ok: false, reason: "invalid" })
    expect(eveOriginOf("   ")).toEqual({ ok: false, reason: "invalid" })
  })

  it("refuses an address carrying a username or password", () => {
    expect(eveOriginOf("https://ada:secret@eve.example.com")).toEqual({ ok: false, reason: "invalid" })
  })
})
