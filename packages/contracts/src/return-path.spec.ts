import { describe, expect, it } from "vitest"

import { toSafeReturnPath } from "./return-path.js"

// Gherkin: dashboard.feature "After sign-in the Candidate returns to the page they asked for"
// and "An expired session sends the Candidate to sign in again" (return-to part).
describe("toSafeReturnPath", () => {
  it.each([
    ["/applications/R-1042", "/applications/R-1042"],
    ["/applications/R-1042#resume", "/applications/R-1042#resume"],
    ["/blocked?tab=login", "/blocked?tab=login"],
    ["/dashboard", "/dashboard"],
  ])("keeps the same-origin dashboard path %s", (input, expected) => {
    expect(toSafeReturnPath(input)).toBe(expected)
  })

  it.each([
    ["missing", undefined],
    ["non-string", ["/dashboard"]],
    ["empty", ""],
    ["absolute URL", "https://evil.example/phish"],
    ["protocol-relative", "//evil.example/phish"],
    ["backslash host", "/\\evil.example"],
    ["scheme", "javascript:alert(1)"],
    ["relative without slash", "applications/R-1042"],
    ["control character", "/app\nlications"],
    ["tab trick", "/\t/evil.example"],
    ["API path", "/v1/session"],
    ["API root", "/v1"],
    ["sign-in loop", "/sign-in?next=/dashboard"],
    ["over-long", `/${"a".repeat(2048)}`],
    ["percent-encoded API path (CR-01)", "/%76%31/session"],
    ["partly encoded API path (CR-01)", "/v%31/session"],
    ["encoded API root (CR-01)", "/%76%31"],
    ["encoded sign-in page (CR-01)", "/sign-%69n"],
    ["encoded slash after sign-in (CR-01)", "/sign-in%2Fx"],
    ["malformed percent escape", "/dash%zzboard"],
  ])("falls back to /dashboard for %s", (_label, input) => {
    expect(toSafeReturnPath(input)).toBe("/dashboard")
  })

  it("normalises dot segments without leaving the origin", () => {
    expect(toSafeReturnPath("/a/../blocked")).toBe("/blocked")
  })

  it("rejects dot segments that resolve to an API path", () => {
    expect(toSafeReturnPath("/x/../v1/session")).toBe("/dashboard")
  })
})

// QA-F1: dot segments that normalise to a protocol-relative path must not leave the origin.
const DOT_SEGMENT_ESCAPES = [
  "/.//evil.com",
  "/..//evil.com",
  "/a/..//evil.com",
  "/%2e//evil.com",
  "/%2e%2e//evil.com",
  "/v1/../..//evil.com",
  "/dashboard/../..//evil.com",
]

const PUBLIC_ORIGIN = "https://dashboard.test"

const PROPERTY_INPUTS = [
  ...DOT_SEGMENT_ESCAPES,
  "/applications/R-1042?tab=documents#resume",
  "/blocked?filter=open#row-3",
  "/a/b/../c",
  "/./dashboard",
  "/%2E%2E/%2E%2E//evil.com",
  "/x/%2e%2e/%2e%2e///evil.com",
  "/.%2e//evil.com",
  "/a/.././/evil.com",
  "/%2f%2fevil.com",
  "/%5cevil.com",
  "///evil.com",
  "/.///evil.com",
  "/dashboard?next=//evil.com",
  "/dashboard#//evil.com",
  "//evil.com",
  "https://evil.com",
  "/sign-in/../dashboard",
  "/v1/../dashboard",
  undefined,
  "",
]

describe("toSafeReturnPath (QA-F1 dot-segment open redirect)", () => {
  it.each(DOT_SEGMENT_ESCAPES)("falls back to /dashboard for %s", (input) => {
    expect(toSafeReturnPath(input)).toBe("/dashboard")
  })

  it.each(PROPERTY_INPUTS)("is idempotent for %j", (input) => {
    const once = toSafeReturnPath(input)
    expect(toSafeReturnPath(once)).toBe(once)
  })

  it.each(PROPERTY_INPUTS)("keeps PUBLIC_ORIGIN when the result for %j is resolved", (input) => {
    const resolved = new URL(toSafeReturnPath(input), PUBLIC_ORIGIN)
    expect(resolved.origin).toBe(PUBLIC_ORIGIN)
  })

  it.each(PROPERTY_INPUTS)("returns a single-slash path for %j", (input) => {
    const result = toSafeReturnPath(input)
    expect(result.startsWith("/")).toBe(true)
    expect(result.startsWith("//")).toBe(false)
  })

  it("holds the same properties over generated dot-segment paths", () => {
    const parts = ["", ".", "..", "%2e", "%2E%2e", "a", "v1", "dashboard", "evil.com", "/"]
    let checked = 0
    for (const a of parts) {
      for (const b of parts) {
        for (const c of parts) {
          for (const d of parts) {
            const input = `/${a}/${b}/${c}/${d}`
            const once = toSafeReturnPath(input)
            expect(toSafeReturnPath(once), input).toBe(once)
            expect(new URL(once, PUBLIC_ORIGIN).origin, input).toBe(PUBLIC_ORIGIN)
            checked++
          }
        }
      }
    }
    expect(checked).toBe(10_000)
  })
})
