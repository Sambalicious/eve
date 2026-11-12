import { describe, expect, it } from "vitest"

import { ApiError } from "@/shared/api"
import { emailErrorFor, noteHelper, outcomeOf, proofWaitMs, validateForm } from "./form-state"

describe("outcomeOf (design-spec r2 feedback matrix)", () => {
  const api = (status: number, code: ConstructorParameters<typeof ApiError>[1], fields: string[] = []) =>
    new ApiError(status, code, "server message", null, fields as never)

  it.each([
    ["400 with field codes", api(400, "access_request_invalid", ["email.format", "note.too_long"]), { kind: "fields", fields: { email: "format", note: "too_long" } }],
    ["429 per IP", api(429, "rate_limited_ip"), { kind: "panel", panel: "rate_ip" }],
    ["429 global cap", api(429, "rate_limited_global"), { kind: "panel", panel: "rate_global" }],
    ["403 origin", api(403, "origin_forbidden"), { kind: "panel", panel: "rejected" }],
    ["415", api(415, "unsupported_media_type"), { kind: "panel", panel: "rejected" }],
    ["400 with only body codes", api(400, "access_request_invalid", ["body.unknown_field"]), { kind: "panel", panel: "rejected" }],
    ["413 without an envelope", new ApiError(413, null, "HTTP 413"), { kind: "panel", panel: "rejected" }],
    ["429 without a code", new ApiError(429, null, "HTTP 429"), { kind: "panel", panel: "rejected" }],
    ["500", api(500, "internal_error"), { kind: "panel", panel: "network" }],
    ["503", api(503, "service_unavailable"), { kind: "panel", panel: "network" }],
    ["a network failure", new TypeError("Failed to fetch"), { kind: "panel", panel: "network" }],
    ["a 15 s timeout", new DOMException("timed out", "TimeoutError"), { kind: "panel", panel: "network" }],
  ] as const)("%s", (_label, error, outcome) => {
    expect(outcomeOf(error)).toEqual(outcome)
  })
})

describe("validateForm (shared contract normalizer)", () => {
  it("passes a valid email with an empty note", () => {
    expect(validateForm("  ada@example.com\u00A0", "")).toEqual({ ok: true, email: "ada@example.com", note: "" })
  })

  it("flags an empty email as required and a 501-character note as too long, email first", () => {
    expect(validateForm("", "x".repeat(501))).toEqual({ ok: false, errors: { email: "required", note: "too_long" }, first: "email" })
  })

  it("flags only the note when the email is fine", () => {
    expect(validateForm("ada@example.com", "😀".repeat(501))).toEqual({ ok: false, errors: { note: "too_long" }, first: "note" })
  })

  it("accepts 500 code points of emoji", () => {
    expect(validateForm("ada@example.com", "😀".repeat(500)).ok).toBe(true)
  })
})

describe("emailErrorFor (blur rule)", () => {
  it("shows nothing for an untouched empty field", () => {
    expect(emailErrorFor("")).toBeNull()
    expect(emailErrorFor("   ")).toBeNull()
  })
  it.each(["name@gmail", '"Ada" <ada@example.com>', "ada@example.com, bob@example.com"])("%j is a format error", (value) => {
    expect(emailErrorFor(value)).toBe("format")
  })
  it("255 characters is too long", () => {
    expect(emailErrorFor(`${"a".repeat(243)}@example.com`)).toBe("too_long")
  })
})

describe("noteHelper", () => {
  it.each([
    [399, { kind: "hint" }],
    [400, { kind: "left", count: 100 }],
    [499, { kind: "left", count: 1 }],
    [500, { kind: "left", count: 0 }],
    [501, { kind: "over", count: 1 }],
  ] as const)("%i characters", (length, helper) => {
    expect(noteHelper("x".repeat(length))).toEqual(helper)
  })

  it("counts the trimmed value in code points, line breaks as one", () => {
    expect(noteHelper(`  ${"中".repeat(400)}  `)).toEqual({ kind: "left", count: 100 })
    expect(noteHelper("a\n".repeat(200) + "b")).toEqual({ kind: "left", count: 99 })
  })
})

describe("proofWaitMs (architecture r1 7.6 alignment)", () => {
  it("posts at once before 3 s since opening, so a fast submit is dropped as intended", () => {
    expect(proofWaitMs({ openedAt: 0, proofAt: 400, now: 2900 })).toBe(0)
  })
  it("waits until the proof is 3.25 s old once 3 s have passed since opening", () => {
    expect(proofWaitMs({ openedAt: 0, proofAt: 400, now: 3000 })).toBe(650)
  })
  it("posts at once when the proof is old enough", () => {
    expect(proofWaitMs({ openedAt: 0, proofAt: 400, now: 3650 })).toBe(0)
    expect(proofWaitMs({ openedAt: 0, proofAt: 400, now: 20_000 })).toBe(0)
  })
})
